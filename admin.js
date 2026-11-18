const $ = (id) => document.getElementById(id);
const form = $('projectForm');
let token = sessionStorage.getItem('zutechsam_admin_token') || '';
let projects = [];
let enquiries = [];
let testimonials = [];
let faqs = [];
let reviews = [];
let betaSignups = [];
let teamData = { me: { username: '', role: 'owner' }, members: [], sessions: [], auditLogs: [] };
let editing = null;
let uploading = false;
let attached = [];
const failedSelections = new Set();
let limits = { apkMB: 1024, imageMB: 100 };

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

function signedIn(on) {
  $('desk').hidden = !on;
  $('loginPanel').hidden = on;
}

async function api(url, method = 'GET', data) {
  const binary = data instanceof Blob;
  const headers = { authorization: 'Bearer ' + token };
  if (binary || data !== undefined) {
    headers['content-type'] = binary ? 'application/octet-stream' : 'application/json';
  }
  const response = await fetch(url, {
    method,
    headers,
    body: data === undefined ? undefined : binary ? data : JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') {
      sessionStorage.removeItem('zutechsam_admin_token');
      token = '';
      signedIn(false);
    }
    throw Object.assign(
      new Error(result.error || `Request failed (${response.status})`),
      { status: response.status }
    );
  }
  return result;
}

const linesOf = (value) =>
  String(value || '')
    .split('\n')
    .map((u) => u.trim())
    .filter(Boolean);

const screenshotUrls = () => linesOf(form.elements.screenshots.value);

function toLocalDatetime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function parseMetrics(text) {
  return linesOf(text)
    .slice(0, 6)
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return null;
      const label = line.slice(0, idx).trim().slice(0, 60);
      const value = line.slice(idx + 1).trim().slice(0, 60);
      return label && value ? { label, value } : null;
    })
    .filter(Boolean);
}

function navigate() {
  const route = location.hash.slice(1);
  const section = ['overview', 'projects', 'editor', 'enquiries', 'content', 'settings'].includes(route)
    ? route
    : 'overview';
  document.querySelectorAll('.workspace section').forEach((el) => {
    el.hidden = el.id !== section;
  });
  document.querySelectorAll('aside nav a').forEach((el) => {
    el.classList.toggle('active', el.hash === '#' + section);
  });
}

window.onhashchange = navigate;

function syncPreviewBox(project) {
  const box = $('previewTokenBox');
  if (!project) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const input = $('previewUrlInput');
  const clearBtn = $('clearPreviewToken');
  if (project.preview_token) {
    input.value = `${location.origin}/preview/${project.preview_token}`;
    clearBtn.hidden = false;
    $('genPreviewToken').textContent = 'Regenerate link';
    $('copyPreviewUrl').disabled = false;
  } else {
    input.value = 'No private preview link active';
    clearBtn.hidden = true;
    $('genPreviewToken').textContent = 'Generate link';
    $('copyPreviewUrl').disabled = true;
  }
}

function clearEditor() {
  editing = null;
  $('editorReleases').hidden = true;
  syncPreviewBox(null);
  form.reset();
  attached = [];
  failedSelections.clear();
  showFiles();
  $('editorTitle').textContent = 'Add project';
  $('projectMsg').textContent = '';
  $('progress').hidden = true;
  $('uploadStatus').textContent = '';
}

const coverFor = (p) =>
  p.image_url ||
  ({
    Games: '/Games.webp',
    AI: '/AI.webp',
    Websites: '/Websites.webp',
    Software: '/Websites.webp',
  }[p.category] || '/studio.webp');

function projectStatusLabel(p) {
  if (!p.published) return 'Draft';
  if (p.publish_at && new Date(p.publish_at) > new Date()) {
    return `Scheduled (${new Date(p.publish_at).toLocaleString()})`;
  }
  return 'Published';
}

function projectRow(p) {
  return (
    `<div class="row project-row">` +
    `<img alt="" class="thumb" src="${esc(coverFor(p))}">` +
    `<div><strong>${esc(p.title)}</strong>` +
    `<div class="small mono">${esc(p.category)} · ${esc(projectStatusLabel(p))}${
      p.featured ? ' · Featured' : ''
    } · ${p.file_count} ${p.file_count === 1 ? 'file' : 'files'} · ${p.release_count} ${
      p.release_count === 1 ? 'release' : 'releases'
    } · ${p.downloads_total || 0} downloads</div></div>` +
    `<div class="row-actions">` +
    `<button type="button" data-release="${p.id}">${p.release_count ? 'Manage releases' : 'Add release'}</button>` +
    `<button type="button" class="alt" data-edit="${p.id}">Edit</button>` +
    `<button type="button" class="alt" data-copy="${p.id}">Duplicate</button>` +
    `<button type="button" class="danger" data-remove="${p.id}">Delete</button>` +
    `</div></div>`
  );
}

