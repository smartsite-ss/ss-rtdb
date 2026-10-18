# 06 — Embedded engine (Form A)

Form A embeds the engine directly in your Node process — like SQLite, there is no server, no port and
no network hop. Use it for a single application, an edge box, or anything where "one process owns the
data" is acceptable.

Switching later to Form B requires **no migration**: point `rtdb-server` at the same `dataDir`.

---

## 1. Install and open

```bash
npm install @ss/rtdb-core
```

```ts
import { RtdbEngine } from '@ss/rtdb-core';

const rtdb = new RtdbEngine({ dataDir: './rtdb-data' });
await rtdb.open();

// … use it …

await rtdb.close();   // flushes, seals the active segment, truncates the WAL, releases the lock
```

Always `close()` on shutdown (register `SIGINT` / `SIGTERM` / `process.on('exit')` handlers). A crash
without `close()` is safe — recovery replays the WAL. With `fsyncPolicy='wal'` (the default) **no points
are lost**: the durability order is "blocks written to the segment → `fsync` the segment → advance the WAL
safe point", so at any instant a point is either inside a segment file (already fsynced) or still inside
the WAL (group-fsynced on every append) — the WAL is only truncated after the points it carried are durable
in a segment.

### Data-root lock

`open()` acquires an exclusive **data-root lock** (`{dataDir}/lock`, containing the owning pid). A
second process opening the same directory fails with `E_DB_LOCKED`; a lock left by a dead process is
taken over automatically. Two databases *inside* one data root can be written concurrently from the
same process; two *processes* cannot share a data root.

If you need multi-process access, use Form B.

---

## 2. Engine options

All options are optional except `dataDir`.

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `dataDir` | — | **Required.** Data root directory. |
| `retentionDays` | `0` | Global default retention in days; `0` = forever. Per-database override wins. |
| `archiveBeforeDelete` | `false` | `tar.gz` an expiring day directory before deleting it. |
| `archiveDir` | `{dataDir}/archive` | Archive destination (same volume). |
| `segmentMaxBytes` | `209715200` | Segment soft cap (200 MiB); clamped to 16 MiB…4 GiB. |
| `segmentMaxPerDay` | `1000` | Max segments per day directory. |
| `blockTargetPoints` | `16384` | Primary block-finalize trigger. |
| `blockMinPoints` | `1024` | Lower bound for the periodic finalize. |
| `flushIntervalMs` | `5000` | Periodic flush fallback (each sweep runs in slices: the event loop is yielded every 2 metrics, so a high write rate cannot stall the main thread for hundreds of milliseconds in one sweep). |
| `maxBufferBytes` | `268435456` | Memory watermark for buffered points → `E_RATE_LIMITED`. |
| `maxPendingPoints` | `2000000` | Unflushed point watermark → `E_RATE_LIMITED`. |
| `cacheBlocks` | `256` | LRU entries for decoded blocks. |
| `cacheFdGroups` | `32` | LRU entries for open segment handles. |
| `walEnabled` | `true` | Disable only for reloadable data. |
| `fsyncPolicy` | `wal` | `wal` = group fsync per WAL append, plus a segment fsync before the WAL safe point is advanced; `none` = rely on the OS (reloadable data only). |

