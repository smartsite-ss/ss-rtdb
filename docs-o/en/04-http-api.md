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
| `query` | `/api/v1/databases`, `/api/v1/databases/:db`, `/api/v1/metrics/:db`, `/api/v1/query/*` | ✅ | ✅ | ✅ |
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
| `GET` | `/healthz` | none | Liveness probe (`{"status":"ok"}`) |
| `GET` | `/health` | none | InfluxDB-shaped health probe (`{"status":"pass",...}`) |
| `GET` | `/api/docs` | none | Built-in HTML API reference (generated from the running configuration) |
| `GET` | `/api/docs/openapi.json` | none | OpenAPI 3.1 document for the served routes |
| `GET` | `/api/v1/databases` | query | List databases |
| `GET` | `/api/v1/databases/:db` | query | On-disk footprint, per-day detail and retention override of one database |
| `GET` | `/api/v1/metrics/:db` | query | List metrics of a database |
| `POST` | `/api/v1/write?db=<db>` | write | Write points (JSON or Line Protocol) |
| `POST` | `/api/v1/query/range` | query | Raw points in a time range |
| `POST` | `/api/v1/query/last` | query | Latest point at or before a timestamp |
| `POST` | `/api/v1/query/last-batch` | query | Latest point of many metrics (1…1000) in one round trip |
| `POST` | `/api/v1/query/count` | query | Point count (estimated or exact) |
| `POST` | `/api/v1/query/aggregate` | query | Windowed aggregation |
| `POST` | `/api/v1/query/at` | query | Point-in-time interpolated lookup |
| `PUT` | `/api/v1/retention/:db` | write | Set per-database retention |
| `POST` | `/api/v1/backup/:db` | write | Trigger a backup (whole database, or a `startDay`/`endDay` day range) |
| `GET` `POST` | `/api/v1/admin/users` | admin | List / create users |
| `PUT` `DELETE` | `/api/v1/admin/users/:username` | admin | Update / remove a user |
| `GET` `POST` | `/api/v1/admin/tokens` | admin | List / issue API tokens |
| `DELETE` | `/api/v1/admin/tokens/:tokenId` | admin | Revoke an API token |
| `POST` | `/api/v1/auth/login` | none (needs user name + password) | Exchange credentials for an API token |
| `GET` | `/api/v1/auth/session` | any valid credential | Identity and scopes of the current credential |
| `POST` | `/api/v1/auth/logout` | any valid credential | Revoke the current API token |
| `GET` | `/ping` | none | InfluxDB-compatible liveness probe (204 + `X-Influxdb-Version`) |
| `POST` | `/write`, `/api/v2/write`, `/api/v3/write_lp` | write | InfluxDB Line Protocol writes (tag/field folding, see §10) |
| `GET` `POST` | `/query`, `/api/v3/query_influxql` | query | InfluxQL read-only subset (see §10) |
| `*` | `/api/v2/query`, `/api/v3/query_sql`, `/api/v2/buckets*`, `/api/v3/configure/*` | — | Explicit `501` + `hint` (Flux / SQL / bucket management unsupported) |
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

`duplicates` only covers duplicates **inside the same batch**. Cross-request duplicates (typically a
retry of the same batch after a timeout) are dropped silently during block merge: the response is still
`accepted=N, duplicates=0` and no counter reflects them. To verify that a retry was idempotent, check
that the exact `count` is unchanged instead.

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
    ],
    "received": { "min": 1760691600050, "max": 1760691600062 }
  }
}
```

`start` / `end` are **inclusive** ms epoch. `limit` defaults to `query.defaultLimit` (100 000);
`order` is `asc` (default) or `desc`.

`series.received` is the **server receive-time window** (ms epoch): `[min, max]` of the server
receive times of the blocks hit by the range plus unblocked buffered points, at block/batch
granularity (not per-point) and independent of the `limit` truncation. Uses: ① tell backfilled
data apart (data timestamps far earlier than the receive time); ② observe client→server link
latency and server blocking (with synchronized clocks, receive time should trail send time
closely). Legacy blocks without the `receivedTime` flag (see doc 11 §2.2) carry no window; the
key is absent when no hit point carries one.

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

### 4.2.1 `last-batch`

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/last-batch" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricNames":["station01.powerMeter.kwh","station01.temperature"]}'
```