function renderWeek() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date();
    day.setDate(day.getDate() - i);
    days.push({ day, key: day.toDateString(), count: 0 });
  }
  for (const enquiry of enquiries) {
    const item = days.find((d) => d.key === new Date(enquiry.created_at).toDateString());
    if (item) item.count++;
  }
  const max = Math.max(1, ...days.map((d) => d.count));
  $('week').innerHTML = days
    .map(
      (d) =>
        `<div><b>${d.count}</b><i style="height:${Math.round((d.count / max) * 48 + 3)}px"></i><small>${d.day.toLocaleDateString(
          undefined,
          { weekday: 'short' }
        )}</small></div>`
    )
    .join('');
}

function replyMailto(e, kind) {
  const subjects = {
    discovery: `Re: ${e.service} enquiry — Discovery call with ZUTECHSAM`,
    quote: `Project scope & estimate for your ${e.service}`,
    scope: `Quick scope questions regarding your ${e.service} project`,
  };
  const bodies = {
    discovery: `Hi ${e.name},\n\nThanks for reaching out about ${e.service}. We reviewed your message and would love to schedule a quick 20-minute discovery call this week to align on milestones and timeline.\n\nPlease let us know what time works best.\n\nBest,\nZUTECHSAM Studio`,
    quote: `Hi ${e.name},\n\nThank you for sharing your requirements for ${e.service}. Based on your brief, we have outlined an initial scope and estimate:\n\n- Phase 1: Architecture & UI prototype\n- Phase 2: Core build & APK/web testing\n- Phase 3: Production handoff & release setup\n\nReply if you'd like us to send the detailed breakdown.\n\nBest,\nZUTECHSAM Studio`,
    scope: `Hi ${e.name},\n\nThanks for contacting ZUTECHSAM about ${e.service}. To give you an accurate estimate, could you clarify:\n1. Target launch date?\n2. Required integrations or logins?\n3. Any reference apps or designs?\n\nBest,\nZUTECHSAM Studio`,
  };
  return `mailto:${encodeURIComponent(e.email)}?subject=${encodeURIComponent(
    subjects[kind]
  )}&body=${encodeURIComponent(bodies[kind])}`;
}

