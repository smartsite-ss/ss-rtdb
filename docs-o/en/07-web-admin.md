# 07 — Web admin console (`rtdb-admin`)

`rtdb-admin` is a Vue 3 single-page application. It **only consumes the public REST API**, so it can be
deployed in two ways:

| Form | How | When |
| ---- | --- | ---- |
| **Bundled** (default) | `rtdb-server` serves it at `http://<host>:<port>/admin/` | Single instance, simplest setup |
| **Standalone** | Deploy `packages/admin/dist` to any static web server; configure the instance URL + token in the UI | One console managing many instances |

---

## 1. Build

```bash
cd ss-rtdb/src
npm install                          # if not done yet
npm run build --workspace @ss/rtdb-admin
```

Output: `packages/admin/dist/`. The build uses `base: './'` so the bundle works from any path.

Without this build the server still runs; `/admin` simply returns 404.

## 2. Bundled form

Default configuration already enables it:

```json
{ "admin": { "enabled": true, "staticDir": "" } }
```

- `staticDir: ""` → the bundled `packages/admin/dist` directory.
- Open <http://127.0.0.1:6180/admin/> — **the trailing slash matters**; `/admin` 301-redirects to
  `/admin/` so the relative asset URLs resolve.
- No extra authentication: the console runs in your browser and sends your token with each API call
  (it is the same REST API with the same scopes).

To disable it (for example when you deploy the standalone form instead):

```json
{ "admin": { "enabled": false } }
```

To serve your own build from another location:

```json
{ "admin": { "enabled": true, "staticDir": "/opt/rtdb-admin/dist" } }
```

## 3. Standalone form

1. Build (`npm run build --workspace @ss/rtdb-admin`) and upload `packages/admin/dist/` to your static
   host (nginx, object storage with website hosting, …).
2. Open the site and fill in **Settings**:
   - **API base URL** — e.g. `https://rtdb.example.com`. Leave it **empty** to talk to the origin that
     served the page (the bundled mode behaviour).
   - **Access token** — a token with the scopes you need (`admin` for the Access control panel).
3. Press **Test connection**, then **Save**. Settings are stored in the browser's local storage only —
   never on the server — so each operator keeps their own credentials.
4. On the server instance, allow the console's origin:

```json
{
  "host": "0.0.0.0",
  "cors": { "allowedOrigins": ["https://rtdb-admin.example.com"] },
  "auth": { "enabled": true, "mode": "token" }
}
```

> CORS is **opt-in and disabled by default**. A non-loopback listener must also keep
> `auth.enabled = true`; otherwise startup fails.

Because the console is a pure static site with no server-side state, you can serve one copy to many
operators and let each of them point it at whichever instance they manage.

---

## 4. Panels

| Panel | What it shows / does |
| ----- | -------------------- |
| **Status** | Connection state, write & query rates, WAL backlog, cache hit rate, latency percentiles |
| **Databases** | Database list with retention, on-disk size and metric count |
| **Metrics** | Metric browser with first/last timestamps and a time-series line chart preview |
| **Backup** | Trigger a whole-database backup and show the result |
| **Access control** | Users (create / change password / change role / enable-disable / remove) and API tokens (issue / revoke; the plaintext is shown once) |

Status data comes from `GET /api/v1/status`; everything else mirrors the endpoints documented in
[04 — HTTP API](./04-http-api.md).

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `/admin` returns 404 | Admin bundle not built, or `admin.enabled: false` | Build the admin workspace; enable `admin` |
| Page loads but assets 404 | Opened `/admin` without the trailing slash from a custom proxy | Use `/admin/`; keep the 301 redirect |
| Console shows `E_AUTH` / `401` | Missing or wrong token in Settings | Re-enter the token; check `rtdb.token` |
| Standalone console cannot reach the API | CORS disabled, or the origin is not allow-listed | Set `cors.allowedOrigins` and restart |
| Access control panel returns 403 | Token role is not `admin` | Issue an `admin`-role token |

## 6. Next steps

- [08 — Operations & maintenance](./08-operations.md)

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
