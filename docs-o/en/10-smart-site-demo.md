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
| Influx `quality` (0–100) | rtdb v0.1.0 only accepts `q=0` (omitted = good); non-zero returns `400 E_INVALID_POINT` |
| `dev_data_tags.scanRate` (usually 1000 ms) | `--interval` (default 1000 ms); `--points-per-tick` / `--rate` add more samples to the same window |
| `dev_data_tags.unit` / `name` | Shown by `--list` only (rtdb stores neither) |

Notes:

- **The metric name is the tag path**: identical to `dev_data_tags.path` (lowercase, hyphen
  separated), so the same tag can be matched one-to-one across Smart Site and rtdb.
- **Value types lock on first write**: every catalog tag has a fixed type (f64 / i64 / bool /
  string) and the simulator never changes it, avoiding `E_TYPE_MISMATCH`.
- **Quality flags are not usable in v0.1.0**: Smart Site uses a 0–100 ratio, rtdb a u8 flag where
  `0` = good; the current version (M0) **rejects any non-zero quality** (`400 E_INVALID_POINT`) to
  avoid silent loss. The simulator therefore only repeats the previous sample (stale) on a simulated
  communication fault and never sends `q`.

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
with the window) or run several client processes against different `--db` values.

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
```

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
  ```

  This window runs the client (`--rate <pts/s> --duration <seconds> --log-every 1`) and forwards any extra
  options. While the server is still booting the script **waits for the token file** (the client resolves its
  token only once, wait capped at 10 s). Exit code `3` (server unreachable) is retried up to 3 times, 3 s
  apart, then the script tells you to start the server. With `RTDB_PORT` set the client switches to that port
  too. A huge `duration` (e.g. `3000000000`) means "run forever"; Ctrl+C stops only the client;
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
- no quality flag is sent: v0.1.0 only accepts `q=0` (omitted = good) and rejects non-zero values.

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
| `400 E_INVALID_POINT ... quality=…` | A non-zero quality flag was written (unsupported in v0.1.0) | Omit `q`; this demo never sends a quality flag |
| `--db` rejected | Database names cannot contain `-` and similar characters | Use letters, digits and underscores, e.g. `smartfactory_demo` |
| `--list` reports an unknown device | Typo in `--devices` | Run `--list` to see the available device codes |
| `exceed the catalog capacity` at startup | Points per batch exceed `metricCount × interval` | Raise `--interval`, lower `--points-per-tick`, or use fewer `--devices` |
| `--rate` together with `--points-per-tick` fails | Both control the same knob | Pass only one of them |

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
