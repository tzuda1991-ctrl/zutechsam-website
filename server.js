import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import pg from 'pg';
const port=Number(process.env.PORT||3000),admin=process.env.SITE_MODE==='admin';
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}}):null;
const sessions=new Map();
const html=await readFile(new URL(admin?'./admin.html':'./index.html',import.meta.url));
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
const clean=s=>String(s||'').trim();
const hash=(p,s)=>scryptSync(p,s,64).toString('hex');
async function init(){if(!pool)return;await pool.query(`CREATE TABLE IF NOT EXISTS projects(id BIGSERIAL PRIMARY KEY,title TEXT NOT NULL,category TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',image_url TEXT NOT NULL DEFAULT '',demo_url TEXT NOT NULL DEFAULT '',apk_url TEXT NOT NULL DEFAULT '',video_url TEXT NOT NULL DEFAULT '',featured BOOLEAN NOT NULL DEFAULT false,published BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS enquiries(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,service TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at TIMESTAMPTZ NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS admins(id BIGSERIAL PRIMARY KEY,username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL)`);if(process.env.ADMIN_USERNAME&&process.env.ADMIN_PASSWORD){const found=await pool.query('SELECT id FROM admins LIMIT 1');if(!found.rowCount){const salt=randomBytes(16).toString('hex');await pool.query('INSERT INTO admins(username,salt,password_hash) VALUES($1,$2,$3)',[process.env.ADMIN_USERNAME,salt,hash(process.env.ADMIN_PASSWORD,salt)])}}}
init().catch(e=>console.error('Database initialization failed:',e.message));
async function body(req){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>100000)throw Error('Request too large');chunks.push(c)}return JSON.parse(Buffer.concat(chunks).toString()||'{}')}
const token=req=>(req.headers.authorization||'').replace(/^Bearer /,'');
const auth=req=>{const s=sessions.get(token(req));if(!s||s.expires<Date.now())return false;return true};
const urlOk=s=>!s||(/^https:\/\//i.test(s)&&s.length<1500);
http.createServer(async(req,res)=>{try{
const path=new URL(req.url,'http://localhost').pathname;
if(path==='/health')return send(res,200,{ok:true,mode:admin?'admin':'public',database:!!pool});
if(path==='/'||path==='/index.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self' https: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});return res.end(html)}
if(!pool)return send(res,503,{error:'Database is not configured. Add DATABASE_URL on Railway.'});
if(path==='/api/projects'&&req.method==='GET'){const q=await pool.query('SELECT * FROM projects WHERE published=true ORDER BY featured DESC,created_at DESC LIMIT 500');return send(res,200,q.rows)}
if(path==='/api/enquiries'&&req.method==='POST'&&!admin){const b=await body(req);if(!clean(b.name)||!/^\S+@\S+\.\S+$/.test(clean(b.email))||!clean(b.message)||clean(b.message).length>5000)return send(res,400,{error:'Please provide valid name, email and message'});await pool.query('INSERT INTO enquiries(name,email,service,message) VALUES($1,$2,$3,$4)',[clean(b.name).slice(0,120),clean(b.email).slice(0,200),clean(b.service).slice(0,100),clean(b.message)]);return send(res,201,{ok:true})}
if(!admin)return send(res,404,{error:'Not found'});
if(path==='/api/login'&&req.method==='POST'){const b=await body(req);const q=await pool.query('SELECT * FROM admins WHERE username=$1',[clean(b.username)]);const a=q.rows[0];if(!a||!timingSafeEqual(Buffer.from(hash(String(b.password||''),a.salt),'hex'),Buffer.from(a.password_hash,'hex')))return send(res,401,{error:'Invalid credentials'});const t=randomBytes(32).toString('hex');sessions.set(t,{expires:Date.now()+8*3600000});return send(res,200,{token:t})}
if(path==='/api/logout'&&req.method==='POST'){sessions.delete(token(req));return send(res,200,{ok:true})}
if(!auth(req))return send(res,401,{error:'Login required'});
if(path==='/api/admin/projects'&&req.method==='GET'){const q=await pool.query('SELECT * FROM projects ORDER BY created_at DESC LIMIT 500');return send(res,200,q.rows)}
if(path==='/api/admin/enquiries'&&req.method==='GET'){const q=await pool.query('SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 500');return send(res,200,q.rows)}
if(path==='/api/admin/projects'&&req.method==='POST'||/^\/api\/admin\/projects\/\d+$/.test(path)&&['PUT','DELETE'].includes(req.method)){
const id=Number(path.split('/').pop());if(req.method==='DELETE'){await pool.query('DELETE FROM projects WHERE id=$1',[id]);return send(res,200,{ok:true})}
const b=await body(req);if(!clean(b.title)||!clean(b.category)||!['Apps','Games','AI','Websites','Software'].includes(b.category)||!['image_url','demo_url','apk_url','video_url'].every(k=>urlOk(clean(b[k]))))return send(res,400,{error:'Title, valid category and HTTPS URLs required'});
const vals=[clean(b.title).slice(0,150),b.category,clean(b.summary).slice(0,400),clean(b.description).slice(0,10000),clean(b.image_url),clean(b.demo_url),clean(b.apk_url),clean(b.video_url),!!b.featured,b.published!==false];
if(req.method==='POST'){await pool.query('INSERT INTO projects(title,category,summary,description,image_url,demo_url,apk_url,video_url,featured,published) VALUES('+vals.map((_,i)=>'$'+(i+1)).join(',')+')',vals)}else{await pool.query('UPDATE projects SET title=$1,category=$2,summary=$3,description=$4,image_url=$5,demo_url=$6,apk_url=$7,video_url=$8,featured=$9,published=$10 WHERE id=$11',[...vals,id])}return send(res,200,{ok:true})}
if(/^\/api\/admin\/enquiries\/\d+$/.test(path)&&req.method==='PATCH'){const b=await body(req);if(!['new','contacted','closed'].includes(b.status))return send(res,400,{error:'Invalid status'});await pool.query('UPDATE enquiries SET status=$1 WHERE id=$2',[b.status,Number(path.split('/').pop())]);return send(res,200,{ok:true})}
return send(res,404,{error:'Not found'});
}catch(e){console.error(e);send(res,e.message==='Request too large'?413:500,{error:e.message==='Request too large'?e.message:'Server error'})}}).listen(port,'0.0.0.0',()=>console.log('ZUTECHSAM '+(admin?'admin':'public')+' listening '+port));