function renderContentAndTeam() {
  const me = teamData.me || { username: '', role: 'owner' };
  const isOwner = me.role === 'owner';
  $('workspaceRole').textContent = `${me.username || 'Admin'} · ${isOwner ? 'Owner' : 'Editor'}`;
  $('teamForm').hidden = !isOwner;
  $('restoreBox').hidden = !isOwner;

  $('reviewModerationList').innerHTML =
    reviews
      .map(
        (r) =>
          `<div class="row"><div><strong>${esc(r.project_title)}</strong> · ${esc(
            r.author_name
          )} · <span class="mono">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>` +
          `<div class="small mono">${r.approved ? 'Approved' : 'Pending moderation'} · ${new Date(
            r.created_at
          ).toLocaleDateString()}</div>` +
          `<p class="small">${esc(r.comment)}</p></div>` +
          `<div class="row-actions">` +
          `<button type="button" class="alt" data-approve-review="${r.id}" data-next="${!r.approved}">${
            r.approved ? 'Unapprove' : 'Approve'
          }</button>` +
          `<button type="button" class="danger" data-del-review="${r.id}">Delete</button>` +
          `</div></div>`
      )
      .join('') || '<p class="small">No submitted project reviews yet.</p>';

  $('betaSignupList').innerHTML =
    betaSignups
      .map(
        (b) =>
          `<div class="row"><div><strong>${esc(b.project_title)}</strong> · <span class="mono">${esc(
            b.email
          )}</span>` +
          `<div class="small mono">${esc(b.device || 'Device unspecified')} · ${new Date(
            b.created_at
          ).toLocaleDateString()}</div></div></div>`
      )
      .join('') || '<p class="small">No beta tester signups yet.</p>';

  $('testimonialsAdminList').innerHTML =
    testimonials
      .map(
        (t) =>
          `<div class="row"><div><strong>${esc(t.author_name)}</strong>${
            t.company ? ` · ${esc(t.company)}` : ''
          } · <span class="mono">${t.published ? 'Visible' : 'Hidden'}</span>` +
          `<p class="small">${esc(t.quote)}</p></div>` +
          `<div class="row-actions">` +
          `<button type="button" class="alt" data-toggle-testimonial="${t.id}">${
            t.published ? 'Hide' : 'Publish'
          }</button>` +
          `<button type="button" class="danger" data-del-testimonial="${t.id}">Delete</button>` +
          `</div></div>`
      )
      .join('') || '<p class="small">No client testimonials added yet.</p>';

  $('faqsAdminList').innerHTML =
    faqs
      .map(
        (f) =>
          `<div class="row"><div><strong>${esc(f.question)}</strong> · <span class="mono">${
            f.published ? 'Visible' : 'Hidden'
          }</span>` +
          `<p class="small">${esc(f.answer)}</p></div>` +
          `<div class="row-actions">` +
          `<button type="button" class="alt" data-toggle-faq="${f.id}">${
            f.published ? 'Hide' : 'Publish'
          }</button>` +
          `<button type="button" class="danger" data-del-faq="${f.id}">Delete</button>` +
          `</div></div>`
      )
      .join('') || '<p class="small">No FAQs added yet.</p>';

  $('teamMembersList').innerHTML =
    (teamData.members || [])
      .map(
        (m) =>
          `<div class="row"><div><strong>${esc(m.username)}</strong> · <span class="mono">${esc(
            m.role
          )}</span>${
            m.username === me.username ? ' <span class="small">(you)</span>' : ''
          }</div>` +
          (isOwner && m.username !== me.username
            ? `<button type="button" class="danger" data-del-member="${m.id}">Remove</button>`
            : '') +
          `</div>`
      )
      .join('') || '<p class="small">Single owner session.</p>';

  $('activeSessionsList').innerHTML =
    (teamData.sessions || [])
      .map(
        (s) =>
          `<div class="row"><div><strong>${esc(s.username)}</strong> · <span class="mono">${esc(
            s.ip || 'unknown IP'
          )}</span>${s.current ? ' · <strong>Current session</strong>' : ''}` +
          `<div class="small mono">${esc(String(s.user_agent || '').slice(0, 90))} · Expires ${new Date(
            s.expires_at
          ).toLocaleString()}</div></div>` +
          `<button type="button" class="alt" data-revoke-session="${esc(s.id_prefix)}">Revoke</button></div>`
      )
      .join('') || '<p class="small">No active sessions found.</p>';

  $('auditLogList').innerHTML =
    (teamData.auditLogs || [])
      .map(
        (a) =>
          `<div class="row"><div><strong>${esc(a.username)}</strong> · <span class="mono ${
            a.success ? '' : 'overdue-mark'
          }">${a.success ? 'Signed in' : 'Failed attempt'}</span> · <span class="mono">${esc(
            a.ip
          )}</span>` +
          `<div class="small mono">${new Date(a.created_at).toLocaleString()}</div></div></div>`
      )
      .join('') || '<p class="small">No recent sign-in events recorded.</p>';
}

