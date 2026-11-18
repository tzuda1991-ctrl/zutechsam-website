import QRCode from 'qrcode';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ApkReader from 'adbkit-apkreader';
import ManifestParser from 'adbkit-apkreader/lib/apkreader/parser/manifest.js';
import {directory} from './uploads.js';

export const centerSchema=`
ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'Stable';
ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS details jsonb;
CREATE TABLE IF NOT EXISTS release_reports(id bigserial PRIMARY KEY, project_id bigint REFERENCES projects ON DELETE CASCADE, version text NOT NULL, message text NOT NULL, screenshot text, resolved boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS reports_by_project_time ON release_reports(project_id,created_at);
CREATE TABLE IF NOT EXISTS release_activity(id bigserial PRIMARY KEY, project_id bigint REFERENCES projects ON DELETE CASCADE, action text NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL, undone boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS project_visits(project_id bigint REFERENCES projects ON DELETE CASCADE, source text, visits bigint DEFAULT 1, PRIMARY KEY(project_id,source))`;
const fail=(status,message)=>Object.assign(Error(message),{status});
export const escapeText=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const snapshot=async(db,id)=>(await db.query('SELECT id::text, version,url,filename,size::text,notes,is_latest,published_at,channel FROM project_releases WHERE project_id=$1 ORDER BY id',[id])).rows;
export async function indexPackages(db){
  const rows=(await db.query('SELECT DISTINCT url FROM project_releases WHERE details IS NULL')).rows;
  for(const {url} of rows){
    const key=new URL(url).pathname.match(/^\/media\/([a-f0-9]{40}\.apk)$/)?.[1];
    if(!key)continue;
    const file=path.join(directory,key),details={};
    try {
      const hash=createHash('sha256');
      for await(const chunk of createReadStream(file))hash.update(chunk);
      details.sha256=hash.digest('hex');
    } catch {continue;}
    try{
      const reader=await ApkReader.open(file);
      const manifest=await reader.usingFileStream('AndroidManifest.xml',async stream=>{
        let size=0;const chunks=[];
        for await(const chunk of stream){size+=chunk.length;if(size>4194304)throw Error('Manifest too large');chunks.push(chunk);}
        return new ManifestParser(Buffer.concat(chunks)).parse();
      });
      Object.assign(details,{package:manifest.package,build:manifest.versionCode,version:manifest.versionName,minSdk:manifest.usesSdk?.minSdkVersion,targetSdk:manifest.usesSdk?.targetSdkVersion});
    }catch{/* Older or nonstandard manifests still get a checksum. */}
    await db.query('UPDATE project_releases SET details=$1 WHERE url=$2 AND details IS NULL',[details,url]);
  }
}
export async function centerApi(pathname,req,res,{pool,body,send,admin}){
  if(admin){
    if(pathname==='/api/admin/center'&&req.method==='GET'){
      const query=sql=>pool.query(sql).then(q=>q.rows);
      const [reports,activity,visits]=await Promise.all([
        query('SELECT r.id,r.version,r.message,r.resolved,r.created_at,p.title,(r.screenshot IS NOT NULL) AS image FROM release_reports r JOIN projects p ON p.id=r.project_id ORDER BY r.id DESC LIMIT 150'),
        query('SELECT a.id,p.title,a.action,a.undone,a.created_at FROM release_activity a JOIN projects p ON p.id=a.project_id ORDER BY a.id DESC LIMIT 100'),
        query('SELECT p.title,v.source,v.visits FROM project_visits v JOIN projects p ON p.id=v.project_id ORDER BY v.visits DESC')]);
      send(res,200,{reports,activity,visits});return true;
    }
    const report=pathname.match(/^\/api\/admin\/reports\/(\d+)$/);
    if(report&&['GET','PATCH'].includes(req.method)){
      const q=req.method==='GET'?await pool.query('SELECT screenshot FROM release_reports WHERE id=$1',[report[1]]):await pool.query('UPDATE release_reports SET resolved=$2 WHERE id=$1 RETURNING resolved',[report[1],(await body(req)).resolved===true]);
      send(res,q.rowCount?200:404,q.rows[0]||{error:'Report no longer exists'});return true;
    }
    const undo=pathname.match(/^\/api\/admin\/activity\/(\d+)\/undo$/);
    if(undo&&req.method==='POST'){
      const db=await pool.connect();
      try{
        await db.query('BEGIN');
        const a=(await db.query('SELECT * FROM release_activity WHERE id=$1',[undo[1]])).rows[0];
        if(!a)throw fail(404,'Activity unavailable');
        await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[a.project_id]);
        const current=await snapshot(db,a.project_id);
        const same=(await db.query('SELECT $1::jsonb=$2::jsonb AS ok',[JSON.stringify(current),JSON.stringify(a.after_state)])).rows[0].ok;
        if(a.undone||!same)throw fail(409,'The releases have changed since this action.');
        for(const r of a.before_state){
          if(current.some(c=>c.url===r.url))continue;
          const key=new URL(r.url).pathname.match(/^\/media\/([a-f0-9]{40}\.apk)$/)?.[1];
          if(key){const {access}=await import('node:fs/promises');await access(path.join(directory,key)).catch(()=>{throw fail(409,'The original APK has been removed from storage.');});}
        }
        await db.query('UPDATE project_releases SET is_latest=false WHERE project_id=$1 AND is_latest',[a.project_id]);
        await db.query('DELETE FROM project_releases WHERE project_id=$1 AND NOT(id=ANY($2::bigint[]))',[a.project_id,a.before_state.map(r=>r.id)]);
        for(const r of a.before_state)await db.query(`INSERT INTO project_releases(id,project_id,version,url,filename,size,notes,is_latest,published_at,channel) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT(id) DO UPDATE SET version=excluded.version,url=excluded.url,filename=excluded.filename,size=excluded.size,notes=excluded.notes,is_latest=excluded.is_latest,channel=excluded.channel,revision=project_releases.revision+1,details=CASE WHEN project_releases.url=excluded.url THEN project_releases.details END`,[r.id,a.project_id,r.version,r.url,r.filename,r.size,r.notes,r.is_latest,r.published_at,r.channel]);
        await db.query('UPDATE release_activity SET undone=true WHERE id=$1',[a.id]);
        await db.query('COMMIT');send(res,200,{ok:true});
      }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
      return true;
    }
    return false;
  }
  const match=pathname.match(/^\/projects\/(\d+)\/(youtube|qr|qr.png|updates.atom|reports)$/);
  if(!match)return false;
  const [,id,action]=match;
  const p=(await pool.query('SELECT title FROM projects WHERE id=$1 AND published',[id])).rows[0];
  if(!p)throw fail(404,'Project unavailable');
  const origin='https://'+req.headers.host,base=origin+'/projects/'+id;
  if(action==='reports'&&req.method==='POST'){
    const data=await body(req),message=String(data.message||'').trim(),shot=data.screenshot||null;
    if(message.length<5||message.length>2000|| (shot&&(typeof shot!=='string'||shot.length>85000||!/^data:image\/jpeg;base64,\/9j\/[a-zA-Z0-9+/=]+$/.test(shot))))throw fail(400,'Check the description and screenshot.');
    const recent=(await pool.query("SELECT count(*)::int AS count FROM release_reports WHERE project_id=$1 AND created_at>now()-interval '1 hour'",[id])).rows[0];
    if(recent.count>=60)throw fail(429,'The report inbox is busy. Please try again later.');
    const q=await pool.query('INSERT INTO release_reports(project_id,version,message,screenshot) SELECT project_id,version,$3,$4 FROM project_releases WHERE project_id=$1 AND id=$2 RETURNING id',[id,/^\d+$/.test(data.release)?data.release:'0',message,shot]);
    if(!q.rowCount)throw fail(404,'Release unavailable');send(res,201,{id:q.rows[0].id});return true;
  }
  if(req.method!=='GET'||action==='reports')return false;
  if(['youtube','qr'].includes(action)){
    await pool.query('INSERT INTO project_visits(project_id,source) VALUES($1,$2) ON CONFLICT(project_id,source) DO UPDATE SET visits=project_visits.visits+1',[id,action]);
    res.writeHead(302,{location:'/projects/'+id,'cache-control':'no-store'});res.end();return true;
  }
  if(action==='qr.png'){res.setHeader('content-type','image/png');res.end(await QRCode.toBuffer(base+'/qr',{width:320}));return true;}
  const rows=(await pool.query('SELECT id,version,notes,published_at,channel FROM project_releases WHERE project_id=$1 ORDER BY published_at DESC,id DESC LIMIT 100',[id])).rows;
  const e=escapeText,stamp=r=>new Date(r.published_at).toISOString();
  res.setHeader('content-type','application/atom+xml; charset=utf-8');
  res.end('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>'+e(p.title)+' updates</title><id>'+e(base)+'</id><link rel="self" href="'+e(base)+'/updates.atom"/><author><name>ZUTECHSAM</name></author><updated>'+(rows.length?stamp(rows[0]):'1970-01-01T00:00:00Z')+'</updated>'+rows.map(r=>'<entry><title>'+e(r.version)+' · '+e(r.channel)+'</title><id>'+e(base)+'#release-'+r.id+'</id><link href="'+e(base)+'#release-'+r.id+'"/><updated>'+stamp(r)+'</updated><summary>'+e(r.notes)+'</summary></entry>').join('')+'</feed>');return true;
}
