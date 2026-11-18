import { releaseTools, packageInfo } from './project-tools.js';

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

const covers = {
  Apps: 'studio',
  AI: 'AI',
  Games: 'Games',
  Websites: 'Websites',
  Software: 'Websites',
};

const samples = {
  'ZUTECHSAM Android App': {
    name: 'Pocket checklist',
    description: 'Create a task, tap to complete it, and clear finished items.',
    html: '<form><input aria-label="New task" maxlength="80" placeholder="Add a task" required><button>Add</button></form><ul></ul><button id="clear">Clear completed</button>',
    script: `const list=document.querySelector('ul'),input=document.querySelector('input');document.querySelector('form').onsubmit=e=>{e.preventDefault();if(!input.value.trim())return;const item=document.createElement('li'),tick=document.createElement('input');tick.type='checkbox';const label=document.createElement('label');label.append(tick,' '+input.value.trim());item.append(label);list.append(item);input.value='';input.focus();};document.querySelector('#clear').onclick=()=>list.querySelectorAll('input:checked').forEach(c=>c.closest('li').remove());`,
  },
  'Arcade Game Concept': {
    name: 'Reaction timer',
    description: 'Start the round. Tap when the button turns green to see your reaction time.',
    html: '<button id="play">Start round</button><p role="status"></p>',
    script: `const btn=document.querySelector('#play'),out=document.querySelector('[role=status]');let phase='idle',timer,started;btn.onclick=()=>{if(phase==='idle'){phase='wait';out.textContent='Wait for green…';btn.textContent='Wait…';timer=setTimeout(()=>{phase='ready';started=performance.now();btn.style.background='#15734b';btn.textContent='Tap now!';},1000+Math.random()*2200);return;}clearTimeout(timer);out.textContent=phase==='ready'?Math.round(performance.now()-started)+' ms':'Too early. Try again.';phase='idle';btn.textContent='Play again';btn.style.background='';};`,
  },
  'AI Assistant Prototype': {
    name: 'Keyword explorer',
    description: 'Paste text to see its most frequent words. This browser demo uses word counts.',
    html: '<textarea aria-label="Text to analyse" placeholder="Paste a paragraph here"></textarea><button>Find keywords</button><p role="status"></p>',
    script: `document.querySelector('button').onclick=()=>{const words=document.querySelector('textarea').value.toLowerCase().match(/[\\p{L}\\p{M}]{2,}/gu)||[],counts=new Map();for(const w of words)counts.set(w,(counts.get(w)||0)+1);document.querySelector('[role=status]').textContent=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([w,n])=>w+' × '+n).join(' · ')||'Enter some text first.';};`,
  },
  'Business Website Design': {
    name: 'Brand palette preview',
    description: 'Choose a palette to preview a business landing page.',
    html: '<label>Palette <select><option value="#1D4ED8">Cobalt</option><option value="#0F766E">Pine</option><option value="#9A3412">Copper</option></select></label><article><small>FIELDWORK STUDIO</small><h2>Design for everyday life.</h2><p>Objects, interiors and visual identities.</p></article>',
    script: `const picker=document.querySelector('select'),card=document.querySelector('article');function paint(){card.style.background=picker.value;}picker.onchange=paint;paint();`,
  },
};

const previewIcons = `<svg xmlns="http://www.w3.org/2000/svg" hidden>
  <symbol id="icon-external" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 18 6M7 6h11v11"/></symbol>
  <symbol id="icon-download" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></symbol>
  <symbol id="icon-back" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12H4m6-6-6 6 6 6"/></symbol>
</svg>`;

export const sampleFor = (p) =>
  p.description?.startsWith('TEST PROJECT:') && Object.hasOwn(samples, p.title)
    ? samples[p.title]
    : null;