function render() {
  renderWeek();
  const totalDownloads = projects.reduce((sum, p) => sum + Number(p.downloads_total || 0), 0);
  const metrics = [
    ['Total projects', projects.length],
    ['Published', projects.filter((p) => p.published).length],
    ['APK downloads', totalDownloads],
    ['New enquiries', enquiries.filter((e) => e.status === 'new').length],
  ];
  $('metrics').innerHTML = metrics
    .map(([title, n]) => `<div class="metric"><strong>${n}</strong>${title}</div>`)
    .join('');
  $('recent').innerHTML = projects.slice(0, 4).map(projectRow).join('') || '<p>No projects yet.</p>';
  const status = $('pub').value;
  const now = new Date();
  $('list').innerHTML =
    projects
      .filter(
        (p) =>
          (p.title + ' ' + p.category + ' ' + (p.slug || ''))
            .toLowerCase()
            .includes($('search').value.toLowerCase()) &&
          (status === 'All projects' ||
            (status === 'Published' &&
              p.published &&
              (!p.publish_at || new Date(p.publish_at) <= now)) ||
            (status === 'Scheduled' &&
              p.published &&
              p.publish_at &&
              new Date(p.publish_at) > now) ||
            (status === 'Draft' && !p.published) ||
            (status === 'Featured' && p.featured))
      )
      .map(projectRow)
      .join('') || '<p>No matching projects.</p>';

  const todayIso = new Date().toISOString().slice(0, 10);
  $('inbox').innerHTML =
    enquiries
      .filter(
        (e) =>
          (e.name + ' ' + e.email + ' ' + e.message + ' ' + e.service + ' ' + (e.notes || ''))
            .toLowerCase()
            .includes($('findMail').value.toLowerCase()) &&
          ($('mailStatus').value === 'All enquiries' || e.status === $('mailStatus').value)
      )
      .map((e) => {
        const followDate = e.follow_up_at ? String(e.follow_up_at).slice(0, 10) : '';
        const overdue = followDate && followDate < todayIso && e.status !== 'closed';
        return (
          `<article class="row enquiry-row"><div><strong>${esc(e.name)}</strong> · ${esc(e.service)}${
            e.budget ? ` · <span class="mono">${esc(e.budget)}</span>` : ''
          }` +
          `${overdue ? ' · <span class="overdue-mark mono">Overdue follow-up</span>' : ''}` +
          `<div class="small mono">${esc(e.email)} · ${new Date(e.created_at).toLocaleDateString()}</div>` +
          `<p>${esc(e.message)}</p>` +
          `<div class="crm-notes"><input type="text" class="note-input" data-note-for="${e.id}" value="${esc(
            e.notes || ''
          )}" placeholder="Internal CRM notes…" maxlength="2000">` +
          `<button type="button" class="alt" data-save-note="${e.id}">Save note</button>` +
          `<input type="date" class="followup-input" aria-label="Follow-up reminder date" data-followup-for="${e.id}" value="${esc(
            followDate
          )}">` +
          `</div>` +
          `<div class="reply-templates">` +
          `<span class="small">Quick reply:</span>` +
          `<a class="textlink" href="${esc(replyMailto(e, 'discovery'))}">Discovery Call</a>` +
          `<a class="textlink" href="${esc(replyMailto(e, 'quote'))}">Project Quote</a>` +
          `<a class="textlink" href="${esc(replyMailto(e, 'scope'))}">Scope Questions</a>` +
          `</div></div>` +
          `<select aria-label="Enquiry status" data-id="${e.id}">${['new', 'contacted', 'quoted', 'closed']
            .map((s) => `<option ${s === e.status ? 'selected' : ''}>${s}</option>`)
            .join('')}</select></article>`
        );
      })
      .join('') || '<p>No matching enquiries.</p>';

  renderContentAndTeam();
}

async function load() {
  const [p, e, settings, config, tList, fList, revList, betaList, tData] = await Promise.all([
    api('/api/admin/projects'),
    api('/api/admin/enquiries'),
    api('/api/admin/studio'),
    api('/api/admin/uploads'),
    api('/api/admin/testimonials'),
    api('/api/admin/faqs'),
    api('/api/admin/reviews'),
    api('/api/admin/beta-signups'),
    api('/api/admin/team'),
  ]);
  projects = p;
  enquiries = e;
  limits = config;
  testimonials = tList;
  faqs = fList;
  reviews = revList;
  betaSignups = betaList;
  teamData = tData;
  $('apkLimit').textContent = config.apkMB;
  for (const key of ['headline', 'intro', 'email', 'telegram_chat_id']) {
    $('settingsForm').elements[key].value = settings[key] || '';
  }
  $('settingsForm').elements.telegram_bot_token.value = '';
  $('telegramState').textContent = settings.has_telegram_token
    ? 'A Telegram Bot Token is saved. Leave the token field blank to keep it.'
    : 'Configure a Bot Token and Chat ID (or set TELEGRAM_BOT_TOKEN env var) to receive instant enquiry & bug alerts.';
  render();
  navigate();
  signedIn(true);
}

$('login').onsubmit = async (event) => {
  event.preventDefault();
  $('loginMsg').textContent = '';
  try {
    const result = await api('/api/login', 'POST', Object.fromEntries(new FormData(event.target)));
    token = result.token;
    sessionStorage.setItem('zutechsam_admin_token', token);
    await load();
    event.target.reset();
  } catch (error) {
    $('loginMsg').textContent = error.message;
  }
};

$('logout').onclick = async () => {
  try {
    await api('/api/logout', 'POST');
  } finally {
    token = '';
    sessionStorage.removeItem('zutechsam_admin_token');
    location.reload();
  }
};

$('newProject').onclick = () => {
  if (!uploading) clearEditor();
};
$('quickNew').onclick = () => {
  if (!uploading) clearEditor();
};
$('cancel').onclick = () => {
  clearEditor();
  location.hash = 'projects';
};

for (const id of ['search', 'findMail', 'mailStatus', 'pub']) {
  $(id).oninput = render;
}

