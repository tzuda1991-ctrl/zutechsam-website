import { escapeText as e } from './release-center.js';

function starsText(rating) {
  const n = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export function reviewsBlock(p, reviews = [], { preview = false, draftPreviewToken = '' } = {}) {
  const list = Array.isArray(reviews) ? reviews : [];
  const avg = list.length
    ? (list.reduce((sum, r) => sum + Number(r.rating || 5), 0) / list.length).toFixed(1)
    : null;
  const headerMeta = avg
    ? `<span class="mono review-avg">${starsText(Math.round(Number(avg)))} ${e(avg)} / 5</span> <span aria-hidden="true">·</span> <span class="mono">${list.length} ${list.length === 1 ? 'review' : 'reviews'}</span>`
    : '<span>No published reviews yet</span>';

  const itemsHtml = list.length
    ? `<div class="reviews-list">${list
        .map(
          (r) =>
            `<article class="review-card">` +
            `<div class="review-head"><strong>${e(r.author_name)}</strong><span class="mono review-stars" aria-label="${Number(r.rating)} out of 5 stars">${starsText(r.rating)}</span></div>` +
            `<small class="mono">${r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : ''}</small>` +
            `<p>${e(r.comment)}</p>` +
            `</article>`
        )
        .join('')}</div>`
    : '';

  const interactive = !preview && !draftPreviewToken;
  const reviewForm = interactive
    ? `<details class="tool-accordion"><summary>Write a review</summary>` +
      `<form id="reviewForm">` +
      `<div class="review-form-row">` +
      `<label>Your name<input name="author_name" required minlength="2" maxlength="80" placeholder="Alex Rivera"></label>` +
      `<label>Rating<select name="rating"><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Fair</option><option value="2">2 — Needs work</option><option value="1">1 — Poor</option></select></label>` +
      `</div>` +
      `<label>Feedback<textarea name="comment" required minlength="5" maxlength="1000" placeholder="Share your experience with this build or product…"></textarea></label>` +
      `<button class="cta">Submit review</button>` +
      `<p class="small-note" role="status"></p>` +
      `</form></details>`
    : '';

  const betaForm = interactive
    ? `<details class="tool-accordion"><summary>Join beta testing program</summary>` +
      `<form id="betaForm">` +
      `<p class="beta-copy">Get early access to pre-release builds and testing notes for ${e(p.title)}.</p>` +
      `<div class="review-form-row">` +
      `<label>Email address<input name="email" type="email" required maxlength="200" placeholder="tester@domain.com"></label>` +
      `<label>Device / Platform<input name="device" maxlength="120" placeholder="e.g. Pixel 8 · Android 14 or Desktop Web"></label>` +
      `</div>` +
      `<button class="cta">Join beta list</button>` +
      `<p class="small-note" role="status"></p>` +
      `</form></details>`
    : '';

  return `<section class="release-tools" id="community"><h2>User reviews &amp; beta access</h2><div class="meta-line">${headerMeta}</div>${itemsHtml}${reviewForm}${betaForm}</section>`;
}

export function releaseTools(
  p,
  releases,
  { preview = false, reviews = [], draftPreviewToken = '' } = {}
) {
  const base = `/projects/${p.slug || p.id}`;
  const items = releases.filter((r) => r.id);
  const choices = items
    .map((r) => `<option value="${r.id}">${e(r.version)} · ${e(r.channel)}</option>`)
    .join('');
  const compare =
    items.length < 2
      ? ''
      : `<details class="tool-accordion"><summary>Compare two versions</summary><div class="compare-grid">${[
          'First',
          'Second',
        ]
          .map(
            (label, i) =>
              `<label>${label} version<select data-compare>${items
                .map(
                  (r, j) =>
                    `<option value="${r.id}" ${i === j ? 'selected' : ''}>${e(r.version)}</option>`
                )
                .join('')}</select><div class="comparison"></div></label>`
          )
          .join('')}</div></details>`;
  const interactive = !preview && !draftPreviewToken;
  const reportPanel =
    items.length && interactive
      ? `<details class="tool-accordion"><summary>Report a problem</summary><form id="reportForm"><label>Affected version<select name="release">${choices}</select></label><label>What happened?<textarea name="message" minlength="5" maxlength="2000" required placeholder="What did you try, and what did you see?"></textarea></label><label>Screenshot (optional)<input type="file" name="image" accept="image/*"></label><button class="cta">Send report</button><p role="status"></p></form></details>`
      : '';
  const sharePanel = interactive
    ? `<details class="tool-accordion"><summary>Follow, update API &amp; share</summary><div class="share-stack">` +
      `<div><p>Subscribe to release updates or integrate in-app update checks.</p>` +
      `<div class="share-links"><a class="textlink" href="${base}/updates.atom">Atom update feed</a>` +
      (items.length ? `<a class="textlink" href="${base}/latest.json">In-app update JSON</a>` : '') +
      `</div></div>` +
      `<div><p>Share this campaign link in your YouTube description.</p><div class="copy-row"><input aria-label="YouTube campaign link" id="campaignLink" readonly><button type="button" id="copyCampaign">Copy link</button></div></div>` +
      `<div><p>Scan to open this project on another device.</p><a class="qr-wrap" href="${base}/qr.png" download="project-qr.png"><img width="144" height="144" loading="lazy" src="${base}/qr.png" alt="Download project QR code"></a></div>` +
      `</div></details>`
    : '';
  const toolsHeading =
    compare || reportPanel || sharePanel
      ? `<section class="release-tools"><h2>Release tools</h2>${compare}${reportPanel}${sharePanel}</section>`
      : '';
  const reviewsHtml = preview ? '' : reviewsBlock(p, reviews, { preview, draftPreviewToken });
  const script = preview ? '' : '<script defer src="/center-public.js"></script>';
  return `${toolsHeading}${reviewsHtml}${script}`;
}

export function packageInfo(r) {
  const d = r.details || {};
  const rows = [
    ['Package', d.package],
    ['Build', d.build],
    ['APK version', d.version],
    ['Minimum Android API', d.minSdk],
    ['Target Android API', d.targetSdk],
    ['SHA-256', d.sha256],
  ].filter(([, v]) => v != null);
  if (!rows.length) return '';
  return `<details class="pkg-meta"><summary>APK details &amp; compatibility</summary><dl>${rows
    .map(([k, v]) =>
      k === 'SHA-256'
        ? `<dt>${k}</dt><dd class="mono sha-row"><span>${e(v)}</span><button type="button" class="copy-sha" data-copy="${e(v)}">Copy</button></dd>`
        : `<dt>${k}</dt><dd class="mono">${e(v)}</dd>`
    )
    .join('')}</dl></details>`;
}
