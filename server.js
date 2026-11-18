import {projectPage,sampleHtml,sampleFor} from './project-page.js';
import {releaseSchema,publicProjects,releaseView,releaseApi} from './releases.js';
import {uploadPosition} from './uploads.js';
import {centerSchema,centerApi,indexPackages} from './release-center.js';
import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import pathModule from 'node:path';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import pg from 'pg';
const port=Number(process.env.PORT||3000),admin=process.env.SITE_MODE==='admin';
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}}):null;
const sessions=new Map();
const assets = new Map(await Promise.all(['icons.svg','brand.svg','public.css','admin.css','admin.js','public.js','release-admin.js','center-admin.js','center-public.js','studio.webp','AI.webp','Games.webp','Websites.webp'].map(async name => ['/'+name,await readFile(new URL('./'+name,import.meta.url))])));
import {directory as uploadDir, apkMB, startUpload, writePart, cleanStaging} from './uploads.js';
if(admin) setInterval(()=>cleanStaging().catch(console.error),3600000).unref();
const mediaOrigin=(process.env.MEDIA_BASE_URL||'').replace(/\/$/,'');
const mediaTypes={'.zip':'application/zip','.aab':'application/octet-stream','.pdf':'application/pdf','.apk':'application/vnd.android.package-archive','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
const html=await readFile(new URL(admin?'./admin.html':'./index.html',import.meta.url));
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
const clean=s=>String(s||'').trim();
const hash=(p,s)=>scryptSync(p,s,64).toString('hex');
async function init(){if(!pool)return;await pool.query(`CREATE TABLE IF NOT EXISTS studio_settings(id INTEGER PRIMARY KEY, data JSONB NOT NULL);CREATE TABLE IF NOT EXISTS projects(id BIGSERIAL PRIMARY KEY,title TEXT NOT NULL,category TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',image_url TEXT NOT NULL DEFAULT '',demo_url TEXT NOT NULL DEFAULT '',apk_url TEXT NOT NULL DEFAULT '',video_url TEXT NOT NULL DEFAULT '',featured BOOLEAN NOT NULL DEFAULT false,published BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT now());ALTER TABLE projects ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]', ADD COLUMN IF NOT EXISTS screenshots JSONB NOT NULL DEFAULT '[]', ADD COLUMN IF NOT EXISTS release_notes TEXT NOT NULL DEFAULT '';ALTER TABLE projects ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '';CREATE TABLE IF NOT EXISTS enquiries(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,service TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at TIMESTAMPTZ NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS admins(id BIGSERIAL PRIMARY KEY,username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);${releaseSchema};${centerSchema}`);if(process.env.ADMIN_USERNAME&&process.env.ADMIN_PASSWORD){const found=await pool.query('SELECT id FROM admins LIMIT 1');if(!found.rowCount){const salt=randomBytes(16).toString('hex');await pool.query('INSERT INTO admins(username,salt,password_hash) VALUES($1,$2,$3)',[process.env.ADMIN_USERNAME,salt,hash(process.env.ADMIN_PASSWORD,salt)])}}
if(admin){
const count=await pool.query('SELECT COUNT(*)::int AS n FROM projects');
if(count.rows[0].n===0){
const demos=[
['ZUTECHSAM Android App','Apps','Android app UI showcase — sample portfolio entry','TEST PROJECT: A sample Android application concept for testing the portfolio gallery and admin workflow. No APK has been uploaded.'],
['Arcade Game Concept','Games','Mobile game interface and gameplay concept','TEST PROJECT: A sample game development portfolio card. Gameplay and downloadable builds are not available yet.'],
['AI Assistant Prototype','AI','AI assistant and automation concept','TEST PROJECT: Sample AI and automation showcase. This is a placeholder, not a live AI service.'],
['Business Website Design','Websites','Responsive website design concept','TEST PROJECT: Sample website showcase for testing project categories and detail pages. No live demo is attached.']
];
for(const d of demos)await pool.query('INSERT INTO projects(title,category,summary,description,featured,published) VALUES($1,$2,$3,$4,false,true)',d);
console.log('Inserted four labeled test projects');
}
}
}
init().then(()=>{
  if(!admin||!pool)return;
  async function scan(){try{await indexPackages(pool);}catch(error){console.error(error.message);}finally{setTimeout(scan,60000).unref();}}
  scan();
}).catch(e=>console.error('Database initialization failed:',e.message));
async function body(req){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>100000)throw Error('Request too large');chunks.push(c)}return JSON.parse(Buffer.concat(chunks).toString()||'{}')}
const token=req=>(req.headers.authorization||'').replace(/^Bearer /,'');
const auth=req=>{const s=sessions.get(token(req));if(!s||s.expires<Date.now())return false;return true};
const urlOk=s=>{if(!s)return true;try{return s.length<1500 && new URL(s).protocol==='https:';}catch{return false;}};
http.createServer(async(req,res)=>{try{
const path=new URL(req.url,'http://localhost').pathname;
if(assets.has(path)){res.writeHead(200,{'content-type':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.webp')?'image/webp':path.endsWith('.css')?'text/css':'text/javascript'});return res.end(assets.get(path))}
if(path==='/health')return send(res,200,{ok:true,mode:admin?'admin':'public',database:!!pool});
if(path==='/'||path==='/index.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self' https: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});return res.end(html)}
if(/^\/media\/[a-f0-9]{40}\.(apk|aab|zip|pdf|png|jpg|jpeg|webp)$/.test(path)&&['GET','HEAD'].includes(req.method)){
if(!admin){if(!mediaOrigin)return send(res,503,{error:'MEDIA_BASE_URL is not configured'});res.writeHead(302,{location:mediaOrigin+path,'cache-control':'public, max-age=300'});return res.end()}
try{
  const name=pathModule.basename(path), file=pathModule.join(uploadDir,name), info=await stat(file);
  const headers={'content-type':mediaTypes[pathModule.extname(name)],'accept-ranges':'bytes','x-content-type-options':'nosniff','content-disposition':/\.(apk|zip|aab|pdf)$/.test(name)?'attachment; filename="zutechsam-release'+pathModule.extname(name)+'"':'inline','cache-control':'public, max-age=31536000, immutable'};
  const suggested=new URL(req.url,'http://localhost').searchParams.get('download');
  if(suggested && /\.(zip|aab|pdf)$/.test(name)){
    const filename=pathModule.basename(suggested).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180);
    if(filename && pathModule.extname(filename).toLowerCase()===pathModule.extname(name))headers['content-disposition']='attachment; filename="'+filename+'"';
  }
  let start=0,end=info.size-1;
  const range=req.headers.range;
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(match && match[1]){start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    else if(match && match[2])start=Math.max(0,info.size-Number(match[2]));
    if(!match || (!match[1] && !match[2]) || start>end || start>=info.size){
      res.writeHead(416,{'content-range':'bytes */'+info.size});return res.end();
    }
    headers['content-range']='bytes '+start+'-'+end+'/'+info.size;
  }
  res.writeHead(range?206:200,{...headers,'content-length':end-start+1});
  if(req.method==='HEAD')return res.end();
  await pipeline(createReadStream(file,{start,end}),res).catch(()=>{});return;
}catch{return send(res,404,{error:'File not found'})}}
if(!pool)return send(res,503,{error:'Database is not configured. Add DATABASE_URL on Railway.'});
if(!admin&&await centerApi(path,req,res,{pool,body,send,admin}))return;
const releaseDownload=!admin&&/^\/projects\/(\d+)\/releases\/(\d+)\/download$/.exec(path);
if(releaseDownload && ['GET','HEAD'].includes(req.method)){
  const sql=req.method==='GET'?'UPDATE project_releases r SET download_clicks=r.download_clicks+1 FROM projects p WHERE r.id=$2 AND p.id=$1 AND p.published AND r.project_id=p.id RETURNING r.url':'SELECT r.url FROM project_releases r JOIN projects p ON p.id=r.project_id WHERE r.id=$2 AND p.id=$1 AND p.published';
  const r=await pool.query(sql,releaseDownload.slice(1));
  if(!r.rowCount)return send(res,404,{error:'Release unavailable'});
  res.writeHead(302,{location:r.rows[0].url,'cache-control':'no-store'});return res.end();
}
const projectRoute=!admin && /^\/projects\/(\d+)(?:\/(demo|sample\.html))?\/?$/.exec(path);
if(projectRoute && req.method==='GET'){
  const result=await pool.query('SELECT * FROM projects WHERE id=$1 AND published=true',[projectRoute[1]]);
  const project=result.rows[0],sample=project&&sampleFor(project),mode=projectRoute[2];
  if(!project || (mode && !sample))return send(res,404,{error:'Project or demo unavailable'});
  const headers={'content-type':'text/html; charset=utf-8','x-content-type-options':'nosniff','cache-control':'no-store','content-security-policy':mode?"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'":"default-src 'self'; img-src 'self' https:; style-src 'self'; frame-src 'self'; frame-ancestors 'none'"};
  if(mode==='sample.html')headers['content-disposition']='attachment; filename="studio-demo-'+project.id+'.html"';
  res.writeHead(200,headers);return res.end(mode?sampleHtml(sample):await releaseView(pool,project));
}
if(path==='/api/studio' && req.method==='GET'){
  const result=await pool.query('SELECT data FROM studio_settings WHERE id=1');
  return send(res,200,result.rows[0]?.data || {});
}
if(path==='/api/projects'&&req.method==='GET'){const q=await pool.query(publicProjects+' WHERE p.published=true ORDER BY p.featured DESC,p.created_at DESC LIMIT 500');return send(res,200,q.rows)}
if(path==='/api/enquiries'&&req.method==='POST'&&!admin){const b=await body(req);if(!clean(b.name)||!/^\S+@\S+\.\S+$/.test(clean(b.email))||!clean(b.message)||clean(b.message).length>5000)return send(res,400,{error:'Please provide valid name, email and message'});await pool.query('INSERT INTO enquiries(name,email,service,message) VALUES($1,$2,$3,$4)',[clean(b.name).slice(0,120),clean(b.email).slice(0,200),clean(b.service).slice(0,100),clean(b.message)]);return send(res,201,{ok:true})}
if(!admin)return send(res,404,{error:'Not found'});
if(path==='/api/login'&&req.method==='POST'){const b=await body(req);const q=await pool.query('SELECT * FROM admins WHERE username=$1',[clean(b.username)]);const a=q.rows[0];if(!a||!timingSafeEqual(Buffer.from(hash(String(b.password||''),a.salt),'hex'),Buffer.from(a.password_hash,'hex')))return send(res,401,{error:'Invalid credentials'});const t=randomBytes(32).toString('hex');sessions.set(t,{expires:Date.now()+8*3600000});return send(res,200,{token:t})}
if(path==='/api/logout'&&req.method==='POST'){sessions.delete(token(req));return send(res,200,{ok:true})}
if(!auth(req))return send(res,401,{error:'Login required'});
if(await centerApi(path,req,res,{pool,body,send,admin}))return;
if(await releaseApi(path,req,res,{pool,body,send}))return;
if(path.startsWith('/api/admin/uploads/') && req.method==='GET'){
  const size=Number(new URL(req.url,'http://localhost').searchParams.get('size'));
  return send(res,200,await uploadPosition(path.split('/').pop(),size));
}
if(path==='/api/admin/studio' && req.method==='PUT'){
  const data=await body(req);
  const keys=['headline','intro','email'];
  const settings=Object.fromEntries(keys.map(key=>[key,clean(data[key])]));
  if(settings.headline.length>90 || settings.intro.length>360 || (settings.email && !/^\S+@\S+\.\S+$/.test(settings.email)))return send(res,400,{error:'Check headline, introduction and email'});
  await pool.query('INSERT INTO studio_settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',[settings]);
  return send(res,200,{ok:true});
}
if(path==='/api/admin/uploads' && req.method==='GET')return send(res,200,{apkMB,imageMB:100});
if(path==='/api/admin/uploads' && req.method==='POST'){
  const data=await body(req);
  return send(res,201,await startUpload(pathModule.extname(clean(data.filename).toLowerCase()),data.size));
}
if(path.startsWith('/api/admin/uploads/') && req.method==='PUT'){
  const params=new URL(req.url,'http://localhost').searchParams;
  return send(res,200,await writePart(req,path.split('/').pop(),Number(params.get('size')),Number(params.get('offset'))));
}
if(path==='/api/admin/upload' && req.method==='POST'){
  const total=Number(req.headers['content-length']);
  const {id}=await startUpload(pathModule.extname(clean(req.headers['x-filename']).toLowerCase()),total);
  const result=await writePart(req,id,total,0,total);
  return send(res,result.url?201:400,result.url?{ok:true,url:result.url}:{error:'Incomplete upload'});
}
if(path==='/api/admin/projects'&&req.method==='GET'){const q=await pool.query( `SELECT p.*,(
  SELECT count(DISTINCT url)::int FROM (
    SELECT NULLIF(p.apk_url,'') AS url
    UNION ALL SELECT file->>'url' FROM jsonb_array_elements(p.attachments) AS file
    UNION ALL SELECT r.url FROM project_releases r WHERE r.project_id=p.id
  ) downloads
) AS file_count,
(SELECT count(*)::int FROM project_releases r WHERE r.project_id=p.id) AS release_count
FROM projects p ORDER BY p.created_at DESC LIMIT 500`);return send(res,200,q.rows)}
if(path==='/api/admin/enquiries'&&req.method==='GET'){const q=await pool.query('SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 500');return send(res,200,q.rows)}
if(path==='/api/admin/projects'&&req.method==='POST'||/^\/api\/admin\/projects\/\d+$/.test(path)&&['PUT','DELETE'].includes(req.method)){
const id=Number(path.split('/').pop());if(req.method==='DELETE'){await pool.query('DELETE FROM projects WHERE id=$1',[id]);return send(res,200,{ok:true})}
const b=await body(req);if(!clean(b.title)||!clean(b.category)||!['Apps','Games','AI','Websites','Software'].includes(b.category)||!['image_url','demo_url','apk_url','video_url'].every(k=>urlOk(clean(b[k]))))return send(res,400,{error:'Title, valid category and HTTPS URLs required'});
const screenshots=b.screenshots;
if(screenshots!==undefined && (!Array.isArray(screenshots)||screenshots.length>6||!screenshots.every(u=>typeof u==='string' && u && urlOk(u))))return send(res,400,{error:'Use up to six HTTPS screenshot URLs'});
const attachments=b.attachments;
if(attachments!==undefined && (!Array.isArray(attachments)||attachments.length>12||attachments.some(f=>!f||typeof f.name!=='string'||!f.name.trim()||f.name.length>240||typeof f.url!=='string'||!f.url||!urlOk(f.url)||!Number.isSafeInteger(f.size)||f.size<0)))return send(res,400,{error:'Use up to 12 named files with HTTPS URLs'});
const vals=[clean(b.title).slice(0,150),b.category,clean(b.summary).slice(0,400),clean(b.description).slice(0,10000),clean(b.image_url),clean(b.demo_url),clean(b.apk_url),clean(b.video_url),!!b.featured,b.published!==false,clean(b.version).slice(0,60),screenshots===undefined?null:JSON.stringify(screenshots),b.release_notes===undefined?null:clean(b.release_notes).slice(0,4000),attachments===undefined?null:JSON.stringify(attachments)];
if(req.method==='POST'){await pool.query('INSERT INTO projects(title,category,summary,description,image_url,demo_url,apk_url,video_url,featured,published,version,screenshots,release_notes,attachments) VALUES('+vals.map((_,i)=>i===13?"coalesce($14::jsonb,'[]'::jsonb)":i===11?"coalesce($12::jsonb,'[]'::jsonb)":i===12?"coalesce($13,'')":'$'+(i+1)).join(',')+')',vals)}else{await pool.query('UPDATE projects SET title=$1,category=$2,summary=$3,description=$4,image_url=$5,demo_url=$6,apk_url=$7,video_url=$8,featured=$9,published=$10,version=$11,screenshots=coalesce($12::jsonb,screenshots),release_notes=coalesce($13,release_notes),attachments=coalesce($14::jsonb,attachments) WHERE id=$15',[...vals,id])}return send(res,200,{ok:true})}
if(/^\/api\/admin\/enquiries\/\d+$/.test(path)&&req.method==='PATCH'){const b=await body(req);if(!['new','contacted','closed'].includes(b.status))return send(res,400,{error:'Invalid status'});await pool.query('UPDATE enquiries SET status=$1 WHERE id=$2',[b.status,Number(path.split('/').pop())]);return send(res,200,{ok:true})}
return send(res,404,{error:'Not found'});
}catch(e){console.error(e);send(res,e.status || (e.message==='Request too large'?413:500),{error:e.status || e.message==='Request too large'?e.message:'Server error'})}}).listen(port,'0.0.0.0',()=>console.log('ZUTECHSAM '+(admin?'admin':'public')+' listening '+port));