async function projectAction(event) {
  const { edit, remove, copy } = event.target.dataset;
  if (uploading || (!edit && !remove && !copy)) return;
  const project = projects.find((p) => String(p.id) === (edit || remove || copy));
  if (!project) return;
  if (edit || copy) {
    clearEditor();
    editing = edit || null;
    for (const key of [
      'title',
      'category',
      'slug',
      'version',
      'tech_stack',
      'summary',
      'description',
      'release_notes',
      'demo_html',
      'image_url',
      'demo_url',
      'apk_url',
      'video_url',
    ]) {
      form.elements[key].value = project[key] || '';
    }
    form.elements.publish_at.value = toLocalDatetime(project.publish_at);
    for (const key of ['featured', 'published']) {
      form.elements[key].checked = project[key];
    }
    attached = (project.attachments || []).map((f) => ({ ...f }));
    showFiles();
    form.elements.screenshots.value = (project.screenshots || []).join('\n');
    form.elements.highlights.value = (project.highlights || []).join('\n');
    form.elements.metrics.value = (project.metrics || [])
      .map((m) => `${m.label}: ${m.value}`)
      .join('\n');
    syncPreviewBox(edit ? project : null);
    if (copy) {
      form.elements.title.value = (project.title + ' (copy)').slice(0, 150);
      form.elements.slug.value = '';
      form.elements.published.checked = false;
      form.elements.featured.checked = false;
    }
    $('editorTitle').textContent = copy ? 'Duplicate as draft' : 'Edit project';
    location.hash = 'editor';
  } else if (confirm('Delete ' + project.title + '?')) {
    try {
      await api('/api/admin/projects/' + remove, 'DELETE');
      await load();
      $('notice').textContent = 'Project deleted.';
    } catch (error) {
      $('notice').textContent = error.message;
    }
  }
}

$('recent').onclick = $('list').onclick = projectAction;

$('genPreviewToken').onclick = async () => {
  if (!editing) return;
  try {
    const r = await api(`/api/admin/projects/${editing}/preview-token`, 'POST', {});
    const p = projects.find((x) => String(x.id) === editing);
    if (p) p.preview_token = r.preview_token;
    syncPreviewBox(p);
    $('notice').textContent = 'Private client preview link ready.';
  } catch (error) {
    $('notice').textContent = error.message;
  }
};

$('clearPreviewToken').onclick = async () => {
  if (!editing || !confirm('Revoke this private preview link?')) return;
  try {
    await api(`/api/admin/projects/${editing}/preview-token`, 'POST', { clear: true });
    const p = projects.find((x) => String(x.id) === editing);
    if (p) p.preview_token = null;
    syncPreviewBox(p);
    $('notice').textContent = 'Preview link revoked.';
  } catch (error) {
    $('notice').textContent = error.message;
  }
};

$('copyPreviewUrl').onclick = async () => {
  const input = $('previewUrlInput');
  try {
    await navigator.clipboard.writeText(input.value);
    $('copyPreviewUrl').textContent = 'Copied';
    setTimeout(() => ($('copyPreviewUrl').textContent = 'Copy link'), 1500);
  } catch {
    input.select();
  }
};

$('inbox').onchange = async ({ target }) => {
  if (target.dataset.id) {
    const enquiry = enquiries.find((e) => String(e.id) === target.dataset.id);
    if (!enquiry) return;
    try {
      await api('/api/admin/enquiries/' + enquiry.id, 'PATCH', { status: target.value });
      enquiry.status = target.value;
      render();
    } catch (error) {
      target.value = enquiry.status;
      $('notice').textContent = error.message;
    }
  } else if (target.dataset.followupFor) {
    const id = target.dataset.followupFor;
    const enquiry = enquiries.find((e) => String(e.id) === id);
    if (!enquiry) return;
    try {
      await api('/api/admin/enquiries/' + id, 'PATCH', { follow_up_at: target.value || '' });
      enquiry.follow_up_at = target.value || null;
      $('notice').textContent = target.value
        ? 'Follow-up reminder date saved.'
        : 'Follow-up date cleared.';
      render();
    } catch (error) {
      $('notice').textContent = error.message;
    }
  }
};

$('inbox').onclick = async ({ target }) => {
  const id = target.dataset.saveNote;
  if (!id) return;
  const enquiry = enquiries.find((e) => String(e.id) === id);
  const input = $('inbox').querySelector(`[data-note-for="${id}"]`);
  if (!enquiry || !input) return;
  target.disabled = true;
  try {
    await api('/api/admin/enquiries/' + id, 'PATCH', { notes: input.value });
    enquiry.notes = input.value;
    $('notice').textContent = 'Enquiry note saved.';
  } catch (error) {
    $('notice').textContent = error.message;
  } finally {
    target.disabled = false;
  }
};

