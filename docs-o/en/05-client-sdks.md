# 05 — Client SDKs (Node & Python)

Both SDKs are **pure HTTP** clients for Form B. They contain no engine code, so they can run in a
different process, container or host from the database, and they have **zero runtime dependencies**.

| SDK | Package | Language | Notes |
| --- | ------- | -------- | ----- |
| `@ss/rtdb-client` | `packages/demo/client-node` | TypeScript / JavaScript (Node ≥ 24) | Full surface incl. admin (users & tokens) |
| `ss-rtdb-client` | `packages/demo/client-python` | Python ≥ 3.9 | Data plane + `status` + Line Protocol helper |

The two SDKs are contract-identical for the six data methods; the three deliberate runtime differences
are listed in §2.6.

### Value type mapping (both SDKs)

The `vt` type marker (`1`=f64, `2`=i64, `3`=bool, `4`=string) is handled **for you**: the SDK infers it
from the language type when writing, and narrows it back when reading.

| Write | Node | Python | Stored type |
| ----- | ---- | ------ | ----------- |
| f64 | `number` | `float` | `1` |
| i64 | `bigint` | `int` | `2` (carried as a decimal string on the wire) |
| bool | `boolean` | `bool` | `3` |
| string | `string` | `str` | `4` |

| Read | Node | Python |
| ---- | ---- | ------ |
| `vt=1` | `number` (`null` → `NaN`) | `float` (`None` → `nan`) |
| `vt=2` | `bigint` | `int` |
| `vt=3` | `boolean` | `bool` |
| `vt=4` | `string` | `str` |

---

## 1. Node SDK

### 1.1 Install

```bash
npm install @ss/rtdb-client
```

Or, inside this repository, import the workspace source directly:

```ts
import { RtdbClient } from './packages/demo/client-node/src/index.ts';
```

### 1.2 Construct

```ts
import { RtdbClient } from '@ss/rtdb-client';

const client = new RtdbClient({
  baseUrl: 'http://127.0.0.1:6180',
  token: process.env.RTDB_TOKEN,     // sent as Authorization: Bearer <token>
  timeoutMs: 10_000,                 // default 10 000, clamped to 1 000…60 000
  maxRetries: 3,                     // default 3, capped at 3
  maxBatchPoints: 100_000,           // default 100 000
  retryDelayMs: 200,                 // default 200; wait = base * 2^n
});
```

### 1.3 Write

```ts
const { accepted } = await client.writeBatch('plant_a', [
  { metricName: 'station01.powerMeter.kwh', timestamp: Date.now(), value: 1024.5 },   // f64
  { metricName: 'station01.valve.open',     timestamp: Date.now(), value: true },     // bool
  { metricName: 'station01.pump.state',     timestamp: Date.now(), value: 'running' },// string
  { metricName: 'station01.counter.pulses', timestamp: Date.now(), value: 42n },      // i64 (bigint)
]);
```

Inputs larger than `maxBatchPoints` are split into ordered chunks and sent sequentially. A chunk is
all-or-nothing: on failure the remaining chunks are aborted and the server error propagates, while
`accepted` reflects the chunks that already succeeded.

Non-finite numbers (`NaN`, `±Infinity`) are rejected locally with `E_CLIENT_INVALID_ARGUMENT` — they
have no JSON representation.

### 1.4 Query

Decoded results use **long field names**: `{ timestamp, value, quality? }` for points and
`{ start, end, value, count }` for aggregate windows.

