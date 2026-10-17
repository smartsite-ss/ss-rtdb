# 04 — HTTP API

Base path: `/api/v1`. Default bind: `http://127.0.0.1:6180`.

## 1. Conventions

### Authentication

| Mode | Header |
| ---- | ------ |
| `token` (default) | `Authorization: Bearer <token>` |
| `basic` | `Authorization: Basic base64(username:password)` |
| `both` | either of the above |

The token may be the static `auth.token` / auto-generated `rtdb.token` (always role `admin`) or an API
token issued through `/api/v1/admin/tokens` (role = the token's role).

Without a token, exchange a **user name + password** for one via `POST /api/v1/auth/login` (see §7.3).
A fresh instance creates the default administrator `admin` / `ss-rtdb` (override with
`auth.bootstrapUsername` / `auth.bootstrapPassword`, see [02 — Configuration](./02-configuration.md) §6.4).

### Scopes and roles

| Scope | Endpoints | `admin` | `write` | `readonly` |
| ----- | --------- | :-----: | :-----: | :--------: |
| `none` | `/api/v1/status`, `/metrics`, `/healthz` | ✅ | ✅ | ✅ |
| `query` | `/api/v1/databases`, `/api/v1/metrics/:db`, `/api/v1/query/*` | ✅ | ✅ | ✅ |
| `write` | `/api/v1/write`, `/api/v1/retention/:db`, `/api/v1/backup/:db` | ✅ | ✅ | ❌ |
| `admin` | `/api/v1/admin/users*`, `/api/v1/admin/tokens*` | ✅ | ❌ | ❌ |

`auth.query` / `auth.write` config switches can turn the query/write requirement off entirely; the
`admin` scope is **always** protected once `auth.enabled = true`.

### Content types

- Query and management endpoints: `application/json`.
- `POST /api/v1/write`: `application/json` for a JSON point array, anything else (e.g.
  `text/plain`) for Line Protocol.

### Error body

Every non-2xx response is JSON:

```json
{ "error": "E_METRIC_NOT_FOUND", "message": "Metric not found: foo", "details": [] }
```

`429` additionally carries `Retry-After: 1`.

| Code | HTTP | Meaning |
| ---- | ---- | ------- |
| `E_INVALID_POINT` | 400 | Malformed point / bad database name / bad Line Protocol line |
| `E_INVALID_RANGE` | 400 | Bad time range, bad `order`, too many aggregate windows |
| `E_BAD_METRIC_NAME` | 400 | Missing or illegal metric name |
| `E_TYPE_MISMATCH` | 400 | Value type differs from the type locked by the metric's first write |
| `E_AUTH` | 401 | Missing or invalid credential |
| `E_FORBIDDEN` | 403 | Authenticated, but the role lacks the scope |
| `E_NOT_FOUND` | 404 | Unknown route |
| `E_METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method for a known route |
| `E_DB_NOT_FOUND` | 404 | Unknown database |
| `E_METRIC_NOT_FOUND` | 404 | Unknown metric |
| `E_USER_NOT_FOUND` | 404 | Unknown user |
| `E_TOKEN_NOT_FOUND` | 404 | Unknown token id |
| `E_DB_LOCKED` | 409 | Data root already owned by another process |
| `E_USER_EXISTS` | 409 | User name already taken |
| `E_BATCH_TOO_LARGE` | 413 | Batch points or body bytes over the cap |
| `E_RATE_LIMITED` | 429 | Backpressure (buffer / pending watermark) — retry after ≥1 s |
| `E_IO` | 500 | Filesystem failure |
| `E_CORRUPT_BLOCK` / `E_CORRUPT_SEGMENT` | 500 | Block or segment CRC / structure failure |
| `E_INTERNAL` | 500 | Unclassified internal error |

---

## 2. Endpoint index

| Method | Path | Scope | Purpose |
| ------ | ---- | ----- | ------- |
| `GET` | `/api/v1/status` | none | Runtime metrics |
| `GET` | `/metrics` | none | Prometheus exposition |
| `GET` | `/healthz` | none | Liveness probe |
| `GET` | `/api/v1/databases` | query | List databases |
| `GET` | `/api/v1/metrics/:db` | query | List metrics of a database |
| `POST` | `/api/v1/write?db=<db>` | write | Write points (JSON or Line Protocol) |
| `POST` | `/api/v1/query/range` | query | Raw points in a time range |
| `POST` | `/api/v1/query/last` | query | Latest point at or before a timestamp |
| `POST` | `/api/v1/query/count` | query | Point count (estimated or exact) |
| `POST` | `/api/v1/query/aggregate` | query | Windowed aggregation |
| `PUT` | `/api/v1/retention/:db` | write | Set per-database retention |
| `POST` | `/api/v1/backup/:db` | write | Trigger a whole-database backup |
| `GET` `POST` | `/api/v1/admin/users` | admin | List / create users |
| `PUT` `DELETE` | `/api/v1/admin/users/:username` | admin | Update / remove a user |
| `GET` `POST` | `/api/v1/admin/tokens` | admin | List / issue API tokens |
| `DELETE` | `/api/v1/admin/tokens/:tokenId` | admin | Revoke an API token |
| `POST` | `/api/v1/auth/login` | none (needs user name + password) | Exchange credentials for an API token |
| `GET` | `/api/v1/auth/session` | any valid credential | Identity and scopes of the current credential |
| `POST` | `/api/v1/auth/logout` | any valid credential | Revoke the current API token |
| `GET` | `/admin/` | none | Web console (static) |
| `GET` | `/` | none | 302 redirect to `/admin/`; still 404 when `admin.enabled=false` |

---

## 3. Write

```
POST /api/v1/write?db=<database>
```

`db` is required and must match `^[a-zA-Z][a-zA-Z0-9_]{0,62}$`. The database is **created on first
write**.

### 3.1 Line Protocol

`Content-Type: text/plain` (anything that is not `application/json`).

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/write?db=plant_a" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary $'station01.powerMeter.kwh 1024.5 1760688000000000000\nstation01.powerMeter.kwh value=1030.25\nstation01.valve.open true\nstation01.pump.state "running"'
```

Grammar and rules:

```
metric[,tag=value...] <value> [timestamp]
```

- **Tags are parsed and then ignored** (counted in `status.write.tagsIgnored`). ss-rtdb is
  single-dimensional: identity is the metric name only.
- **Timestamps are nanoseconds**, truncated to milliseconds. Omitted = server receive time.
  Only digits (with optional sign) are accepted.
- **Value typing**: `true`/`false`/`t`/`f` → bool; `"…"` → string (escape `\"` and `\\`);
  an integer without a decimal point, or any integer with an `i` suffix → **i64**; anything else → f64.
- A leading `key=` field-set form is accepted and the right-hand side is used.
- Blank lines and lines starting with `#` are skipped.
- **Any invalid line rejects the whole batch** (`E_INVALID_POINT`, `details` carries line numbers).

### 3.2 JSON array

`Content-Type: application/json`; the body is a JSON **array** of points:

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/write?db=plant_a" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
        {"metricName":"station01.powerMeter.kwh","timestamp":1760688000000,"value":1024.5},
        {"metricName":"station01.powerMeter.kwh","t":1760688001000,"v":1030.25},
        {"metricName":"station01.valve.open","t":1760688000000,"v":true},
        {"metricName":"station01.pump.state","t":1760688000000,"v":"running"},
        {"metricName":"station01.counter.pulses","t":1760688000000,"v":"9007199254740991","vt":2}
      ]'
