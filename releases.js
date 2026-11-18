import {snapshot} from './release-center.js';
import {projectPage} from './project-page.js';
import {deleteStoredFile,storedFiles,storageSpace,uploadPosition} from './uploads.js';

export const releaseSchema=`CREATE TABLE IF NOT EXISTS project_releases(
  id BIGSERIAL PRIMARY KEY, project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL, url TEXT NOT NULL, filename TEXT NOT NULL, size BIGINT NOT NULL,
  notes TEXT NOT NULL, download_clicks BIGINT NOT NULL DEFAULT 0, published_at TIMESTAMPTZ NOT NULL DEFAULT now(), is_latest BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(project_id,version));
  ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
  CREATE UNIQUE INDEX IF NOT EXISTS one_latest_release ON project_releases(project_id) WHERE is_latest`;

export const publicProjects=`SELECT p.*,r.id AS latest_release_id,COALESCE(r.version,p.version) AS version,
  COALESCE(r.url,p.apk_url) AS apk_url,COALESCE(r.notes,p.release_notes) AS release_notes
  FROM projects p LEFT JOIN project_releases r ON r.project_id=p.id AND r.is_latest`;
const bad=(status,message)=>Object.assign(Error(message),{status});
async function history(db,id){
  return (await db.query('SELECT * FROM project_releases WHERE project_id=$1 ORDER BY is_latest DESC,published_at DESC,id DESC',[id])).rows;
}
export async function releaseView(db,project,preview){
  const releases=await history(db,project.id);
  if(preview)releases.unshift({...preview,is_latest:preview.channel!=='Beta',published_at:new Date()});
  const current=preview||releases.find(r=>r.is_latest);
  if(!releases.length)return projectPage(project);
  if(project.apk_url&&!releases.some(r=>r.url===project.apk_url))releases.push({version:project.version||'Original release',url:project.apk_url,notes:project.release_notes});
  const links=releases.map(r=>({...r,download:!preview&&r.id?'/projects/'+project.id+'/releases/'+r.id+'/download':r.url}));
  return projectPage({...project,version:current?.version||project.version,apk_url:current?links[0].download:project.apk_url,release_notes:current?.notes||project.release_notes},links);
}
async function fileReferences(db){
    const projects=(await db.query('SELECT id,title,apk_url,image_url,screenshots,attachments FROM projects')).rows;
    const versions=(await db.query('SELECT project_id,url,filename FROM project_releases')).rows;
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
    return references;
}
export async function releaseApi(path,req,res,{pool,body,send}){
  if(path==='/api/admin/space'&&req.method==='GET'){send(res,200,await storageSpace());return true;}
  if(path.startsWith('/api/admin/files/')&&req.method==='DELETE'){
    const name=path.slice('/api/admin/files/'.length);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('LOCK TABLE projects,project_releases IN SHARE MODE');
      if((await fileReferences(client)).has(name))throw bad(409,'This file is attached to a project. Remove its reference first.');
      await deleteStoredFile(name);
      await client.query('COMMIT');send(res,200,{ok:true});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    return true;
  }
  if(path==='/api/admin/files'&&req.method==='GET'){
    const inventory=await storedFiles();
    const references=await fileReferences(pool);
    for(const file of inventory.files){const ref=references.get(file.name);file.projects=[...(ref?.projects||[])];file.label=ref?.label||file.name;}
    send(res,200,inventory);return true;
  }
  const match=/^\/api\/admin\/projects\/(\d+)\/releases(?:\/(preview|\d+))?$/.exec(path);
  if(!match)return false;
  const [,id,action]=match;
  if(req.method==='GET'&&!action){send(res,200,await history(pool,id));return true;}
  const changing=/^\d+$/.test(action||'')&&['PUT','DELETE'].includes(req.method);
  if(req.method!=='POST'&&!changing)return false;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const project=(await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!project)throw bad(404,'Project no longer exists');
    const before=action==='preview'?null:await snapshot(client,id);
    let chosen,preview;
    if(changing){
      const current=(await client.query('SELECT * FROM project_releases WHERE project_id=$1 AND id=$2',[id,action])).rows[0];
      if(!current)throw bad(404,'This release has already been removed.');
      const data=await body(req);
      if(data.revision!==current.revision)throw bad(409,'This release changed. Reopen it to see the current version.');
      if(req.method==='DELETE'){
        await client.query('DELETE FROM project_releases WHERE project_id=$1 AND id=$2',[id,action]);
        if(current.is_latest)chosen=(await client.query(`SELECT id FROM project_releases WHERE project_id=$1 AND channel='Stable' ORDER BY published_at DESC,id DESC LIMIT 1`,[id])).rows[0];
      }else{
        const version=String(data.version||'').trim(), notes=String(data.notes||'').trim();
        if(!version||version.length>60||notes.length>4000)throw bad(400,'Enter a version and valid release notes.');
        const channel=data.channel??current.channel;
        if(!['Stable','Beta'].includes(channel))throw bad(400,'Choose a release channel.');
        let {url,size,filename}=current;
        if(data.url!==current.url){
          let next;try{next=new URL(data.url);}catch{throw bad(400,'Choose a valid APK');}
          const key=next.pathname.match(/^\/media\/([a-f0-9]{40}\.apk)$/)?.[1];
          if(!key||next.protocol!=='https:'||next.host!==req.headers.host||!data.filename||String(data.filename).length>240)throw bad(400,'Choose an uploaded APK');
          if(!(await uploadPosition(key,data.size)).url)throw bad(400,'Finish uploading the replacement first');
          url=next.href;size=data.size;filename=data.filename;
        }
        await client.query(`UPDATE project_releases SET version=$1,notes=$2,url=$3,size=$4,filename=$5,channel=$8,details=CASE WHEN url=$3 THEN details END,is_latest=is_latest AND $8='Stable',revision=revision+1 WHERE project_id=$6 AND id=$7`,[version,notes,url,size,filename,id,action,channel]);
        if(current.is_latest&&channel==='Beta')chosen=(await client.query("SELECT id FROM project_releases WHERE project_id=$1 AND channel='Stable' ORDER BY published_at DESC,id DESC LIMIT 1",[id])).rows[0];
      }
    }else if(action&&action!=='preview'){
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
      const channel=data.channel||'Stable';
      if(!['Stable','Beta'].includes(channel))throw bad(400,'Choose a release channel.');
      const release={version,url:url.href,size:data.size,notes,filename,channel};
      if(action==='preview')preview=await releaseView(client,project,release);
      else{
        const existing=(await client.query('SELECT * FROM project_releases WHERE project_id=$1 AND version=$2',[id,version])).rows[0];
        if(existing){if(existing.url!==url.href||existing.notes!==notes)throw bad(409,'That version already exists. Choose another version.');}
        else chosen=(await client.query('INSERT INTO project_releases(project_id,version,url,filename,size,notes,channel) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,channel',[id,version,url.href,filename,data.size,notes,channel])).rows[0];
      }
    }
    if(chosen&&chosen.channel!=='Beta'){
      await client.query('UPDATE project_releases SET is_latest=false WHERE project_id=$1 AND is_latest',[id]);
      await client.query(`UPDATE project_releases SET is_latest=true,channel='Stable',revision=revision+1 WHERE id=$1`,[chosen.id]);
    }
    if(before){
      const after=await snapshot(client,id);
      if(JSON.stringify(before)!==JSON.stringify(after))await client.query('INSERT INTO release_activity(project_id,action,before_state,after_state) VALUES($1,$2,$3,$4)',[id,req.method==='DELETE'?'Deleted '+before.find(r=>r.id===action)?.version:changing?'Edited '+after.find(r=>r.id===action)?.version:action?'Promoted '+after.find(r=>r.id===action)?.version:'Published '+after.find(r=>!before.some(b=>b.id===r.id))?.version,JSON.stringify(before),JSON.stringify(after)]);
    }
    await client.query('COMMIT');
    send(res,200,preview?{html:preview}:{ok:true,published:project.published});
  }catch(e){await client.query('ROLLBACK');if(e.code==='23505')throw bad(409,'That version already exists in this project.');throw e;}finally{client.release();}
  return true;
}