$('exportCsv').onclick = () => {
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [
    [
      'ID',
      'Date',
      'Name',
      'Email',
      'Service',
      'Budget',
      'Status',
      'FollowUpAt',
      'Message',
      'Notes',
    ].join(','),
    ...enquiries.map((e) =>
      [
        e.id,
        new Date(e.created_at).toISOString(),
        e.name,
        e.email,
        e.service,
        e.budget || '',
        e.status,
        e.follow_up_at ? String(e.follow_up_at).slice(0, 10) : '',
        e.message,
        e.notes || '',
      ]
        .map(csvCell)
        .join(',')
    ),
  ];
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `zutechsam-enquiries-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

form.onsubmit = async (event) => {
  event.preventDefault();
  if (uploading) return;
  if ([...failedSelections].some((input) => input.files.length)) {
    $('projectMsg').textContent = 'Retry the failed upload or clear its file selection before saving.';
    return;
  }
  const data = Object.fromEntries(new FormData(form));
  data.attachments = attached;
  data.screenshots = screenshotUrls();
  data.highlights = linesOf(form.elements.highlights.value).slice(0, 8);
  data.metrics = parseMetrics(form.elements.metrics.value);
  data.publish_at = form.elements.publish_at.value
    ? new Date(form.elements.publish_at.value).toISOString()
    : null;
  for (const key of ['featured', 'published']) {
    data[key] = form.elements[key].checked;
  }
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api(
      '/api/admin/projects' + (editing ? '/' + editing : ''),
      editing ? 'PUT' : 'POST',
      data
    );
    clearEditor();
    location.hash = 'projects';
    $('notice').textContent = 'Project saved.';
    await load();
  } catch (error) {
    $('notice').textContent = $('projectMsg').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

// Content Manager handlers
$('testimonialForm').onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  data.published = e.target.elements.published.checked;
  data.rating = Number(data.rating || 5);
  data.sort_order = Number(data.sort_order || 0);
  try {
    await api('/api/admin/testimonials', 'POST', data);
    e.target.reset();
    e.target.elements.published.checked = true;
    await load();
    $('notice').textContent = 'Testimonial added.';
  } catch (err) {
    $('notice').textContent = err.message;
  }
};

$('faqForm').onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  data.published = e.target.elements.published.checked;
  data.sort_order = Number(data.sort_order || 0);
  try {
    await api('/api/admin/faqs', 'POST', data);
    e.target.reset();
    e.target.elements.published.checked = true;
    await load();
    $('notice').textContent = 'FAQ added.';
  } catch (err) {
    $('notice').textContent = err.message;
  }
};

$('content').onclick = async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const d = btn.dataset;
  try {
    if (d.approveReview) {
      await api('/api/admin/reviews/' + d.approveReview, 'PATCH', {
        approved: d.next === 'true',
      });
      await load();
      $('notice').textContent = 'Review moderation updated.';
    } else if (d.delReview && confirm('Delete this review?')) {
      await api('/api/admin/reviews/' + d.delReview, 'DELETE');
      await load();
    } else if (d.toggleTestimonial) {
      const t = testimonials.find((x) => String(x.id) === d.toggleTestimonial);
      if (!t) return;
      await api('/api/admin/testimonials/' + t.id, 'PUT', { ...t, published: !t.published });
      await load();
    } else if (d.delTestimonial && confirm('Delete this testimonial?')) {
      await api('/api/admin/testimonials/' + d.delTestimonial, 'DELETE');
      await load();
    } else if (d.toggleFaq) {
      const f = faqs.find((x) => String(x.id) === d.toggleFaq);
      if (!f) return;
      await api('/api/admin/faqs/' + f.id, 'PUT', { ...f, published: !f.published });
      await load();
    } else if (d.delFaq && confirm('Delete this FAQ?')) {
      await api('/api/admin/faqs/' + d.delFaq, 'DELETE');
      await load();
    }
  } catch (err) {
    $('notice').textContent = err.message;
  }
};

// Settings, Team, Sessions & Restore handlers
$('teamForm').onsubmit = async (e) => {
  e.preventDefault();
  $('teamMsg').textContent = '';
  try {
    await api('/api/admin/team', 'POST', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    $('teamMsg').textContent = 'Team member created.';
    await load();
  } catch (err) {
    $('teamMsg').textContent = err.message;
  }
};

$('teamPanel').onclick = async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { delMember, revokeSession } = btn.dataset;
  try {
    if (delMember && confirm('Remove this team member and end their sessions?')) {
      await api('/api/admin/team/' + delMember, 'DELETE');
      await load();
    } else if (revokeSession && confirm('Revoke this admin session?')) {
      await api('/api/admin/sessions/' + revokeSession, 'DELETE');
      await load();
    }
  } catch (err) {
    $('notice').textContent = err.message;
  }
};

$('settingsForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const res = await api('/api/admin/studio', 'PUT', Object.fromEntries(new FormData(event.target)));
    event.target.elements.telegram_bot_token.value = '';
    $('telegramState').textContent = res.has_telegram_token
      ? 'A Telegram Bot Token is saved. Leave the token field blank to keep it.'
      : 'No Telegram Bot Token saved.';
    $('notice').textContent = 'Website settings saved.';
  } catch (error) {
    $('notice').textContent = error.message;
  }
};

$('testTelegram').onclick = async () => {
  const btn = $('testTelegram');
  btn.disabled = true;
  try {
    await api('/api/admin/telegram-test', 'POST', {});
    $('notice').textContent = 'Test Telegram alert sent.';
  } catch (error) {
    $('notice').textContent = error.message;
  } finally {
    btn.disabled = false;
  }
};

$('passwordForm').onsubmit = async (event) => {
  event.preventDefault();
  const msg = $('passwordMsg');
  msg.textContent = '';
  try {
    await api('/api/admin/password', 'POST', Object.fromEntries(new FormData(event.target)));
    event.target.reset();
    msg.textContent = 'Administrator password updated.';
  } catch (error) {
    msg.textContent = error.message;
  }
};

$('exportBackup').onclick = async () => {
  const btn = $('exportBackup');
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/backup', {
      headers: { authorization: 'Bearer ' + token },
    });
    if (!res.ok) throw new Error('Backup download failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `zutechsam-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (error) {
    $('notice').textContent = error.message;
  } finally {
    btn.disabled = false;
  }
};