```json
{
  "points": [
    { "metricName": "station01.powerMeter.kwh", "point": { "t": 1760688001000, "v": 1030.25, "vt": 1 } },
    { "metricName": "station01.temperature", "point": null }
  ]
}
```

Same lookup as `last`, for **many metrics in one round trip** (1…1000 names; more is `413
E_BATCH_TOO_LARGE`, an empty or non-string list is `400 E_INVALID_POINT`). `points` echoes the request
order, so a caller can zip it with its own list. Unlike `last`, an **unknown metric name is not an
error**: it comes back as `"point": null` — a dashboard page asks for the metrics it just listed, and a
name deleted in between must not fail the other 999 entries. `before` behaves exactly as in `last`.

Use it for anything page-shaped: the console's inventory reads every visible row in one request instead
of one request per row.

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

### 4.5 `at` (point-in-time interpolation)

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/at" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh",
       "timestamps":[1760688000000,1760688900000],"mode":"linear"}'
```

```json
{
  "points": [
    { "t": 1760688000000, "v": 1024.5, "vt": 1, "state": "exact" },
    { "t": 1760688900000, "v": 1037.1, "vt": 1, "state": "interpolated" }
  ]
}
```

Batch value lookup at arbitrary timestamps (fifth query primitive; see the Interpolation Detailed Design):

- `timestamps`: ms epoch array, any order, at most 10 000 per call (exceeding → `400 E_INVALID_POINT`).
- `mode`: `step` (default, previous-value hold — the latest real point at or before `t`) |
  `linear` (piecewise-linear between the two real neighbors; f64/i64 metrics only, other value types
  reject the whole batch with `400 E_TYPE_MISMATCH`; i64 results are rounded back and returned as i64).
- `state`: `exact` = the value exists in storage (previous-value hold included); `interpolated` =
  computed between two real points; `extrapolated` = flat from the nearest real point outside the
  data range; `no-data` = nothing available (`v: null`).
- Results echo the request order; unblocked buffered points participate (visible right after a
  write); a missing metric returns `404 E_METRIC_NOT_FOUND`.

### 4.6 Reading values

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
# {"metrics":[{"metricName":"station01.powerMeter.kwh","firstTs":1760688000000,"lastTs":1760691600000,"valueType":1}]}
```

`valueType` is the value-type marker locked on the metric's first write (same encoding as the `vt` field
of writes/queries: `1=f64 2=i64 3=bool 4=string`), read from the metric's first block header; it is
`null` while the database has no committed block for the metric and it has not been written this session.

### 5.1 Database detail

`GET /api/v1/databases/:db` returns the on-disk footprint of one database plus the retention override that
`PUT /api/v1/retention/:db` writes (`null` = the global default applies). It is a pure filesystem
measurement: no data-root lock is taken, so it is safe while the instance is writing, and the numbers are a
point-in-time snapshot.

`directory` is reported **relative to the server working directory** (`rtdb-data/plant_a`); set
`admin.exposePaths = true` to get the resolved absolute path instead.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/databases/plant_a
# {
#   "database": "plant_a",
#   "directory": "rtdb-data/plant_a",
#   "fileCount": 42,
#   "totalBytes": 1932735283,
#   "breakdown": { "segmentBytes": 1800000000, "indexBytes": 120000000, "walBytes": 13273583, "otherBytes": 0 },
#   "retentionDays": 90,
#   "days": [{ "dateNumber": 20261017, "dayLabel": "20261017", "fileCount": 42, "totalBytes": 1932735283 }]
# }
```

Unknown databases return `404 E_DB_NOT_FOUND`; invalid names return `400 E_INVALID_POINT`.

---

## 6. Retention and backup

```bash
# Set retention (days; 0 = keep forever) — requires the write scope
curl -X PUT "http://127.0.0.1:6180/api/v1/retention/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"days":90}'
# {"ok":true}

# Read the stored retention override (null = the global default applies)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/databases/plant_a
# {"database":"plant_a","directory":"...","fileCount":42,"totalBytes":1932735283,"retentionDays":90,...}

# Trigger a whole-database backup on the server host
curl -X POST "http://127.0.0.1:6180/api/v1/backup/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"targetDir":"/mnt/backups/2026-10-17"}'
# {"files":42,"totalBytes":1932735283,"database":"plant_a","targetDirectory":"/mnt/backups/2026-10-17/plant_a",
#  "partial":false,"range":null,"days":null}

