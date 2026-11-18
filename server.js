import { projectPage, releasesPage, sampleHtml, sampleFor } from './project-page.js';
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
  resolvePreviewProject,
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
      'theme.js',
      'release-admin.js',
      'center-admin.js',
      'center-public.js',
      'studio.webp',
      'agency.webp',
      'AI.webp',
      'Games.webp',
      'Websites.webp',
      'manifest.webmanifest',
      'sw.js',
      'pwa-192x192.png',
      'pwa-512x512.png',
      'pwa-maskable-512x512.png',
      'apple-touch-icon.png',
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
      ADD COLUMN IF NOT EXISTS highlights JSONB NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS preview_token TEXT,
      ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS demo_html TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS metrics JSONB NOT NULL DEFAULT '[]';
    CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_unique ON projects(slug) WHERE slug IS NOT NULL AND slug <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS projects_preview_token_unique ON projects(preview_token) WHERE preview_token IS NOT NULL AND preview_token <> '';
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
      ADD COLUMN IF NOT EXISTS budget TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS follow_up_at DATE;
    CREATE TABLE IF NOT EXISTS admins(
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    ALTER TABLE admins
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS admin_sessions(
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE admin_sessions
      ADD COLUMN IF NOT EXISTS ip TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS admin_audit_logs(
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      success BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS testimonials(
      id BIGSERIAL PRIMARY KEY,
      author_name TEXT NOT NULL,
      author_role TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      quote TEXT NOT NULL,
      rating INTEGER NOT NULL DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),
      published BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS faqs(
      id BIGSERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      published BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS project_reviews(
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL,
      approved BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS beta_signups(
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      device TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(project_id, email)
    );
    ${releaseSchema};
    ${centerSchema}
  `);

  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    const salt = randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO admins(username,salt,password_hash,role)
       VALUES($1,$2,$3,'owner')
       ON CONFLICT(username) DO UPDATE SET salt=excluded.salt, password_hash=excluded.password_hash, role='owner'`,
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
          JSON.stringify([
            { label: 'Offline sync', value: '100%' },
            { label: 'Cold launch', value: '< 0.8s' },
          ]),
        ],
        [
          'Arcade Game Concept',
          'arcade-game-concept',
          'Games',
          'Mobile game interface and gameplay concept',
          'TEST PROJECT: A sample game development portfolio card. Gameplay and downloadable builds are not available yet.',
          'HTML5 Canvas · JavaScript · WebAudio',
          JSON.stringify(['Low-latency touch reaction loop', 'Zero external dependencies', '60fps frame timing']),
          JSON.stringify([
            { label: 'Frame budget', value: '16.6ms' },
            { label: 'Runtime size', value: '42 KB' },
          ]),
        ],
        [
          'AI Assistant Prototype',
          'ai-assistant-prototype',
          'AI',
          'AI assistant and automation concept',
          'TEST PROJECT: Sample AI and automation showcase. This is a placeholder, not a live AI service.',
          'Node.js · PostgreSQL · NLP Pipelines',
          JSON.stringify(['Instant keyword frequency analysis', 'Unicode multi-language tokenization', 'Exportable workflow output']),
          JSON.stringify([
            { label: 'Token throughput', value: '12k/s' },
            { label: 'Accuracy', value: '98.4%' },
          ]),
        ],
        [
          'Business Website Design',
          'business-website-design',
          'Websites',
          'Responsive website design concept',
          'TEST PROJECT: Sample website showcase for testing project categories and detail pages. No live demo is attached.',
          'HTML5 · CSS Grid · Responsive Design',
          JSON.stringify(['Interactive brand palette switcher', 'Mobile-first layout', 'Fast zero-bundle delivery']),
          JSON.stringify([
            { label: 'Lighthouse', value: '99/100' },
            { label: 'First paint', value: '0.4s' },
          ]),
        ],
      ];
      for (const d of demos) {
        await pool.query(
          'INSERT INTO projects(title,slug,category,summary,description,tech_stack,highlights,metrics,featured,published) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,false,true)',
          d
        );
      }
      console.log('Inserted four labeled test projects');
    }
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

async function body(req, maxBytes = 100000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw Error('Request too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const token = (req) => (req.headers.authorization || '').replace(/^Bearer /, '').trim();

async function getAdminSession(req) {
  const t = token(req);
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  const q = await pool.query(
    `SELECT s.token, s.username, COALESCE(a.role, 'owner') AS role
     FROM admin_sessions s
     LEFT JOIN admins a ON a.username=s.username
     WHERE s.token=$1 AND s.expires_at > now()`,
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

function parsePublishAt(raw) {
  if (raw === undefined) return undefined;
  if (!raw) return null;
  const dt = new Date(raw);
  if (!Number.isFinite(dt.getTime())) {
    const err = Error('Invalid schedule timestamp');
    err.status = 400;
    throw err;
  }
  return dt.toISOString();
}

const pageCsp =
  "default-src 'self' https: data:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'";
const detailCsp =
  "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-src 'self' https://www.youtube-nocookie.com; media-src 'self' https:; frame-ancestors 'none'";
const demoCsp =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'self'";

function assetType(path) {
  if (path.endsWith('.webmanifest')) return 'application/manifest+json; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/javascript; charset=utf-8';
}

http
  .createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;

      if (assets.has(path)) {
        const headers = {
          'content-type': assetType(path),
          'cache-control': path === '/sw.js' ? 'no-cache' : 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        };
        if (path === '/sw.js') headers['service-worker-allowed'] = '/';
        res.writeHead(200, headers);
        return res.end(assets.get(path));
      }

      if (path === '/health') {
        return send(res, 200, { ok: true, mode: admin ? 'admin' : 'public', database: !!pool });
      }

      if (path === '/robots.txt' && req.method === 'GET' && !admin) {
        const origin = getOrigin(req);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(
          `User-agent: *\nDisallow: /preview/\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`
        );
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
          headers['content-length'] = end - start + 1;
          res.writeHead(range ? 206 : 200, headers);
          if (req.method === 'HEAD') return res.end();
          await pipeline(createReadStream(file, { start, end }), res);
          return;
        } catch (e) {
          if (e.code === 'ENOENT') return send(res, 404, { error: 'Not found' });
          throw e;
        }
      }

      if (!pool) return send(res, 503, { error: 'DATABASE_URL is not configured' });

      if (!admin && path === '/sitemap.xml' && req.method === 'GET') {
        const origin = getOrigin(req);
        const rows = (
          await pool.query(
            'SELECT id, slug, created_at FROM projects WHERE published=true AND (publish_at IS NULL OR publish_at <= now()) ORDER BY created_at DESC LIMIT 500'
          )
        ).rows;
        const urls = [
          `<url><loc>${escapeText(origin)}/</loc><changefreq>weekly</changefreq></url>`,
          `<url><loc>${escapeText(origin)}/releases</loc><changefreq>daily</changefreq></url>`,
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

      if (!admin && path === '/releases' && req.method === 'GET') {
        const rows = (
          await pool.query(`
            SELECT r.*, p.title AS project_title, p.slug AS project_slug, p.category AS project_category, p.image_url AS project_image_url
            FROM project_releases r
            JOIN projects p ON p.id=r.project_id
            WHERE p.published=true
              AND (p.publish_at IS NULL OR p.publish_at <= now())
              AND (r.publish_at IS NULL OR r.publish_at <= now())
            ORDER BY r.published_at DESC, r.id DESC
            LIMIT 200
          `)
        ).rows.map((r) => ({ ...r, project_image_url: resolvePublicMedia(r.project_image_url) }));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': detailCsp,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        return res.end(releasesPage(rows, { origin: getOrigin(req) }));
      }

      // Private Draft Client Preview (/preview/:token)
      const previewRoute =
        !admin && /^\/preview\/([a-f0-9]{32})(?:\/(demo|sample\.html))?\/?$/.exec(path);
      if (previewRoute && req.method === 'GET') {
        const project = await resolvePreviewProject(pool, previewRoute[1]);
        const sample = project && sampleFor(project);
        const mode = previewRoute[2];
        if (!project || (mode && !sample)) {
          return send(res, 404, { error: 'Preview link expired or unavailable' });
        }
        const headers = {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'x-robots-tag': 'noindex, nofollow',
          'cache-control': 'no-store',
          'content-security-policy': mode ? demoCsp : detailCsp,
        };
        if (mode === 'sample.html') {
          headers['content-disposition'] = `attachment; filename="studio-demo-${project.id}.html"`;
        }
        res.writeHead(200, headers);
        return res.end(
          mode
            ? sampleHtml(sample)
            : await releaseView(pool, rewriteProjectMedia(project), null, getOrigin(req), {
                isDraftPreview: true,
                draftPreviewToken: previewRoute[1],
              })
        );
      }

      // Public project reviews & beta signup
      const communityMatch =
        !admin && /^\/projects\/([a-zA-Z0-9-]+)\/(reviews|beta)$/.exec(path);
      if (communityMatch && req.method === 'POST') {
        const [, key, action] = communityMatch;
        const project = await resolvePublishedProject(pool, key);
        if (!project) return send(res, 404, { error: 'Project unavailable' });
        if (action === 'reviews') {
          if (!allowRequest(`review:${clientIp(req)}`, 10, 3600000)) {
            return send(res, 429, { error: 'Too many reviews submitted. Please try again later.' });
          }
          const b = await body(req);
          const author = clean(b.author_name);
          const rating = Number(b.rating);
          const comment = clean(b.comment);
          if (
            author.length < 2 ||
            author.length > 80 ||
            !Number.isInteger(rating) ||
            rating < 1 ||
            rating > 5 ||
            comment.length < 5 ||
            comment.length > 1000
          ) {
            return send(res, 400, { error: 'Enter your name, a 1–5 rating, and review comments.' });
          }
          const q = await pool.query(
            'INSERT INTO project_reviews(project_id,author_name,rating,comment,approved) VALUES($1,$2,$3,$4,false) RETURNING id',
            [project.id, author, rating, comment]
          );
          sendTelegramAlert(
            pool,
            `New project review (pending moderation)\nProject: ${project.title}\nBy: ${author} (${rating}/5)\nComment: ${comment}`
          ).catch(() => {});
          return send(res, 201, { ok: true, id: q.rows[0].id });
        }
        if (action === 'beta') {
          if (!allowRequest(`beta:${clientIp(req)}`, 15, 3600000)) {
            return send(res, 429, { error: 'Too many requests. Please try again later.' });
          }
          const b = await body(req);
          const email = clean(b.email).toLowerCase();
          const device = clean(b.device).slice(0, 120);
          if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) {
            return send(res, 400, { error: 'Enter a valid email address.' });
          }
          await pool.query(
            `INSERT INTO beta_signups(project_id,email,device)
             VALUES($1,$2,$3)
             ON CONFLICT(project_id,email) DO UPDATE SET device=excluded.device`,
            [project.id, email, device]
          );
          sendTelegramAlert(
            pool,
            `New Beta tester signup\nProject: ${project.title}\nEmail: ${email}${device ? `\nDevice: ${device}` : ''}`
          ).catch(() => {});
          return send(res, 201, { ok: true });
        }
      }

      if (!admin && (await centerApi(path, req, res, { pool, body, send, admin }))) return;

      const releaseDownload =
        !admin && /^\/projects\/([a-zA-Z0-9-]+)\/releases\/(\d+)\/download$/.exec(path);
      if (releaseDownload && ['GET', 'HEAD'].includes(req.method)) {
        const project = await resolvePublishedProject(pool, releaseDownload[1]);
        if (!project) return send(res, 404, { error: 'Release unavailable' });
        const sql =
          req.method === 'GET'
            ? 'UPDATE project_releases SET download_clicks=download_clicks+1 WHERE id=$2 AND project_id=$1 AND (publish_at IS NULL OR publish_at <= now()) RETURNING id, url'
            : 'SELECT id, url FROM project_releases WHERE id=$2 AND project_id=$1 AND (publish_at IS NULL OR publish_at <= now())';
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
          'content-security-policy': mode ? demoCsp : detailCsp,
        };
        if (mode === 'sample.html') {
          headers['content-disposition'] = `attachment; filename="studio-demo-${project.id}.html"`;
        }
        const reviews = mode
          ? []
          : (
              await pool.query(
                'SELECT id, author_name, rating, comment, created_at FROM project_reviews WHERE project_id=$1 AND approved=true ORDER BY id DESC LIMIT 40',
                [project.id]
              )
            ).rows;
        res.writeHead(200, headers);
        return res.end(
          mode
            ? sampleHtml(sample)
            : await releaseView(pool, rewriteProjectMedia(project), null, getOrigin(req), {
                reviews,
              })
        );
      }

      if (path === '/api/studio' && req.method === 'GET') {
        const [result, testimonials, faqs] = await Promise.all([
          pool.query('SELECT data FROM studio_settings WHERE id=1'),
          pool.query(
            'SELECT id, author_name, author_role, company, quote, rating FROM testimonials WHERE published=true ORDER BY sort_order ASC, id ASC LIMIT 24'
          ),
          pool.query(
            'SELECT id, question, answer FROM faqs WHERE published=true ORDER BY sort_order ASC, id ASC LIMIT 30'
          ),
        ]);
        const d = result.rows[0]?.data || {};
        return send(res, 200, {
          headline: d.headline || '',
          intro: d.intro || '',
          email: d.email || '',
          testimonials: testimonials.rows,
          faqs: faqs.rows,
        });
      }

      if (path === '/api/projects' && req.method === 'GET') {
        const q = await pool.query(
          `${publicProjects} WHERE p.published=true AND (p.publish_at IS NULL OR p.publish_at <= now()) ORDER BY p.featured DESC, p.created_at DESC LIMIT 500`
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
        const ip = clientIp(req);
        const ua = clean(req.headers['user-agent']).slice(0, 240);
        if (!allowRequest(`login:${ip}`, 10, 900000)) {
          return send(res, 429, { error: 'Too many login attempts. Wait 15 minutes and retry.' });
        }
        const b = await body(req);
        const uname = clean(b.username);
        const q = await pool.query('SELECT * FROM admins WHERE username=$1', [uname]);
        const a = q.rows[0];
        const candidate = Buffer.from(
          hash(String(b.password || ''), a?.salt || '0'.repeat(32)),
          'hex'
        );
        const expected = a ? Buffer.from(a.password_hash, 'hex') : null;
        if (!a || expected.length !== candidate.length || !timingSafeEqual(candidate, expected)) {
          pool
            .query('INSERT INTO admin_audit_logs(username,ip,user_agent,success) VALUES($1,$2,$3,false)', [
              uname || '(blank)',
              ip,
              ua,
            ])
            .catch(() => {});
          return send(res, 401, { error: 'Invalid credentials' });
        }
        const t = randomBytes(32).toString('hex');
        await pool.query(
          "INSERT INTO admin_sessions(token,username,ip,user_agent,expires_at) VALUES($1,$2,$3,$4,now() + interval '8 hours')",
          [t, a.username, ip, ua]
        );
        await pool.query(
          'INSERT INTO admin_audit_logs(username,ip,user_agent,success) VALUES($1,$2,$3,true)',
          [a.username, ip, ua]
        );
        return send(res, 200, { token: t, username: a.username, role: a.role || 'owner' });
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
          me: { username: session.username, role: session.role },
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

      // Team, Sessions & Audit logs
      if (path === '/api/admin/team' && req.method === 'GET') {
        const [members, sessions, auditLogs] = await Promise.all([
          pool.query('SELECT id, username, role, created_at FROM admins ORDER BY id'),
          pool.query(
            'SELECT left(token, 12) AS id_prefix, username, ip, user_agent, created_at, expires_at, (token=$1) AS current FROM admin_sessions WHERE expires_at > now() ORDER BY created_at DESC LIMIT 60',
            [session.token]
          ),
          pool.query(
            'SELECT id, username, ip, user_agent, success, created_at FROM admin_audit_logs ORDER BY id DESC LIMIT 60'
          ),
        ]);
        return send(res, 200, {
          me: { username: session.username, role: session.role },
          members: members.rows,
          sessions: sessions.rows,
          auditLogs: auditLogs.rows,
        });
      }

      if (path === '/api/admin/team' && req.method === 'POST') {
        if (session.role !== 'owner') {
          return send(res, 403, { error: 'Only owner accounts can add team members.' });
        }
        const b = await body(req);
        const username = clean(b.username).slice(0, 60);
        const password = String(b.password || '');
        const role = ['owner', 'editor'].includes(b.role) ? b.role : 'editor';
        if (!/^[a-zA-Z0-9._-]{3,60}$/.test(username) || password.length < 8 || password.length > 128) {
          return send(res, 400, {
            error: 'Use 3–60 username characters (letters, numbers, . _ -) and an 8+ character password.',
          });
        }
        const salt = randomBytes(16).toString('hex');
        try {
          await pool.query(
            'INSERT INTO admins(username,salt,password_hash,role) VALUES($1,$2,$3,$4)',
            [username, salt, hash(password, salt), role]
          );
        } catch (err) {
          if (err.code === '23505') return send(res, 409, { error: 'Username already exists.' });
          throw err;
        }
        return send(res, 201, { ok: true });
      }

      const teamDel = /^\/api\/admin\/team\/(\d+)$/.exec(path);
      if (teamDel && req.method === 'DELETE') {
        if (session.role !== 'owner') {
          return send(res, 403, { error: 'Only owner accounts can remove team members.' });
        }
        const q = await pool.query('SELECT username FROM admins WHERE id=$1', [teamDel[1]]);
        if (!q.rowCount) return send(res, 404, { error: 'Member not found' });
        if (q.rows[0].username === session.username) {
          return send(res, 400, { error: 'You cannot delete your own active account.' });
        }
        await pool.query('DELETE FROM admin_sessions WHERE username=$1', [q.rows[0].username]);
        await pool.query('DELETE FROM admins WHERE id=$1', [teamDel[1]]);
        return send(res, 200, { ok: true });
      }

      const sessDel = /^\/api\/admin\/sessions\/([a-f0-9]{12})$/.exec(path);
      if (sessDel && req.method === 'DELETE') {
        if (session.role !== 'owner') {
          await pool.query('DELETE FROM admin_sessions WHERE left(token,12)=$1 AND username=$2', [
            sessDel[1],
            session.username,
          ]);
        } else {
          await pool.query('DELETE FROM admin_sessions WHERE left(token,12)=$1', [sessDel[1]]);
        }
        return send(res, 200, { ok: true });
      }

      // Testimonials & FAQs CRUD
      if (path === '/api/admin/testimonials' && req.method === 'GET') {
        const q = await pool.query('SELECT * FROM testimonials ORDER BY sort_order ASC, id DESC');
        return send(res, 200, q.rows);
      }
      if (
        (path === '/api/admin/testimonials' && req.method === 'POST') ||
        (/^\/api\/admin\/testimonials\/\d+$/.test(path) && ['PUT', 'DELETE'].includes(req.method))
      ) {
        const tid = Number(path.split('/').pop());
        if (req.method === 'DELETE') {
          await pool.query('DELETE FROM testimonials WHERE id=$1', [tid]);
          return send(res, 200, { ok: true });
        }
        const b = await body(req);
        const author = clean(b.author_name).slice(0, 100);
        const role = clean(b.author_role).slice(0, 100);
        const company = clean(b.company).slice(0, 100);
        const quote = clean(b.quote).slice(0, 800);
        const rating = Math.max(1, Math.min(5, Math.round(Number(b.rating) || 5)));
        const sort = Number.isFinite(Number(b.sort_order)) ? Math.round(Number(b.sort_order)) : 0;
        const published = b.published !== false;
        if (!author || quote.length < 5) {
          return send(res, 400, { error: 'Enter author name and testimonial quote.' });
        }
        if (req.method === 'POST') {
          await pool.query(
            'INSERT INTO testimonials(author_name,author_role,company,quote,rating,published,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [author, role, company, quote, rating, published, sort]
          );
        } else {
          await pool.query(
            'UPDATE testimonials SET author_name=$1,author_role=$2,company=$3,quote=$4,rating=$5,published=$6,sort_order=$7 WHERE id=$8',
            [author, role, company, quote, rating, published, sort, tid]
          );
        }
        return send(res, 200, { ok: true });
      }

      if (path === '/api/admin/faqs' && req.method === 'GET') {
        const q = await pool.query('SELECT * FROM faqs ORDER BY sort_order ASC, id DESC');
        return send(res, 200, q.rows);
      }
      if (
        (path === '/api/admin/faqs' && req.method === 'POST') ||
        (/^\/api\/admin\/faqs\/\d+$/.test(path) && ['PUT', 'DELETE'].includes(req.method))
      ) {
        const fid = Number(path.split('/').pop());
        if (req.method === 'DELETE') {
          await pool.query('DELETE FROM faqs WHERE id=$1', [fid]);
          return send(res, 200, { ok: true });
        }
        const b = await body(req);
        const question = clean(b.question).slice(0, 240);
        const answer = clean(b.answer).slice(0, 2000);
        const sort = Number.isFinite(Number(b.sort_order)) ? Math.round(Number(b.sort_order)) : 0;
        const published = b.published !== false;
        if (question.length < 3 || answer.length < 5) {
          return send(res, 400, { error: 'Enter a valid FAQ question and answer.' });
        }
        if (req.method === 'POST') {
          await pool.query(
            'INSERT INTO faqs(question,answer,published,sort_order) VALUES($1,$2,$3,$4)',
            [question, answer, published, sort]
          );
        } else {
          await pool.query(
            'UPDATE faqs SET question=$1,answer=$2,published=$3,sort_order=$4 WHERE id=$5',
            [question, answer, published, sort, fid]
          );
        }
        return send(res, 200, { ok: true });
      }

      // Reviews moderation & Beta signups
      if (path === '/api/admin/reviews' && req.method === 'GET') {
        const q = await pool.query(
          'SELECT r.*, p.title AS project_title FROM project_reviews r JOIN projects p ON p.id=r.project_id ORDER BY r.approved ASC, r.id DESC LIMIT 200'
        );
        return send(res, 200, q.rows);
      }
      const revMatch = /^\/api\/admin\/reviews\/(\d+)$/.exec(path);
      if (revMatch && ['PATCH', 'DELETE'].includes(req.method)) {
        if (req.method === 'DELETE') {
          await pool.query('DELETE FROM project_reviews WHERE id=$1', [revMatch[1]]);
        } else {
          const b = await body(req);
          await pool.query('UPDATE project_reviews SET approved=$2 WHERE id=$1', [
            revMatch[1],
            b.approved === true,
          ]);
        }
        return send(res, 200, { ok: true });
      }
      if (path === '/api/admin/beta-signups' && req.method === 'GET') {
        const q = await pool.query(
          'SELECT b.*, p.title AS project_title FROM beta_signups b JOIN projects p ON p.id=b.project_id ORDER BY b.id DESC LIMIT 300'
        );
        return send(res, 200, q.rows);
      }

      // Backup & Restore
      if (path === '/api/admin/backup' && req.method === 'GET') {
        const [proj, rel, enq, settings, testi, faqRows, revRows, betaRows] = await Promise.all([
          pool.query('SELECT * FROM projects ORDER BY id'),
          pool.query('SELECT * FROM project_releases ORDER BY id'),
          pool.query('SELECT * FROM enquiries ORDER BY id'),
          pool.query('SELECT data FROM studio_settings WHERE id=1'),
          pool.query('SELECT * FROM testimonials ORDER BY id'),
          pool.query('SELECT * FROM faqs ORDER BY id'),
          pool.query('SELECT * FROM project_reviews ORDER BY id'),
          pool.query('SELECT * FROM beta_signups ORDER BY id'),
        ]);
        const s = settings.rows[0]?.data || {};
        const payload = {
          exportedAt: new Date().toISOString(),
          studio: { headline: s.headline || '', intro: s.intro || '', email: s.email || '' },
          projects: proj.rows,
          releases: rel.rows,
          enquiries: enq.rows,
          testimonials: testi.rows,
          faqs: faqRows.rows,
          reviews: revRows.rows,
          betaSignups: betaRows.rows,
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

      if (path === '/api/admin/restore' && req.method === 'POST') {
        if (session.role !== 'owner') {
          return send(res, 403, { error: 'Only owner accounts can restore JSON backups.' });
        }
        const data = await body(req, 5000000);
        if (!data || !Array.isArray(data.projects)) {
          return send(res, 400, { error: 'Invalid backup JSON file (missing projects array).' });
        }
        const db = await pool.connect();
        try {
          await db.query('BEGIN');
          if (data.studio && typeof data.studio === 'object') {
            const cur = (await db.query('SELECT data FROM studio_settings WHERE id=1')).rows[0]?.data || {};
            await db.query(
              'INSERT INTO studio_settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',
              [
                {
                  ...cur,
                  headline: clean(data.studio.headline).slice(0, 90),
                  intro: clean(data.studio.intro).slice(0, 360),
                  email: clean(data.studio.email).slice(0, 200),
                },
              ]
            );
          }
          for (const p of data.projects) {
            if (!p?.id || !p?.title || !p?.category) continue;
            await db.query(
              `INSERT INTO projects(id,title,category,summary,description,image_url,demo_url,apk_url,video_url,featured,published,created_at,attachments,screenshots,release_notes,version,slug,tech_stack,highlights,preview_token,publish_at,demo_html,metrics)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23::jsonb)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title,category=excluded.category,summary=excluded.summary,description=excluded.description,
                 image_url=excluded.image_url,demo_url=excluded.demo_url,apk_url=excluded.apk_url,video_url=excluded.video_url,
                 featured=excluded.featured,published=excluded.published,attachments=excluded.attachments,screenshots=excluded.screenshots,
                 release_notes=excluded.release_notes,version=excluded.version,slug=excluded.slug,tech_stack=excluded.tech_stack,
                 highlights=excluded.highlights,preview_token=excluded.preview_token,publish_at=excluded.publish_at,
                 demo_html=excluded.demo_html,metrics=excluded.metrics`,
              [
                p.id,
                p.title,
                p.category,
                p.summary || '',
                p.description || '',
                p.image_url || '',
                p.demo_url || '',
                p.apk_url || '',
                p.video_url || '',
                !!p.featured,
                p.published !== false,
                p.created_at || new Date(),
                JSON.stringify(Array.isArray(p.attachments) ? p.attachments : []),
                JSON.stringify(Array.isArray(p.screenshots) ? p.screenshots : []),
                p.release_notes || '',
                p.version || '',
                p.slug || null,
                p.tech_stack || '',
                JSON.stringify(Array.isArray(p.highlights) ? p.highlights : []),
                p.preview_token || null,
                p.publish_at || null,
                p.demo_html || '',
                JSON.stringify(Array.isArray(p.metrics) ? p.metrics : []),
              ]
            );
          }
          if (Array.isArray(data.releases)) {
            for (const r of data.releases) {
              if (!r?.id || !r?.project_id || !r?.version || !r?.url) continue;
              await db.query(
                `INSERT INTO project_releases(id,project_id,version,url,filename,size,notes,download_clicks,published_at,is_latest,revision,channel,details,publish_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
                 ON CONFLICT(id) DO UPDATE SET
                   version=excluded.version,url=excluded.url,filename=excluded.filename,size=excluded.size,
                   notes=excluded.notes,download_clicks=excluded.download_clicks,is_latest=excluded.is_latest,
                   channel=excluded.channel,details=excluded.details,publish_at=excluded.publish_at`,
                [
                  r.id,
                  r.project_id,
                  r.version,
                  r.url,
                  r.filename || 'release.apk',
                  Number(r.size) || 0,
                  r.notes || '',
                  Number(r.download_clicks) || 0,
                  r.published_at || new Date(),
                  !!r.is_latest,
                  Number(r.revision) || 1,
                  r.channel || 'Stable',
                  r.details ? JSON.stringify(r.details) : null,
                  r.publish_at || null,
                ]
              );
            }
          }
          if (Array.isArray(data.enquiries)) {
            for (const e of data.enquiries) {
              if (!e?.id || !e?.name || !e?.email || !e?.message) continue;
              await db.query(
                `INSERT INTO enquiries(id,name,email,service,message,status,created_at,notes,budget,follow_up_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 ON CONFLICT(id) DO UPDATE SET status=excluded.status, notes=excluded.notes, follow_up_at=excluded.follow_up_at`,
                [
                  e.id,
                  e.name,
                  e.email,
                  e.service || '',
                  e.message,
                  e.status || 'new',
                  e.created_at || new Date(),
                  e.notes || '',
                  e.budget || '',
                  e.follow_up_at || null,
                ]
              );
            }
          }
          if (Array.isArray(data.testimonials)) {
            for (const t of data.testimonials) {
              if (!t?.id || !t?.author_name || !t?.quote) continue;
              await db.query(
                `INSERT INTO testimonials(id,author_name,author_role,company,quote,rating,published,sort_order,created_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT(id) DO UPDATE SET author_name=excluded.author_name,author_role=excluded.author_role,company=excluded.company,quote=excluded.quote,rating=excluded.rating,published=excluded.published,sort_order=excluded.sort_order`,
                [
                  t.id,
                  t.author_name,
                  t.author_role || '',
                  t.company || '',
                  t.quote,
                  Number(t.rating) || 5,
                  t.published !== false,
                  Number(t.sort_order) || 0,
                  t.created_at || new Date(),
                ]
              );
            }
          }
          if (Array.isArray(data.faqs)) {
            for (const f of data.faqs) {
              if (!f?.id || !f?.question || !f?.answer) continue;
              await db.query(
                `INSERT INTO faqs(id,question,answer,published,sort_order,created_at)
                 VALUES($1,$2,$3,$4,$5,$6)
                 ON CONFLICT(id) DO UPDATE SET question=excluded.question,answer=excluded.answer,published=excluded.published,sort_order=excluded.sort_order`,
                [
                  f.id,
                  f.question,
                  f.answer,
                  f.published !== false,
                  Number(f.sort_order) || 0,
                  f.created_at || new Date(),
                ]
              );
            }
          }
          for (const tbl of ['projects', 'project_releases', 'enquiries', 'testimonials', 'faqs']) {
            await db.query(
              `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${tbl}), 1), true)`,
              [tbl]
            );
          }
          await db.query('COMMIT');
          return send(res, 200, { ok: true, restoredProjects: data.projects.length });
        } catch (err) {
          await db.query('ROLLBACK');
          throw err;
        } finally {
          db.release();
        }
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

      const previewGen = /^\/api\/admin\/projects\/(\d+)\/preview-token$/.exec(path);
      if (previewGen && req.method === 'POST') {
        const b = await body(req);
        const nextToken = b.clear ? null : randomBytes(16).toString('hex');
        const q = await pool.query(
          'UPDATE projects SET preview_token=$1 WHERE id=$2 RETURNING preview_token',
          [nextToken, previewGen[1]]
        );
        if (!q.rowCount) return send(res, 404, { error: 'Project not found' });
        return send(res, 200, { preview_token: q.rows[0].preview_token });
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
        const b = await body(req, 250000);
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
        const metrics = b.metrics;
        if (
          metrics !== undefined &&
          (!Array.isArray(metrics) ||
            metrics.length > 6 ||
            !metrics.every(
              (m) =>
                m &&
                typeof m.label === 'string' &&
                m.label.trim() &&
                m.label.length <= 60 &&
                typeof m.value === 'string' &&
                m.value.trim() &&
                m.value.length <= 60
            ))
        ) {
          return send(res, 400, { error: 'Use up to 6 impact metrics with label and value.' });
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
        const publishAt = parsePublishAt(b.publish_at);
        const demoHtml =
          b.demo_html === undefined ? null : String(b.demo_html || '').slice(0, 32000);
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
          publishAt === undefined ? null : publishAt,
          demoHtml,
          metrics === undefined
            ? null
            : JSON.stringify(metrics.map((m) => ({ label: m.label.trim(), value: m.value.trim() }))),
        ];
        if (req.method === 'POST') {
          await pool.query(
            'INSERT INTO projects(title,category,summary,description,image_url,demo_url,apk_url,video_url,featured,published,version,screenshots,release_notes,attachments,slug,tech_stack,highlights,publish_at,demo_html,metrics) VALUES(' +
              vals
                .map((_, i) =>
                  i === 13 || i === 16 || i === 19
                    ? `coalesce($${i + 1}::jsonb,'[]'::jsonb)`
                    : i === 11
                      ? "coalesce($12::jsonb,'[]'::jsonb)"
                      : i === 12 || i === 18
                        ? `coalesce($${i + 1},'')`
                        : '$' + (i + 1)
                )
                .join(',') +
              ')',
            vals
          );
        } else {
          await pool.query(
            `UPDATE projects SET title=$1,category=$2,summary=$3,description=$4,image_url=$5,demo_url=$6,apk_url=$7,video_url=$8,featured=$9,published=$10,version=$11,
             screenshots=coalesce($12::jsonb,screenshots),release_notes=coalesce($13,release_notes),attachments=coalesce($14::jsonb,attachments),slug=$15,tech_stack=$16,
             highlights=coalesce($17::jsonb,highlights),publish_at=$18,demo_html=coalesce($19,demo_html),metrics=coalesce($20::jsonb,metrics) WHERE id=$21`,
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
        let followUpSql = 'follow_up_at';
        const params = [status, notes, enquiryId];
        if (b.follow_up_at !== undefined) {
          if (!b.follow_up_at) {
            followUpSql = 'NULL';
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.follow_up_at))) {
            params.push(String(b.follow_up_at));
            followUpSql = '$4::date';
          } else {
            return send(res, 400, { error: 'Follow-up date must be YYYY-MM-DD' });
          }
        }
        await pool.query(
          `UPDATE enquiries SET status=coalesce($1,status), notes=coalesce($2,notes), follow_up_at=${followUpSql} WHERE id=$3`,
          params
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
