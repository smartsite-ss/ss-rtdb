# 02 — Configuration

This page covers configuration of **Form B** (`rtdb-server` / `rtdbctl`). Form A passes the equivalent
options directly to `RtdbEngine` — see [06 — Embedded engine](./06-embedded-engine.md#2-engine-options).

## 1. Precedence

Configuration is merged from four layers, lowest priority first:

```
built-in defaults  <  config file  <  environment variables  <  explicit arguments
```

- **Config file**: JSON. `conf/rtdb-server.json` under the **working directory** is loaded automatically when
  present (both the repository and the release package ship it); `--config <path>` or `RTDB_CONFIG` point at
  a different file, replacing the default one instead of layering on top of it.
- **Environment variables**: see the table in §4.
- **Explicit arguments**: the `overrides` object when embedding `RtdbServer` in your own process; the
  `--data-dir` / `--url` / `--token` / `--timeout` flags for `rtdbctl` (they affect the CLI only, not
  the server config).

Unknown keys in the config file are ignored. Numeric values that fall outside the supported range are
**clamped** to the boundary and a `WARN` is logged — a bad number never blocks startup. Only genuine
*semantic conflicts* fail startup (§5).

## 2. Config file

The runtime layout keeps the configuration in `conf/rtdb-server.json`:

```
ss-rtdb/            (repository root, or the root of a release package)
├── bin/            start / packaging scripts
├── conf/
│   └── rtdb-server.json    <- edit this file; loaded automatically from the working directory
└── src/
```

`bin\start-server.bat` starts the server with the repository (or package) root as the working directory, so
that file is picked up without any environment variable. Running the server from another directory simply
means the built-in defaults apply, unless `RTDB_CONFIG` points at a file. The file below lists **every key
with its default value**, so it can be used as a template as-is — every key is optional and omitted keys keep
their default:

```json
{
  "port": 6180,
  "host": "127.0.0.1",
  "dataDir": "./rtdb-data",
  "retentionDays": 0,
  "archiveDir": "",
  "archiveBeforeDelete": false,

  "quality": { "store": "all", "onReject": "reject" },

  "auth": {
    "enabled": true,
    "mode": "token",
    "token": "",
    "tokenFile": "./rtdb.token",
    "username": "admin",
    "password": "",
    "passwordHash": "",
    "bootstrapUsername": "admin",
    "bootstrapPassword": "ss-rtdb",
    "write": true,
    "query": true,
    "usersFile": "",
    "tokensFile": ""
  },

  "admin": { "enabled": true, "staticDir": "", "exposePaths": false },
  "cors": { "allowedOrigins": [] },

  "write": {
    "walEnabled": true,
    "fsyncPolicy": "wal",
    "blockTargetPoints": 16384,
    "blockMinPoints": 1024,
    "flushIntervalMs": 5000,
    "maxBufferBytes": 268435456,
    "maxPendingPoints": 2000000,
    "maxBatch": 1000000
  },

  "storage": { "segment": { "maxBytes": 209715200, "maxPerDay": 1000 } },
  "cache": { "blocks": 256, "fdGroups": 32 },
  "query": { "defaultLimit": 100000 },
  "http": { "maxBodyBytes": 67108864 },
  "log": { "level": "info" }
}
```

Start with a specific file (any file name):

```bash
rtdbctl serve --config /etc/rtdb/rtdb.config.json                       # CLI (parses --config)
RTDB_CONFIG=/etc/rtdb/rtdb.config.json npm start --workspace @ss/rtdb-server
```

`rtdb-server` itself reads no command-line arguments — pass the config path through `RTDB_CONFIG`.

## 3. Key reference

| Key | Default | Meaning |
| --- | ------- | ------- |
| `port` | `6180` | HTTP port. `0` = let the OS pick a free port (tests / containers). |
| `host` | `127.0.0.1` | Bind address. |
| `dataDir` | `./rtdb-data` | **Data root**. One process at a time may own it. |
| `retentionDays` | `0` | Global default retention in days; `0` = keep forever. Per-database override wins. |
| `archiveDir` | `""` | Cold-archive destination; empty = `{dataDir}/archive`. Must be on the same volume. |
| `archiveBeforeDelete` | `false` | Pack an expiring day directory into `tar.gz` before deleting it. |
| `quality.store` | `all` | Quality store threshold: `all` (Good/Uncertain/Bad all stored) \| `good-uncertain` (drop Bad) \| `good` (Good only). A per-database `{database}/quality.json` (e.g. `{"store":"good"}`) wins. |
| `quality.onReject` | `reject` | Below the threshold: `reject` fails the batch with `400 E_QUALITY_REJECTED`; `drop` accepts the request but discards the point, counting it only in `write.qualityDropped`. |
| `auth.enabled` | `true` | Master authentication switch. |
| `auth.mode` | `token` | `token` \| `basic` \| `both`. |
| `auth.token` | `""` | Static bearer token. Empty → read/generate `auth.tokenFile`. |
| `auth.tokenFile` | `./rtdb.token` | Where the auto-generated token is stored (mode `0600`). |
| `auth.username` | `admin` | Basic-auth user, and the identity attributed to the static token. |
| `auth.password` | `""` | Basic-auth password (plaintext in config; prefer `passwordHash`). |
| `auth.passwordHash` | `""` | scrypt hash `scrypt$N$r$p$saltHex$hashHex`, generated by `auth.hashPassword()`. |
| `auth.bootstrapUsername` | `admin` | Default administrator created on first start (empty user directory); empty disables the bootstrap. |
| `auth.bootstrapPassword` | `ss-rtdb` | Password of that administrator (persisted as a scrypt hash only); empty disables the bootstrap. |
| `auth.write` | `true` | Require a credential on write endpoints. |
| `auth.query` | `true` | Require a credential on query endpoints. |
| `auth.usersFile` | `""` | User directory JSON; empty = `{dataDir}/rtdb-users.json`. |
| `auth.tokensFile` | `""` | API token directory JSON; empty = `{dataDir}/rtdb-tokens.json`. |
| `admin.enabled` | `true` | Serve the Web console at `/admin`. |
| `admin.staticDir` | `""` | Override the console asset directory; empty = bundled `packages/admin/dist`. |
| `admin.exposePaths` | `false` | `false`: `GET /api/v1/databases/:db` reports the directory **relative to the working directory** (`rtdb-data/plant_a`); `true`: the resolved absolute path (host layout is disclosed). |
| `cors.allowedOrigins` | `[]` | Opt-in CORS origins; `["*"]` allows any. Empty disables CORS entirely. |
| `compat.influx.enabled` | `true` | Master switch for the InfluxDB compatibility surface (`/write`, `/api/v2/write`, `/api/v3/write_lp`, `/ping`, `/query`). |
| `compat.influx.metricPrefix` | `""` | Prefix of folded metric names; use `influx.` during migration to separate them from native metrics. |
| `compat.influx.tagFolding` | `metric` | `metric` folds tags into the name; `ignore` drops them (explicitly lossy). |
| `compat.influx.fieldFolding` | `metric` | `metric` emits one metric per field; `reject` rejects multi-field lines. |
| `compat.influx.duplicatePolicy` | `last` | In-request `(metric, millisecond)` resolution: `last` or `first`. |
| `compat.influx.maxBodyBytes` | `26214400` | Compatibility write body cap (compressed and decoded, 25 MiB). |
| `compat.influx.defaultOrg` | `""` | Fallback `org` for v2 writes; empty = required. |
| `compat.influx.allowQueryCredentials` | `false` | Accept `?u=&p=` / `?access_token=` (credentials leak into access logs). |
| `compat.influx.rejectNoSync` | `false` | Treat `no_sync` as an error; by default it is accepted with `X-Rtdb-NoSync: ignored`. |
| `compat.influx.influxql` | `read-only` | `off` disables `/query` and `/api/v3/query_influxql`; `read-only` enables the subset. |
| `compat.influx.versionHeader` | `2.7.8` | `X-Influxdb-Version` value on `/ping` (declares the compatibility baseline). |
| `compat.influx.cardinalityWarnThreshold` | `100000` | Warn once when the folded metric count exceeds this value. |
| `write.walEnabled` | `true` | Write-ahead log. Set `false` only when data can be re-generated. |
| `write.fsyncPolicy` | `wal` | `wal` = group fsync after each WAL append; `none` = rely on the OS. |
| `write.blockTargetPoints` | `16384` | Primary block-finalize trigger (points per block). |
| `write.blockMinPoints` | `1024` | Lower bound for the periodic fallback finalize. |
| `write.flushIntervalMs` | `5000` | Periodic flush fallback interval. |
| `write.maxBufferBytes` | `268435456` | Memory watermark for not-yet-blocked points; exceeding → `429`. |
| `write.maxPendingPoints` | `2000000` | Unflushed point watermark; exceeding → `429`. |
| `write.maxBatch` | `1000000` | Max points in a single write request; exceeding → `413`. |
| `storage.segment.maxBytes` | `209715200` | Segment soft size cap (200 MiB); rolling happens at block boundaries. |
| `storage.segment.maxPerDay` | `1000` | Max segments per day directory. |
| `cache.blocks` | `256` | LRU entries for decoded blocks. |
| `cache.fdGroups` | `32` | LRU entries for open segment file handles. |
| `query.defaultLimit` | `100000` | Default `limit` for `range` queries. |
| `http.maxBodyBytes` | `67108864` | HTTP body cap (64 MiB); exceeding → `413`. |
| `log.level` | `info` | `debug` \| `info` \| `warn` \| `error`. |

### Clamps (out-of-range values are silently clamped + `WARN`)

| Option | Min | Max |
| ------ | --- | --- |
| `storage.segment.maxBytes` | 16 MiB | 4 GiB |
| `write.blockTargetPoints` | 4 096 | 65 536 |
| `write.blockMinPoints` | 64 | 65 536 |
| `write.flushIntervalMs` | 200 | 60 000 |
| `write.maxBufferBytes` | 16 MiB | 2 GiB |
| `write.maxPendingPoints` | 100 000 | 10 000 000 |
| `cache.blocks` | 16 | 4 096 |
| `cache.fdGroups` | 4 | 256 |
| `retentionDays` | 0 | 3 650 |
| `storage.segment.maxPerDay` | 1 | 1 000 |

### Compatibility layer (`compat.influx`)

The compatibility layer is a **side adapter**: it never changes the `/api/v1/*` contract or the auth model
(writes still need the `write` scope, queries the `query` scope).

- `measurement + tags + field` is folded into one metric name `measurement|field|key=value...` (tag keys sorted,
  `\`, `|`, `=` escaped). `tagFolding=ignore` drops tags and can collapse distinct series; it is opt-in.
- The timestamp unit comes from `precision` (`ns/us/ms/s/m/h` and full names); storage stays millisecond.
  Points landing in the same millisecond are merged according to `duplicatePolicy`.
- A duplicate `(metric, millisecond)` from a **later request** is not overwritten (append-only storage keeps the
  first point). This is a documented difference from InfluxDB's last-write-wins.
- Capabilities tied to a specific InfluxDB generation (Flux `/api/v2/query`, SQL `/api/v3/query_sql`, bucket
  management `/api/v2/buckets`, `/api/v3/configure/*`) answer **501** with a `hint` pointing at the replacement
  endpoint instead of pretending to succeed.

## 4. Environment variables

| Variable | Maps to |
| -------- | ------- |
| `RTDB_CONFIG` | config file path |
| `RTDB_PORT` | `port` |
| `RTDB_HOST` | `host` |
| `RTDB_DATA_DIR` | `dataDir` |
| `RTDB_RETENTION_DAYS` | `retentionDays` |
| `RTDB_QUALITY_STORE` | `quality.store` |
| `RTDB_QUALITY_ON_REJECT` | `quality.onReject` |
| `RTDB_AUTH_ENABLED` | `auth.enabled` (`true`/`1`, `false`/`0`) |
| `RTDB_TOKEN` | `auth.token` |
| `RTDB_AUTH_USERNAME` | `auth.username` |
| `RTDB_AUTH_PASSWORD` | `auth.password` |
| `RTDB_AUTH_BOOTSTRAP_USERNAME` | `auth.bootstrapUsername` |
| `RTDB_AUTH_BOOTSTRAP_PASSWORD` | `auth.bootstrapPassword` |
| `RTDB_AUTH_USERS_FILE` | `auth.usersFile` |
| `RTDB_AUTH_TOKENS_FILE` | `auth.tokensFile` |
| `RTDB_ADMIN_ENABLED` | `admin.enabled` |
| `RTDB_ADMIN_EXPOSE_PATHS` | `admin.exposePaths` (`true`/`1`, `false`/`0`) |
| `RTDB_CORS_ALLOWED_ORIGINS` | `cors.allowedOrigins` (comma separated) |
| `RTDB_COMPAT_INFLUX_ENABLED` | `compat.influx.enabled` (`true`/`1`, `false`/`0`) |
| `RTDB_COMPAT_INFLUX_METRIC_PREFIX` | `compat.influx.metricPrefix` |
| `RTDB_COMPAT_INFLUX_TAG_FOLDING` | `compat.influx.tagFolding` |
| `RTDB_COMPAT_INFLUX_FIELD_FOLDING` | `compat.influx.fieldFolding` |
| `RTDB_COMPAT_INFLUX_DUPLICATE_POLICY` | `compat.influx.duplicatePolicy` |
| `RTDB_COMPAT_INFLUX_MAX_BODY_BYTES` | `compat.influx.maxBodyBytes` |
| `RTDB_COMPAT_INFLUX_DEFAULT_ORG` | `compat.influx.defaultOrg` |
| `RTDB_COMPAT_INFLUX_ALLOW_QUERY_CREDENTIALS` | `compat.influx.allowQueryCredentials` |
| `RTDB_COMPAT_INFLUX_REJECT_NO_SYNC` | `compat.influx.rejectNoSync` |
| `RTDB_COMPAT_INFLUX_INFLUXQL` | `compat.influx.influxql` |
| `RTDB_COMPAT_INFLUX_VERSION_HEADER` | `compat.influx.versionHeader` |
| `RTDB_COMPAT_INFLUX_CARDINALITY_WARN_THRESHOLD` | `compat.influx.cardinalityWarnThreshold` |
| `RTDB_LOG_LEVEL` | `log.level` |

Additional variables used by the CLI only:

| Variable | Maps to |
| -------- | ------- |
| `RTDB_URL` | server base URL for online subcommands (default `http://127.0.0.1:<port>`) |
| `RTDB_TOKEN` | bearer token sent by the CLI |
| `RTDB_DATA_DIR` | data root for offline subcommands |

## 5. Startup validation (these DO fail startup)

| Condition | Error |
| --------- | ----- |
| `port` outside `0…65535` | `E_INTERNAL` |
| `host` is not loopback **and** `auth.enabled = false` | `E_AUTH` — a non-loopback listener must authenticate |
| `write.blockMinPoints > write.blockTargetPoints` | `E_INTERNAL` |
| `write.maxBatch < 1` | `E_INTERNAL` |
| mode `basic`/`both` with neither `password` nor `passwordHash` | `E_AUTH` |
| Config file missing / malformed JSON / root not an object | `E_IO` / `E_INTERNAL` |

Loopback means `localhost`, `::1`, or `127.x.x.x`.

## 6. Sample configurations

### 6.1 Local development (loopback, auto-generated token)

```json
{
  "dataDir": "./rtdb-data",
  "log": { "level": "debug" }
}
```

### 6.2 Production, LAN-exposed, basic auth, 90-day retention with archiving

```json
{
  "host": "0.0.0.0",
  "port": 6180,
  "dataDir": "/var/lib/ss-rtdb",
  "retentionDays": 90,
  "archiveBeforeDelete": true,
  "archiveDir": "/var/lib/ss-rtdb/archive",
  "auth": {
    "enabled": true,
    "mode": "both",
    "username": "admin",
    "passwordHash": "scrypt$16384$8$1$<saltHex>$<hashHex>"
  },
  "log": { "level": "info" }
}
```

Generate a hash without writing it by hand:

```bash
node --input-type=module -e "
import { hashPassword } from './packages/server/src/auth.ts';
console.log(hashPassword('your-strong-password'));
"
```

Paste the resulting `scrypt$…` string into `auth.passwordHash` and keep `auth.password` empty.

### 6.3 Standalone Web console (CORS)

Deploy `packages/admin/dist` to your own web server and point it at a remote instance. The browser
calls the REST API cross-origin, so the instance must allow that origin:

```json
{
  "host": "0.0.0.0",
  "cors": { "allowedOrigins": ["https://rtdb-admin.example.com"] },
  "admin": { "enabled": false }
}
```

### 6.4 Default administrator on first start

When `auth.enabled = true` (the default) **and** the user directory (`rtdb-users.json`) is **empty**, startup
creates one administrator:

- User name `admin`, password `ss-rtdb` (override with `auth.bootstrapUsername` / `auth.bootstrapPassword`;
  an empty value disables the bootstrap).
- Only a scrypt hash is written, and the log mentions that the default administrator was created.
- The bootstrap **only applies to an empty directory**: an instance that already has users (or a changed
  password) is never reset on restart.

With those credentials you can exchange a user name + password for an API token (see
[04 — HTTP API](./04-http-api.md) §7.3); the console's **Sign in** form uses the same endpoint:

```bash
curl -X POST http://127.0.0.1:6180/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"ss-rtdb"}'
# {"token":"<64 hex chars>","expiresAt":null,"user":{"username":"admin","role":"admin"}}
```

> Change the password right after the first sign-in (Access control panel). For production deployments,
> leave `auth.bootstrapPassword` empty and provision the user directory (hashes) before starting.

## 7. Where runtime state is written

| File | Location | Purpose |
| ---- | -------- | ------- |
| `lock` | `{dataDir}/lock` | Data-root ownership (pid). Stale locks from dead processes are taken over. |
| `rtdb.token` | `auth.tokenFile` (default `./rtdb.token`) | Auto-generated bearer token, `0600`. |
| `rtdb-users.json` | `{dataDir}/` | User directory (scrypt hashes only). |
| `rtdb-tokens.json` | `{dataDir}/` | API token directory (hashes only). |
| `retention.json` | `{dataDir}/{database}/` | Per-database retention override, written by `setRetention`. |

## 8. Next steps

- [03 — Running the server & `rtdbctl`](./03-running-and-cli.md)

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Added `auth.bootstrapUsername` / `auth.bootstrapPassword` (defaults `admin` / `ss-rtdb`), their environment variables and §6.4 "Default administrator on first start" | DeepSeek-V4.1-Flash |
| 2026-10-17 | Documented the runtime `conf/rtdb-server.json` (auto-loaded from the working directory, shipped by the repository and the release package) and `admin.exposePaths` with `RTDB_ADMIN_EXPOSE_PATHS` | DeepSeek-V4.1-Flash |
| 2026-10-17 | `admin.exposePaths` now defaults to `false`: the reported database directory is relative to the working directory; `true` opts into the absolute path | DeepSeek-V4.1-Flash |
| 2026-10-18 | Added the §3 "Compatibility layer (`compat.influx`)" block: 12 configuration keys and 12 `RTDB_COMPAT_INFLUX_*` environment variables (write compatibility on by default, InfluxQL `read-only`, tag/field folding, precision and the no-cross-request-overwrite caveat) | DeepSeek-V4.1-Flash |
| 2026-10-18 | Added `quality.store` / `quality.onReject` (with the per-database `quality.json` override) and the `RTDB_QUALITY_STORE` / `RTDB_QUALITY_ON_REJECT` environment variables | DeepSeek-V4.1-Flash |