```ts
// range
const series = await client.queryRange('plant_a', 'station01.powerMeter.kwh', {
  start: startMs, end: endMs, limit: 10_000, order: 'asc',
});
for (const point of series.points) console.log(point.timestamp, point.value);
// series.received: server receive-time window ({ min, max } ms epoch, block/batch granularity; absent for legacy servers/blocks)

// at — batch point-in-time lookup (step = previous-value hold / linear = piecewise-linear; state tells real points from computed ones)
const atPoints = await client.queryAt('plant_a', 'station01.powerMeter.kwh', {
  timestamps: [startMs, startMs + 60_000], mode: 'linear',
});
for (const at of atPoints) console.log(at.timestamp, at.value, at.state);

// last — latest point at or before `before` (omit for the latest overall)
const last = await client.queryLast('plant_a', 'station01.powerMeter.kwh', { before: endMs });

// last-batch — newest point of many metrics in one round trip; the Map keeps the request order and a
// metric without a point (or an unknown name) maps to null
const latest = await client.queryLastBatch('plant_a', [
  'station01.powerMeter.kwh',
  'station01.temperature',
]);

// count — index estimate by default, exact when requested
const count = await client.queryCount('plant_a', 'station01.powerMeter.kwh',
  { start: startMs, end: endMs, exact: false });

// aggregate — six operators
const windows = await client.queryAggregate('plant_a', 'station01.powerMeter.kwh', {
  start: startMs, end: endMs, type: 'avg', windowMs: 60_000,
});
for (const w of windows) console.log(w.start, w.end, w.value, w.count);
```

### 1.5 Status and metadata

```ts
const status = await client.status();                       // full StatusReport
const databases = await client.listDatabases();              // string[]
const metrics = await client.listMetrics('plant_a');         // [{ metricName, firstTs, lastTs, valueType }]
await client.setRetention('plant_a', 90);                    // days; 0 = forever
await client.backup('plant_a', '/mnt/backups/2026-10-17');   // server-side copy
// Optional day range (inclusive; omit for a whole-database backup). Returns partial / range / days
await client.backup('plant_a', '/mnt/backups/2026-09', { startDay: '2026-09-01', endDay: '2026-09-30' });
```

Besides the write / WAL / cache / query counters, `StatusReport` carries `cpu` (`percent` of one core,
`systemPercent` machine share, cumulative `userMs` / `systemMs`) and `memory` (`rssMb`, `heapTotalMb`,
`heapUsedMb`, `externalMb`, `systemTotalMb`, `systemPercent`, `heapPercent`).

### 1.6 Users and tokens (admin)

```ts
await client.createUser({ username: 'collector', password: 'S3cret!', role: 'write', enabled: true });
const users = await client.listUsers();
await client.updateUser('collector', { role: 'readonly', enabled: false });
await client.removeUser('collector');

const issued = await client.issueToken({ user: 'collector', label: 'edge-1', ttlMs: 2_592_000_000 });
console.log(issued.token);          // plaintext, shown once
const tokens = await client.listTokens();
await client.revokeToken(issued.tokenRecord.tokenId);
```

### 1.7 Errors and retries

```ts
import { isRtdbClientError } from '@ss/rtdb-client';

try {
  await client.writeBatch('plant_a', points);
} catch (error) {
  if (isRtdbClientError(error)) {
    console.error(error.code, error.status, error.message, error.details);
  }
}
```

- **Retried automatically**: `429 E_RATE_LIMITED` and transport failures (network / timeout), with
  exponential backoff, at most `maxRetries` extra attempts.
- **Never retried**: `400`, `401`, `403`, `404`, `413`, `500`… — business errors surface immediately.
- The `Retry-After` header is intentionally **not** honoured; latency stays bounded and predictable.

---

## 2. Python SDK

### 2.1 Install

```bash
pip install ./packages/demo/client-python     # from a checkout
pip install -e ./packages/demo/client-python  # editable / development
```

Stdlib only (`urllib`), Python ≥ 3.9, zero runtime dependencies.

### 2.2 Construct

```python
from ss_rtdb_client import RtdbClient

client = RtdbClient(
    base_url="http://127.0.0.1:6180",
    token="...",            # optional
    timeout_ms=10_000,      # default 10 000
    max_retries=3,          # default 3 (0..3)
    max_batch_points=100_000,
    retry_delay_ms=200,
)
```

### 2.3 Write

```python
from ss_rtdb_client import WritePoint

now_ms = 1_760_688_000_000
result = client.write_batch("plant_a", [
    WritePoint("station01.powerMeter.kwh", now_ms, 1024.5),    # float  -> f64
    WritePoint("station01.valve.open",     now_ms, True),      # bool   -> bool
    WritePoint("station01.pump.state",     now_ms, "running"), # str    -> string
    WritePoint("station01.counter.pulses", now_ms, 42),        # int    -> i64
])
print(result.accepted, result.duplicates)
```

`WritePoint` fields are `metric_name`, `timestamp`, `value`, and an optional `quality`. There is no
`vt` argument — the marker is inferred from the Python type.

