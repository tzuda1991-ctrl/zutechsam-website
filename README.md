# ZUTECHSAM Software Solutions

The public portfolio and the studio admin run as two Railway services from the same branch. Both use `npm start` and the same PostgreSQL `DATABASE_URL`.

| Setting | Public website | Admin service |
| --- | --- | --- |
| SITE_MODE | public (default) | admin |
| ADMIN_USERNAME, ADMIN_PASSWORD | — | Initial administrator credentials |
| UPLOAD_DIR | — | /data/uploads (default), on a persistent volume mounted at /data |
| APK_MAX_MB | — | 1024 by default, configurable from 1 to 16384 MiB |
| MEDIA_BASE_URL | HTTPS origin of the admin service for relative media links | — |

Use one admin replica with the mounted volume. The editor uploads files in 4 MiB parts with retry and progress, then attaches the completed file when the project is saved. The image limit is 100 MiB. Completed files support HTTP range downloads. Staging files idle for a day are eligible for hourly cleanup. HTTPS links to externally hosted downloads also work.

Use **Website settings** to change the homepage headline, introduction and contact email. Blank fields restore the defaults. **Project library** supports drafts, featured placement, project covers, versions, live demos, videos and APKs. Each published project has a shareable URL ending in `#project-ID`.
