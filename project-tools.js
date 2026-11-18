import { escapeText as e } from './release-center.js';

export function releaseTools(p, releases, { preview = false } = {}) {
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

  const reportPanel = items.length
    ? `<details class="tool-accordion"><summary>Report a problem</summary><form id="reportForm"><label>Affected version<select name="release">${choices}</select></label><label>What happened?<textarea name="message" minlength="5" maxlength="2000" required placeholder="What did you try, and what did you see?"></textarea></label><label>Screenshot (optional)<input type="file" name="image" accept="image/*"></label><button class="cta">Send report</button><p role="status"></p></form></details>`
    : '';

  const sharePanel =
    `<details class="tool-accordion"><summary>Follow, update API &amp; share</summary><div class="share-stack">` +
    `<div><p>Subscribe to release updates or integrate in-app update checks.</p>` +
    `<div class="share-links"><a class="textlink" href="${base}/updates.atom">Atom update feed</a>` +
    (items.length
      ? `<a class="textlink" href="${base}/latest.json">In-app update JSON</a>`
      : '') +
    `</div></div>` +
    `<div><p>Share this campaign link in your YouTube description.</p><div class="copy-row"><input aria-label="YouTube campaign link" id="campaignLink" readonly><button type="button" id="copyCampaign">Copy link</button></div></div>` +
    `<div><p>Scan to open this project on another device.</p><a class="qr-wrap" href="${base}/qr.png" download="project-qr.png"><img width="144" height="144" loading="lazy" src="${base}/qr.png" alt="Download project QR code"></a></div>` +
    `</div></details>`;

  return `<section class="release-tools"><h2>Release tools</h2>${compare}${reportPanel}${sharePanel}</section>${
    preview ? '' : '<script defer src="/center-public.js"></script>'
  }`;
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
