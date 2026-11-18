import QRCode from 'qrcode';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ApkReader from 'adbkit-apkreader';
import ManifestParser from 'adbkit-apkreader/lib/apkreader/parser/manifest.js';
import { directory } from './uploads.js';

export const centerSchema = `
  ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'Stable';
  ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS details jsonb;
  CREATE TABLE IF NOT EXISTS release_reports(
    id bigserial PRIMARY KEY,
    project_id bigint REFERENCES projects ON DELETE CASCADE,
    version text NOT NULL,
    message text NOT NULL,
    screenshot text,
    resolved boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS reports_by_project_time ON release_reports(project_id,created_at);
  CREATE TABLE IF NOT EXISTS release_activity(
    id bigserial PRIMARY KEY,
    project_id bigint REFERENCES projects ON DELETE CASCADE,
    action text NOT NULL,
    before_state jsonb NOT NULL,
    after_state jsonb NOT NULL,
    undone boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS project_visits(
    project_id bigint REFERENCES projects ON DELETE CASCADE,
    source text,
    visits bigint DEFAULT 1,
    PRIMARY KEY(project_id,source)
  );
  CREATE TABLE IF NOT EXISTS download_events(
    id bigserial PRIMARY KEY,
    project_id bigint REFERENCES projects ON DELETE CASCADE,
    release_id bigint REFERENCES project_releases ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS download_events_time_idx ON download_events(created_at)
`;

const fail = (status, message) => Object.assign(Error(message), { status });

export const escapeText = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

export const snapshot = async (db, id) =>
  (
    await db.query(
      'SELECT id::text, version, url, filename, size::text, notes, is_latest, published_at, channel FROM project_releases WHERE project_id=$1 ORDER BY id',
      [id]
    )
  ).rows;

const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

export function getOrigin(req) {
  if (publicBaseUrl) return publicBaseUrl;
  const rawHost = String(req.headers.host || 'localhost:3000').trim();
  const safeHost = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(rawHost) ? rawHost : 'localhost:3000';
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(safeHost);
  const proto =
    forwardedProto === 'http' || forwardedProto === 'https'
      ? forwardedProto
      : isLocal
        ? 'http'
        : 'https';
  return `${proto}://${safeHost}`;
}

