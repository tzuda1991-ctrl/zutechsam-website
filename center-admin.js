(() => {
  const dialog = $('centerDialog');
  const content = $('centerContent');
  const status = $('centerStatus');

  function downloadBars(daily) {
    const days = [];
    const lookup = new Map((daily || []).map((d) => [d.day, d.count]));
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      days.push({ label: iso.slice(5), count: lookup.get(iso) || 0 });
    }
    const max = Math.max(1, ...days.map((d) => d.count));
    return (
      '<div class="week week-14">' +
      days
        .map(
          (d) =>
            `<div><b>${d.count}</b><i style="height:${Math.round((d.count / max) * 48 + 3)}px"></i><small class="mono">${esc(
              d.label
            )}</small></div>`
        )
        .join('') +
      '</div>'
    );
  }

  async function load() {
    const { reports, visits, activity, downloadsDaily, topProjects } = await api('/api/admin/center');
    content.innerHTML =
      '<h3>Downloads (last 14 days)</h3>' +
      downloadBars(downloadsDaily) +
      '<h3>Top projects by downloads &amp; campaign visits</h3>' +
      ((topProjects || [])
        .map(
          (p) =>
            `<p class="mono">${esc(p.title)} · ${p.downloads} downloads · ${p.visits} campaign visits</p>`
        )
        .join('') || '<p>No project analytics yet.</p>') +
      '<h3>Version bug reports</h3>' +
      (reports
        .map(
          (r) =>
            `<article class="file-item"><b>${esc(r.title)} · ${esc(r.version)}</b>` +
            `<small class="mono">${esc(new Date(r.created_at).toLocaleString())} · ${
              r.resolved ? 'Resolved' : 'Open'
            }</small>` +
            `<p>${esc(r.message)}</p>` +
            `${r.image ? `<button type="button" data-shot="${r.id}">View screenshot</button>` : ''}` +
            `<button type="button" class="alt" data-report="${r.id}" data-resolved="${!r.resolved}">${
              r.resolved ? 'Reopen' : 'Mark resolved'
            }</button></article>`
        )
        .join('') || '<p>No reports yet.</p>') +
      '<h3>Campaign visits</h3>' +
      (visits
        .map(
          (v) =>
            `<p class="mono">${esc(v.title)} · ${esc(v.source)} · ${esc(v.visits)} visits</p>`
        )
        .join('') || '<p>Share a project’s YouTube link or QR code to start counting visits.</p>') +
      '<h3>Release history</h3>' +
      (activity
        .map(
          (a) =>
            `<article class="file-item"><b>${esc(a.title)} · ${esc(a.action)}</b>` +
            `<small class="mono">${esc(new Date(a.created_at).toLocaleString())}</small>` +
            `${
              a.undone
                ? '<span class="small">Undone</span>'
                : `<button type="button" class="alt" data-undo="${a.id}">Undo release change</button>`
            }</article>`
        )
        .join('') || '<p>New release changes will appear here.</p>');
  }

  $('centerButton').onclick = async () => {
    dialog.showModal();
    status.textContent = 'Loading…';
    content.replaceChildren();
    try {
      await load();
      status.textContent = '';
    } catch (e) {
      status.textContent = e.message;
    }
  };

  $('centerClose').onclick = () => dialog.close();

  content.onclick = async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const { shot, report, resolved, undo } = btn.dataset;
    if (undo && !confirm('Restore the release list to its state before this change?')) return;
    btn.disabled = true;
    try {
      if (shot) {
        const data = await api('/api/admin/reports/' + shot);
        const img = document.createElement('img');
        img.alt = 'Submitted bug screenshot';
        img.style.maxWidth = '100%';
        img.style.borderRadius = '8px';
        img.style.marginTop = '8px';
        img.src = data.screenshot;
        btn.replaceWith(img);
        return;
      }
      if (report) {
        await api('/api/admin/reports/' + report, 'PATCH', { resolved: resolved === 'true' });
      }
      if (undo) {
        await api('/api/admin/activity/' + undo + '/undo', 'POST', {});
        projects = await api('/api/admin/projects');
        render();
      }
      await load();
      status.textContent = undo ? 'Release change undone.' : 'Report updated.';
    } catch (err) {
      status.textContent = err.message;
      btn.disabled = false;
    }
  };
})();
