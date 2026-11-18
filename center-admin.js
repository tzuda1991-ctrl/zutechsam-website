(()=>{
  const dialog=$('centerDialog'),content=$('centerContent'),status=$('centerStatus');
  async function load(){
    const {reports,visits,activity}=await api('/api/admin/center');
    content.innerHTML='<h3>Version bug reports</h3>'+ (reports.map(r=>'<article class="file-item"><b>'+esc(r.title)+' · '+esc(r.version)+'</b><small>'+esc(new Date(r.created_at).toLocaleString())+' · '+(r.resolved?'Resolved':'Open')+'</small><p>'+esc(r.message)+'</p>'+(r.image?'<button data-shot="'+r.id+'">View screenshot</button>':'')+'<button class="alt" data-report="'+r.id+'" data-resolved="'+!r.resolved+'">'+(r.resolved?'Reopen':'Mark resolved')+'</button></article>').join('')||'<p>No reports yet.</p>')+
      '<h3>Campaign visits</h3>'+(visits.map(v=>'<p>'+esc(v.title)+' · '+esc(v.source)+' · '+esc(v.visits)+' visits</p>').join('')||'<p>Share a project’s YouTube link or QR code to start counting visits.</p>')+
      '<h3>Release history</h3>'+(activity.map(a=>'<article class="file-item"><b>'+esc(a.title)+' · '+esc(a.action)+'</b><small>'+esc(new Date(a.created_at).toLocaleString())+'</small>'+(a.undone?'Undone':'<button class="alt" data-undo="'+a.id+'">Undo release change</button>')+'</article>').join('')||'<p>New release changes will appear here.</p>');
  }
  $('centerButton').onclick=async()=>{dialog.showModal();status.textContent='Loading…';content.replaceChildren();try{await load();status.textContent='';}catch(e){status.textContent=e.message;}};
  $('centerClose').onclick=()=>dialog.close();
  content.onclick=async e=>{
    const btn=e.target.closest('button');if(!btn)return;
    const {shot,report,resolved,undo}=btn.dataset;
    if(undo&&!confirm('Restore the release list to its state before this change?'))return;
    btn.disabled=true;
    try{
      if(shot){const data=await api('/api/admin/reports/'+shot);const img=document.createElement('img');img.alt='Submitted bug screenshot';img.style.maxWidth='100%';img.src=data.screenshot;btn.replaceWith(img);return;}
      if(report)await api('/api/admin/reports/'+report,'PATCH',{resolved:resolved==='true'});
      if(undo){await api('/api/admin/activity/'+undo+'/undo','POST',{});projects=await api('/api/admin/projects');render();}
      await load();status.textContent=undo?'Release change undone.':'Report updated.';
    }catch(err){status.textContent=err.message;btn.disabled=false;}
  };
})();