Raw Line Protocol (a helper beyond the six JSON methods):

```python
client.write_line_protocol(
    "plant_a",
    'station01.powerMeter.kwh 1024.5\nstation01.powerMeter.kwh value=1030.25\n',
)
```

### 2.4 Query

```python
series = client.query_range("plant_a", "station01.powerMeter.kwh",
                            start=start_ms, end=end_ms, limit=10_000, order="asc")
for point in series.points:
    print(point.timestamp, point.value, point.quality)

# at — batch point-in-time lookup (step = previous-value hold / linear = piecewise-linear; state tells real points from computed ones)
at_points = client.query_at("plant_a", "station01.powerMeter.kwh",
                            [start_ms, start_ms + 60000], mode="linear")
for at in at_points:
    print(at.timestamp, at.value, at.state)

last = client.query_last("plant_a", "station01.powerMeter.kwh", before=end_ms)

latest = client.query_last_batch("plant_a",
                                  ["station01.powerMeter.kwh", "station01.temperature"])

count = client.query_count("plant_a", "station01.powerMeter.kwh",
                           start=start_ms, end=end_ms, exact=False)

windows = client.query_aggregate("plant_a", "station01.powerMeter.kwh",
                                 start=start_ms, end=end_ms,
                                 aggregate_type="avg", window_ms=60_000)
for window in windows:
    print(window.start, window.end, window.value, window.count)

status = client.status()        # dict of GET /api/v1/status
```

Note the signature of `query_aggregate`: the operator is the **positional** `aggregate_type`
parameter (not `type`, which is a Python builtin), and the window width is `window_ms`.

### 2.5 Errors

```python
from ss_rtdb_client import RtdbClientError

try:
    client.write_batch("plant_a", points)
except RtdbClientError as error:
    print(error.code, error.status, error.message)
```

Same retry policy as the Node SDK: only `429` and transport failures are retried.

### 2.6 Runtime differences vs. the Node SDK

1. Python has no BigInt — **i64 is limited to ±2^53** (the same safe-integer rule the engine applies).
2. Python has no `undefined` — a non-finite / missing f64 is mapped to `float('nan')`.
3. Sixty-four-bit timestamps are passed as plain `int`.

**The admin surface (users / tokens / backup) exists only in the Node SDK.**

---

## 3. Choosing an integration

| Situation | Use |
| --------- | --- |
| Your app is Node and runs on the same host/box | Consider the embedded engine ([06](./06-embedded-engine.md)) — no HTTP hop |
| Your app is Node and talks to a shared server | `@ss/rtdb-client` |
| Your app is Python | `ss-rtdb-client` |
| Any other language, or a collector that speaks InfluxDB Line Protocol | Plain HTTP ([04](./04-http-api.md)) |

## 4. Next steps

- [06 — Embedded engine (Form A)](./06-embedded-engine.md)

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Corrected SDK directories to `packages/demo/client-node` / `packages/demo/client-python` (workspace source import path and `pip install` commands) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Node SDK `listMetrics` items now include `valueType` (in sync with the server `GET /api/v1/metrics/:db`) | GLM-5.3-Flash |
| 2026-10-17 | Both SDKs' `queryRange`/`query_range` results gain the optional `received` field (server receive-time window, block/batch granularity); Python `Series.received` in sync | GLM-5.3-Flash |
| 2026-10-17 | Both SDKs add `queryAt`/`query_at` (point-in-time interpolated lookup, `step`/`linear`, `state` provenance markers), examples updated | GLM-5.3-Flash |
| 2026-10-18 | Node SDK `backup` gains the optional day range `{ startDay, endDay }` and returns `partial` / `range` / `days`; example updated | DeepSeek-V4.1-Flash |
| 2026-10-18 | Both SDKs gain the batch latest-point call (`queryLastBatch` → `Map<string, ClientPoint \\| null>` / `query_last_batch` → `Dict[str, Optional[Point]]`) over `POST /api/v1/query/last-batch`, keeping request order and mapping unknown metrics to `null` | Step-5-Preview |
| 2026-10-18 | §1.5 documents the new `cpu` / `memory` fields of `StatusReport` | DeepSeek-V4.1-Flash |
