import {projectPage} from './project-page.js';
import {storedFiles,storageSpace,uploadPosition} from './uploads.js';

export const releaseSchema=`CREATE TABLE IF NOT EXISTS project_releases(
  id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL, url TEXT NOT NULL, filename TEXT NOT NULL, size BIGINT NOT NULL,
  notes TEXT NOT NULL, download_clicks BIGINT NOT NULL DEFAULT 0, published_at TIMESTAMPTZ NOT NULL DEFAULT now(), is_latest BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(project_id,version));
  CREATE UNIQUE INDEX IF NOT EXISTS one_latest_release ON project_releases(project_id) WHERE is_latest`;

export const publicProjects=`SELECT p.*,COALESCE(r.version,p.version) AS version,
  COALESCE(r.url,p.apk_url) AS apk_url,COALESCE(r.notes,p.release_notes) AS release_notes
  FROM projects p LEFT JOIN project_releases r ON r.project_id=p.id AND r.is_latest`;
const bad=(status,message)=>Object.assign(Error(message),{status});
async function history(db,id){
  return (await db.query('SELECT * FROM project_releases WHERE project_id=$1 ORDER BY is_latest DESC,published_at DESC,id DESC',[id])).rows;
}
export async function releaseView(db,project,preview){
  const releases=await history(db,project.id);
  if(preview)releases.unshift({...preview,is_latest:true,published_at:new Date()});
  const current=releases[0];
  if(!current)return projectPage(project);
  if(project.apk_url&&!releases.some(r=>r.url===project.apk_url))releases.push({version:project.version||'Original release',url:project.apk_url,notes:project.release_notes});
  const links=releases.map(r=>({...r,download:!preview&&r.id?'/projects/'+project.id+'/releases/'+r.id+'/download':r.url}));
  return projectPage({...project,version:current.version,apk_url:links[0].download,release_notes:current.notes},links);
}
export async function releaseApi(path,req,res,{pool,body,send}){
  if(path==='/api/admin/space'&&req.method==='GET'){send(res,200,await storageSpace());return true;}
  if(path==='/api/admin/files'&&req.method==='GET'){
    const inventory=await storedFiles();
    const projects=(await pool.query('SELECT id,title,apk_url,image_url,screenshots,attachments FROM projects')).rows;
    const versions=(await pool.query('SELECT project_id,url,filename FROM project_releases')).rows;
    const references=new Map();
    function record(url,project,label){
      if(!url)return;
      let name;try{name=new URL(url,'https://studio.invalid').pathname.split('/').pop();}catch{return;}
      const entry=references.get(name)||{projects:new Set(),label:''};
      entry.projects.add(project.title);if(label)entry.label=label;references.set(name,entry);
    }
    const lookup=new Map(projects.map(p=>[p.id,p]));
    for(const p of projects){record(p.apk_url,p);record(p.image_url,p);for(const s of p.screenshots)record(s,p);for(const f of p.attachments)record(f.url,p,f.name);}
    for(const r of versions){const p=lookup.get(r.project_id);if(p)record(r.url,p,r.filename);}
    for(const file of inventory.files){const ref=references.get(file.name);file.projects=[...(ref?.projects||[])];file.label=ref?.label||file.name;}
    send(res,200,inventory);return true;
  }
  const match=/^\/api\/admin\/projects\/(\d+)\/releases(?:\/(preview|\d+))?$/.exec(path);
  if(!match)return false;
  const [,id,action]=match;
  if(req.method==='GET'&&!action){send(res,200,await history(pool,id));return true;}
  if(req.method!=='POST')return false;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const project=(await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!project)throw bad(404,'Project no longer exists');
    let chosen,preview;
    if(action&&action!=='preview'){
      chosen=(await client.query('SELECT id FROM project_releases WHERE project_id=$1 AND id=$2',[id,action])).rows[0];
      if(!chosen)throw bad(404,'Release no longer exists');
    }else{
      const data=await body(req);
      const version=String(data.version||'').trim(),notes=String(data.notes||'').trim(),filename=String(data.filename||'').trim();
      let url;try{url=new URL(data.url);}catch{throw bad(400,'Upload an APK before previewing');}
      const key=url.pathname.match(/^\/media\/([a-f0-9]{40}\.apk)$/)?.[1];
      if(!key||url.protocol!=='https:'||url.host!==req.headers.host||!version||version.length>60||notes.length>4000||!filename||filename.length>240)throw bad(400,'Check the version, notes and APK file');
      const state=await uploadPosition(key,data.size);
      if(!state.url)throw bad(400,'Finish uploading the APK first');
      const release={version,url:url.href,size:data.size,notes,filename};
      if(action==='preview')preview=await releaseView(client,project,release);
      else{
        const existing=(await client.query('SELECT * FROM project_releases WHERE project_id=$1 AND version=$2',[id,version])).rows[0];
        if(existing){if(existing.url!==url.href||existing.notes!==notes)throw bad(409,'That version already exists. Choose another version.');}
        else chosen=(await client.query('INSERT INTO project_releases(project_id,version,url,filename,size,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[id,version,url.href,filename,data.size,notes])).rows[0];
      }
    }
    if(chosen){
      await client.query('UPDATE project_releases SET is_latest=false WHERE project_id=$1 AND is_latest',[id]);
      await client.query('UPDATE project_releases SET is_latest=true WHERE id=$1',[chosen.id]);
    }
    await client.query('COMMIT');
    send(res,200,preview?{html:preview}:{ok:true,published:project.published});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  return true;
}
