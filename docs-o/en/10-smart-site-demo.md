# 10 — Smart Site demo client (`demo/client-smart-site`)

This client turns the **device / tag naming and value semantics of Smart Site (`ss-v7/ss-services`)**
into rtdb metrics and points and streams them into `rtdb-server`. It is meant for local integration
work, write-path load testing and query/aggregate acceptance, and doubles as a reference for how an
external acquisition system can write into rtdb.

- Location: `src/packages/demo/client-smart-site/` (one directory per test client, alongside
  `client-node` and `client-python`).
- Dependencies: **zero third-party modules** — Node built-ins only; Node ≥ 24 (sources run directly).
- Components: `catalog.ts` (device / tag catalog), `generator.ts` (deterministic signal generator),
  `client.ts` (minimal HTTP client), `main.ts` (CLI).

---

## 1. Data mapping

rtdb only has `database → metric → point`; it has no tag dimension, so the Smart Site
`projectId / deviceId / tagId` triple is folded into "database + metric name":

| Smart Site (`ss-v7/ss-services`) | rtdb representation in this demo |
| -------------------------------- | -------------------------------- |
| One project (Influx bucket isolation) | One database, default `smartfactory_demo` |
| `dev_devices.device_code` + `dev_data_tags.path` | Metric name `<device_code>.<variable>`, e.g. `hvac-chiller.supply-temp` |
| `dataType` = `float32` / `float` | `f64` |
| `dataType` = `int` / `int32` | `i64` (JSON write: decimal string + `"vt": 2`) |
| `dataType` = `bool` | `bool` |
| `dataType` = `string` | `string` |
| Influx `quality` (0–100) | rtdb uses a u8 bit-field quality flag (omitted = `0x00` = good); this demo does not send `q` yet |
| `dev_data_tags.scanRate` (usually 1000 ms) | `--interval` (default 1000 ms); `--points-per-tick` / `--rate` add more samples to the same window |
| `dev_data_tags.unit` / `name` | Shown by `--list` only (rtdb stores neither) |

Notes:

- **The metric name is the tag path**: identical to `dev_data_tags.path` (lowercase, hyphen
  separated), so the same tag can be matched one-to-one across Smart Site and rtdb.
- **Value types lock on first write**: every catalog tag has a fixed type (f64 / i64 / bool /
  string) and the simulator never changes it, avoiding `E_TYPE_MISMATCH`.
- **The simulator sends no quality flag**: Smart Site uses a 0–100 ratio, rtdb a u8 bit-field flag
  (`0x00` = good); the engine accepts non-zero flags and lets `quality.store` / `quality.onReject`
  decide whether they are persisted or rejected (see [06 — Embedded engine](./06-embedded-engine.md) §2
  and [11 — Storage format](./11-segment-format.md) §2.2). The simulator still only repeats the
  previous sample (stale) on a simulated communication fault and sends no `q`; the quality mapping is
  left for a later version.

---

## 2. Simulated station catalog

The catalog mirrors the real tags of the `smartfactory-demo` project: **9 devices / 44 metrics**
covering all four value types.

| Category | Devices (`deviceCode`) | Main tags |
| -------- | ---------------------- | --------- |
| HVAC | `hvac-chiller` / `hvac-chw-pump` / `hvac-tower` | supply/return temperature, flow, power, COP/EER, run status (bool) |
| Sewage | `sewage-in` / `sewage-aerobic` / `sewage-pump-lift` | COD, ammonia, pH, turbidity, dissolved oxygen, ORP (i64), level |
| Workshop energy | `ws-a-meter-01` | voltage, current, power, cumulative energy (counter) |
| Production PLC | `ws-a-plc-01` | power, cycle time, total output (i64), OEE, runtime (i64) |
| MES gateway | `ws-mes-gw-01` | current work order, MES write-back (string) |

Signal model:

- analog = slow sine wave + bounded random walk, clamped to the engineering range and rounded;
- counters accumulate from a rate (energy = power × seconds / 3600, output +1 piece every 25 s);
- booleans flip with a probability, integer state machines (0/1/2) switch with a probability, and
  strings rotate through candidate values;