export function sampleHtml(sample) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(
    sample.name
  )}</title><style>*{box-sizing:border-box}body{margin:auto;padding:24px;max-width:660px;font:15px/1.6 system-ui,-apple-system,sans-serif;color:#0f172a;background:#f8fafc}h1,h2{line-height:1.15;letter-spacing:-0.02em}h1{margin:0 0 8px;font-size:1.5rem}p{color:#475569}button,input,select,textarea{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #cbd5e1;max-width:100%;background:#fff;color:#0f172a}button{background:#1d4ed8;border-color:#1d4ed8;color:#fff;font-weight:600;cursor:pointer}textarea{width:100%;display:block;margin-bottom:10px;min-height:96px}li{list-style:none;padding:6px 0}ul{padding:0}article{padding:18px;border-radius:10px;color:#fff;margin-top:12px}form{display:flex;flex-wrap:wrap;gap:8px}input:checked+span{text-decoration:line-through}</style></head><body><h1>${esc(
    sample.name
  )}</h1><p>${esc(sample.description)}</p>${sample.html}<script>${sample.script}</script></body></html>`;
}

function formatAttachmentUrl(rawUrl, filename) {
  try {
    const parsed = new URL(rawUrl, 'https://studio.invalid');
    if (/^\/media\/[a-f0-9]{40}\.(zip|aab|pdf)$/.test(parsed.pathname)) {
      parsed.searchParams.set('download', filename);
    }
    return rawUrl.startsWith('/') ? `${parsed.pathname}${parsed.search}` : parsed.href;
  } catch {
    return rawUrl;
  }
}

export function projectPage(p, releases = [], { preview = false } = {}) {
  const icon = (id) => (preview ? `#icon-${id}` : `/icons.svg#${id}`);

  const archive = releases.length
    ? `<h2>APK releases</h2><div class="release-list">${releases
        .map(
          (r) =>
            `<article class="version-entry" id="release-${esc(r.id || 'original')}">` +
            `<div class="version-head"><strong>${esc(r.version)}</strong><span class="meta-sep">·</span><span>${esc(
              r.channel || 'Stable'
            )}</span>${r.is_latest ? '<span class="meta-sep">·</span><span class="latest-mark">Latest</span>' : ''}</div>` +
            `<small class="mono">${[
              r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : '',
              r.size ? `${(Number(r.size) / 1048576).toFixed(1)} MiB` : '',
            ]
              .filter(Boolean)
              .join(' · ')}</small>` +
            (r.notes ? `<p>${esc(r.notes)}</p>` : '') +
            packageInfo(r) +
            `<div class="version-actions"><a class="textlink" href="${esc(
              r.download || r.url
            )}"><svg aria-hidden="true" class="glyph"><use href="${icon(
              'download'
            )}"></use></svg> Download APK</a>` +
            (r.id
              ? `<a class="release-permalink" href="/projects/${p.id}#release-${r.id}">Release link <svg aria-hidden="true" class="glyph"><use href="${icon(
                  'external'
                )}"></use></svg></a>`
              : '') +
            '</div></article>'
        )
        .join('')}</div>`
    : '';

  const sample = sampleFor(p);
  const image = p.image_url || `/${covers[p.category] || 'studio'}.webp`;

  const files = (p.attachments || []).map((f) => ({
    url: f.size ? formatAttachmentUrl(f.url, f.name) : f.url,
    name: f.name,
    detail: f.size ? `${(f.size / 1048576).toFixed(1)} MiB` : 'External file',
  }));
  if (p.apk_url) {
    files.unshift({ url: p.apk_url, name: 'Download Android APK', detail: 'Android package' });
  }
  if (sample) {
    files.push({
      url: `/projects/${p.id}/sample.html`,
      name: 'Download offline demo',
      detail: 'Standalone HTML · opens in a browser',
    });
  }

  const links = [
    ['Launch live demo', p.demo_url],
    ['Watch project video', p.video_url],
  ].filter(([, url]) => url);

  const gallery = (p.screenshots || [])
    .map(
      (url, i) =>
        `<a href="${esc(url)}" target="_blank" rel="noopener"><img loading="lazy" referrerpolicy="no-referrer" alt="Screenshot ${
          i + 1
        }" src="${esc(url)}"></a>`
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(
    p.title
  )} · ZUTECHSAM</title><link rel="icon" href="/brand.svg" type="image/svg+xml"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/public.css"></head><body class="agency detail-page">${
    preview ? previewIcons : ''
  }<header><div class="wrap nav"><a class="logo" href="/"><img class="brand-mark" src="/brand.svg" width="34" height="34" alt=""><span>ZUTECHSAM</span></a><nav class="navlinks"><a href="/#projects">Our work</a><a href="/#services">Services</a><a href="/#about">Approach</a><a href="/#contact">Contact</a></nav><a class="pill" href="/#projects"><svg aria-hidden="true" class="glyph"><use href="${icon(
    'back'
  )}"></use></svg> All projects</a></div></header><main class="release wrap"><div class="release-main"><figure class="release-cover-frame"><img class="release-cover" referrerpolicy="no-referrer" src="${esc(
    image
  )}" alt="${esc(p.title)} cover"></figure><div class="meta-line">${esc(p.category)} <span aria-hidden="true">·</span> ${
    p.version ? esc(p.version) : 'Project overview'
  }</div><h1>${esc(p.title)}</h1><p class="release-summary">${esc(
    p.summary
  )}</p><a class="cta release-jump" href="#downloads"><svg aria-hidden="true" class="glyph"><use href="${icon(
    'download'
  )}"></use></svg> Downloads &amp; links</a><h2>About the project</h2><p class="prose">${esc(
    sample ? sample.description : p.description || p.summary
  )}</p>${
    sample
      ? `<h2>Interactive sample</h2><iframe class="demo-frame" title="${esc(
          sample.name
        )}" src="/projects/${p.id}/demo" sandbox="allow-scripts"></iframe>`
      : ''
  }${archive}${releaseTools(p, releases, { preview })}${
    gallery ? `<h2>Screenshots</h2><div class="release-gallery">${gallery}</div>` : ''
  }${
    p.release_notes ? `<h2>Release notes</h2><p class="prose">${esc(p.release_notes)}</p>` : ''
  }</div><aside class="release-files" id="downloads"><h2>Downloads &amp; links</h2>${files
    .map(
      (f) =>
        `<a class="file-link" href="${esc(f.url)}"><strong><span>${esc(
          f.name
        )}</span><svg aria-hidden="true" class="glyph"><use href="${icon(
          'download'
        )}"></use></svg></strong><small class="mono">${esc(f.detail)}</small></a>`
    )
    .join('')}${links
    .map(
      ([name, url]) =>
        `<a class="file-link" href="${esc(
          url
        )}" target="_blank" rel="noopener"><strong><span>${esc(
          name
        )}</span><svg aria-hidden="true" class="glyph"><use href="${icon(
          'external'
        )}"></use></svg></strong><small>External link</small></a>`
    )
    .join('')}${
    !files.length && !links.length
      ? '<p class="empty-note">The studio has not attached a downloadable build yet.</p>'
      : ''
  }<a class="textlink side-cta" href="/#contact">Discuss a similar project <svg aria-hidden="true" class="glyph"><use href="${icon(
    'external'
  )}"></use></svg></a></aside></main></body></html>`;
}
