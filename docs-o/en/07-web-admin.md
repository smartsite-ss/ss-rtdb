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
| **Databases** | Two categories: (1) location / size / status — directory (relative to the server working directory), on-disk footprint with the segment / index / WAL split, the retention override and an expandable per-day detail; (2) a database-name filter whose result is the inventory table. Retention can be changed inline and is read back from `GET /api/v1/databases/{db}` |
| **Metrics** | **One card, two tabs**: `Metric inventory` and `Range preview`; pressing `Select` on a row switches to the preview tab and redraws immediately. The inventory lists first/last timestamps and also shows **Latest value** and **Updated** columns (newest point per metric via `POST /api/v1/query/last`); the **Refresh live values** button reloads them (a metric-list reload refreshes them automatically too). Live values cover at most the first 200 metrics with 6 requests in flight, and the panel says so when capped — a database with thousands of metrics must not flood the connection pool. The preview variable is a **combobox**; switching it redraws immediately. The range is a **single "time range" control** (Grafana style): the trigger shows the current `start → end`, and the popover holds the presets (5m / 15m / 1h / 6h / 24h / 7d / All = the metric's full span) plus second-precision start / end pickers — a preset applies and queries immediately, manual fields apply on "Apply". The popover also offers a **day picker** (From day / To day, local time, both ends inclusive): picking a start day fills `00:00:00`, picking an end day fills `23:59:59`, and the two levels stay in sync (editing the exact time moves the days, picking one side fills the other). An empty or inverted range shows an inline message instead of firing a query. Queries can run raw (`query/range`), window-aggregated (`query/aggregate`, operators `avg`/`sum`/`min`/`max`/`count`/`last`) or interpolated (`query/at`, `step` / `linear`) — **aggregation and interpolation are both driven by the same Window (s/m/h)**: aggregation buckets the range into windows, interpolation resamples at `start, start + window, …`; the row **Limit** applies to raw queries only. Two hint lines state the rules — raw samples are joined without interpolation (gaps look like ramps) and `avg` is time-weighted with linearly interpolated neighbours — plus the measured sampling-interval median / largest gap. The current preview exports to `*.xls` (Excel 2003 SpreadsheetML, typed cells). The **metric inventory** (`GET /api/v1/metrics/{db}`) also exports to **CSV** in one click: database, metric name, type, first point and last point (each with a local-time + UTC-offset text column and a millisecond epoch column), with a UTF-8 BOM, CRLF endings and RFC 4180 quoting for names containing commas / quotes / newlines. Time cells are `YYYY-MM-DD HH:mm:ss (UTC+08:00)`; the trailing offset stops Excel/WPS from auto-converting the cell to a date, so seconds are not hidden and the timezone is explicit |
| **Backup** | Trigger a backup and show the result: enter the server-side target directory and optionally a **start / end day** (day granularity, server local time, both inclusive) for a range backup; leaving both empty backs up the whole database. The result shows the mode (full = replace on restore / day range = merge on restore), the effective range and day count, file count and total bytes |
| **Access control** | Users (create / change password / change role / enable-disable / remove) and API tokens (issue / revoke; the plaintext is shown once). The token table has an explicit **Refresh** button and shows, per token, the last database it accessed, the last-use timestamp and the current write rate (points/s + payload bytes/s) reported by `GET /api/v1/admin/tokens`; its first row is the **static token** (`config-token`, i.e. `rtdb.token`, where the Smart Site demo client's writes are counted). The write-rate column sits **directly after the token id** (ids are abbreviated, the full id is in the tooltip), so it stays visible without horizontal scrolling, and the panel re-reads the endpoint every 5 s so the rates stay live. A hint explains that tokens are server-side credentials and closing a client does not revoke them |

Status data comes from `GET /api/v1/status`; everything else mirrors the endpoints documented in
[04 — HTTP API](./04-http-api.md).

The tab bar carries one extra entry on its right edge: **API docs** opens the server's built-in reference
(`/api/docs`) in a new tab. The URL follows the applied API base URL — relative in the bundled form,
`<remote>/api/docs` in the standalone form — so it always documents the instance the console is talking to.
The reference page is generated by the server from its route table and is public (no sign-in needed); see
[04 — HTTP API](./04-http-api.md) §8.1.

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
| 2026-10-17 | Databases panel reworked into two categories: location / size / status from the new `GET /api/v1/databases/{db}` endpoint (expandable per-day detail, retention read back) and a database-name filter whose result is the inventory table | DeepSeek-V4.1-Flash |
| 2026-10-17 | Location column shows the server-reported directory, now relative to the working directory instead of an absolute host path | DeepSeek-V4.1-Flash |
| 2026-10-17 | Token table: Refresh button, last accessed database + timestamp and write-rate columns, plus a hint that closing a client does not revoke a token | DeepSeek-V4.1-Flash |
| 2026-10-17 | Token table now pins a static-token row (`config-token`, i.e. `rtdb.token`) showing its access time and write rate, so static-token clients such as the demo are no longer invisible | DeepSeek-V4.1-Flash |
| 2026-10-17 | Token table re-laid out: the write-rate column follows the token id, ids are abbreviated (full value in the tooltip), owner/role and created/expires are merged, so the table no longer overflows horizontally; the panel silently re-polls every 5 s | DeepSeek-V4.1-Flash |
| 2026-10-17 | Metrics panel: second-precision pickers with quick ranges, raw vs windowed aggregation (`query/aggregate`), interpolation / aggregation rules and measured sampling-interval hints, and `*.xls` export of the preview | DeepSeek-V4.1-Flash |
| 2026-10-17 | Range merged into a single "time range" control: the trigger shows the span, the popover holds presets plus start/end, and presets query immediately | DeepSeek-V4.1-Flash |
| 2026-10-18 | Added the **API docs** nav entry (opens the server's `/api/docs` in a new tab; URL follows the applied API base URL) to §4 | DeepSeek-V4.1-Flash |
| 2026-10-18 | Metrics panel: the **Window** now drives interpolation as well (resampling stride `start, start + window, …`), so the window input is editable in both modes and the row **Limit** applies to raw queries only | DeepSeek-V4.1-Flash |
| 2026-10-18 | Backup panel gains an optional **start / end day** range (day granularity) and reports the backup mode (full vs day range) plus the effective range and day count | DeepSeek-V4.1-Flash |
| 2026-10-18 | Metric inventory gains **Export CSV** (database / metric / type / first-last local time and ms epoch; UTF-8 BOM + CRLF + RFC 4180 quoting) | DeepSeek-V4.1-Flash |
| 2026-10-18 | CSV time cells are now `YYYY-MM-DD HH:mm:ss (UTC+08:00)`, fixing Excel auto-converting them to dates (`1970/1/1 8:29`, seconds dropped, timezone unclear) | DeepSeek-V4.1-Flash |
| 2026-10-18 | Metrics "time range" control gains a **day picker** (From day / To day, whole local days, synced with the exact fields) and an inline message for empty/inverted ranges | DeepSeek-V4.1-Flash |
| 2026-10-18 | Metric inventory gains **Latest value / Updated** columns and a **Refresh live values** button (`query/last`, max 200 metrics with 6 in flight); the preview variable becomes a **combobox** that redraws on change | DeepSeek-V4.1-Flash |
| 2026-10-18 | Metrics panel merged into **one card with two tabs** (Metric inventory / Range preview); `Select` on a row switches to the preview tab, cutting vertical scrolling | DeepSeek-V4.1-Flash |