- with `--glitch-rate` > 0 a tag can enter a short "communication fault": the previous sample is
  repeated (stale) and no quality flag is written.

The same `--seed` and timestamp sequence always produce the same output, which keeps regressions
reproducible.

Print the full catalog:

```bash
cd src
npm run demo:smart-site -- --list
```

---

## 3. Running

```bash
cd src

# Print one batch in wire format without sending it
npm run demo:smart-site -- --dry-run

# Write one batch and verify immediately (last / count / aggregate / metrics)
npm run demo:smart-site -- --once --verify

# Stream for 60 seconds at 1 s and verify afterwards
npm run demo:smart-site -- --duration 60 --verify

# HVAC only, 500 ms period, 0.5% simulated communication faults
npm run demo:smart-site -- --devices hvac-chiller,hvac-chw-pump --interval 500 --glitch-rate 0.005

# Performance run: 20000 points per second for 30 seconds
npm run demo:smart-site -- --rate 20000 --duration 30

# Fixed 5000-point batches, stop after 100000 points
npm run demo:smart-site -- --points-per-tick 5000 --total-points 100000
```

`npm run` needs `--` to separate the script name from its arguments; alternatively call Node directly:

```bash
node packages/demo/client-smart-site/src/main.ts --once --verify
```

### 3.1 Centralized configuration (`demo/conf/`)

All server and connection settings used by the demo live in `src/packages/demo/conf/`:

| File | Purpose |
| ---- | ------- |
| `rtdb-server.json` | Demo server runtime settings: port, bind address, data directory, token file, console directory, WAL and log level |
| `client-smart-site.json` | Client defaults: `url`, `database`, `tokenFile`, `intervalMs`, `pointsPerTick`, `rate`, `totalPoints`, `seed`, `devices`, `glitchProbability`, `logEvery`, `timeoutMs` |
| `rtdb.token` | Bearer token generated on first server start (`*.token` is gitignored) |

- **Server**: `bin\start-demo-server.bat` loads `rtdb-server.json` through `RTDB_CONFIG`; precedence is
  built-in defaults < config file < environment variables (`RTDB_PORT`, `RTDB_DATA_DIR`, …) < explicit arguments.
- **Client**: `client-smart-site.json` is loaded automatically; precedence is built-in defaults <
  config file < command-line arguments. Use `--config <path>` for another file or `--no-config` to skip it.
- Relative paths inside the files resolve against the repository `src\` directory (both wrappers
  switch there first); runtime data goes to `src\packages\demo\data\` (gitignored).
- The client validates its config strictly: unknown keys or wrong types fail immediately instead of
  being silently ignored.

### 3.2 Options

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--config <path>` | `packages/demo/conf/client-smart-site.json` | Use a specific client config file |
| `--no-config` | off | Skip the config file and use built-in defaults |
| `--url <url>` | `http://127.0.0.1:6180` | rtdb-server base URL |
| `--token <token>` | empty | Bearer token (highest priority) |
| `--token-file <path>` | empty | Explicit token file |
| `--db <name>` | `smartfactory_demo` | Target database; must match `^[a-zA-Z][a-zA-Z0-9_]{0,62}$` |
| `--interval <ms>` | `1000` | **Write frequency**: one batch every N ms, minimum 100 ms |
| `--points-per-tick <n>` | `0` | **Points per batch**; `0` = one sample per metric (capped by the window capacity, see §3.3) |
| `--rate <points/s>` | `0` | Target write rate; derives the batch size from `--interval`; mutually exclusive with `--points-per-tick` |
| `--total-points <n>` | `0` | Stop after n written points; `0` = unlimited |
| `--metrics <n>` | `0` | **Simulated variable count**; `0` = the 44-tag catalog. A larger value replicates every tag with a `#k` metric-name suffix (`hvac-chiller.supply-temp#2`), a smaller one truncates the catalog (see §3.3) |
| `--duration <seconds>` | `0` | Run time; `0` = until Ctrl+C |
| `--once` | off | Write exactly one batch and exit |
| `--seed <int>` | `20261017` | RNG seed that determines the signal sequence |
| `--devices <list>` | all | Comma-separated device codes |
| `--glitch-rate <0..1>` | `0` | Per-sample probability of a communication fault |
| `--verify` | off | Query and verify after the run |
| `--dry-run` | off | Print one write batch without sending it |
| `--list` | off | Print the device / tag catalog and exit |
| `--log-every <n>` | `5` | Progress line every n batches |
| `--timeout <ms>` | `10000` | Per-request HTTP timeout |

