let projects=[],category='All';const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const filters=document.getElementById('filters'),grid=document.getElementById('projectGrid');
function render(){filters.innerHTML=['All','Apps','Games','AI','Websites','Software'].map(c=>'<button class="filter '+(category===c?'active':'')+'" data-category="'+c+'">'+c+'</button>').join('');const q=document.getElementById('search').value.toLowerCase();const items=projects.filter(p=>(category==='All'||p.category===category)&&(!availability.value||p[availability.value])&&(p.title+' '+p.summary).toLowerCase().includes(q));grid.innerHTML=items.length?items.map(p=>'<article class="card project-card">'+art(p)+'<div class="tag">'+esc(p.category)+(p.version?' · '+esc(p.version):'')+'</div><h3>'+esc(p.title)+'</h3><p>'+esc(p.summary)+'</p><button class="cta" data-id="'+p.id+'">View Project →</button></article>').join(''):'<div class="empty">No matching projects. Try another category or search.</div>'}
filters.onclick=e=>{if(e.target.dataset.category){category=e.target.dataset.category;render()}};document.getElementById('search').oninput=render;
grid.onclick=e=>{const id=e.target.dataset.id;if(id)location.hash='project-'+id;};
function openProject(){const id=location.hash.match(/^#project-(\d+)$/)?.[1];if(!id){if(modal.open)modal.close();return;}const p=projects.find(x=>String(x.id)===id);if(!p)return;const links=[['Live Demo',p.demo_url],['Download APK',p.apk_url],['Watch Video',p.video_url]].filter(x=>x[1]).map(x=>'<a class="cta" href="'+esc(x[1])+'" target="_blank" rel="noopener noreferrer">'+x[0]+' ↗</a>').join(' ');document.getElementById('detail').innerHTML='<div class="tag">'+esc(p.category)+'</div><h2>'+esc(p.title)+'</h2><p>'+esc(p.description||p.summary)+'</p><div class="actions">'+links+'</div>';if(!modal.open)modal.showModal();}
function closeProject(){history.replaceState(null,'','#projects');modal.close();}
document.getElementById('close').onclick=closeProject;
modal.oncancel=e=>{e.preventDefault();closeProject();};
window.addEventListener('hashchange',openProject);
fetch('/api/projects').then(r=>{if(!r.ok)throw Error('Project database is not connected yet');return r.json()}).then(p=>{projects=p;render();openProject();
const featured=p.find(project=>project.featured)||p[0];
if(featured){
  spotTitle.textContent=featured.title;
  spotCategory.textContent=featured.category;
  spotArt.outerHTML=art(featured);
  spotLink.onclick=event=>{event.preventDefault();grid.onclick({target:{dataset:{id:String(featured.id)}}})};
}}).catch(e=>grid.innerHTML='<div class="empty">'+esc(e.message)+'</div>');render();
document.getElementById('enquiry').onsubmit=async e=>{e.preventDefault();const f=e.target,s=document.getElementById('formStatus');s.textContent='Sending...';try{const r=await fetch('/api/enquiries',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});const data=await r.json();if(!r.ok)throw Error(data.error||'Unable to send');s.textContent='Thank you! Your enquiry has been received.';f.reset()}catch(err){s.textContent=err.message+' You can also use the contact email.'}};

function art(project){
  const content=project.image_url ? '<img loading="lazy" alt="" src="'+esc(project.image_url)+'">' : '<i></i><i></i><i></i>';
  return '<div class="art" aria-hidden="true" data-cat="'+esc(project.category)+'">'+content+'</div>';
}
availability.onchange=render;
fetch('/api/studio').then(r=>r.ok?r.json():{}).then(data=>{
  if(data.headline) headline.textContent=data.headline;
  if(data.intro) intro.textContent=data.intro;
  if(data.email){contactEmail.href='mailto:'+data.email;contactEmail.textContent=data.email;}
}).catch(()=>{});