Out-of-range values are clamped (see [02 — Configuration](./02-configuration.md#3-key-reference) for
the clamp table).

---

## 3. Writing

```ts
const { accepted } = await rtdb.writeBatch('plant_a', [
  { metricName: 'station01.powerMeter.kwh', timestamp: Date.now(), value: 1024.5 },
  { metricName: 'station01.valve.open',     timestamp: Date.now(), value: true },
  { metricName: 'station01.pump.state',     timestamp: Date.now(), value: 'running', quality: 0 },
  // i64 uses bigint (or a number within ±2^53)
  { metricName: 'station01.counter.pulses', timestamp: Date.now(), value: 9007199254740991n },
]);
```

Type mapping (the metric locks its type on the **first** write):

| JS value | Stored type |
| -------- | ----------- |
| `number` | **f64** (JS numbers are doubles) |
| `bigint` | **i64** (capped at ±2^53) |
| `boolean` | **bool** |
| `string` | **string** (≤256 UTF-8 bytes) |

A later write with a different type throws `E_TYPE_MISMATCH`. Duplicate `(metric, timestamp)` pairs are
counted as duplicates, not as errors — retries are idempotent.

---

## 4. Querying (the four primitives)

```ts
// range — inclusive [start, end]
const series = await rtdb.queryRange('plant_a', 'station01.powerMeter.kwh', {
  start: startMs, end: endMs, limit: 100_000, order: 'asc',
});
// series: { metricName, points: [{ timestamp, value, quality? }], received?: { min, max } }
// received = server receive-time window (ms epoch, block/batch granularity; absent when no hit block carries one)

// last — latest point at or before `before` (omit = latest overall)
const last = await rtdb.queryLast('plant_a', 'station01.powerMeter.kwh', { before: endMs });

// at — batch point-in-time lookup (step = previous-value hold / linear = piecewise-linear; state: exact|interpolated|extrapolated|no-data)
const atPoints = await rtdb.queryAt('plant_a', 'station01.powerMeter.kwh', {
  timestamps: [startMs, startMs + 60_000], mode: 'linear',
});

// count — index estimate by default, exact when requested
const count = await rtdb.queryCount('plant_a', 'station01.powerMeter.kwh',
  { start: startMs, end: endMs, exact: false });

// aggregate — six operators, avg is time-weighted
const windows = await rtdb.queryAggregate('plant_a', 'station01.powerMeter.kwh', {
  start: startMs, end: endMs, type: 'avg', windowMs: 60_000,
});
// [{ start, end, value, count }, ...]
```

More than 100 000 windows in a single `queryAggregate` throws `E_INVALID_RANGE`.

---

## 5. Management

```ts
await rtdb.listDatabases();                  // string[]
await rtdb.listMetrics('plant_a');           // MetricSummary[] — { metricName, firstTs, lastTs, valueType }
await rtdb.hasMetric('plant_a', 'm.kwh');    // boolean — existence only (cached per-segment name set); far cheaper than listMetrics
await rtdb.setRetention('plant_a', 90);      // persists {dataDir}/plant_a/retention.json
await rtdb.runRetention();                   // sweep now (also runs on a timer)
await rtdb.backup('plant_a', '/mnt/backups/2026-10-17');
await rtdb.restore('/mnt/backups/2026-10-17', 'plant_a');
const stats = await rtdb.stats();            // runtime metrics (see §7)
```

`setRetention` writes a per-database override that survives restarts; when absent, the global
`retentionDays` applies.

---

## 6. Errors

```ts
import { ERROR_CODE, RtdbError, isRtdbError } from '@ss/rtdb-core';

try {
  await rtdb.writeBatch('plant_a', points);
} catch (error) {
  if (isRtdbError(error)) {
    console.error(error.code, error.message, error.details);
    if (error.code === ERROR_CODE.RateLimited) {
      await new Promise((r) => setTimeout(r, 1000));   // backpressure — retry later
    }
  }
  throw error;
}
```

Codes: `E_INVALID_POINT`, `E_INVALID_RANGE`, `E_BAD_METRIC_NAME`, `E_TYPE_MISMATCH`, `E_AUTH`,
`E_DB_NOT_FOUND`, `E_METRIC_NOT_FOUND`, `E_DB_LOCKED`, `E_BATCH_TOO_LARGE`, `E_RATE_LIMITED`, `E_IO`,
`E_CORRUPT_BLOCK`, `E_CORRUPT_SEGMENT`, `E_INTERNAL`.

---

## 7. Runtime metrics (`stats()`)

```ts
const stats = await rtdb.stats();
```

| Group | Fields |
| ----- | ------ |
| `uptimeMs`, `databases`, `metrics` | instance scale |
| `write` | `pointsPerSec`, `bufferedPoints`, `duplicatePoints` |
| `wal` | `pendingBytes`, `pendingPoints`, `outstandingBatches`, `lastFsyncMs` |
| `segments` | `openFiles`, `bytesToday` |
| `cache` | `blocks`, `blockHitRate`, `heapUsedMb`, `externalMb` |
| `gc` | `count`, `totalMs`, `maxMs` |
| `query` | `count`, `p50Ms`, `p95Ms`, `p99Ms`, `maxMs` |

Watch `wal.pendingBytes` and `write.buffered` — sustained growth means the sink cannot keep up; watch
`cache.blockHitRate` to size `cacheBlocks`.

---

## 8. Complete example

```ts
import { RtdbEngine, isRtdbError } from '@ss/rtdb-core';

const METRIC = 'station01.powerMeter.kwh';
const rtdb = new RtdbEngine({
  dataDir: './rtdb-data',
  retentionDays: 90,
  blockTargetPoints: 16_384,
});

async function main(): Promise<void> {
  await rtdb.open();

  // simulate one hour of one-second samples
  const end = Date.now();
  const start = end - 3_600_000;
  const points = [];
  for (let ts = start; ts <= end; ts += 1_000) {
    points.push({ metricName: METRIC, timestamp: ts, value: 1000 + Math.random() * 50 });
  }
  console.log('accepted', (await rtdb.writeBatch('plant_a', points)).accepted);

  // one-minute average over the last 10 minutes
  const windows = await rtdb.queryAggregate('plant_a', METRIC, {
    start: end - 600_000, end, type: 'avg', windowMs: 60_000,
  });
  for (const w of windows) console.log(new Date(w.start).toISOString(), w.value, w.count);

  console.log(await rtdb.stats());
}

main()
  .catch((error: unknown) => {
    if (isRtdbError(error)) console.error(`[${error.code}] ${error.message}`);
    else console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await rtdb.close();
  });
```

## 9. Next steps

- [07 — Web admin console](./07-web-admin.md)
- [08 — Operations & maintenance](./08-operations.md)

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Corrected the crash-loss wording: with `fsyncPolicy='wal'` no points are lost (block append → segment fsync → WAL safe point; the former "lose at most ≤5 s" described the pre-fix behavior) | DeepSeek-V4.1-Flash |
| 2026-10-17 | `MetricSummary` returned by `listMetrics` now includes the `valueType` field | GLM-5.3-Flash |
| 2026-10-17 | `Series` returned by `queryRange` gains the optional `received` field (server receive-time window, block/batch granularity) | GLM-5.3-Flash |
| 2026-10-17 | `RtdbEngine` adds the fifth query primitive `queryAt` (batch point-in-time interpolated lookup, `step`/`linear`, `state` provenance markers; see the Interpolation Detailed Design) | GLM-5.3-Flash |
| 2026-10-18 | Adds `hasMetric(database, metricName)` (existence only, cached per-segment name sets); fixes `readBlockValueType` probing too few bytes, which made `listMetrics` re-probe every block of the same metric (the HTTP layer validates the metric on every query; measured ~1.4 s → ~0.15 s per endpoint) | DeepSeek-V4.1-Flash |
| 2026-10-18 | The periodic flush fallback now runs in slices: the event loop is yielded every 2 metrics and the whole sweep performs a single segment `fsync` (measured at 20k points/s: the worst single-sweep stall dropped from ~210–275 ms to ≤58 ms; the residual jitter comes from the write batches themselves) | DeepSeek-V4.1-Flash |