### 3.3 Performance mode (points per batch and write frequency)

By default a batch carries "one sample per metric", so the batch size is pinned to the 44-tag catalog.
Three options decouple the **batch size** from the **write frequency**:

| Option | Role | Description |
| ------ | ---- | ----------- |
| `--interval <ms>` | Frequency | Send one batch every N ms (minimum 100 ms) |
| `--points-per-tick <n>` | Points per batch | Write n points per batch; `0` (default) = one sample per metric |
| `--rate <points/s>` | Target rate | Derives the batch size from `--interval` (`n ≈ rate × interval / 1000`); mutually exclusive with `--points-per-tick` |
| `--total-points <n>` | Total budget | Stop after n written points; `0` (default) = unlimited |

Multi-point batches come from `SmartSiteSimulator.tickBatch()`:

- points are allocated **round-robin across metrics**, so any two metrics differ by at most one sample;
- timestamps of one metric are **evenly spread and distinct** inside `[t - interval, t]` — the write path
  treats `(metric, timestamp)` as an idempotency key, so repeated timestamps would be silently counted as
  `duplicates`; the generator never produces them;
- derived counters (`counter.rateFrom`) read the rate from the same sample layer, so no cross-layer
  reordering happens.

Capacity: one `interval` window holds at most `metricCount × interval` points (default 44 × 1000 = 44 000).
Exceeding it fails at startup instead of silently dropping points; raise `--interval` (capacity grows
with the window), raise `--metrics`, or run several client processes against different `--db` values.

The startup header prints the effective batch size and target rate; the summary reports the real
throughput, latency percentiles (p50/p95/p99/max) and the gap to the target:

```text
  batch     : 20000 pts/tick (--rate 20000, ~20000 pts/s)
[t=1s] tick 2 · 20000 pts (accepted 40000, dup 0) · 36232 pts/s · p50 82.8 ms · p95 125.0 ms · stale 0
  throughput   25591.8 points/s over 3.1 s (target 20000 points/s)
```

`--dry-run` honours the same options, so `--dry-run --points-per-tick 100` previews a multi-point batch.
All three options can also live in `client-smart-site.json` (`pointsPerTick` / `rate` / `totalPoints`,
where `0` disables them); command-line arguments still win.

### 3.3.1 Variable-count mode (`--metrics`)

`--metrics <n>` scales the **catalog** itself, not just the batch size — the knob for "how many variables
does this site have":

| `--metrics` | Result | Replicas |
| ----------- | ------ | -------- |
| `0` (default) | the native catalog, 9 devices / 44 metrics | 1 |
| `< 44` | the first n catalog tags (truncation) | 1 |
| `1000` | 44 tags × 23 copies = 1000 metrics | 23 |
| `3000` | 44 tags × 69 copies | 69 |
| `6000` | 44 tags × 137 copies | 137 |
| `10000` | 44 tags × 228 copies | 228 |