```

Point fields:

| Field | Alias | Notes |
| ----- | ----- | ----- |
| `metricName` | — | required, non-empty, ≤512 UTF-8 bytes |
| `timestamp` | `t` | required, integer ms epoch |
| `value` | `v` | required |
| `vt` | — | optional type marker: `1`=f64, `2`=i64, `3`=bool, `4`=string |
| `quality` | `q` | optional u8; `0` = good (default, not stored) |

> v0.1.0 (M0) only accepts `quality` `0` (equivalent to omitting it): any non-zero quality flag
> returns `400 E_INVALID_POINT` (to avoid silent loss) until the flag enumeration is finalized.

**When you need `vt`**: JSON numbers can only express f64, so write i64 values as a **decimal string
with `"vt": 2`**. Without `vt`, the type is inferred from the JSON type (number → f64, boolean → bool,
string → string).

### 3.3 Response

```json
{ "accepted": 5, "duplicates": 0 }
```

Points whose `(metric, timestamp)` already exists are counted as `duplicates` — writes are
**idempotent**, so a client can safely retry a failed batch.

### 3.4 Limits

| Condition | Result |
| --------- | ------ |
| `points.length > write.maxBatch` (default 1 000 000) | `413 E_BATCH_TOO_LARGE` |
| Body bytes > `http.maxBodyBytes` (default 64 MiB) | `413 E_BATCH_TOO_LARGE` |
| Buffer / pending watermark exceeded | `429 E_RATE_LIMITED` (+ `Retry-After: 1`) |

---

## 4. Query primitives

All four are `POST` with a JSON body. `db` and `metricName` are required in every one; the database and
metric must already exist (`404` otherwise).

### 4.1 `range`

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/range" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh",
       "start":1760688000000,"end":1760691600000,"limit":1000,"order":"asc"}'
```