# Day-granular range backup (inclusive, server local time; yyyy-MM-dd or yyyyMMdd)
curl -X POST "http://127.0.0.1:6180/api/v1/backup/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"targetDir":"/mnt/backups/2026-09","startDay":"2026-09-01","endDay":"2026-09-30"}'
# {"files":840,"totalBytes":1932735283,"database":"plant_a","targetDirectory":"/mnt/backups/2026-09/plant_a",
#  "partial":true,
#  "range":{"startDay":20260901,"endDay":20260930,"dayCount":30,
#           "startTimestamp":1756656000000,"endTimestamp":1759247999999},
#  "days":[20260901,"…"]}
```

Range backup semantics:

- **Day granularity** (the day directory is the storage and retention unit). `startDay` / `endDay` can be given
  alone (the missing side defaults to the earliest / latest day directory); omitting both means a
  whole-database backup. Days are server local time and both ends are inclusive.
- A range backup copies only the matching `yyyyMMdd/` directories plus the database-level `retention.json`, and
  writes `manifest.json` into the backup directory. Restoring it (`rtdbctl restore` or `RtdbEngine.restore`)
  **merges** the recorded days: same-day directories are replaced as a group, every other day is kept — a range
  restore can never delete live data outside the range. A full backup (no manifest) still replaces the whole
  database.
- No day directory inside the range, `startDay` after `endDay`, or an invalid date (`2026-02-30`) → `400
  E_INVALID_RANGE`.
- The backup is a **server-side directory copy**: it needs the `write` scope and a writable target on the server
  host, and it does not pause writes (synchronous run-to-completion gives a consistent snapshot).

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
# {"tokens":[{"tokenId":"...","user":"collector","role":"write","label":"edge-gateway-1",
#  "createdAt":...,"expiresAt":...,"revokedAt":null,
#  "lastUsedAt":1760691600000,"lastDatabase":"plant_a","pointsPerSec":1200,"bytesPerSec":98304}],
#  "configToken":{"user":"admin","lastUsedAt":1760691601000,"lastDatabase":"smartfactory_demo",
#  "pointsPerSec":205,"bytesPerSec":30720}}

curl -X DELETE "http://127.0.0.1:6180/api/v1/admin/tokens/<tokenId>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# {"ok":true}
```

Omitting `role` defaults to the owner's role (or `write`); omitting `ttlMs` means no expiry.

Every listed token also carries **runtime usage statistics**. They live in process memory (a restart resets
them) and nothing is added to the token store:

| Field | Meaning |
| ----- | ------- |
| `lastUsedAt` | Timestamp (ms) of the last authenticated request; `null` = the token was never used |
| `lastDatabase` | Database of the last request that addressed one; `null` = only admin endpoints were used |
| `pointsPerSec` | Accepted points per second over a 10 s rolling window |
| `bytesPerSec` | Request payload bytes per second over the same window |

The static `auth.token` (`rtdb.token`; the Smart Site demo client writes with it) has **no record in the token
store**, so it never shows up in `tokens` and its usage is not attributed to any API token. It is reported in a
separate `configToken` object carrying the same four fields plus `user` (the configured `auth.username`). The field
is always present — `lastUsedAt`/`lastDatabase` stay `null` and both rates stay `0` until the static token is used.

