import { projectPage, sampleHtml, sampleFor } from './project-page.js';
import { releaseSchema, publicProjects, releaseView, releaseApi } from './releases.js';
import {
  directory as uploadDir,
  apkMB,
  startUpload,
  writePart,
  cleanStaging,
  uploadPosition,
  mediaId,
} from './uploads.js';
import {
  centerSchema,
  centerApi,
  indexPackages,
  getOrigin,
  resolvePublishedProject,
  sendTelegramAlert,
  escapeText,
} from './release-center.js';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import pathModule from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const port = Number(process.env.PORT || 3000);
const admin = process.env.SITE_MODE === 'admin';
const dbUrl = process.env.DATABASE_URL || '';
const isLocalDb = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

const pool = dbUrl
  ? new pg.Pool({
      connectionString: dbUrl,
      ssl: isLocalDb ? false : { rejectUnauthorized: false },
    })
  : null;

const assets = new Map(
  await Promise.all(
    [
      'icons.svg',
      'brand.svg',
      'public.css',
      'admin.css',
      'admin.js',
      'public.js',
      'release-admin.js',
      'center-admin.js',
      'center-public.js',
      'studio.webp',
      'agency.webp',
      'AI.webp',
      'Games.webp',
      'Websites.webp',
    ].map(async (name) => ['/' + name, await readFile(new URL('./' + name, import.meta.url))])
  )
);

if (admin) {
  setInterval(() => cleanStaging().catch(console.error), 3600000).unref();
}

const mediaOrigin = (process.env.MEDIA_BASE_URL || '').replace(/\/$/, '');
const mediaTypes = {
  '.zip': 'application/zip',
  '.aab': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.apk': 'application/vnd.android.package-archive',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const html = await readFile(new URL(admin ? './admin.html' : './index.html', import.meta.url));

const send = (res, status, data) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
};

const clean = (s) => String(s || '').trim();
const hash = (p, s) => scryptSync(p, s, 64).toString('hex');

const slugify = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const rateBuckets = new Map();
function allowRequest(key, maxCount, windowMs) {
  const now = Date.now();
  const entry = rateBuckets.get(key);
  if (!entry || entry.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxCount) return false;
  entry.count += 1;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (v.resetAt <= now) rateBuckets.delete(k);
  }
}, 300000).unref();

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function resolvePublicMedia(value) {
  if (!mediaOrigin || !value) return value;
  return String(value).startsWith('/media/') ? `${mediaOrigin}${value}` : value;
}

function rewriteProjectMedia(p) {
  if (!mediaOrigin || !p) return p;
  return {
    ...p,
    image_url: resolvePublicMedia(p.image_url),
    apk_url: resolvePublicMedia(p.apk_url),
    screenshots: Array.isArray(p.screenshots)
      ? p.screenshots.map(resolvePublicMedia)
      : p.screenshots,
    attachments: Array.isArray(p.attachments)
      ? p.attachments.map((f) => ({ ...f, url: resolvePublicMedia(f.url) }))
      : p.attachments,
  };
}

async function uniqueSlug(db, desired, title, excludeId = null) {
  const base = slugify(desired || title) || 'project';
  let candidate = base;
  for (let i = 0; i < 20; i++) {
    const q = await db.query(
      'SELECT id FROM projects WHERE slug=$1 AND ($2::bigint IS NULL OR id<>$2)',
      [candidate, excludeId]
    );
    if (!q.rowCount) return candidate;
    candidate = `${base.slice(0, 72)}-${i + 2}`;
  }
  return `${base.slice(0, 68)}-${Date.now().toString(36)}`;
}

