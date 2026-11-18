# ZUTECHSAM Software Solutions

The public portfolio and the studio admin run as two services from the same branch. Both use `npm start` and share the same PostgreSQL `DATABASE_URL`.

| Setting | Public website | Admin service |
| --- | --- | --- |
| `SITE_MODE` | `public` (default) | `admin` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | — | Initial & synced administrator credentials |
| `UPLOAD_DIR` | — | `/data/uploads` (default), on a persistent volume |
| `APK_MAX_MB` | — | `1024` by default, configurable from `1` to `16384` MiB |
| `MEDIA_BASE_URL` | HTTPS origin of the admin service for `/media/*` links | — |
| `PUBLIC_BASE_URL` | Optional canonical origin for SEO, sitemap, QR codes & Atom feeds | Optional |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional instant alerts for enquiries & bug reports | Optional |

## Key Capabilities

- **Portfolio & SEO**: Custom project slugs (`/projects/<slug>`), dynamic OpenGraph social cards, `sitemap.xml`, `robots.txt`, embedded video previews, and screenshot lightbox.
- **APK Release Hub**: Versioned `Stable`/`Beta` channels, automatic APK manifest & SHA-256 indexing, one-click SHA-256 copy, HTTP `Range` downloads, and `/projects/<slug>/latest.json` in-app update API.
- **Resumable Chunked Uploads**: 4 MiB chunks with SHA-256 content fingerprinting and magic-byte verification.
- **Studio Desk & Analytics**: 7-day enquiry & download charts, CRM notes/budget/CSV export, Telegram alert testing, admin password rotation, and JSON backup export.