$('restoreBackup').onclick = async () => {
  const file = $('restoreFile').files[0];
  const msg = $('restoreMsg');
  msg.textContent = '';
  if (!file) {
    msg.textContent = 'Select a JSON backup file first.';
    return;
  }
  if (!confirm('Restore data from this backup JSON? Existing matching IDs will be updated.')) {
    return;
  }
  const btn = $('restoreBackup');
  btn.disabled = true;
  try {
    const parsed = JSON.parse(await file.text());
    const result = await api('/api/admin/restore', 'POST', parsed);
    $('restoreFile').value = '';
    msg.textContent = `Backup restored (${result.restoredProjects} projects synced).`;
    await load();
  } catch (error) {
    msg.textContent = error.message;
  } finally {
    btn.disabled = false;
  }
};

function showFiles() {
  $('attachedFiles').innerHTML = attached
    .map(
      (f, i) =>
        `<div class="row"><span>${esc(f.name)}${
          f.size ? ` · ${(f.size / 1048576).toFixed(1)} MiB` : ' · Link'
        }</span><button type="button" class="alt" data-detach="${i}">Remove</button></div>`
    )
    .join('');
}

$('attachedFiles').onclick = (e) => {
  if (e.target.dataset.detach !== undefined) {
    attached.splice(Number(e.target.dataset.detach), 1);
    showFiles();
  }
};

$('addLink').onclick = () => {
  const name = $('linkName').value.trim();
  const url = $('linkUrl').value.trim();
  if (
    !name ||
    !/^https:\/\//i.test(url) ||
    !$('linkUrl').validity.valid ||
    url.length >= 1500 ||
    attached.length >= 12
  ) {
    $('uploadStatus').textContent = 'Enter a label and valid HTTPS URL (up to 12 files).';
    return;
  }
  attached.push({ name, url, size: 0 });
  showFiles();
  $('linkName').value = $('linkUrl').value = '';
  $('uploadStatus').textContent = 'Link attached. Save the project.';
};

const safeMediaOrUrl = (u) => /^(\/media\/|https?:\/\/)/i.test(String(u || '').trim());

$('previewRelease').onclick = () => {
  const fields = form.elements;
  const cover = safeMediaOrUrl(fields.image_url.value)
    ? fields.image_url.value.trim()
    : coverFor({ category: fields.category.value });
  $('releasePreview').innerHTML =
    `<img class="previewHero" alt="" src="${esc(cover)}">` +
    `<small>${esc(fields.category.value)} · ${esc(fields.version.value || 'Draft')}</small>` +
    `<h2>${esc(fields.title.value || 'Untitled project')}</h2>` +
    `<p>${esc(fields.description.value || fields.summary.value)}</p>` +
    screenshotUrls()
      .filter(safeMediaOrUrl)
      .map((url) => `<img class="previewThumb" alt="Gallery preview" src="${esc(url)}">`)
      .join('') +
    (fields.release_notes.value
      ? `<h3>Release notes</h3><p>${esc(fields.release_notes.value)}</p>`
      : '');
  $('releaseDialog').showModal();
};

$('closePreview').onclick = () => $('releaseDialog').close();

