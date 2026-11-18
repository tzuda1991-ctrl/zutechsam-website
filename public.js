const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const covers={Apps:'studio',AI:'AI',Games:'Games',Websites:'Websites',Software:'Websites'};
let projects=[],category='All',onlySaved=false,saved=new Set(),loaded=false;
try{saved=new Set(JSON.parse(localStorage.getItem('zu-saved')||'[]').map(String));}catch{}
function image(project){return project.image_url||'/'+(covers[project.category]||'studio')+'.webp';}
function render(){
  $('savedCount').textContent=projects.filter(p=>saved.has(String(p.id))).length;
  $('savedOnly').setAttribute('aria-pressed',onlySaved);
  $('filters').innerHTML=['All','Apps','Games','AI','Websites','Software'].map(c=>'<button class="filter '+(category===c?'active':'')+'" aria-pressed="'+(category===c)+'" data-category="'+c+'">'+c+'</button>').join('');
  if(!loaded)return;
  const query=$('search').value.trim().toLowerCase(),availability=$('availability').value;
  const list=projects.filter(p=>(category==='All'||category===p.category)&&(!onlySaved||saved.has(String(p.id)))&&(!availability||(availability==='files'?p.attachments?.length:p[availability]))&&(p.title+' '+p.summary+' '+p.category).toLowerCase().includes(query));
  if($('sortBy').value==='title')list.sort((a,b)=>a.title.localeCompare(b.title));
  if($('sortBy').value==='latest')list.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  $('projectGrid').innerHTML=list.map(p=>{
    const selected=saved.has(String(p.id));
    return '<article class="card project-card"><a href="/projects/'+p.id+'" aria-label="Open '+esc(p.title)+'"><img class="art" loading="lazy" alt="" src="'+esc(image(p))+'"></a><button class="fav" data-save="'+p.id+'" aria-label="Save '+esc(p.title)+'" aria-pressed="'+selected+'"><svg aria-hidden="true" class="glyph"><use href="/icons.svg#bookmark"></use></svg></button><div class="project-body"><div class="tag">'+esc(p.category)+(p.version?' · '+esc(p.version):'')+'</div><h3>'+esc(p.title)+'</h3><p>'+esc(p.summary)+'</p><a class="textlink" href="/projects/'+p.id+'">Open project <svg aria-hidden="true" class="glyph"><use href="/icons.svg#external"></use></svg></a></div></article>';
  }).join('')||'<p class="empty">'+(onlySaved?'Your saved projects appear here. Use the bookmark on a project to save it on this device.':'No matching projects. Try another filter.')+'</p>';
}
$('projectGrid').onclick=e=>{
  const id=e.target.closest('[data-save]')?.dataset.save;if(!id)return;
  if(saved.has(id))saved.delete(id);else saved.add(id);
  try{localStorage.setItem('zu-saved',JSON.stringify([...saved]));}catch{}
  render();$('projectGrid').querySelector('[data-save="'+id+'"]')?.focus();
};
$('savedOnly').onclick=()=>{onlySaved=!onlySaved;render();};
$('filters').onclick=e=>{if(e.target.dataset.category){category=e.target.dataset.category;render();}};
for(const id of ['search','sortBy','availability'])$(id).oninput=render;
function followOldLink(){
  const id=location.hash.match(/^#project-(\d+)$/)?.[1];
  if(id)location.replace('/projects/'+id);
}
followOldLink();window.addEventListener('hashchange',followOldLink);
render();
fetch('/api/projects').then(r=>{if(!r.ok)throw Error();return r.json();}).then(rows=>{
  projects=rows;loaded=true;render();
  const lead=projects.find(p=>p.featured&&p.apk_url)||projects.find(p=>p.apk_url)||projects.find(p=>p.featured)||projects[0];
  if(lead){
    const page='/projects/'+lead.id;
    $('spotTitle').textContent=lead.title;
    $('spotLink').href=page;
    $('spotLabel').textContent=lead.apk_url?'Android release'+(lead.version?' · v'+String(lead.version).replace(/^v/i,''):''):'Featured project';
    $('spotImage').src=image(lead);
    $('spotAction').href=lead.apk_url?(lead.latest_release_id?page+'/releases/'+lead.latest_release_id+'/download':lead.apk_url):page;
    $('spotButton').textContent=lead.apk_url?'Download APK':'Open project';
    $('spotIcon').setAttribute('href',lead.apk_url?'/icons.svg#download':'/icons.svg#arrow');
    $('spotLink').hidden=!lead.apk_url;
    $('spotlight').hidden=false;
  }
}).catch(()=>{$('projectGrid').textContent='The project collection could not load. Refresh to try again.';});
document.getElementById('enquiry').onsubmit=async e=>{e.preventDefault();const f=e.target,s=document.getElementById('formStatus');s.textContent='Sending...';try{const r=await fetch('/api/enquiries',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});const data=await r.json();if(!r.ok)throw Error(data.error||'Unable to send');s.textContent='Thank you! Your enquiry has been received.';f.reset()}catch(err){s.textContent=err.message+' You can also use the contact email.'}};

fetch('/api/studio').then(r=>r.ok?r.json():{}).then(data=>{
  if(data.headline) headline.textContent=data.headline;
  if(data.intro) intro.textContent=data.intro;
  if(data.email){contactEmail.href='mailto:'+data.email;contactEmail.textContent=data.email;}
}).catch(()=>{});