export async function sendTelegramAlert(pool, text) {
  try {
    let botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    let chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
    if ((!botToken || !chatId) && pool) {
      const q = await pool.query('SELECT data FROM studio_settings WHERE id=1');
      const d = q.rows[0]?.data || {};
      if (!botToken) botToken = String(d.telegram_bot_token || '').trim();
      if (!chatId) chatId = String(d.telegram_chat_id || '').trim();
    }
    if (!botToken || !chatId) return { sent: false, reason: 'not_configured' };

    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 3900),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return { sent: false, reason: err || `HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

export async function resolvePublishedProject(pool, key) {
  if (/^\d+$/.test(key)) {
    const q = await pool.query('SELECT * FROM projects WHERE id=$1 AND published=true', [key]);
    return q.rows[0] || null;
  }
  const q = await pool.query('SELECT * FROM projects WHERE slug=$1 AND published=true', [key]);
  return q.rows[0] || null;
}

export async function indexPackages(db) {
  const rows = (
    await db.query('SELECT DISTINCT url FROM project_releases WHERE details IS NULL')
  ).rows;

  for (const { url } of rows) {
    let key;
    try {
      key = new URL(url, 'https://studio.invalid').pathname.match(
        /^\/media\/([a-f0-9]{40}\.apk)$/
      )?.[1];
    } catch {
      continue;
    }
    if (!key) continue;

    const file = path.join(directory, key);
    const details = {};

    try {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
      }
      details.sha256 = hash.digest('hex');
    } catch {
      continue;
    }

    try {
      const reader = await ApkReader.open(file);
      const manifest = await reader.usingFileStream('AndroidManifest.xml', async (stream) => {
        let size = 0;
        const chunks = [];
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > 4194304) throw Error('Manifest too large');
          chunks.push(chunk);
        }
        return new ManifestParser(Buffer.concat(chunks)).parse();
      });
      Object.assign(details, {
        package: manifest.package,
        build: manifest.versionCode,
        version: manifest.versionName,
        minSdk: manifest.usesSdk?.minSdkVersion,
        targetSdk: manifest.usesSdk?.targetSdkVersion,
      });
    } catch {
      // Older or nonstandard manifests still retain their SHA-256 checksum.
    }

    await db.query('UPDATE project_releases SET details=$1 WHERE url=$2 AND details IS NULL', [
      details,
      url,
    ]);
  }
}

export async function centerApi(pathname, req, res, { pool, body, send, admin }) {
  if (admin) {
    if (pathname === '/api/admin/center' && req.method === 'GET') {
      const query = (sql) => pool.query(sql).then((q) => q.rows);
      const [reports, activity, visits, downloadsDaily, topProjects] = await Promise.all([
        query(
          'SELECT r.id,r.version,r.message,r.resolved,r.created_at,p.title,(r.screenshot IS NOT NULL) AS image FROM release_reports r JOIN projects p ON p.id=r.project_id ORDER BY r.id DESC LIMIT 150'
        ),
        query(
          'SELECT a.id,p.title,a.action,a.undone,a.created_at FROM release_activity a JOIN projects p ON p.id=a.project_id ORDER BY a.id DESC LIMIT 100'
        ),
        query(
          'SELECT p.title,v.source,v.visits FROM project_visits v JOIN projects p ON p.id=v.project_id ORDER BY v.visits DESC'
        ),
        query(
          "SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS count FROM download_events WHERE created_at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1"
        ),
        query(
          'SELECT p.id, p.title, COALESCE(SUM(r.download_clicks),0)::int AS downloads, COALESCE((SELECT SUM(v.visits) FROM project_visits v WHERE v.project_id=p.id),0)::int AS visits FROM projects p LEFT JOIN project_releases r ON r.project_id=p.id GROUP BY p.id ORDER BY downloads DESC, visits DESC LIMIT 8'
        ),
      ]);
      send(res, 200, { reports, activity, visits, downloadsDaily, topProjects });
      return true;
    }

    const report = pathname.match(/^\/api\/admin\/reports\/(\d+)$/);
    if (report && ['GET', 'PATCH'].includes(req.method)) {
      const q =
        req.method === 'GET'
          ? await pool.query('SELECT screenshot FROM release_reports WHERE id=$1', [report[1]])
          : await pool.query(
              'UPDATE release_reports SET resolved=$2 WHERE id=$1 RETURNING resolved',
              [report[1], (await body(req)).resolved === true]
            );
      send(res, q.rowCount ? 200 : 404, q.rows[0] || { error: 'Report no longer exists' });
      return true;
    }

    const undo = pathname.match(/^\/api\/admin\/activity\/(\d+)\/undo$/);
    if (undo && req.method === 'POST') {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const a = (await db.query('SELECT * FROM release_activity WHERE id=$1', [undo[1]])).rows[0];
        if (!a) throw fail(404, 'Activity unavailable');

        await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [a.project_id]);
        const current = await snapshot(db, a.project_id);
        const same = (
          await db.query('SELECT $1::jsonb=$2::jsonb AS ok', [
            JSON.stringify(current),
            JSON.stringify(a.after_state),
          ])
        ).rows[0].ok;

        if (a.undone || !same) {
          throw fail(409, 'The releases have changed since this action.');
        }

        for (const r of a.before_state) {
          if (current.some((c) => c.url === r.url)) continue;
          const key = new URL(r.url, 'https://studio.invalid').pathname.match(
            /^\/media\/([a-f0-9]{40}\.apk)$/
          )?.[1];
          if (key) {
            await access(path.join(directory, key)).catch(() => {
              throw fail(409, 'The original APK has been removed from storage.');
            });
          }
        }

        await db.query('UPDATE project_releases SET is_latest=false WHERE project_id=$1 AND is_latest', [
          a.project_id,
        ]);
        await db.query(
          'DELETE FROM project_releases WHERE project_id=$1 AND NOT(id=ANY($2::bigint[]))',
          [a.project_id, a.before_state.map((r) => r.id)]
        );
        for (const r of a.before_state) {
          await db.query(
            `INSERT INTO project_releases(id,project_id,version,url,filename,size,notes,is_latest,published_at,channel)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT(id) DO UPDATE SET
               version=excluded.version,
               url=excluded.url,
               filename=excluded.filename,
               size=excluded.size,
               notes=excluded.notes,
               is_latest=excluded.is_latest,
               channel=excluded.channel,
               revision=project_releases.revision+1,
               details=CASE WHEN project_releases.url=excluded.url THEN project_releases.details END`,
            [
              r.id,
              a.project_id,
              r.version,
              r.url,
              r.filename,
              r.size,
              r.notes,
              r.is_latest,
              r.published_at,
              r.channel,
            ]
          );
        }
        await db.query('UPDATE release_activity SET undone=true WHERE id=$1', [a.id]);
        await db.query('COMMIT');
        send(res, 200, { ok: true });
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }
      return true;
    }
    return false;
  }

  const match = pathname.match(
    /^\/projects\/([a-zA-Z0-9-]+)\/(youtube|qr|qr\.png|updates\.atom|reports|latest\.json)$/
  );
  if (!match) return false;

  const [, key, action] = match;
  const p = await resolvePublishedProject(pool, key);
  if (!p) throw fail(404, 'Project unavailable');

  const id = p.id;
  const slugOrId = p.slug || String(p.id);
  const origin = getOrigin(req);
  const base = `${origin}/projects/${slugOrId}`;

  if (action === 'latest.json' && req.method === 'GET') {
    const reqUrl = new URL(req.url, 'http://localhost');
    const reqChannel = reqUrl.searchParams.get('channel') || 'Stable';
    const channelFilter = ['Stable', 'Beta'].includes(reqChannel) ? reqChannel : 'Stable';
    const r = (
      await pool.query(
        'SELECT * FROM project_releases WHERE project_id=$1 AND channel=$2 ORDER BY is_latest DESC, published_at DESC, id DESC LIMIT 1',
        [id, channelFilter]
      )
    ).rows[0];
    if (!r) return send(res, 404, { error: `No ${channelFilter} release available` });
    const details = r.details || {};
    send(res, 200, {
      projectId: Number(id),
      slug: p.slug || null,
      title: p.title,
      channel: r.channel,
      version: r.version,
      versionCode: details.build ?? null,
      package: details.package ?? null,
      minSdk: details.minSdk ?? null,
      targetSdk: details.targetSdk ?? null,
      sha256: details.sha256 ?? null,
      size: Number(r.size),
      publishedAt: r.published_at,
      releaseNotes: r.notes,
      downloadUrl: `${origin}/projects/${id}/releases/${r.id}/download`,
    });
    return true;
  }

  if (action === 'reports' && req.method === 'POST') {
    const data = await body(req);
    const message = String(data.message || '').trim();
    const shot = data.screenshot || null;
    if (
      message.length < 5 ||
      message.length > 2000 ||
      (shot &&
        (typeof shot !== 'string' ||
          shot.length > 85000 ||
          !/^data:image\/jpeg;base64,\/9j\/[a-zA-Z0-9+/=]+$/.test(shot)))
    ) {
      throw fail(400, 'Check the description and screenshot.');
    }

    const recent = (
      await pool.query(
        "SELECT count(*)::int AS count FROM release_reports WHERE project_id=$1 AND created_at>now()-interval '1 hour'",
        [id]
      )
    ).rows[0];
    if (recent.count >= 60) {
      throw fail(429, 'The report inbox is busy. Please try again later.');
    }

    const q = await pool.query(
      'INSERT INTO release_reports(project_id,version,message,screenshot) SELECT project_id,version,$3,$4 FROM project_releases WHERE project_id=$1 AND id=$2 RETURNING id, version',
      [id, /^\d+$/.test(data.release) ? data.release : '0', message, shot]
    );
    if (!q.rowCount) throw fail(404, 'Release unavailable');

    sendTelegramAlert(
      pool,
      `New bug report #${q.rows[0].id}\nProject: ${p.title}\nVersion: ${q.rows[0].version}\nMessage: ${message}`
    ).catch(() => {});

    send(res, 201, { id: q.rows[0].id });
    return true;
  }

  if (req.method !== 'GET' || action === 'reports') return false;

  if (['youtube', 'qr'].includes(action)) {
    await pool.query(
      'INSERT INTO project_visits(project_id,source) VALUES($1,$2) ON CONFLICT(project_id,source) DO UPDATE SET visits=project_visits.visits+1',
      [id, action]
    );
    res.writeHead(302, { location: `/projects/${slugOrId}`, 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  if (action === 'qr.png') {
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=3600',
    });
    res.end(await QRCode.toBuffer(`${base}/qr`, { width: 320, margin: 2 }));
    return true;
  }

  const rows = (
    await pool.query(
      'SELECT id,version,notes,published_at,channel FROM project_releases WHERE project_id=$1 ORDER BY published_at DESC,id DESC LIMIT 100',
      [id]
    )
  ).rows;
  const e = escapeText;
  const stamp = (r) => new Date(r.published_at).toISOString();

  res.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
  res.end(
    '<?xml version="1.0"?>' +
      '<feed xmlns="http://www.w3.org/2005/Atom">' +
      `<title>${e(p.title)} updates</title>` +
      `<id>${e(base)}</id>` +
      `<link rel="self" href="${e(base)}/updates.atom"/>` +
      '<author><name>ZUTECHSAM</name></author>' +
      `<updated>${rows.length ? stamp(rows[0]) : '1970-01-01T00:00:00Z'}</updated>` +
      rows
        .map(
          (r) =>
            `<entry><title>${e(r.version)} · ${e(r.channel)}</title>` +
            `<id>${e(base)}#release-${r.id}</id>` +
            `<link href="${e(base)}#release-${r.id}"/>` +
            `<updated>${stamp(r)}</updated>` +
            `<summary>${e(r.notes)}</summary></entry>`
        )
        .join('') +
      '</feed>'
  );
  return true;
}
