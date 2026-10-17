# ss-rtdb — Documentation (English)

**ss-rtdb** is a general-purpose, lightweight real-time / time-series database for industrial and IoT
workloads. It ships in **two forms** that share *one engine* and *one on-disk data format*:

| Form | Package / binary | Shape | Comparable to |
| ---- | ---------------- | ----- | ------------- |
| **A — Embedded library** | `@ss/rtdb-core` | In-process, direct engine calls, no network, no deployment | SQLite |
| **B — Standalone server** | `rtdb-server` (+ `rtdbctl`, SDKs, Web console) | One process exposing an HTTP API, multi-client, multi-language | InfluxDB |

Because both forms use the same data directory format, you can start embedded and later hand the
directory to `rtdb-server` with **zero migration**.

---

## 1. What you get

- **Write**: InfluxDB Line Protocol compatible *and* JSON batch writes; ≥50k points/s target throughput.
- **Query**: exactly four primitives — `range`, `last`, `count`, `aggregate`
  (`avg` / `sum` / `min` / `max` / `count` / `last`).
- **Storage**: one directory per day, capacity-rolled segment files inside it, block encoding with
  Gorilla / delta-of-delta / RLE / dictionary codecs (≥10× compression on full blocks).
- **Durability**: WAL + CRC per block; sealed segments are immutable; power-loss injection shows zero
  corruption.
- **Operations**: retention by whole day directory, cold archive (`tar.gz`), copy-a-directory backup,
  offline repair, built-in status / Prometheus metrics / liveness probe.
- **Zero runtime dependencies**: the engine, server, CLI and both SDKs depend on nothing but the Node /
  Python standard library. No native modules, no `.node` / `.exe` artifacts.
- **Multi-user**: roles `admin` / `write` / `readonly`, scrypt password hashes, revocable API tokens.

### Non-goals (by design)

Single node only (no clustering in the current release); no SQL engine, no JOINs, no transactions, no
multi-tenancy beyond directory-per-database isolation.

---

## 2. Documentation index

| # | Document | Read it when you want to… |
| - | -------- | ------------------------- |
| 01 | [Installation](./01-installation.md) | Install prerequisites, build from source, verify the build |
| 02 | [Configuration](./02-configuration.md) | Configure port, dataDir, auth, retention, storage, logging |
| 03 | [Running the server & `rtdbctl` CLI](./03-running-and-cli.md) | Start/stop the server; use every CLI subcommand |
| 04 | [HTTP API](./04-http-api.md) | Call the REST endpoints directly (curl / any language) |
| 05 | [Client SDKs (Node & Python)](./05-client-sdks.md) | Integrate from application code |
| 06 | [Embedded engine (Form A)](./06-embedded-engine.md) | Embed the engine inside your own Node process |
| 07 | [Web admin console](./07-web-admin.md) | Use / deploy the browser management console |
| 08 | [Operations & maintenance](./08-operations.md) | Backup, restore, archive, retention, repair, monitoring |
| 09 | [Developer guide](./09-developer-guide.md) | Repository layout, tests, benchmarks, contributing |

New users should read **01 → 03 → 04**; operators should read **02 → 08**.

---

## 3. Five-minute quickstart

Requirements: **Node.js ≥ 24** (the sources run directly through Node's native TypeScript type
stripping) and npm.

```bash
# 1. Get the source and install workspace dependencies
cd ss-rtdb/src
npm install

# 2. Build the Web console (optional — skip it and /admin simply 404s)
npm run build --workspace @ss/rtdb-admin

# 3. Start the server (foreground; sources run directly, no build needed)
npm start --workspace @ss/rtdb-server
# -> rtdb-server started: http://127.0.0.1:6180 (dataDir=./rtdb-data)
```

On the first start with authentication enabled (the default) and no token configured, the server
**generates a token and writes it to `./rtdb.token`** (permissions `0600`). Read it:

```bash
cat rtdb.token          # Linux / macOS
type rtdb.token         # Windows cmd
```

Write two points (Line Protocol), then read them back:

```bash
TOKEN=$(cat rtdb.token)

curl -X POST "http://127.0.0.1:6180/api/v1/write?db=plant_a" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary $'station01.powerMeter.kwh 1024.5\nstation01.powerMeter.kwh 1030.25'

curl -X POST "http://127.0.0.1:6180/api/v1/query/last" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh"}'
```

Sanity checks that need no credential:

```bash
curl http://127.0.0.1:6180/healthz     # {"status":"ok"}
curl http://127.0.0.1:6180/api/v1/status
curl http://127.0.0.1:6180/metrics     # Prometheus exposition
```

Open the Web console at <http://127.0.0.1:6180/admin/> (requires the `admin` package to be built — see
[07](./07-web-admin.md)).

---

## 4. Repository layout

```
ss-rtdb/
├── src/                         # npm workspace root (package.json lives here)
│   ├── packages/
│   │   ├── core/                # @ss/rtdb-core      — engine, zero dependencies
│   │   ├── server/              # @ss/rtdb-server    — Form B HTTP service (rtdb-server)
│   │   ├── client-node/         # @ss/rtdb-client    — Node.js SDK
│   │   ├── client-python/       # ss-rtdb-client     — Python SDK (stdlib only)
│   │   ├── cli/                 # @ss/rtdb-cli       — rtdbctl
│   │   └── admin/               # @ss/rtdb-admin     — Vue 3 Web console (private)
│   ├── __tests__/               # unit / integration tests
│   ├── scripts/                 # dependency audit, throughput regression gate
│   └── package.json             # workspace root scripts
└── docs-o/en/                   # this documentation
```

---

## 5. Data model at a glance

```
data root (dataDir)
 └── database            # created automatically on first write; directory-level isolation
      └── metric         # flat name, e.g. "station01.powerMeter.kwh"; value type locked on first write
           └── point { timestamp: ms epoch, value: f64 | i64 | bool | string, quality?: u8 }
```

- **Value types**: `f64`, `i64`, `bool`, `string`. The first write to a metric locks its type; a later
  mismatch returns `E_TYPE_MISMATCH`.
- **i64** is limited to ±2^53 so that SDK-side numbers stay exact; **string** values are limited to
  256 UTF-8 bytes; **metric names** to 512 UTF-8 bytes.
- **Timestamps** are millisecond epoch. Line Protocol timestamps are nanoseconds and are truncated to ms.
- **Database names**: first character a letter, then letters / digits / `_`, at most 63 characters.

---

## 6. License and contact

Apache License 2.0. Every source file carries the standard Apache-2.0 header; see
[09-developer-guide.md](./09-developer-guide.md#6-coding-conventions) before submitting a patch.

- Website: <https://smartsite.top/>
- Contact: zkxxa@qq.com, zcwebms@gmail.com
