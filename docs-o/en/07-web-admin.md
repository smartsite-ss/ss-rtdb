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
  `/admin/` so the relative asset URLs resolve. Visiting the bare origin `/` **302-redirects to
  `/admin/`** (the root path still returns 404 when `admin.enabled=false`).
- **Sign in** first: with `auth.enabled = true` (the default) the page shows a sign-in form — enter a user
  name + password (`POST /api/v1/auth/login` trades them for an API token). A fresh instance creates the
  default administrator `admin` / `ss-rtdb` (see [02 — Configuration](./02-configuration.md) §6.4); the form
  is pre-filled with both, so a first sign-in is one click.
- The top-right corner always carries the entry point: **Sign in** while anonymous (jumps to the form), and
  the account (e.g. `admin · admin`) plus **Sign out** once signed in.
- The browser stores only the token (`localStorage`); **the password is never stored**. Use
  **Use an existing token** to paste a token issued elsewhere, and **Sign out** to revoke it.
- No separate authentication layer: the console calls the same REST API and sends that token with each
  request, with exactly the same scopes.

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
2. Open the site and fill in **API base URL** — e.g. `https://rtdb.example.com`. Leave it **empty** to talk
   to the origin that served the page (the bundled mode behaviour).
3. **Sign in** with a user name + password, or press **Use an existing token** and paste a token issued
   elsewhere (`admin` scope for the Access control panel).
4. Press **Test connection** to confirm connectivity; the base URL and token are stored in the browser's
   local storage only — never on the server — so each operator keeps their own credentials.
5. On the server instance, allow the console's origin:

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

## 5. Languages

The console ships two locales and starts in **English**:

| Locale | Coverage | Notes |
| ------ | -------- | ----- |
| `en` (default) | Every user-visible string | Source of truth for the key set (`packages/admin/src/locales/en.ts`) |
| `zh` | Every user-visible string | Typed as `Record<MessageKey, string>` (`packages/admin/src/locales/zh.ts`), so a missing translation fails the build |

- The header button shows `中文` while the UI is English and `EN` while it is Chinese; pressing it switches
  the locale.
- The choice is persisted in `localStorage` under `rtdbAdminLocale` and survives a reload; `<html lang>`
  and the document title follow it.
- Switching language is purely local: nothing is sent to the server, and already displayed notices are
  re-rendered in the new language.
- Adding UI text means adding the key to **both** dictionaries (AGENTS.md §4 rule 12). `npm run typecheck
  --workspace @ss/rtdb-admin` (also part of `npm run build`) reports an English key that has no Chinese
  counterpart, so the two dictionaries cannot drift.
- Messages may contain `{placeholder}` segments (`{database}`, `{days}`, `{time}`, …) that `t()` fills from
  the values passed by the panel.

## 6. Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `/admin` returns 404 | Admin bundle not built, or `admin.enabled: false` | Build the admin workspace; enable `admin` |
| Page loads but assets 404 | Opened `/admin` without the trailing slash from a custom proxy | Use `/admin/`; keep the 301 redirect |
| Root `/` returns `E_NOT_FOUND: Unregistered route: /` | Older server without the root redirect, or `admin.enabled=false` | Upgrade to a build with the root redirect; with the bundled console disabled, open `/admin/` and serve your own static site |
| Console shows `E_AUTH` / `401` | Not signed in, token expired, or anonymous access to a protected endpoint | Sign in; paste a valid token; check `rtdb.token` |
| Sign-in returns `401 E_AUTH` | Wrong user name / password, or the instance has a non-empty user directory without that user | Use `admin` / `ss-rtdb` on a fresh instance, otherwise the credentials your operator provisioned |
| Default administrator password forgotten | Only the scrypt hash is stored, so it cannot be recovered | Change it with an admin token (`PUT /api/v1/admin/users/admin`), or stop the server, delete `rtdb-users.json` and restart (an empty directory recreates the default administrator) |
| Standalone console cannot reach the API | CORS disabled, or the origin is not allow-listed | Set `cors.allowedOrigins` and restart |
| Access control panel returns 403 | Token role is not `admin` | Issue an `admin`-role token |

## 7. Next steps

- [08 — Operations & maintenance](./08-operations.md)

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Documented the root `/` 302 redirect to `/admin/` and added an `E_NOT_FOUND: Unregistered route: /` troubleshooting row | DeepSeek-V4.1-Flash |
| 2026-10-17 | Documented console sign-in (default administrator `admin` / `ss-rtdb`, Sign in / Sign out, pasting an existing token) and added two sign-in troubleshooting rows | DeepSeek-V4.1-Flash |
| 2026-10-17 | Sign-in form moved to the top and pre-filled with `admin` / `ss-rtdb`; the header always shows a Sign in / Sign out entry point | DeepSeek-V4.1-Flash |
| 2026-10-17 | Console internationalised (English default + Chinese) with a header language switch persisted in `localStorage`; added §5 "Languages" and renumbered the following sections | DeepSeek-V4.1-Flash |
