# ZUTECHSAM Software Solutions

The public portfolio and the studio admin run as two services from the same branch. Both use `npm start` and share the same PostgreSQL `DATABASE_URL`.

| Setting | Public website | Admin service |
| --- | --- | --- |
| `SITE_MODE` | `public` (default) | `admin` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | — | Initial & synced administrator credentials |
| `UPLOAD_DIR` | — | `/data/uploads` (default), on a persistent volume |
| `APK_MAX_MB` | — | `1024` by default, configurable from `1` to `16384` MiB |
| `MEDIA_BASE_URL` | HTTPS origin of the admin service for `/media/*` links | — |
| `PUBLIC_BASE_URL` | Optional canonical origin for QR codes & Atom feeds | Optional |

## Architecture & Highlights

- **Resumable chunked uploads**: Files upload in 4 MiB chunks with SHA-256 content fingerprinting and magic-byte verification, supporting pause/resume across retries.
- **Range downloads & media routing**: Uploaded assets are stored with relative `/media/<hash>.<ext>` paths and support HTTP `Range` requests (`206 Partial Content`).
- **Release management**: Supports `Stable` and `Beta` channels, optimistic concurrency (`revision`), automatic APK manifest & SHA-256 indexing, live sandboxed preview, and activity undo.
- **Security**: PostgreSQL-backed admin sessions with expiry pruning, scrypt password hashing, IP rate-limiting on login and enquiries, CSP headers, and HTML output escaping.

Use **Website settings** in the studio workspace to update the homepage headline, introduction, and contact email. Each published project has a canonical page at `/projects/<id>` (with `#project-<id>` redirect support).
