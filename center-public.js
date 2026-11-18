(()=>{
  document.querySelectorAll('[data-compare]').forEach(select=>{
    const show=()=>{
      const source=document.getElementById('release-'+select.value),target=select.nextElementSibling;
      target.replaceChildren();
      if(!source)return;
      for(const el of source.querySelectorAll('strong, small, p, dl'))target.append(el.cloneNode(true));
    };
    select.onchange=show;show();
  });
  const link=document.getElementById('campaignLink');
  link.value=location.origin+location.pathname.replace(/\/$/,'')+'/youtube';
  document.getElementById('copyCampaign').onclick=async e=>{
    try{await navigator.clipboard.writeText(link.value);e.target.textContent='Copied';}catch{link.select();}
  };
  async function screenshot(file){
    const img=await createImageBitmap(file);
    try{
      const scale=Math.min(1,850/Math.max(img.width,img.height)),canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
      for(const quality of [.75,.5,.3,.15]){const url=canvas.toDataURL('image/jpeg',quality);if(url.length<=85000)return url;}
      throw Error('Crop this screenshot and try again.');
    }finally{img.close();}
  }
  const form=document.getElementById('reportForm');
  if(form)form.onsubmit=async e=>{
    e.preventDefault();const status=form.querySelector('[role=status]'),button=form.querySelector('button');button.disabled=true;status.textContent='Sending…';
    try{
      const fields=form.elements,file=fields.image.files[0],payload={release:fields.release.value,message:fields.message.value};
      if(file)payload.screenshot=await screenshot(file);
      const response=await fetch(location.pathname.replace(/\/$/,'')+'/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data=await response.json();if(!response.ok)throw Error(data.error||'Could not send report.');
      form.reset();status.textContent='Report #'+data.id+' sent to the studio.';
    }catch(err){status.textContent=err.message;}finally{button.disabled=false;}
  };
})();