Replica metric names are `<device>.<variable>#k` (`hvac-chiller.supply-temp#2`); the original tags keep
their plain names. Every replica is an **independent signal stream**: its own RNG stream, wave phase and
state, so the values differ from the original tag, and a `counter.rateFrom` resolves inside its own replica
group (`ws-a-meter-01.yong-dian-liang#2` integrates `ws-a-meter-01.gong-l#2`, not the original's). The
device count stays at 9 — only the metric count grows, which is what the engine's index and write path see.

The practical effect: the per-batch capacity becomes `metrics × interval`, so a single client can push
far more points per batch (10000 metrics × 1000 ms = 10 000 000 pairs), and the server is exercised with
thousands of metrics instead of 44. `--devices` filters first, then the remaining tags are replicated.
`--list` prints the scaled catalog and a `Scaled catalog:` note; the startup header shows
`9 devices / 1000 metrics (44 catalog tags x 23)`.

```bash
# 10,000 variables at 200,000 points/s for a minute
npm run demo:smart-site -- --metrics 10000 --rate 200000 --duration 60
```

`--metrics` also lives in `client-smart-site.json` as `metrics` (`0` = native catalog). The upper bound is
100 000 metrics per process; a non-integer or negative value fails at startup.

### 3.4 Token resolution order

1. `--token <token>`
2. `RTDB_TOKEN` environment variable
3. `--token-file <path>`; otherwise the `tokenFile` value from the config file
4. `rtdb.token` in the current working directory
5. `rtdb.token` next to the executable (SEA single-file releases keep the token beside the exe)

When none is found the client runs anonymously; if the server requires authentication the write
fails with `401 E_AUTH` and the hint tells you to provide a token.

### 3.5 `bin\` wrapper

On Windows you can use `bin\demo-smart-site.bat`, which switches to `src\` and forwards arguments:

```bat
bin\start-demo-server.bat
bin\demo-smart-site.bat list
bin\demo-smart-site.bat dry
bin\demo-smart-site.bat once --token-file ..\release\sea\rtdb.token
bin\demo-smart-site.bat stream 60 --glitch-rate 0.002 --token-file ..\release\sea\rtdb.token
bin\demo-smart-site.bat run --devices hvac-chiller --interval 500 --duration 10 --verify
:: large-volume test: 20,000 points/s for 60 s, then verify the written range
bin\demo-smart-site.bat run --rate 20000 --duration 60 --verify
:: fixed batches: 5,000 points every second until 1,000,000 points are written
bin\demo-smart-site.bat run --points-per-tick 5000 --interval 1000 --total-points 1000000
:: print one large batch in wire format without writing it
bin\demo-smart-site.bat dry --points-per-tick 5000
```

- **Large-volume tests** use `run` with `--rate` (target pts/s), `--points-per-tick` (points per
  batch) or `--total-points` (stop after N points); the batch size is decoupled from the 44-tag
  catalog. One client is still bounded by `metrics × interval` (44 × 1000 = 44,000 points per batch) —
  raise `--interval`, raise `--metrics` (§3.3.1) or run several clients for more. Measured on this
  machine (Ryzen 7 4800H, local disk): `--rate 20000 --duration 10` wrote 220,000 points at
  **21,823 points/s** with 0 duplicates and 0 failed batches; every `--verify` check
  (`count` / `last` / `aggregate`) passed.

- `bin\start-demo-server.bat` starts the demo server from `demo\conf\rtdb-server.json`; when port
  6180 is taken, override it with `set RTDB_PORT=6190`;
- `bin\start-demo-server.bat bench <pts/s> <seconds> [client options]` runs the **load client only** and
  **never starts a server** (start rtdb-server yourself, in another window or as a service):

  ```bat
  :: window 1
  bin\start-demo-server.bat
  :: window 2
  bin\start-demo-server.bat bench 20000 30
  bin\start-demo-server.bat bench 20000 30 --db perf_demo --interval 500
  bin\start-demo-server.bat bench 5000 60 --points-per-tick 5000
  :: variable-count runs: pass --metrics (the catalog is replicated with a "#k" suffix)
  bin\start-demo-server.bat bench 200000 60 --metrics 10000
  ```

  This window runs the client (`--rate <pts/s> --duration <seconds> --log-every 1`) and forwards any extra
  options. While the server is still booting the script **waits for the token file** (the client resolves its
  token only once, wait capped at 10 s). Exit code `3` (server unreachable) is retried up to 3 times, 3 s
  apart, then the script tells you to start the server. With `RTDB_PORT` set the client switches to that port
  too. A huge `duration` (e.g. `3000000000`) means "run forever"; Ctrl+C stops only the client;
- `bin\start-demo-server.bat vars <pts/s> <seconds> [client options]` runs the **variable-count ladder**:
  the same bench for **1000 / 3000 / 6000 / 10000 metrics**, one database per point
  (`perf_vars_1000` … `perf_vars_10000`), so the results stay comparable:

  ```bat
  :: window 2 - four short runs, 3000 points/s for 2 s each
  bin\start-demo-server.bat vars 3000 2
  ```

  Each point prints the client header (`catalog : 9 devices / 1000 metrics (44 catalog tags x 23)`) and a
  `[demo] vars <n> finished with exit code …` line; the ladder ends with the list of databases it wrote.
  Pass `--db` in the extra options to share one database instead (later `--db` wins);
- `list` / `dry` / `once` / `stream` are presets: `once` means `--once --verify`, and `stream`
  runs 60 seconds by default with `--verify` (the seconds argument is optional);
- `run` forwards all remaining arguments unchanged; `run --help` shows the full client help;
- an unknown action exits with `1`; all other exit codes match the client (`0/2/3`);
- the script runs inside `src\`, so relative paths resolve from there: a token in the SEA release
  directory is `..\release\sea\rtdb.token`.

---

## 4. Write format

The body printed by `--dry-run` is exactly what is sent
(`POST /api/v1/write?db=smartfactory_demo`):

```json
[
  { "metricName": "hvac-chiller.supply-temp", "t": 1792224000000, "v": 8.6, "vt": 1 },
  { "metricName": "hvac-chiller.status", "t": 1792224000000, "v": true, "vt": 3 },
  { "metricName": "sewage-aerobic.orp", "t": 1792224000000, "v": "-127", "vt": 2 },
  { "metricName": "ws-mes-gw-01.m-e-s-hui-xie", "t": 1792224000000, "v": "ok", "vt": 4 }
]
```

- `t` is a millisecond epoch and `vt` the type marker (`1`=f64, `2`=i64, `3`=bool, `4`=string);
- i64 **must** travel as a decimal string so JSON numbers cannot lose precision;
- no quality flag is sent (this demo's choice): omitting `q` means `0x00` = good.

---

## 5. Verification

`--verify` (or curl / an SDK) checks one representative metric per value type:

```text
Verification
  PASS  hvac-chiller.supply-temp  type=f64  count=1  last=7.5  good
  PASS  hvac-chiller.status  type=bool  count=1  last=true  good
  PASS  sewage-aerobic.orp  type=i64  count=1  last=-127  good
  PASS  ws-mes-gw-01.dang-qian-pai-chan-gong-dan  type=string  count=1  last=WO-20261017-001  good
  PASS  aggregate/avg hvac-chiller.supply-temp  windows=1  first=7.5
  PASS  database smartfactory_demo: 44 metrics
```

What is checked:

1. `query/last` returns a point whose decoded type matches the catalog (i64 narrows back to an integer);
2. `query/count` (exact) counts more than zero points inside the run window;
3. `query/aggregate` (`avg`) on the first f64 metric returns at least one window;
4. `/api/v1/metrics/:db` lists all 44 metrics.

Exit codes:

| Code | Meaning |
| ---- | ------- |
| `0` | Writes (and verification) succeeded |
| `1` | Bad arguments or an unexpected error |
| `2` | Writes succeeded but verification failed |
| `3` | Server unreachable, authentication failed, or 5 consecutive write failures |

Manual query example:

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/last" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"smartfactory_demo","metricName":"hvac-chiller.supply-temp"}'
```

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `401 E_AUTH` | Authentication is enabled but no token was supplied, or the token does not match the server | Pass `--token` / `RTDB_TOKEN` / `--token-file` |
| `401 E_AUTH` after `--token rtdb.token` | `--token` takes the token **value**, not a file path (it is sent as the bearer token as-is and **overrides** the config `tokenFile`) | Use `--token-file rtdb.token`, or `--token <64-char value>`; identical file names do not mean identical tokens — the demo server uses `packages\demo\conf\rtdb.token`, the SEA release (`release\sea\rtdb-server.exe`) uses `release\sea\rtdb.token` |
| `--url` connection failure | Server not running or a different port | Start `rtdb-server` and check the port |
| `E_TYPE_MISMATCH` | The metric already exists with another value type | Use another `--db`, or clear that database and rerun |
| `400 E_INVALID_POINT ... Illegal quality flag` | `q` is not an integer `0..255` | Send a valid u8 flag, or omit `q` |
| `400 E_QUALITY_REJECTED` | Quality is below the database/global `quality.store` threshold with `onReject='reject'` | Omit `q`, relax `quality.store`, or switch to `onReject='drop'` |
| `--db` rejected | Database names cannot contain `-` and similar characters | Use letters, digits and underscores, e.g. `smartfactory_demo` |
| `--list` reports an unknown device | Typo in `--devices` | Run `--list` to see the available device codes |
| `exceed the catalog capacity` at startup | Points per batch exceed `metricCount × interval` | Raise `--interval`, raise `--metrics`, lower `--points-per-tick`, or use fewer `--devices` |
| `--rate` together with `--points-per-tick` fails | Both control the same knob | Pass only one of them |
| `metricTarget must be a positive integer …` / `… exceeds the 100000-metric limit` | `--metrics` was negative, fractional or above 100 000 | Use an integer in `1 … 100000` (`0` = native catalog) |

## 7. Next steps

- [04 — HTTP API](./04-http-api.md): the full write / query protocol.
- [05 — Client SDKs](./05-client-sdks.md): integrate from your own application (Node / Python).
- [08 — Operations & maintenance](./08-operations.md): data directories, retention and backups.

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | New page: Smart Site demo client (data mapping, catalog, options, write format, verification and troubleshooting) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Added the `bin\demo-smart-site.bat` wrapper (list / dry / once / stream / run presets) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Added §3.1 centralized configuration: `packages/demo/conf/` (`rtdb-server.json`, `client-smart-site.json`) and `bin\start-demo-server.bat`; the client supports `--config` / `--no-config` | DeepSeek-V4.1-Flash |
| 2026-10-17 | Added §3.3 performance mode: `--points-per-tick` (points per batch), `--rate` (target points/s) and `--total-points` (budget); new `tickBatch()` generator (evenly spread timestamps inside the window, capacity check); progress and summary now report points/s, p99/max and the gap to the target | DeepSeek-V4.1-Flash |
| 2026-10-17 | §3.5 documents `bin\start-demo-server.bat bench <pts/s> <seconds> [client options]`: **load client only, never starts a server** (start rtdb-server yourself; waits for the token file, retries 3 times while unreachable) | DeepSeek-V4.1-Flash |
| 2026-10-17 | §6 troubleshooting covers `--token rtdb.token` → `401 E_AUTH` (`--token` takes the value and overrides the config `tokenFile`; the demo instance and the SEA release use different token files); the client now warns when `--token` looks like a path and the 401 hint explains the precedence | DeepSeek-V4.1-Flash |
| 2026-10-18 | §3.5 and `bin\demo-smart-site.bat` add **large-volume** examples (`--rate 20000 --duration 60 --verify`, `--points-per-tick 5000 --total-points 1000000`, `dry --points-per-tick 5000`), plus the capacity bound and a measured 21,823 points/s run | DeepSeek-V4.1-Flash |
| 2026-10-18 | New §3.3.1 **variable-count mode** `--metrics <n>` (and config key `metrics`): the catalog is replicated with a `#k` metric-name suffix (1000 / 3000 / 6000 / 10000 variables = 44 tags × 23/69/137/228), each replica an independent signal stream with its own `counter.rateFrom` group; `bin\start-demo-server.bat` gains the `vars <pts/s> <seconds>` ladder (one `perf_vars_<count>` database per point) and `bench … --metrics` forwarding | Step-5-Preview |
| 2026-10-18 | Quality wording aligned with the implementation: the engine now accepts u8 quality flags with `quality.store` / `quality.onReject` storage policies while the simulator still sends no `q`; §6 troubleshooting gains `E_QUALITY_REJECTED` and illegal-quality rows | DeepSeek-V4.1-Flash |