A token is a **server-side credential, not a session**: closing a client cannot notify the server, so the token
stays valid until it is revoked (`DELETE`) or reaches `expiresAt` (set `ttlMs` when issuing).

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
- **Single-session semantics**: before issuing a new token, login revokes the same user's previous
  `console login` tokens — repeated sign-ins no longer accumulate orphaned credentials (tokens issued through
  the admin panel with other labels and the static `auth.token` are unaffected).
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
  "cpu":    { "percent": 12.5, "systemPercent": 1.56, "userMs": 15230, "systemMs": 3210 },
  "memory": { "rssMb": 96.4, "heapTotalMb": 40.1, "heapUsedMb": 18.2, "externalMb": 6.1,
              "systemTotalMb": 8192, "systemPercent": 1.18, "heapPercent": 45.39 },
  "cache":  { "blocks": 256, "blockHitRate": 0.93, "heapUsedMb": 180, "externalMb": 64 },
  "gc":     { "count": 12, "totalMs": 340, "maxMs": 41 },
  "query":  { "count": 5000, "p50Ms": 2, "p95Ms": 11, "p99Ms": 28, "maxMs": 96 },
  "compat": { "influx": { "enabled": true, "tagFolding": "metric", "fieldFolding": "metric",
                          "influxql": "read-only", "requests": 42, "writePoints": 8640000,
                          "duplicates": 17, "truncatedPoints": 0, "rejectedLines": 0,
                          "tagsFolded": 8640000, "tagsDropped": 0, "influxqlQueries": 3,
                          "unmappedMetrics": 0, "cardinalityWarn": false } }
}
```

`cpu` / `memory` describe **this process** (not the whole machine):

- `cpu.percent` is the usage between two `stats()` samples, expressed in percent of **one core**, so a
  multi-core saturation can exceed 100. `cpu.systemPercent` divides it by the host's logical CPU count,
  i.e. the share of the whole machine (0–100).
- The sampling window has a 1-second floor: when `/status` and `/metrics` interleave, calls closer than
  that reuse the previous percentage so the window cannot collapse into millisecond noise.
  `cpu.userMs` / `cpu.systemMs` are cumulative CPU time since `open()`.
- `memory.rssMb` is the resident set the OS actually holds; `memory.systemPercent` = RSS / host total memory;
  `memory.heapPercent` = `heapUsedMb` / `heapTotalMb`; `systemTotalMb` is the denominator of the percentage.
  `cache.heapUsedMb` / `cache.externalMb` are the same-snapshot heap/external values kept for older clients.

`/metrics` exposes the matching `rtdb_process_cpu_*`, `rtdb_process_memory_*` and
`rtdb_process_resident_memory_bytes` process families, plus the `rtdb_compat_influx_*` counters (the latter
only while the compatibility layer is enabled).

### 8.1 Built-in API reference (`/api/docs`)

The server generates its own reference page and OpenAPI document from one route-metadata table, so the
published contract cannot drift from the routes that are actually registered.

| Method | Path | Scope | Purpose |
| ------ | ---- | ----- | ------- |
| `GET` | `/api/docs` | none | Self-contained HTML reference: two API families, grouped endpoints, scopes, parameters, request fields, response shapes, `501` table |
| `GET` | `/api/docs/openapi.json` | none | OpenAPI 3.1 document (`paths`, `components.securitySchemes`, error schema) |

- **Two API families, shown apart**: the reference is split into **ss-rtdb native API** (`/api/v1/*`,
  `/metrics`, `/healthz`, `/health`, `/api/docs`) and **InfluxDB compatibility** (`/write`, `/api/v2/*`,
  `/api/v3/*`, `/query`, `/ping`). Each family is its own page section with a coloured header, its own
  sidebar group (native: probes/metrics, catalog, write, query, retention & backup, sign-in, admin,
  console; InfluxDB: Line Protocol writes, InfluxQL queries, connectivity probes) and its own endpoint
  count; the intro shows one summary card per family. Groups of a family never interleave.
- **Public**: like `/status` and `/metrics`, no credential is required. The page documents shapes only —
  it lists no database, metric or token data.
- **Configuration-aware**: with `compat.influx.enabled = false` the whole InfluxDB family (its section,
  sidebar group and the `501` table) disappears; with `admin.enabled = false` the console rows
  (`/admin/`, `/`) and the top-bar Console link disappear. `compat.influx.influxql = off` keeps `/query`
  listed with its "otherwise 501" note.
- **Offline-friendly**: inline CSS and a small inline filter script — no CDN, which matters on air-gapped
  industrial networks. Press `/` to focus the endpoint filter; it matches the path, summary, family and
  group names, hides empty groups/families, and also filters the `501` table.
- The OpenAPI document skips the `/` redirect and the static `/admin/` hosting (not part of the machine
  contract), marks public operations with `security: []`, and tags every operation with both its family
  and its group (`tags: ["native","write"]`, `tags: ["influx","influx-write"]`) plus `x-family`, so
  generated clients can keep the two surfaces apart.
- The console's **API docs** nav entry opens `/api/docs` in a new tab; its URL follows the configured API
  base URL, so a standalone console points at its remote instance (see [07 — Web admin](./07-web-admin.md) §4).

## 9. CORS

CORS is **off by default**. Set `cors.allowedOrigins` (e.g. `["https://rtdb-admin.example.com"]` or
`["*"]`) to let a browser-based console on another origin call this instance. Preflight `OPTIONS` is
answered with `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS` and
`Access-Control-Allow-Headers: Authorization, Content-Type`, cached for 600 s.

## 10. InfluxDB compatibility layer

The layer is controlled by `compat.influx.enabled` (on by default) and is a **side adapter**: the `/api/v1/*`
contract, the write path (`engine.writeBatch`) and the auth ledger (users/tokens/scopes) are unchanged. The full
decision record, difference matrix and fidelity caveats live in `docs-e/03-详细设计/HTTP接口详细设计.md`.

### 10.1 Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/write?db=<db>&precision=ns\|us\|ms\|s\|m\|h` | v1 Line Protocol |
| `POST` | `/api/v2/write?org=<org>&bucket=<bucket>&precision=ns\|us\|ms\|s` | v2 Line Protocol (`Authorization: Token <t>` or `Bearer`) |
| `POST` | `/api/v3/write_lp?db=<db>&precision=<unit>&no_sync=&accept_partial=` | v3 Line Protocol (`precision` also accepts full names) |
| `GET` `POST` | `/query?db=<db>&q=<InfluxQL>&epoch=ms` | v1 InfluxQL read-only subset (POST takes a form or JSON `{db,q}`) |
| `GET` `POST` | `/api/v3/query_influxql?db=<db>&q=<InfluxQL>&format=json` | v3 path, same response shape |
| `GET` | `/ping` | `204` + `X-Influxdb-Version` / `X-Rtdb-Version` / `X-Rtdb-Compat` |
| `*` | `/api/v2/query`, `/api/v3/query_sql`, `/api/v2/buckets*`, `/api/v3/configure/*`, `/api/v2/setup`, `/api/v2/signin`, `/api/v2/tasks*` | `501 {"code":"not implemented","message":…,"hint":…}` |

Successful writes always answer `204 No Content` (as InfluxDB does) with counters in
`X-Rtdb-Accepted`, `X-Rtdb-Duplicates`, `X-Rtdb-Truncated-Points` and `X-Rtdb-Database` (resolved v2 bucket).
`no_sync` is accepted but never changes the server-side durability policy (`X-Rtdb-NoSync: ignored`).
With `accept_partial=true` and rejected lines the response is `200` plus
`{"accepted":N,"duplicates":N,"truncated":N,"rejected":[{line_number,error_message}]}` (at most 100 items).
The default is **atomic**: one invalid line rejects the whole batch with `400` and writes nothing.

### 10.2 Data model mapping

```
cpu,host=srv01,region=us usage_idle=97.2,usage_user=2i 1700000000000000000
→ cpu|usage_idle|host=srv01|region=us = 97.2 (f64)
→ cpu|usage_user|host=srv01|region=us = 2 (i64)
```

- `measurement|field|key=value...`, tag keys sorted; `\`, `|`, `=` escape as `\\`, `\|`, `\=`.
- `tagFolding=metric` (default) keeps distinct tag sets distinct; `ignore` is explicitly lossy and counted in
  `tagsDropped`.
- `fieldFolding=metric` (default) emits one metric per field; `reject` rejects multi-field lines.
- Value typing follows InfluxDB: `42` is a float, `42i` an i64, `42u` returns `400` (u64 unsupported).
- Folded metric names are capped at 512 bytes and string values at 256 bytes; violations return `400` with the
  line number.

### 10.3 Authentication

`Token`, `Bearer` and `Basic` are all accepted; `?u=&p=` / `?access_token=` only with
`compat.influx.allowQueryCredentials=true` (URL credentials end up in access logs). Scope mapping: writes →
`write`, InfluxQL → `query`. Missing/invalid credentials → `401`; insufficient role → `403`.

### 10.4 Error bodies

| Family | Shape |
| ------ | ----- |
| v2 (`/api/v2/*`) | `{"code":"invalid\|not found\|unauthorized\|forbidden\|request too large\|too many requests\|not implemented","message":"…","hint"?,"data"?}` |
| v1 / v3 (`/write`, `/query`, `/api/v3/*`) | `{"error":"…","hint"?,"data"?}` |

Atomic line failures carry `data: [{ "line_number": 2, "error_message": "…" }]`. The `X-Rtdb-Error-Code` header
reports the native ss-rtdb error code; `429` includes `Retry-After: 1`.

### 10.5 InfluxQL read-only subset

```sql
SELECT <field | * | mean|sum|count|min|max|first|last(field)> [, …]
FROM <measurement>
[WHERE time <op> <RFC3339 | integer(ns) | now() [- duration]> [AND tag =|!= 'value']…]
[GROUP BY time(<duration>) [, tag…] [fill(none|null|0|previous)]]
[ORDER BY time ASC|DESC] [LIMIT n] [OFFSET n]

SHOW DATABASES | MEASUREMENTS [ON db] | TAG KEYS [FROM m] | TAG VALUES [FROM m] WITH KEY = "k"
     | FIELD KEYS [FROM m] | RETENTION POLICIES [ON db]
```

Semantics:

- `mean()` is the **point-equal-weight** mean (computed as `sum/count`, matching InfluxQL); the native `avg` is
  time-weighted — do not mix them.
- `GROUP BY time()` windows are epoch-aligned (the first window starts at the next boundary) and `fill` defaults
  to `null`, matching InfluxDB.
- `count()` without `GROUP BY time` uses the exact count, `last()` uses index backtracking, and `first()` performs
  a bounded per-window scan (≤2000 windows).
- **Visibility boundary**: InfluxQL only sees **folded** metric names (`measurement|field[|tag=value…]`, i.e. data
  written through the compatibility layer). Metrics written via the native `/api/v1/write` (no `|` separator) never
  appear in `SHOW MEASUREMENTS` or `SELECT`; they are counted in `status.compat.influx.unmappedMetrics`. Keep this
  isolation in mind when both API families share one database.
- Multi-statement (`;`), multiple measurements, `OR`, regex, subqueries, `INTO`, `DELETE`/`DROP`/`CREATE` all answer
  `501` with a reason.

`epoch` defaults to RFC3339 with millisecond precision; `epoch=ms|s|m|h|u|us|ns` returns integers.

### 10.6 Known differences from InfluxDB

| Difference | Detail |
| ---------- | ------ |
| Cross-request duplicates are not overwritten | Append-only storage keeps the first point; InfluxDB is last-write-wins. In-request duplicates follow `duplicatePolicy` (default `last`). |
| ns → ms truncation | Points sharing a millisecond are merged and counted in `X-Rtdb-Truncated-Points`. |
| Field type is locked forever | InfluxDB can change it per shard; ss-rtdb returns `400 E_TYPE_MISMATCH`. |
| No bucket/org/control plane | `/api/v2/buckets`, `/api/v3/configure/*`, `setup`, `tasks`, Flux and SQL answer `501`. |
| `X-Influxdb-Version` | Declares only the compatibility baseline (default `2.7.8`, configurable); the real version is in `X-Rtdb-Version`. |

### 10.7 Examples

```bash
# v2 clients (Telegraf / Vector influxdb_v2 output)
curl -XPOST "http://127.0.0.1:6180/api/v2/write?org=smart-site&bucket=plant-a&precision=ns" \
  -H "Authorization: Token $TOKEN" -H "Content-Type: text/plain" \
  --data-binary 'cpu,host=srv01 usage_idle=97.2,usage_user=2i 1700000000000000000'

# v3 clients (gzip + accept_partial)
gzip -c points.lp | curl -XPOST "http://127.0.0.1:6180/api/v3/write_lp?db=plant_a&precision=nanosecond&accept_partial=true" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Encoding: gzip" --data-binary @-

# InfluxQL (Grafana InfluxQL data source)
curl -G "http://127.0.0.1:6180/query" --data-urlencode "db=plant_a" --data-urlencode "epoch=ms" \
  --data-urlencode "q=SELECT mean(usage_idle) FROM cpu WHERE host = 'srv01' GROUP BY time(5m) fill(none)" \
  -H "Authorization: Token $TOKEN"
```

## 11. Next steps

- [05 — Client SDKs](./05-client-sdks.md) — use these endpoints from Node or Python.

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Endpoint index: documented `GET /` → 302 to `/admin/` (still 404 when `admin.enabled=false`) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Write fields: clarified that v0.1.0 only accepts `quality = 0`; non-zero returns `400 E_INVALID_POINT` | DeepSeek-V4.1-Flash |
| 2026-10-17 | Added §7.3 "Sign-in and sessions" plus three endpoint-index rows: `POST /api/v1/auth/login`, `GET /api/v1/auth/session`, `POST /api/v1/auth/logout` | DeepSeek-V4.1-Flash |
| 2026-10-17 | Added `GET /api/v1/databases/:db` (on-disk footprint, per-day detail, retention readback) with §5.1, the endpoint index row and the `query` scope entry | DeepSeek-V4.1-Flash |
| 2026-10-17 | `directory` in §5.1 is now documented as relative to the server working directory by default (`admin.exposePaths=true` for the absolute path) | DeepSeek-V4.1-Flash |
| 2026-10-17 | `GET /api/v1/admin/tokens` now returns per-token runtime usage (`lastUsedAt`, `lastDatabase`, `pointsPerSec`, `bytesPerSec`); §7.2 documents the fields and the "credential, not session" rule | DeepSeek-V4.1-Flash |
| 2026-10-17 | §7.2 adds `configToken`: the static `auth.token` (`rtdb.token`) has no token-store record, so its usage is returned separately instead of being dropped | DeepSeek-V4.1-Flash |
| 2026-10-17 | `GET /api/v1/metrics/:db` response now carries `valueType` (value-type marker locked on first write, from the first block header, `null` when unknown); §5 example updated | GLM-5.3-Flash |
| 2026-10-17 | §7.3 login is now **single-session**: issuing a new token first revokes the same user's previous `console login` tokens (other labels and the static token are unaffected) | GLM-5.3-Flash |
| 2026-10-17 | §4.1 `query/range` response adds `series.received` (server receive-time window, block/batch granularity; for backfill identification and link-latency observation), example updated | GLM-5.3-Flash |
| 2026-10-17 | Added §4.5 `POST /api/v1/query/at` (point-in-time interpolated lookup: `step`/`linear` modes, `state` provenance markers, batches ≤10 000) and the endpoint-index row; "Reading values" renumbered to §4.6 | GLM-5.3-Flash |
| 2026-10-18 | Added §10 "InfluxDB compatibility layer": three Line Protocol write endpoints (tag/field folding, precision, gzip, 204, `accept_partial`), `/ping`, InfluxQL read-only subset (`/query`, `/api/v3/query_influxql`), error families, known differences and examples; endpoint index gains `/health`, `/ping`, write/query/501 rows; §8 status gains `compat.influx` counters and the `rtdb_compat_influx_*` families; "Next steps" renumbered to §11 | DeepSeek-V4.1-Flash |
| 2026-10-18 | Added §8.1 "Built-in API reference": `GET /api/docs` (self-contained HTML, public, configuration-aware) and `GET /api/docs/openapi.json` (OpenAPI 3.1 generated from the same route-metadata table); two endpoint-index rows; noted the console **API docs** nav entry | DeepSeek-V4.1-Flash |
| 2026-10-18 | §8.1 now describes the reference as **two API families** (ss-rtdb native vs InfluxDB compatibility): separate page sections, sidebar groups and counts; the search also matches family/group names and the `501` table; OpenAPI operations are tagged `[family, group]` with `x-family` | DeepSeek-V4.1-Flash |
| 2026-10-18 | §3.3 clarifies that `duplicates` only counts **in-batch** duplicates (cross-request retries are de-duplicated silently during block merge, so idempotence must be verified via exact `count`); §10.5 adds the InfluxQL **visibility boundary** (only folded metric names are visible; native metrics are reported as `unmappedMetrics`) | DeepSeek-V4.1-Flash |
| 2026-10-18 | §6 backup gains a **day range** (`startDay`/`endDay`): the response adds `partial`/`range`/`days`, a range backup writes `manifest.json` and restores by merging those days (data outside the range is never deleted); endpoint index row updated | DeepSeek-V4.1-Flash |
| 2026-10-18 | New §4.2.1 **`POST /api/v1/query/last-batch`**: 1…1000 metric names in one round trip, response echoes the request order, unknown names yield `"point": null`; empty/non-string list `400 E_INVALID_POINT`, over 1000 names `413 E_BATCH_TOO_LARGE` | Step-5-Preview |
| 2026-10-18 | §8 `/api/v1/status` gains `cpu` / `memory` (process CPU usage, resident memory, memory and heap usage); `/metrics` gains the `rtdb_process_*` families | DeepSeek-V4.1-Flash |
