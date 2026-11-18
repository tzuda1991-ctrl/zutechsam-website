const $ = id => document.getElementById(id);
const form = $('projectForm');
let token = sessionStorage.getItem('zutechsam_admin_token') || '';
let projects = [], enquiries = [], editing = null, uploading = false;
let limits = {apkMB:1024,imageMB:100};
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function signedIn(on){
  $('desk').hidden=!on;
  $('loginPanel').hidden=on;
}
async function api(url, method='GET', data){
  const binary=data instanceof Blob;
  const response=await fetch(url,{method,headers:{authorization:'Bearer '+token,'content-type':binary?'application/octet-stream':'application/json'},body:binary?data:JSON.stringify(data)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok){
    if(response.status===401 && url!=='/api/login'){sessionStorage.removeItem('zutechsam_admin_token');token='';signedIn(false);}
    throw Object.assign(new Error(result.error || 'Request failed ('+response.status+')'),{status:response.status});
  }
  return result;
}
function navigate(){
  const route=location.hash.slice(1);
  const section=['overview','projects','editor','enquiries','settings'].includes(route)?route:'overview';
  document.querySelectorAll('#desk main section').forEach(el=>el.hidden=el.id!==section);
  document.querySelectorAll('nav a').forEach(el=>el.classList.toggle('active',el.hash==='#'+section));
}
window.onhashchange=navigate;
function clearEditor(){
  editing=null;form.reset();$('editorTitle').textContent='Add project';$('projectMsg').textContent='';
  $('progress').hidden=true;$('uploadStatus').textContent='';
}
const coverFor=p=>p.image_url||({Games:'/Games.webp',AI:'/AI.webp',Websites:'/Websites.webp',Software:'/Websites.webp'}[p.category]||'/studio.webp');
function projectRow(p){
  return '<div class="row project-row"><img alt="" class="thumb" src="'+esc(coverFor(p))+'"><div><strong>'+esc(p.title)+'</strong><div class="small">'+esc(p.category)+' · '+(p.published?'Published':'Draft')+(p.featured?' · Featured':'')+'</div></div><div><button class="alt" data-edit="'+p.id+'">Edit</button><button class="alt" data-copy="'+p.id+'">Duplicate</button><button class="danger" data-remove="'+p.id+'">Delete</button></div></div>';
}
function render(){
  renderWeek();
  const metrics=[['Total projects',projects.length],['Published',projects.filter(p=>p.published).length],['Drafts',projects.filter(p=>!p.published).length],['New enquiries',enquiries.filter(e=>e.status==='new').length]];
  $('metrics').innerHTML=metrics.map(([title,n])=>'<div class="metric"><strong>'+n+'</strong>'+title+'</div>').join('');
  $('recent').innerHTML=projects.slice(0,4).map(projectRow).join('')||'<p>No projects yet.</p>';
  const status=$('pub').value;
  $('list').innerHTML=projects.filter(p=>(p.title+' '+p.category).toLowerCase().includes($('search').value.toLowerCase()) && (status==='All projects'||(status==='Published'&&p.published)||(status==='Draft'&&!p.published)||(status==='Featured'&&p.featured))).map(projectRow).join('')||'<p>No matching projects.</p>';
  $('inbox').innerHTML=enquiries.filter(e=>(e.name+' '+e.email+' '+e.message+' '+e.service).toLowerCase().includes($('findMail').value.toLowerCase()) && ($('mailStatus').value==='All enquiries'||e.status===$('mailStatus').value)).map(e=>'<article class="row"><div><strong>'+esc(e.name)+'</strong> · '+esc(e.service)+'<div class="small">'+esc(e.email)+' · '+new Date(e.created_at).toLocaleDateString()+'</div><p>'+esc(e.message)+'</p></div><select aria-label="Enquiry status" data-id="'+e.id+'">'+['new','contacted','closed'].map(status=>'<option '+(status===e.status?'selected':'')+'>'+status+'</option>').join('')+'</select></article>').join('')||'<p>No matching enquiries.</p>';
}
async function load(){
  const [p,e,settings,config]=await Promise.all([api('/api/admin/projects'),api('/api/admin/enquiries'),api('/api/studio'),api('/api/admin/uploads')]);
  projects=p;enquiries=e;limits=config;$('apkLimit').textContent=config.apkMB;
  for(const key of ['headline','intro','email']) $('settingsForm').elements[key].value=settings[key]||'';
  render();navigate();signedIn(true);
}
$('login').onsubmit=async event=>{
  event.preventDefault();
  try{const result=await api('/api/login','POST',Object.fromEntries(new FormData(event.target)));token=result.token;sessionStorage.setItem('zutechsam_admin_token',token);await load();event.target.reset();}
  catch(error){$('loginMsg').textContent=error.message;}
};
$('logout').onclick=async()=>{try{await api('/api/logout','POST');}finally{token='';sessionStorage.removeItem('zutechsam_admin_token');location.reload();}};
$('newProject').onclick=()=>{if(!uploading) clearEditor();};
$('cancel').onclick=()=>{clearEditor();location.hash='projects';};
for(const id of ['search','findMail','mailStatus','pub']) $(id).oninput=render;
async function projectAction(event){
  const {edit,remove,copy}=event.target.dataset;
  if(uploading||(!edit&&!remove&&!copy)) return;
  const project=projects.find(p=>String(p.id)===(edit||remove||copy));
  if(edit||copy){
    clearEditor();editing=edit||null;
    for(const key of ['title','category','version','summary','description','release_notes','image_url','demo_url','apk_url','video_url']) form.elements[key].value=project[key]||'';
    for(const key of ['featured','published']) form.elements[key].checked=project[key];
    form.elements.screenshots.value=(project.screenshots||[]).join('\n');
    if(copy){form.elements.title.value=(project.title+' (copy)').slice(0,150);form.elements.published.checked=false;form.elements.featured.checked=false;}
    $('editorTitle').textContent=copy?'Duplicate as draft':'Edit project';location.hash='editor';
  }else if(confirm('Delete '+project.title+'?')){
    try{await api('/api/admin/projects/'+remove,'DELETE');await load();$('notice').textContent='Project deleted.';}catch(error){$('notice').textContent=error.message;}
  }
}
$('recent').onclick=$('list').onclick=projectAction;
$('inbox').onchange=async({target})=>{
  const enquiry=enquiries.find(e=>String(e.id)===target.dataset.id);
  if(!enquiry)return;
  try{await api('/api/admin/enquiries/'+enquiry.id,'PATCH',{status:target.value});enquiry.status=target.value;render();}
  catch(error){target.value=enquiry.status;$('notice').textContent=error.message;}
};
form.onsubmit=async event=>{
  event.preventDefault();if(uploading)return;
  const data=Object.fromEntries(new FormData(form));
  data.screenshots=screenshotUrls();
  for(const key of ['featured','published'])data[key]=form.elements[key].checked;
  const submit=form.querySelector('button:not([type])');submit.disabled=true;
  try{await api('/api/admin/projects'+(editing?'/'+editing:''),editing?'PUT':'POST',data);clearEditor();location.hash='projects';$('notice').textContent='Project saved.';await load();}
  catch(error){$('notice').textContent=$('projectMsg').textContent=error.message;}
  finally{submit.disabled=false;}
};
$('settingsForm').onsubmit=async event=>{
  event.preventDefault();try{await api('/api/admin/studio','PUT',Object.fromEntries(new FormData(event.target)));$('notice').textContent='Website settings saved.';}catch(error){$('notice').textContent=error.message;}
};
for(const button of form.querySelectorAll('[data-upload]'))button.onclick=async()=>{
  if(uploading)return;
  const file=$(button.dataset.upload).files[0],status=$('uploadStatus');
  if(!file){status.textContent='Choose a file first.';return;}
  if(button.dataset.target==='screenshots' && screenshotUrls().length>=6){status.textContent='The gallery already contains six images.';return;}
  const max=button.dataset.target==='apk_url'?limits.apkMB:limits.imageMB;
  if(file.size>max*1024**2){status.textContent='Maximum size is '+max+' MB.';return;}
  uploading=true;
  form.querySelectorAll('button,input[type=file]').forEach(el=>el.disabled=true);
  $('progress').hidden=false;$('progress').value=0;status.textContent='Starting upload…';
  try{
    const {id,chunkSize}=await api('/api/admin/uploads','POST',{filename:file.name,size:file.size});
    let offset=0;
    while(offset<file.size){
      const part=file.slice(offset,offset+chunkSize);
      let result;
      for(let attempt=0;attempt<3;attempt++){
        try{result=await api('/api/admin/uploads/'+id+'?size='+file.size+'&offset='+offset,'PUT',part);break;}
        catch(error){if(attempt===2 || (error.status<500 && error.status!==409))throw error;await new Promise(resolve=>setTimeout(resolve,800*(attempt+1)));}
      }
      if(result.offset<=offset)throw Error('Upload interrupted. Please retry.');
      offset=result.offset;$('progress').value=Math.round(offset/file.size*100);status.textContent='Uploading '+file.name+' · '+$('progress').value+'%';
      if(result.url){const url=new URL(result.url,location.origin).href;form.elements[button.dataset.target].value=button.dataset.target==='screenshots'?[...screenshotUrls(),url].join('\n'):url;}
    }
    status.textContent='Upload complete. Save the project to attach this file.';
  }catch(error){status.textContent=error.message;}
  finally{uploading=false;form.querySelectorAll('button,input[type=file]').forEach(el=>el.disabled=false);}
};
navigate();
if(token)load().catch(error=>{$('loginMsg').textContent=error.message;});

function screenshotUrls(){return form.elements.screenshots.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);}
function renderWeek(){
  const days=Array.from({length:7},(_,i)=>{const day=new Date();day.setDate(day.getDate()-6+i);return {day,count:0};});
  for(const enquiry of enquiries){const item=days.find(d=>d.day.toDateString()===new Date(enquiry.created_at).toDateString());if(item)item.count++;}
  const max=Math.max(1,...days.map(d=>d.count));
  $('week').innerHTML=days.map(d=>'<div><b>'+d.count+'</b><i style="height:'+Math.round(d.count/max*48+2)+'px"></i><small>'+d.day.toLocaleDateString(undefined,{weekday:'short'})+'</small></div>').join('');
}
$('quickNew').onclick=()=>{if(!uploading)clearEditor();};
$('previewRelease').onclick=()=>{
  const fields=form.elements;
  const cover=/^https:\/\//i.test(fields.image_url.value)?fields.image_url.value:coverFor({category:fields.category.value});
  $('releasePreview').innerHTML='<img class="previewHero" alt="" src="'+esc(cover)+'"><small>'+esc(fields.category.value)+' · '+esc(fields.version.value)+'</small><h2>'+esc(fields.title.value||'Untitled project')+'</h2><p>'+esc(fields.description.value||fields.summary.value)+'</p>'+screenshotUrls().filter(url=>/^https:\/\//i.test(url)).map(url=>'<img class="previewThumb" alt="Gallery preview" src="'+esc(url)+'">').join('')+(fields.release_notes.value?'<h3>Release notes</h3><p>'+esc(fields.release_notes.value)+'</p>':'');
  $('releaseDialog').showModal();
};
$('closePreview').onclick=()=>$('releaseDialog').close();