async function fingerprintFile(file) {
  const parts = [];
  for (let i = 0; i < file.size; i += 4 * 1048576) {
    const buf = await file.slice(i, i + 4 * 1048576).arrayBuffer();
    parts.push(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
  }
  const joined = new Uint8Array(parts.length * 32);
  parts.forEach((part, i) => joined.set(part, i * 32));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)), (n) =>
    n.toString(16).padStart(2, '0')
  ).join('');
}

for (const button of form.querySelectorAll('[data-upload]')) {
  const picker = $(button.dataset.upload);
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'alt';
  discard.textContent = 'Clear selection';
  discard.hidden = true;
  button.after(discard);
  discard.onclick = () => {
    picker.value = '';
    failedSelections.delete(picker);
    discard.hidden = true;
    $('uploadStatus').textContent = 'File selection cleared.';
  };
  picker.onchange = () => {
    if (picker.files.length) button.click();
    else failedSelections.delete(picker);
  };
  button.onclick = async () => {
    if (uploading) return;
    const file = picker.files[0];
    const status = $('uploadStatus');
    if (!file) {
      status.textContent = 'Choose a file first.';
      return;
    }
    discard.hidden = false;
    failedSelections.add(picker);
    const field = button.dataset.target;
    if (field === 'screenshots' && screenshotUrls().length >= 6) {
      status.textContent = 'The gallery already contains six images.';
      return;
    }
    const ext = file.name.split('.').pop().toLowerCase();
    const allowed =
      field === 'attachments'
        ? ['zip', 'aab', 'pdf']
        : field === 'apk_url'
          ? ['apk']
          : ['png', 'jpg', 'jpeg', 'webp'];
    if (!allowed.includes(ext)) {
      status.textContent = `Choose a ${allowed.join(', ')} file for this field.`;
      return;
    }
    if (field === 'attachments' && attached.length >= 12) {
      status.textContent = 'Remove a file before adding another.';
      return;
    }
    const max = ['apk_url', 'attachments'].includes(field) ? limits.apkMB : limits.imageMB;
    if (file.size < 16 || file.size > max * 1024 ** 2) {
      status.textContent = `File size must be between 16 B and ${max} MiB.`;
      return;
    }
    uploading = true;
    form.querySelectorAll('button,input[type=file]').forEach((el) => (el.disabled = true));
    $('progress').hidden = false;
    $('progress').value = 0;
    status.textContent = `Preparing ${file.name}…`;
    const resumeKey = `zu-editor-upload-${field}`;
    try {
      const hash = await fingerprintFile(file);
      let state = null;
      try {
        const saved = JSON.parse(localStorage.getItem(resumeKey) || 'null');
        if (saved && saved.hash === hash && saved.size === file.size) {
          const pos = await api(`/api/admin/uploads/${saved.id}?size=${file.size}`).catch(
            () => null
          );
          if (pos) state = { ...saved, ...pos };
        }
      } catch {}
      if (!state) {
        const created = await api('/api/admin/uploads', 'POST', {
          filename: file.name,
          size: file.size,
        });
        state = { ...created, hash, size: file.size, offset: 0 };
        try {
          localStorage.setItem(resumeKey, JSON.stringify(state));
        } catch {}
      }
      let offset = state.offset || 0;
      let result = state.url ? { offset: file.size, url: state.url } : null;
      while (offset < file.size) {
        const part = file.slice(offset, offset + state.chunkSize);
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            result = await api(
              `/api/admin/uploads/${state.id}?size=${file.size}&offset=${offset}`,
              'PUT',
              part
            );
            break;
          } catch (error) {
            if (attempt === 2 || (error.status < 500 && error.status !== 409)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
          }
        }
        if (result.offset <= offset) throw Error('Upload interrupted. Please retry.');
        offset = result.offset;
        $('progress').value = Math.round((offset / file.size) * 100);
        status.textContent = `Uploading ${file.name} · ${$('progress').value}%`;
      }
      if (result?.url) {
        const url = result.url;
        if (field === 'attachments') {
          attached.push({ name: file.name.slice(0, 240), size: file.size, url });
          showFiles();
        } else {
          form.elements[field].value =
            field === 'screenshots' ? [...screenshotUrls(), url].join('\n') : url;
        }
        try {
          localStorage.removeItem(resumeKey);
        } catch {}
      }
      picker.value = '';
      discard.hidden = true;
      failedSelections.delete(picker);
      status.textContent = 'Upload complete. Save the project to attach this file.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      uploading = false;
      form.querySelectorAll('button,input[type=file]').forEach((el) => (el.disabled = false));
    }
  };
}

navigate();
if (token) {
  load().catch((error) => {
    $('loginMsg').textContent = error.message;
  });
}
