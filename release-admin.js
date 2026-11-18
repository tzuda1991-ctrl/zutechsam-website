(()=>{
  let project, draft, working=false, ready=false, inventory=[];
  const desk=$('versionDesk'),status=$('versionStatus'),fileInput=$('versionFile');
  const mib=n=>(Number(n)/1048576).toFixed(1)+' MiB';
  const draftKey=()=> 'zu-release-'+project.id;
  function persist(){try{localStorage.setItem(draftKey(),JSON.stringify(draft));}catch{}}
  function getDraft(){try{return JSON.parse(localStorage.getItem(draftKey()))||{};}catch{return {};}}
  function invalidate(){ready=false;$('previewBox').hidden=true;$('versionFrame').removeAttribute('srcdoc');}
  function lock(on){
    working=on;
    for(const id of ['versionFile','versionTag','versionNotes','previewVersion','publishVersion','retryVersion','exitVersion'])$(id).disabled=on;
  }
  function reset(){
    draft={};persist();$('versionForm').reset();$('versionProgress').value=0;$('retryVersion').hidden=true;invalidate();
  }
  async function space(){
    const data=await api('/api/admin/space');
    $('releaseSpace').textContent=mib(data.free)+' available on the upload volume · '+limits.apkMB+' MiB maximum per APK.';
  }
  async function list(){
    const rows=await api('/api/admin/projects/'+project.id+'/releases');
    $('versionList').innerHTML=rows.map(r=>'<div class="file-item"><b>'+esc(r.version)+(r.is_latest?' · Latest':'')+'</b><small>'+esc(r.filename)+' · '+mib(r.size)+' · '+esc(new Date(r.published_at).toLocaleDateString())+' · '+esc(r.download_clicks)+' download clicks</small>'+(r.is_latest?'':'<button class="alt" data-promote="'+r.id+'">Make latest</button>')+'</div>').join('')||'No versioned releases yet.';
  }
  async function openDesk(id){
    if(working||uploading)return;
    project=projects.find(p=>String(p.id)===id);if(!project)return;
    draft=getDraft();invalidate();$('versionList').textContent='Loading…';$('versionTitle').textContent='Add release · '+project.title;
    $('versionTag').value=draft.version||'';$('versionNotes').value=draft.notes||'';fileInput.value='';$('retryVersion').hidden=true;
    $('versionProgress').value=draft.url?100:0;
    status.textContent=draft.url?'Attached: '+draft.filename+' · '+mib(draft.size):draft.id?'Select the same APK to resume its upload.':'Choose an APK to start.';
    desk.showModal();lock(true);
    try{await Promise.all([space(),list()]);}catch(e){status.textContent=e.message;}finally{lock(false);}
  }
  for(const id of ['recent','list'])$(id).addEventListener('click',e=>{const key=e.target.dataset.release;if(key)openDesk(key);});
  $('exitVersion').onclick=()=>desk.close();desk.oncancel=e=>{if(working)e.preventDefault();};
  for(const id of ['versionTag','versionNotes'])$(id).oninput=()=>{draft.version=$('versionTag').value;draft.notes=$('versionNotes').value;persist();invalidate();};

  // Bounded-memory content fingerprint prevents mixing bytes from different APKs on resume.
  async function fingerprint(file){
    const parts=[];
    for(let i=0;i<file.size;i+=4*1048576){
      const buf=await file.slice(i,i+4*1048576).arrayBuffer();
      parts.push(new Uint8Array(await crypto.subtle.digest('SHA-256',buf)));
    }
    const joined=new Uint8Array(parts.length*32);parts.forEach((part,i)=>joined.set(part,i*32));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',joined)),n=>n.toString(16).padStart(2,'0')).join('');
  }
  async function upload(){
    const file=fileInput.files[0];if(!file||working)return;
    invalidate();lock(true);$('retryVersion').hidden=true;let complete=false;
    try{
      if(!file.name.toLowerCase().endsWith('.apk')||file.size<16||file.size>limits.apkMB*1048576)throw Error('Choose an APK of up to '+limits.apkMB+' MiB.');
      status.textContent='Checking '+file.name+' · '+mib(file.size);
      const hash=await fingerprint(file);
      let position=null;
      if(draft.id&&draft.hash===hash){
        try{position=await api('/api/admin/uploads/'+draft.id+'?size='+file.size);}catch(e){if(e.status!==404)throw e;}
      }
      if(!position){
        const created=await api('/api/admin/uploads','POST',{filename:file.name,size:file.size});
        Object.assign(draft,{...created,filename:file.name,size:file.size,hash,url:null});persist();position={offset:0};
      }
      while(position.offset<file.size){
        $('versionProgress').value=100*position.offset/file.size;
        status.textContent=file.name+' · '+mib(position.offset)+' of '+mib(file.size);
        const offset=position.offset;
        for(let attempt=0;;attempt++){
          try{position=await api('/api/admin/uploads/'+draft.id+'?size='+file.size+'&offset='+offset,'PUT',file.slice(offset,offset+draft.chunkSize));break;}
          catch(e){if(attempt===2||(e.status<500&&e.status!==409))throw e;await new Promise(r=>setTimeout(r,600*(attempt+1)));}
        }
        if(position.offset<=offset)throw Error('Upload paused. Retry to continue.');
      }
      if(!position.url)throw Error('Upload is incomplete.');
      draft.url=new URL(position.url,location.origin).href;persist();complete=true;
      $('versionProgress').value=100;status.textContent='Attached: '+draft.filename+' · '+mib(draft.size);
      await space();
    }catch(e){status.textContent=e.message;$('retryVersion').hidden=complete;}finally{lock(false);}
  }
  fileInput.onchange=upload;$('retryVersion').onclick=upload;
  const endpoint=()=>'/api/admin/projects/'+project.id+'/releases';
  $('versionForm').onsubmit=async e=>{
    e.preventDefault();if(working)return;
    if(!draft.url||!$('retryVersion').hidden){status.textContent='Finish the selected upload first.';return;}
    draft.version=$('versionTag').value.trim();draft.notes=$('versionNotes').value.trim();persist();lock(true);
    try{
      const preview=await api(endpoint()+'/preview','POST',draft);
      $('versionFrame').srcdoc=preview.html;$('previewBox').hidden=false;ready=true;
      status.textContent=project.published?'Preview ready. Publish to update this project page.':'This project is a draft. Its releases become visible when you publish the project.';
    }catch(error){invalidate();status.textContent=error.message;}finally{lock(false);}
  };
  $('publishVersion').onclick=async()=>{
    if(!ready||working)return;lock(true);
    try{const result=await api(endpoint(),'POST',draft);reset();await list();status.textContent=result.published?'Published on the existing project page.':'Release saved to draft project.';}
    catch(error){status.textContent=error.message;}finally{lock(false);}
  };
  $('versionList').onclick=async e=>{
    const id=e.target.dataset.promote;if(!id||working)return;lock(true);
    try{await api(endpoint()+'/'+id,'POST',{});await list();status.textContent='Latest release updated.';}
    catch(error){status.textContent=error.message;}finally{lock(false);}
  };

  function renderFiles(){
    const filter=$('fileView').value;
    $('fileRows').innerHTML=inventory.filter(f=>filter==='all'||((filter==='used')===!!f.projects.length)).map(f=>'<div class="file-item"><b>'+esc(f.label)+'</b><small>'+mib(f.size)+' · '+esc(f.projects.join(', ')||'Unattached')+'</small></div>').join('')||'No matching uploads.';
  }
  $('storageButton').onclick=async()=>{
    $('filesDesk').showModal();$('spaceLine').textContent='Checking storage…';$('fileRows').textContent='';
    try{const result=await api('/api/admin/files');inventory=result.files;$('spaceLine').textContent=mib(result.free)+' free of '+mib(result.total);renderFiles();}
    catch(e){$('spaceLine').textContent=e.message;}
  };
  $('exitFiles').onclick=()=>$('filesDesk').close();$('fileView').onchange=renderFiles;
})();
