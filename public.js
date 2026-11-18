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
  const list=projects.filter(p=>(category==='All'||category===p.category)&&(!onlySaved||saved.has(String(p.id)))&&(!availability||p[availability])&&(p.title+' '+p.summary+' '+p.category).toLowerCase().includes(query));
  if($('sortBy').value==='title')list.sort((a,b)=>a.title.localeCompare(b.title));
  if($('sortBy').value==='latest')list.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  $('projectGrid').innerHTML=list.map(p=>{
    const selected=saved.has(String(p.id));
    return '<article class="card project-card"><a href="#project-'+p.id+'" aria-label="Open '+esc(p.title)+'"><img class="art" loading="lazy" alt="" src="'+esc(image(p))+'"></a><button class="fav" data-save="'+p.id+'" aria-label="Save '+esc(p.title)+'" aria-pressed="'+selected+'">'+(selected?'♥':'♡')+'</button><div class="project-body"><div class="tag">'+esc(p.category)+(p.version?' · '+esc(p.version):'')+'</div><h3>'+esc(p.title)+'</h3><p>'+esc(p.summary)+'</p><a class="textlink" href="#project-'+p.id+'">Open project ↗</a></div></article>';
  }).join('')||'<p class="empty">'+(onlySaved?'Your saved projects appear here. Use the heart on a project to save it on this device.':'No matching projects. Try another filter.')+'</p>';
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
function openProject(){
  const modal=$('modal'),id=location.hash.match(/^#project-(\d+)$/)?.[1];
  const p=projects.find(x=>String(x.id)===id);
  if(!p){if(modal.open)modal.close();return;}
  const links=[['Download APK ↓',p.apk_url],['Live demo ↗',p.demo_url],['Watch video ↗',p.video_url]].filter(([,url])=>url);
  const pictures=p.screenshots||[];
  $('detail').innerHTML='<span class="tag">'+esc(p.category)+' '+esc(p.version)+'</span><h2 id="detailTitle">'+esc(p.title)+'</h2><p>'+esc(p.description||p.summary)+'</p><div class="actions">'+links.map(([t,url])=>'<a class="cta" target="_blank" rel="noopener" href="'+esc(url)+'">'+t+'</a>').join('')+'</div>'+(pictures.length?'<h3>Screenshots</h3><div class="gallery" tabindex="0" aria-label="Project screenshots">'+pictures.map((url,i)=>'<img src="'+esc(url)+'" alt="'+esc(p.title)+' screenshot '+(i+1)+'">').join('')+'</div>':'')+(p.release_notes?'<h3>Release notes</h3><p>'+esc(p.release_notes)+'</p>':'');
  if(!modal.open)modal.showModal();
}
function closeProject(){history.replaceState(null,'','#projects');$('modal').close();}
$('close').onclick=closeProject;$('modal').oncancel=e=>{e.preventDefault();closeProject();};
window.addEventListener('hashchange',openProject);
render();
fetch('/api/projects').then(r=>{if(!r.ok)throw Error();return r.json();}).then(rows=>{
  projects=rows;loaded=true;render();openProject();
  const lead=projects.find(p=>p.featured)||projects[0];
  if(lead){$('spotLink').href='#project-'+lead.id;$('spotTitle').textContent=lead.title;}
}).catch(()=>{$('projectGrid').textContent='The project collection could not load. Refresh to try again.';});
document.getElementById('enquiry').onsubmit=async e=>{e.preventDefault();const f=e.target,s=document.getElementById('formStatus');s.textContent='Sending...';try{const r=await fetch('/api/enquiries',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});const data=await r.json();if(!r.ok)throw Error(data.error||'Unable to send');s.textContent='Thank you! Your enquiry has been received.';f.reset()}catch(err){s.textContent=err.message+' You can also use the contact email.'}};

fetch('/api/studio').then(r=>r.ok?r.json():{}).then(data=>{
  if(data.headline) headline.textContent=data.headline;
  if(data.intro) intro.textContent=data.intro;
  if(data.email){contactEmail.href='mailto:'+data.email;contactEmail.textContent=data.email;}
}).catch(()=>{});