```json
{
  "series": {
    "metricName": "station01.powerMeter.kwh",
    "points": [
      { "t": 1760688000000, "v": 1024.5, "vt": 1 },
      { "t": 1760688001000, "v": 1030.25, "vt": 1 }
    ]
  }
}
```

`start` / `end` are **inclusive** ms epoch. `limit` defaults to `query.defaultLimit` (100 000);
`order` is `asc` (default) or `desc`.

### 4.2 `last`

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/last" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh","before":1760691600000}'
```

```json
{ "point": { "t": 1760688001000, "v": 1030.25, "vt": 1 } }
```

`before` is optional (default = latest overall). This is the primitive for "value at or before a
report boundary".

### 4.3 `count`

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/count" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh",
       "start":1760688000000,"end":1760691600000,"exact":false}'
```

```json
{ "count": 3600 }
```

`exact: false` (default) sums `pointCount` from the index — fast, may include points outside the range
at block granularity. `exact: true` decodes and counts precisely.

### 4.4 `aggregate`

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/aggregate" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh",
       "start":1760688000000,"end":1760691600000,"type":"avg","windowMs":60000}'
```

```json
{
  "windows": [
    { "start": 1760688000000, "end": 1760688060000, "v": 1027.375, "vt": 1, "count": 60 },
    { "start": 1760688060000, "end": 1760688120000, "v": 1044.5,   "vt": 1, "count": 60 }
  ]
}
```

- `type`: `avg` | `sum` | `min` | `max` | `count` | `last`.
- Windows are `[start + k*windowMs, start + (k+1)*windowMs)`; the last window is backfilled to the
  window width.
- `avg` is the **time-weighted average** (industrial convention): the window's points plus linearly
  interpolated neighbours just before/after the window, integrated over time. For an equal-weight mean
  compute `sum / count` client-side.
- A window with no coverage returns `null` for `v` and `count: 0`.
- More than 100 000 windows in one call → `400 E_INVALID_RANGE`.

### 4.5 Reading values

| `vt` | JSON `v` |
| ---- | -------- |
| `1` f64 | number (non-finite → `null`) |
| `2` i64 | **decimal string** |
| `3` bool | boolean |
| `4` string | string |

`q` is present only when a quality was written.

---

## 5. Databases and metrics

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/databases
# {"databases":["plant_a","plant_b"]}

curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/metrics/plant_a
# {"metrics":[{"metricName":"station01.powerMeter.kwh","firstTs":1760688000000,"lastTs":1760691600000}]}
```

---

## 6. Retention and backup

```bash
# Set retention (days; 0 = keep forever) — requires the write scope
curl -X PUT "http://127.0.0.1:6180/api/v1/retention/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"days":90}'
# {"ok":true}

# Trigger a whole-database backup on the server host
curl -X POST "http://127.0.0.1:6180/api/v1/backup/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"targetDir":"/mnt/backups/2026-10-17"}'
# {"files":42,"totalBytes":1932735283,"database":"plant_a","targetDirectory":"/mnt/backups/2026-10-17/plant_a"}
```

---

## 7. Users and API tokens (admin scope)

### 7.1 Users

```bash
# Create (201)
curl -X POST "http://127.0.0.1:6180/api/v1/admin/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"collector","password":"S3cret!","role":"write","enabled":true}'
# {"user":{"username":"collector","role":"write","enabled":true,"createdAt":...,"updatedAt":...}}

# List
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:6180/api/v1/admin/users

# Update role / password / enabled state
curl -X PUT "http://127.0.0.1:6180/api/v1/admin/users/collector" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"role":"readonly","enabled":false}'

# Delete
curl -X DELETE "http://127.0.0.1:6180/api/v1/admin/users/collector" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# {"ok":true}
```