async function init() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS studio_settings(id INTEGER PRIMARY KEY, data JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      demo_url TEXT NOT NULL DEFAULT '',
      apk_url TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL DEFAULT '',
      featured BOOLEAN NOT NULL DEFAULT false,
      published BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS screenshots JSONB NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS release_notes TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS slug TEXT,
      ADD COLUMN IF NOT EXISTS tech_stack TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS highlights JSONB NOT NULL DEFAULT '[]';
    CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_unique ON projects(slug) WHERE slug IS NOT NULL AND slug <> '';
    CREATE TABLE IF NOT EXISTS enquiries(
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE enquiries
      ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS budget TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS admins(
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions(
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions(expires_at);
    ${releaseSchema};
    ${centerSchema}
  `);

  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    const salt = randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO admins(username,salt,password_hash)
       VALUES($1,$2,$3)
       ON CONFLICT(username) DO UPDATE SET salt=excluded.salt, password_hash=excluded.password_hash`,
      [clean(process.env.ADMIN_USERNAME), salt, hash(process.env.ADMIN_PASSWORD, salt)]
    );
  }

  if (admin) {
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM projects');
    if (count.rows[0].n === 0) {
      const demos = [
        [
          'ZUTECHSAM Android App',
          'zutechsam-android-app',
          'Apps',
          'Android app UI showcase — sample portfolio entry',
          'TEST PROJECT: A sample Android application concept for testing the portfolio gallery and admin workflow. No APK has been uploaded.',
          'Kotlin · Jetpack Compose · Material 3',
          JSON.stringify(['Offline task checklist', 'Clean adaptive UI', 'Versioned APK rollout']),
        ],
        [
          'Arcade Game Concept',
          'arcade-game-concept',
          'Games',
          'Mobile game interface and gameplay concept',
          'TEST PROJECT: A sample game development portfolio card. Gameplay and downloadable builds are not available yet.',
          'HTML5 Canvas · JavaScript · WebAudio',
          JSON.stringify(['Low-latency touch reaction loop', 'Zero external dependencies', '60fps frame timing']),
        ],
        [
          'AI Assistant Prototype',
          'ai-assistant-prototype',
          'AI',
          'AI assistant and automation concept',
          'TEST PROJECT: Sample AI and automation showcase. This is a placeholder, not a live AI service.',
          'Node.js · PostgreSQL · NLP Pipelines',
          JSON.stringify(['Instant keyword frequency analysis', 'Unicode multi-language tokenization', 'Exportable workflow output']),
        ],
        [
          'Business Website Design',
          'business-website-design',
          'Websites',
          'Responsive website design concept',
          'TEST PROJECT: Sample website showcase for testing project categories and detail pages. No live demo is attached.',
          'HTML5 · CSS Grid · Responsive Design',
          JSON.stringify(['Interactive brand palette switcher', 'Mobile-first layout', 'Fast zero-bundle delivery']),
        ],
      ];
      for (const d of demos) {
        await pool.query(
          'INSERT INTO projects(title,slug,category,summary,description,tech_stack,highlights,featured,published) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,false,true)',
          d
        );
      }
      console.log('Inserted four labeled test projects');
    }

    // Backfill slugs for any legacy projects missing one
    const missingSlugs = (
      await pool.query("SELECT id, title FROM projects WHERE slug IS NULL OR slug=''")
    ).rows;
    for (const row of missingSlugs) {
      const s = await uniqueSlug(pool, '', row.title, row.id);
      await pool.query('UPDATE projects SET slug=$1 WHERE id=$2', [s, row.id]);
    }
  }
}

init()
  .then(() => {
    if (!pool) return;
    if (admin) {
      async function scan() {
        try {
          await indexPackages(pool);
        } catch (error) {
          console.error(error.message);
        } finally {
          setTimeout(scan, 60000).unref();
        }
      }
      scan();

      setInterval(() => {
        pool.query('DELETE FROM admin_sessions WHERE expires_at <= now()').catch(() => {});
      }, 3600000).unref();
    }
  })
  .catch((e) => console.error('Database initialization failed:', e.message));

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100000) throw Error('Request too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const token = (req) => (req.headers.authorization || '').replace(/^Bearer /, '').trim();

async function getAdminSession(req) {
  const t = token(req);
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  const q = await pool.query(
    'SELECT username FROM admin_sessions WHERE token=$1 AND expires_at > now()',
    [t]
  );
  return q.rows[0] || null;
}

const urlOk = (s) => {
  if (!s) return true;
  if (s.length >= 1500) return false;
  if (s.startsWith('/media/')) {
    return mediaId.test(s.slice('/media/'.length));
  }
  try {
    const parsed = new URL(s);
    if (parsed.protocol === 'https:') return true;
    return (
      parsed.protocol === 'http:' &&
      /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(parsed.host)
    );
  } catch {
    return false;
  }
};

const pageCsp =
  "default-src 'self' https: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'";

const detailCsp =
  "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-src 'self' https://www.youtube-nocookie.com; media-src 'self' https:; frame-ancestors 'none'";

http
  .createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;

      if (assets.has(path)) {
        const contentType = path.endsWith('.svg')
          ? 'image/svg+xml'
          : path.endsWith('.webp')
            ? 'image/webp'
            : path.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'text/javascript; charset=utf-8';
        res.writeHead(200, {
          'content-type': contentType,
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        });
        return res.end(assets.get(path));
      }

      if (path === '/health') {
        return send(res, 200, { ok: true, mode: admin ? 'admin' : 'public', database: !!pool });
      }

      if (path === '/robots.txt' && req.method === 'GET' && !admin) {
        const origin = getOrigin(req);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
      }

      if (path === '/' || path === '/index.html') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': pageCsp,
          'x-content-type-options': 'nosniff',
        });
        return res.end(html);
      }

      if (
        /^\/media\/[a-f0-9]{40}\.(apk|aab|zip|pdf|png|jpg|jpeg|webp)$/.test(path) &&
        ['GET', 'HEAD'].includes(req.method)
      ) {
        if (!admin) {
          if (!mediaOrigin) {
            return send(res, 503, { error: 'MEDIA_BASE_URL is not configured' });
          }
          res.writeHead(302, {
            location: mediaOrigin + path,
            'cache-control': 'public, max-age=300',
          });
          return res.end();
        }

        try {
          const name = pathModule.basename(path);
          const file = pathModule.join(uploadDir, name);
          const info = await stat(file);
          const headers = {
            'content-type': mediaTypes[pathModule.extname(name)],
            'accept-ranges': 'bytes',
            'x-content-type-options': 'nosniff',
            'content-disposition': /\.(apk|zip|aab|pdf)$/.test(name)
              ? `attachment; filename="zutechsam-release${pathModule.extname(name)}"`
              : 'inline',
            'cache-control': 'public, max-age=31536000, immutable',
          };

          const suggested = new URL(req.url, 'http://localhost').searchParams.get('download');
          if (suggested && /\.(zip|aab|pdf)$/.test(name)) {
            const filename = pathModule
              .basename(suggested)
              .replace(/[^a-zA-Z0-9._ -]/g, '_')
              .slice(0, 180);
            if (
              filename &&
              pathModule.extname(filename).toLowerCase() === pathModule.extname(name)
            ) {
              headers['content-disposition'] = `attachment; filename="${filename}"`;
            }
          }

          let start = 0;
          let end = info.size - 1;
          const range = req.headers.range;
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (match && match[1]) {
              start = Number(match[1]);
              if (match[2]) end = Math.min(end, Number(match[2]));
            } else if (match && match[2]) {
              start = Math.max(0, info.size - Number(match[2]));
            }
            if (!match || (!match[1] && !match[2]) || start > end || start >= info.size) {
              res.writeHead(416, { 'content-range': `bytes */${info.size}` });
              return res.end();
            }
            headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
          }

          res.writeHead(range ? 206 : 200, {
            ...headers,
            'content-length': end - start + 1,
          });
          if (req.method === 'HEAD') return res.end();
          await pipeline(createReadStream(file, { start, end }), res).catch(() => {});
          return;
        } catch {
          return send(res, 404, { error: 'File not found' });
        }
      }

      if (!pool) {
        return send(res, 503, { error: 'Database is not configured. Add DATABASE_URL.' });
      }

      if (path === '/sitemap.xml' && req.method === 'GET' && !admin) {
        const origin = getOrigin(req);
        const rows = (
          await pool.query(
            'SELECT id, slug, created_at FROM projects WHERE published=true ORDER BY created_at DESC LIMIT 500'
          )
        ).rows;
        const urls = [
          `<url><loc>${escapeText(origin)}/</loc><changefreq>weekly</changefreq></url>`,
          ...rows.map(
            (r) =>
              `<url><loc>${escapeText(origin)}/projects/${escapeText(
                r.slug || r.id
              )}</loc><lastmod>${new Date(r.created_at).toISOString()}</lastmod></url>`
          ),
        ];
        res.writeHead(200, {
          'content-type': 'application/xml; charset=utf-8',
          'cache-control': 'public, max-age=600',
        });
        return res.end(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join(
            ''
          )}</urlset>`
        );
      }

      if (!admin && (await centerApi(path, req, res, { pool, body, send, admin }))) return;

      const releaseDownload =
        !admin && /^\/projects\/([a-zA-Z0-9-]+)\/releases\/(\d+)\/download$/.exec(path);
      if (releaseDownload && ['GET', 'HEAD'].includes(req.method)) {
        const project = await resolvePublishedProject(pool, releaseDownload[1]);
        if (!project) return send(res, 404, { error: 'Release unavailable' });
        const sql =
          req.method === 'GET'
            ? 'UPDATE project_releases SET download_clicks=download_clicks+1 WHERE id=$2 AND project_id=$1 RETURNING id, url'
            : 'SELECT id, url FROM project_releases WHERE id=$2 AND project_id=$1';
        const r = await pool.query(sql, [project.id, releaseDownload[2]]);
        if (!r.rowCount) return send(res, 404, { error: 'Release unavailable' });
        if (req.method === 'GET') {
          pool
            .query('INSERT INTO download_events(project_id, release_id) VALUES($1,$2)', [
              project.id,
              r.rows[0].id,
            ])
            .catch(() => {});
        }
        res.writeHead(302, {
          location: resolvePublicMedia(r.rows[0].url),
          'cache-control': 'no-store',
        });
        return res.end();
      }

      const projectRoute =
        !admin && /^\/projects\/([a-zA-Z0-9-]+)(?:\/(demo|sample\.html))?\/?$/.exec(path);
      if (projectRoute && req.method === 'GET') {
        const project = await resolvePublishedProject(pool, projectRoute[1]);
        const sample = project && sampleFor(project);
        const mode = projectRoute[2];
        if (!project || (mode && !sample)) {
          return send(res, 404, { error: 'Project or demo unavailable' });
        }

        const headers = {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          'content-security-policy': mode
            ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'"
            : detailCsp,
        };
        if (mode === 'sample.html') {
          headers['content-disposition'] =
            `attachment; filename="studio-demo-${project.id}.html"`;
        }
        res.writeHead(200, headers);
        return res.end(
          mode
            ? sampleHtml(sample)
            : await releaseView(pool, rewriteProjectMedia(project), null, getOrigin(req))
        );
      }

      if (path === '/api/studio' && req.method === 'GET') {
        const result = await pool.query('SELECT data FROM studio_settings WHERE id=1');
        const d = result.rows[0]?.data || {};
        return send(res, 200, {
          headline: d.headline || '',
          intro: d.intro || '',
          email: d.email || '',
        });
      }

      if (path === '/api/projects' && req.method === 'GET') {
        const q = await pool.query(
          `${publicProjects} WHERE p.published=true ORDER BY p.featured DESC, p.created_at DESC LIMIT 500`
        );
        return send(
          res,
          200,
          q.rows.map((row) => {
            const p = rewriteProjectMedia(row);
            return {
              ...p,
              demo_link: p.demo_url || (sampleFor(p) ? `/projects/${p.slug || p.id}/demo` : null),
            };
          })
        );
      }

      if (path === '/api/enquiries' && req.method === 'POST' && !admin) {
        if (!allowRequest(`enquiry:${clientIp(req)}`, 15, 3600000)) {
          return send(res, 429, { error: 'Too many enquiries sent. Please try again later.' });
        }
        const b = await body(req);
        if (
          !clean(b.name) ||
          !/^\S+@\S+\.\S+$/.test(clean(b.email)) ||
          !clean(b.message) ||
          clean(b.message).length > 5000
        ) {
          return send(res, 400, { error: 'Please provide valid name, email and message' });
        }
        const name = clean(b.name).slice(0, 120);
        const email = clean(b.email).slice(0, 200);
        const service = clean(b.service).slice(0, 100);
        const budget = clean(b.budget).slice(0, 80);
        const message = clean(b.message);

        await pool.query(
          'INSERT INTO enquiries(name,email,service,budget,message) VALUES($1,$2,$3,$4,$5)',
          [name, email, service, budget, message]
        );

        sendTelegramAlert(
          pool,
          `New client enquiry\nName: ${name}\nEmail: ${email}\nService: ${service}${
            budget ? `\nBudget: ${budget}` : ''
          }\nMessage: ${message}`
        ).catch(() => {});

        return send(res, 201, { ok: true });
      }

      if (!admin) return send(res, 404, { error: 'Not found' });

      if (path === '/api/login' && req.method === 'POST') {
        if (!allowRequest(`login:${clientIp(req)}`, 10, 900000)) {
          return send(res, 429, { error: 'Too many login attempts. Wait 15 minutes and retry.' });
        }
        const b = await body(req);
        const q = await pool.query('SELECT * FROM admins WHERE username=$1', [clean(b.username)]);
        const a = q.rows[0];
        const candidate = Buffer.from(
          hash(String(b.password || ''), a?.salt || '0'.repeat(32)),
          'hex'
        );
        const expected = a ? Buffer.from(a.password_hash, 'hex') : null;
        if (!a || expected.length !== candidate.length || !timingSafeEqual(candidate, expected)) {
          return send(res, 401, { error: 'Invalid credentials' });
        }
        const t = randomBytes(32).toString('hex');
        await pool.query(
          "INSERT INTO admin_sessions(token,username,expires_at) VALUES($1,$2,now() + interval '8 hours')",
          [t, a.username]
        );
        return send(res, 200, { token: t });
      }

      if (path === '/api/logout' && req.method === 'POST') {
        const t = token(req);
        if (t) await pool.query('DELETE FROM admin_sessions WHERE token=$1', [t]);
        return send(res, 200, { ok: true });
      }

      const session = await getAdminSession(req);
      if (!session) return send(res, 401, { error: 'Login required' });

      if (await centerApi(path, req, res, { pool, body, send, admin })) return;
      if (await releaseApi(path, req, res, { pool, body, send })) return;

      if (path.startsWith('/api/admin/uploads/') && req.method === 'GET') {
        const size = Number(new URL(req.url, 'http://localhost').searchParams.get('size'));
        return send(res, 200, await uploadPosition(path.split('/').pop(), size));
      }

      if (path === '/api/admin/studio' && req.method === 'GET') {
        const result = await pool.query('SELECT data FROM studio_settings WHERE id=1');
        const d = result.rows[0]?.data || {};
        return send(res, 200, {
          headline: d.headline || '',
          intro: d.intro || '',
          email: d.email || '',
          telegram_chat_id: d.telegram_chat_id || '',
          has_telegram_token: !!d.telegram_bot_token,
        });
      }

      if (path === '/api/admin/studio' && req.method === 'PUT') {
        const data = await body(req);
        const current =
          (await pool.query('SELECT data FROM studio_settings WHERE id=1')).rows[0]?.data || {};
        const settings = {
          headline: clean(data.headline),
          intro: clean(data.intro),
          email: clean(data.email),
          telegram_chat_id: clean(data.telegram_chat_id).slice(0, 80),
          telegram_bot_token: data.clear_telegram
            ? ''
            : clean(data.telegram_bot_token) || current.telegram_bot_token || '',
        };
        if (
          settings.headline.length > 90 ||
          settings.intro.length > 360 ||
          (settings.email && !/^\S+@\S+\.\S+$/.test(settings.email))
        ) {
          return send(res, 400, { error: 'Check headline, introduction and email' });
        }
        await pool.query(
          'INSERT INTO studio_settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',
          [settings]
        );
        return send(res, 200, { ok: true, has_telegram_token: !!settings.telegram_bot_token });
      }

      if (path === '/api/admin/telegram-test' && req.method === 'POST') {
        const result = await sendTelegramAlert(
          pool,
          `ZUTECHSAM Studio alert test (${new Date().toISOString()})`
        );
        if (!result.sent) {
          return send(res, 400, {
            error:
              result.reason === 'not_configured'
                ? 'Save a Telegram Bot Token and Chat ID first.'
                : `Telegram error: ${result.reason}`,
          });
        }
        return send(res, 200, { ok: true });
      }

      if (path === '/api/admin/password' && req.method === 'POST') {
        const data = await body(req);
        const currentPw = String(data.currentPassword || '');
        const nextPw = String(data.newPassword || '');
        if (nextPw.length < 8 || nextPw.length > 128) {
          return send(res, 400, { error: 'New password must be 8 to 128 characters.' });
        }
        const a = (
          await pool.query('SELECT * FROM admins WHERE username=$1', [session.username])
        ).rows[0];
        if (!a) return send(res, 404, { error: 'Account not found' });
        const candidate = Buffer.from(hash(currentPw, a.salt), 'hex');
        const expected = Buffer.from(a.password_hash, 'hex');
        if (expected.length !== candidate.length || !timingSafeEqual(candidate, expected)) {
          return send(res, 401, { error: 'Current password is incorrect.' });
        }
        const newSalt = randomBytes(16).toString('hex');
        await pool.query('UPDATE admins SET salt=$1, password_hash=$2 WHERE id=$3', [
          newSalt,
          hash(nextPw, newSalt),
          a.id,
        ]);
        return send(res, 200, { ok: true });
      }

      if (path === '/api/admin/backup' && req.method === 'GET') {
        const [proj, rel, enq, settings] = await Promise.all([
          pool.query('SELECT * FROM projects ORDER BY id'),
          pool.query('SELECT * FROM project_releases ORDER BY id'),
          pool.query('SELECT * FROM enquiries ORDER BY id'),
          pool.query('SELECT data FROM studio_settings WHERE id=1'),
        ]);
        const s = settings.rows[0]?.data || {};
        const payload = {
          exportedAt: new Date().toISOString(),
          studio: { headline: s.headline || '', intro: s.intro || '', email: s.email || '' },
          projects: proj.rows,
          releases: rel.rows,
          enquiries: enq.rows,
        };
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="zutechsam-backup-${new Date()
            .toISOString()
            .slice(0, 10)}.json"`,
          'cache-control': 'no-store',
        });
        return res.end(JSON.stringify(payload, null, 2));
      }

      if (path === '/api/admin/uploads' && req.method === 'GET') {
        return send(res, 200, { apkMB, imageMB: 100 });
      }

      if (path === '/api/admin/uploads' && req.method === 'POST') {
        const data = await body(req);
        return send(
          res,
          201,
          await startUpload(pathModule.extname(clean(data.filename).toLowerCase()), data.size)
        );
      }

      if (path.startsWith('/api/admin/uploads/') && req.method === 'PUT') {
        const params = new URL(req.url, 'http://localhost').searchParams;
        return send(
          res,
          200,
          await writePart(
            req,
            path.split('/').pop(),
            Number(params.get('size')),
            Number(params.get('offset'))
          )
        );
      }

      if (path === '/api/admin/upload' && req.method === 'POST') {
        const total = Number(req.headers['content-length']);
        const { id } = await startUpload(
          pathModule.extname(clean(req.headers['x-filename']).toLowerCase()),
          total
        );
        const result = await writePart(req, id, total, 0, total);
        return send(
          res,
          result.url ? 201 : 400,
          result.url ? { ok: true, url: result.url } : { error: 'Incomplete upload' }
        );
      }

      if (path === '/api/admin/projects' && req.method === 'GET') {
        const q = await pool.query(`
          SELECT p.*,
            (
              SELECT count(DISTINCT url)::int FROM (
                SELECT NULLIF(p.apk_url, '') AS url
                UNION ALL SELECT file->>'url' FROM jsonb_array_elements(p.attachments) AS file
                UNION ALL SELECT r.url FROM project_releases r WHERE r.project_id=p.id
              ) downloads
            ) AS file_count,
            (SELECT count(*)::int FROM project_releases r WHERE r.project_id=p.id) AS release_count,
            (SELECT COALESCE(SUM(r.download_clicks),0)::int FROM project_releases r WHERE r.project_id=p.id) AS downloads_total
          FROM projects p
          ORDER BY p.created_at DESC
          LIMIT 500
        `);
        return send(res, 200, q.rows);
      }

      if (path === '/api/admin/enquiries' && req.method === 'GET') {
        const q = await pool.query('SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 500');
        return send(res, 200, q.rows);
      }

      if (
        (path === '/api/admin/projects' && req.method === 'POST') ||
        (/^\/api\/admin\/projects\/\d+$/.test(path) && ['PUT', 'DELETE'].includes(req.method))
      ) {
        const id = Number(path.split('/').pop());
        if (req.method === 'DELETE') {
          await pool.query('DELETE FROM projects WHERE id=$1', [id]);
          return send(res, 200, { ok: true });
        }

        const b = await body(req);
        if (
          !clean(b.title) ||
          !clean(b.category) ||
          !['Apps', 'Games', 'AI', 'Websites', 'Software'].includes(b.category) ||
          !['image_url', 'demo_url', 'apk_url', 'video_url'].every((k) => urlOk(clean(b[k])))
        ) {
          return send(res, 400, {
            error: 'Title, valid category and valid HTTPS/media URLs required',
          });
        }

        const screenshots = b.screenshots;
        if (
          screenshots !== undefined &&
          (!Array.isArray(screenshots) ||
            screenshots.length > 6 ||
            !screenshots.every((u) => typeof u === 'string' && u && urlOk(u)))
        ) {
          return send(res, 400, { error: 'Use up to six valid screenshot URLs' });
        }

        const highlights = b.highlights;
        if (
          highlights !== undefined &&
          (!Array.isArray(highlights) ||
            highlights.length > 8 ||
            !highlights.every((h) => typeof h === 'string' && h.trim() && h.length <= 160))
        ) {
          return send(res, 400, { error: 'Use up to 8 highlights (max 160 chars each)' });
        }

        const attachments = b.attachments;
        if (
          attachments !== undefined &&
          (!Array.isArray(attachments) ||
            attachments.length > 12 ||
            attachments.some(
              (f) =>
                !f ||
                typeof f.name !== 'string' ||
                !f.name.trim() ||
                f.name.length > 240 ||
                typeof f.url !== 'string' ||
                !f.url ||
                !urlOk(f.url) ||
                !Number.isSafeInteger(f.size) ||
                f.size < 0
            ))
        ) {
          return send(res, 400, { error: 'Use up to 12 named files with valid URLs' });
        }

        const slug = await uniqueSlug(
          pool,
          clean(b.slug),
          clean(b.title),
          req.method === 'PUT' ? id : null
        );

        const vals = [
          clean(b.title).slice(0, 150),
          b.category,
          clean(b.summary).slice(0, 400),
          clean(b.description).slice(0, 10000),
          clean(b.image_url),
          clean(b.demo_url),
          clean(b.apk_url),
          clean(b.video_url),
          !!b.featured,
          b.published !== false,
          clean(b.version).slice(0, 60),
          screenshots === undefined ? null : JSON.stringify(screenshots),
          b.release_notes === undefined ? null : clean(b.release_notes).slice(0, 4000),
          attachments === undefined ? null : JSON.stringify(attachments),
          slug,
          clean(b.tech_stack).slice(0, 240),
          highlights === undefined ? null : JSON.stringify(highlights.map((h) => h.trim())),
        ];

        if (req.method === 'POST') {
          await pool.query(
            'INSERT INTO projects(title,category,summary,description,image_url,demo_url,apk_url,video_url,featured,published,version,screenshots,release_notes,attachments,slug,tech_stack,highlights) VALUES(' +
              vals
                .map((_, i) =>
                  i === 13 || i === 16
                    ? `coalesce($${i + 1}::jsonb,'[]'::jsonb)`
                    : i === 11
                      ? "coalesce($12::jsonb,'[]'::jsonb)"
                      : i === 12
                        ? "coalesce($13,'')"
                        : '$' + (i + 1)
                )
                .join(',') +
              ')',
            vals
          );
        } else {
          await pool.query(
            'UPDATE projects SET title=$1,category=$2,summary=$3,description=$4,image_url=$5,demo_url=$6,apk_url=$7,video_url=$8,featured=$9,published=$10,version=$11,screenshots=coalesce($12::jsonb,screenshots),release_notes=coalesce($13,release_notes),attachments=coalesce($14::jsonb,attachments),slug=$15,tech_stack=$16,highlights=coalesce($17::jsonb,highlights) WHERE id=$18',
            [...vals, id]
          );
        }
        return send(res, 200, { ok: true });
      }

      if (/^\/api\/admin\/enquiries\/\d+$/.test(path) && req.method === 'PATCH') {
        const b = await body(req);
        const enquiryId = Number(path.split('/').pop());
        if (b.status !== undefined && !['new', 'contacted', 'quoted', 'closed'].includes(b.status)) {
          return send(res, 400, { error: 'Invalid status' });
        }
        const notes = b.notes === undefined ? null : clean(b.notes).slice(0, 2000);
        const status = b.status === undefined ? null : b.status;
        await pool.query(
          'UPDATE enquiries SET status=coalesce($1,status), notes=coalesce($2,notes) WHERE id=$3',
          [status, notes, enquiryId]
        );
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      console.error(e);
      send(res, e.status || (e.message === 'Request too large' ? 413 : 500), {
        error: e.status || e.message === 'Request too large' ? e.message : 'Server error',
      });
    }
  })
  .listen(port, '0.0.0.0', () =>
    console.log(`ZUTECHSAM ${admin ? 'admin' : 'public'} listening ${port}`)
  );