User names match `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`. Passwords are stored only as scrypt hashes and are
never returned.

### 7.2 API tokens

```bash
# Issue (201) — the plaintext is returned once
curl -X POST "http://127.0.0.1:6180/api/v1/admin/tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"user":"collector","role":"write","label":"edge-gateway-1","ttlMs":2592000000}'
# {"token":"<64 hex chars>","tokenRecord":{"tokenId":"...","user":"collector","role":"write",
#  "label":"edge-gateway-1","createdAt":...,"expiresAt":...,"revokedAt":null}}

curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:6180/api/v1/admin/tokens
curl -X DELETE "http://127.0.0.1:6180/api/v1/admin/tokens/<tokenId>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# {"ok":true}
```

Omitting `role` defaults to the owner's role (or `write`); omitting `ttlMs` means no expiry.

### 7.3 Sign-in and sessions

The login endpoint itself needs no credential: it trades a user-directory user name + password for an API
token (the plaintext is returned once, then sent as a bearer token).

```bash
curl -X POST http://127.0.0.1:6180/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"ss-rtdb"}'
# {"token":"<64 hex chars>","expiresAt":null,"user":{"username":"admin","role":"admin"}}
```

- `ttlMs` is optional; omitting it means the token never expires (same rule as `POST /api/v1/admin/tokens`).
- An unknown user and a wrong password both return `401 E_AUTH` (no user enumeration); a missing field
  returns `400 E_INVALID_POINT`.

```bash
# Who the credential belongs to, and which scopes its role grants
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/auth/session
# {"user":{"username":"admin","role":"admin"},"source":"token","scopes":["query","write","admin"]}

# Sign out: revoke the current API token (the static auth.token / basic credentials report revoked=false)
curl -X POST http://127.0.0.1:6180/api/v1/auth/logout -H "Authorization: Bearer $TOKEN"
# {"ok":true,"revoked":true}
```

---

## 8. Observability endpoints (no authentication)

```bash
curl http://127.0.0.1:6180/healthz
# {"status":"ok"}

curl http://127.0.0.1:6180/api/v1/status

curl http://127.0.0.1:6180/metrics      # Prometheus text exposition
```

`/api/v1/status` shape:

```json
{
  "uptimeMs": 12345,
  "databases": 2,
  "metrics": 1204,
  "write":  { "pointsPerSec": 51230, "buffered": 0, "duplicates": 13, "tagsIgnored": 0 },
  "wal":    { "pendingBytes": 0, "outstandingBatches": 0, "pendingPoints": 0, "lastFsyncMs": 1760691600000 },
  "segments": { "openFiles": 3, "bytesToday": 610000000 },
  "cache":  { "blocks": 256, "blockHitRate": 0.93, "heapUsedMb": 180, "externalMb": 64 },
  "gc":     { "count": 12, "totalMs": 340, "maxMs": 41 },
  "query":  { "count": 5000, "p50Ms": 2, "p95Ms": 11, "p99Ms": 28, "maxMs": 96 }
}
```

## 9. CORS

CORS is **off by default**. Set `cors.allowedOrigins` (e.g. `["https://rtdb-admin.example.com"]` or
`["*"]`) to let a browser-based console on another origin call this instance. Preflight `OPTIONS` is
answered with `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS` and
`Access-Control-Allow-Headers: Authorization, Content-Type`, cached for 600 s.

## 10. Next steps

- [05 — Client SDKs](./05-client-sdks.md) — use these endpoints from Node or Python.

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Endpoint index: documented `GET /` → 302 to `/admin/` (still 404 when `admin.enabled=false`) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Write fields: clarified that v0.1.0 only accepts `quality = 0`; non-zero returns `400 E_INVALID_POINT` | DeepSeek-V4.1-Flash |
| 2026-10-17 | Added §7.3 "Sign-in and sessions" plus three endpoint-index rows: `POST /api/v1/auth/login`, `GET /api/v1/auth/session`, `POST /api/v1/auth/logout` | DeepSeek-V4.1-Flash |
