// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Engine facade: the `RtdbEngine` public API (aligned with Detailed Design v2.0 §2.2, §2.6, §2.8, §2.9)
 *
 * Responsibility: string together "data root lock -> startup recovery -> WAL orchestration -> segment
 * write/read -> retention policy -> backup/restore" into an in-process singleton form (form A).
 *
 * Write path orchestration (§2.6, the landing point of the consistency point — `writer` does not hold the WAL;
 * batches and safe points are orchestrated by this layer):
 *   1. `writer.checkBatch(points)`: whole-batch validation + two-watermark backpressure (**zero state change**)
 *   2. In-batch `(metricName, timestamp)` dedupe (keep the first, count `duplicatePointCount`)
 *   3. `wal.append(deduped)`: the consistency point — recoverable by power loss from here on
 *   4. `writer.append(deduped)`: buffer + primary block trigger + segment append
 *   5. `recordBatch` records the ledger -> `tryCompleteBatches` completion decision -> `wal.completeBatch` +
 *      `commitSafePoint`
 *
 * Batch completion decision (prefix property): `writer.flush` always dequeues from the buffer head, so for each
 * metric in the batch, as long as
 *   `appendedByMetric(metric) - writer.pendingPointsOf(metric) >= this batch's cumulative appended count`
 * the batch's points on that metric have all landed in segments. When the FIFO head is satisfied, the batch is
 * complete and the safe point advances (§2.5).
 *
 * Query four primitives: in-segment points are read by `SegmentReader` with three layers of pruning; **and the
 * currently unblocked buffered points of each database's writer are merged** (`bufferedPointsOf`), so that a
 * query immediately after `writeBatch` sees the data (real-time database semantics; for the same `(metric, ts)`,
 * segments win).
 *
 * Retention and operations (§2.9, S7): `runRetention` deletes expired **entire day directories** per
 * `retentionDays` (database-level override wins, 0 = permanent), archiving as tar.gz before deletion as needed;
 * `backup` / `restore` are implemented as "whole-database directory replacing copy"; after restore, that
 * database's startup recovery is rerun and the WAL replayed. Before deletion and replacement, that database's
 * segment handles, WAL day-file handles, and decoded block cache are forcibly released (on Windows a file being
 * opened cannot have its directory entry deleted).
 *
 * IO scope: internally always uses `node:fs` synchronous primitives (unit-test determinism + no interleaving
 * with the 5s timer); the public API is uniformly wrapped as `Promise` (§2.2).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';

import { ERROR_CODE, RtdbError } from './errors.ts';
import { dateNumberFromTimestamp, nextDayTimestampFromDateNumber, timestampFromDateNumber } from './format.ts';
import type { SegmentBlockIndexEntry } from './format.ts';
import { DataRootLock } from './lock.ts';
import { BufferPool } from './pool.ts';
import { recoverDataRoot } from './recovery.ts';
import type { DatabaseRecoveryReport } from './recovery.ts';
import {
  ARCHIVE_DIRECTORY_NAME,
  RETENTION_SWEEP_INTERVAL_MS,
  archiveDayDirectory,
  copyDirectoryReplacing,
  deleteDayDirectory,
  planExpiredDayDirectories,
} from './retention.ts';
import type { RetentionSweepResult } from './retention.ts';
import { SegmentReader } from './segment-reader.ts';
import { SegmentStore } from './segment-store.ts';
import { SegmentWriter } from './segment-writer.ts';
import {
  DEFAULT_RANGE_LIMIT,
  ENGINE_DEFAULTS,
  ValueType,
  clampEngineOption,
} from './types.ts';
import type {
  AggregateType,
  AggregateWindow,
  AtPoint,
  EngineOptionName,
  EngineOptions,
  Point,
  RangeOptions,
  Series,
  WritePoint,
} from './types.ts';
import { WAL_ADOPTED_BATCH_ID, WriteAheadLog } from './wal.ts';
import type { WalEntry } from './wal.ts';

/* ---------- Constants ---------- */

/** Maximum number of windows returned by a single aggregate call (prevents a window explosion from too small a `windowMs`; exceeding the limit throws `E_INVALID_RANGE`) */
export const MAX_AGGREGATE_WINDOWS = 100_000;

/** Maximum number of timestamps accepted by one `queryAt` call (exceeding throws `E_INVALID_POINT`) */
export const MAX_QUERY_AT_TIMESTAMPS = 10_000;

/** Milliseconds per day (day-expanding search step for the nearest-point helpers) */
const DAY_MS = 86_400_000;

/** Per-database retention policy file name (listed under the database directory, atomically written by `setRetention`; §6.2.1) */
export const RETENTION_FILE_NAME = 'retention.json';

/** Number of most recent query latencies kept for the `status.query.*` percentiles (ring window over successful queries) */
export const QUERY_LATENCY_SAMPLE_WINDOW = 1024;

/** Bytes per MiB (base of `status.cache.heapUsedMb` / `externalMb`) */
const MEBIBYTE = 1024 * 1024;

/* ---------- Public types ---------- */

/** Engine runtime metrics (status output, per Detailed Design §3.4; only `write.backfilled` remains deferred to M2) */
export interface EngineStats {
  /** Milliseconds elapsed since `open()` */
  uptimeMs: number;
  /** Number of databases under the data root (including ones created this session) */
  databases: number;
  /** Number of metrics across all databases (in-segment index + unblocked buffer) */
  metrics: number;
  write: {
    /** Points accepted into the buffer this session (including recovery replay) */
    acceptedPoints: number;
    /** Currently unblocked points */
    bufferedPoints: number;
    /** Duplicate points silently discarded this session */
    duplicatePoints: number;
    /** Session-average accepted points per second (`acceptedPoints` / seconds since the first write; 0 before it) */
    pointsPerSec: number;
  };
  wal: {
    /** WAL unreleased bytes */
    pendingBytes: number;
    /** Number of outstanding batches */
    outstandingBatches: number;
    /** Points in outstanding batches (accepted but not yet flushed into segments) */
    pendingPoints: number;
    /** Epoch ms of the last WAL group fsync (0 = no fsync yet / `fsyncPolicy != 'wal'`) */
    lastFsyncMs: number;
  };
  segments: {
    /** Current live segment file handle count (including the active segment write-side handle) */
    openFiles: number;
    /** Bytes occupied by today's day directories across all databases (`.seg` + `.idx` + `.wal`) */
    bytesToday: number;
  };
  cache: {
    /** Decoded block cache entries */
    blocks: number;
    /** Decoded block cache hit rate this session ([0,1]; 0 when there has been no lookup) */
    blockHitRate: number;
    /** Node heap used (MiB, `process.memoryUsage().heapUsed`) */
    heapUsedMb: number;
    /** Node external memory including ArrayBuffers (MiB, `process.memoryUsage().external`) */
    externalMb: number;
  };
  gc: {
    /** GC cycles observed since `open()` (0 when GC observation is unavailable) */
    count: number;
    /** Cumulative GC pause (ms) since `open()` */
    totalMs: number;
    /** Longest single GC pause (ms) since `open()` */
    maxMs: number;
  };
  query: {
    /** Successful queries executed since `open()` */
    count: number;
    /** Latency percentiles (ms) over the most recent `QUERY_LATENCY_SAMPLE_WINDOW` queries */
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
}

/** Metric summary (`listMetrics` item) */
export interface MetricSummary {
  metricName: string;
  /** Earliest timestamp (ms epoch) */
  firstTs: number;
  /** Latest timestamp (ms epoch) */
  lastTs: number;
  /** Value type locked on the metric's first write (read from its first block header; null when unknown) */
  valueType: ValueType | null;
}

/** Per-metric index statistics (management API; aggregated from `.idx`/rebuilt indexes, no payload decode) */
export interface DatabaseMetricStats {
  metricName: string;
  /** Earliest timestamp (ms epoch); `0` when the metric only exists in the unflushed write buffer */
  firstTs: number;
  /** Latest timestamp (ms epoch); `0` when the metric only exists in the unflushed write buffer */
  lastTs: number;
  /** Value type locked by the first write; `null` when no block could be probed (buffered-only metric) */
  valueType: ValueType | null;
  /** Stored points (sum of index entry point counts; excludes the unflushed buffer) */
  points: number;
  /** Block count (index entries) */
  blocks: number;
  /** Whole-block byte count (index entry lengths) */
  bytes: number;
}

/** Per-database runtime snapshot used by the management console (`GET /api/v1/databases/{db}`) */
export interface DatabaseRuntimeStats {
  /** Ascending by metric name */
  metrics: DatabaseMetricStats[];
  /** Sum of `metrics[].points` */
  points: number;
  range: { firstTs: number | null; lastTs: number | null };
  segments: { count: number; sealed: number; active: number };
  wal: { pendingBytes: number; outstandingBatches: number };
  /** Database override (`days`) and the effective policy (`days ?? global default`); `0` = keep forever */
  retention: { days: number | null; effectiveDays: number };
}

/** Backup result (`backup` output, §2.9) */
export interface BackupResult {
  database: string;
  /** Backup landing directory (= `{targetDir}/{database}`) */
  targetDirectory: string;
  /** Number of files copied (sealed segments + the current day's active segment snapshot + `.idx` + `.wal` + retention policy file) */
  fileCount: number;
  /** Number of bytes copied */
  totalBytes: number;
}

/** Restore result (`restore` output, §2.9) */
export interface RestoreResult {
  database: string;
  /** Backup source directory (= `{targetDir}/{database}`) */
  sourceDirectory: string;
  fileCount: number;
  totalBytes: number;
}

/* ---------- Internal types ---------- */

/** Outstanding batch ledger item: `cumulativeByMetric` = the cumulative appended point count per metric up to and including this batch */
interface OutstandingBatch {
  batchId: number;
  cumulativeByMetric: Map<string, number>;
}

/** Per-database runtime context: write-side writer, WAL, and batch ledger */
interface DatabaseContext {
  database: string;
  writer: SegmentWriter;
  wal: WriteAheadLog;
  /** Cumulative points appended into the buffer (per metric; the base of the completion decision) */
  appendedByMetric: Map<string, number>;
  /** FIFO outstanding batches */
  outstandingBatches: OutstandingBatch[];
}

/* ---------- Engine ---------- */

export class RtdbEngine {
  /** Data root directory (absolute path) */
  readonly dataDir: string;

  /** Effective global default retention days (already clamped) */
  readonly retentionDays: number;
  readonly segmentMaxBytes: number;
  readonly segmentMaxPerDay: number;
  readonly blockTargetPoints: number;
  readonly blockMinPoints: number;
  readonly flushIntervalMs: number;
  readonly maxBufferBytes: number;
  readonly maxPendingPoints: number;
  readonly cacheBlocks: number;
  readonly cacheFdGroups: number;
  readonly walEnabled: boolean;
  readonly fsyncPolicy: 'wal' | 'none';
  /** Archive landing directory (absolute path; default `{dataDir}/archive`) */
  readonly archiveDir: string;
  /** Whether to archive each whole day as tar.gz before expiration deletion */
  readonly archiveBeforeDelete: boolean;

  private readonly store: SegmentStore;
  private readonly reader: SegmentReader;
  private readonly lock: DataRootLock;
  private readonly bufferPool: BufferPool;

  private readonly contexts = new Map<string, DatabaseContext>();
  /** Per-database retention overrides (read from `retention.json`; used by the S7 retention sweep path) */
  private readonly retentionByDatabase = new Map<string, number>();

  private flushTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private opened = false;
  private openedAt = 0;
  private acceptedPointCount = 0;
  private duplicatePointCount = 0;
  /** Epoch ms of the first write this session (0 = no write yet; base of `write.pointsPerSec`) */
  private firstWriteEpochMs = 0;
  /** GC observation (perf_hooks; disconnected on `close()`); cumulative over this open session */
  private gcObserver: PerformanceObserver | null = null;
  private gcCycleCount = 0;
  private gcTotalPauseMs = 0;
  private gcMaxPauseMs = 0;
  /** Successful query count + the most recent latency samples (ring window, `QUERY_LATENCY_SAMPLE_WINDOW` entries) */
  private queryExecutionCount = 0;
  private readonly queryLatencySamplesMs: number[] = [];

  constructor(options: EngineOptions) {
    if (typeof options.dataDir !== 'string' || options.dataDir.length === 0) {
      throw new RtdbError(ERROR_CODE.Internal, 'EngineOptions.dataDir cannot be empty');
    }
    this.dataDir = resolve(options.dataDir);
    this.retentionDays = clampAndWarn('retentionDays', options.retentionDays ?? ENGINE_DEFAULTS.retentionDays);
    this.segmentMaxBytes = clampAndWarn('segmentMaxBytes', options.segmentMaxBytes ?? ENGINE_DEFAULTS.segmentMaxBytes);
    this.segmentMaxPerDay = clampAndWarn('segmentMaxPerDay', options.segmentMaxPerDay ?? ENGINE_DEFAULTS.segmentMaxPerDay);
    this.blockTargetPoints = clampAndWarn('blockTargetPoints', options.blockTargetPoints ?? ENGINE_DEFAULTS.blockTargetPoints);
    this.blockMinPoints = Math.min(
      clampAndWarn('blockMinPoints', options.blockMinPoints ?? ENGINE_DEFAULTS.blockMinPoints),
      this.blockTargetPoints,
    );
    this.flushIntervalMs = clampAndWarn('flushIntervalMs', options.flushIntervalMs ?? ENGINE_DEFAULTS.flushIntervalMs);
    this.maxBufferBytes = clampAndWarn('maxBufferBytes', options.maxBufferBytes ?? ENGINE_DEFAULTS.maxBufferBytes);
    this.maxPendingPoints = clampAndWarn('maxPendingPoints', options.maxPendingPoints ?? ENGINE_DEFAULTS.maxPendingPoints);
    this.cacheBlocks = clampAndWarn('cacheBlocks', options.cacheBlocks ?? ENGINE_DEFAULTS.cacheBlocks);
    this.cacheFdGroups = clampAndWarn('cacheFdGroups', options.cacheFdGroups ?? ENGINE_DEFAULTS.cacheFdGroups);
    this.walEnabled = options.walEnabled ?? ENGINE_DEFAULTS.walEnabled;
    this.fsyncPolicy = options.fsyncPolicy ?? ENGINE_DEFAULTS.fsyncPolicy;
    this.archiveBeforeDelete = options.archiveBeforeDelete ?? ENGINE_DEFAULTS.archiveBeforeDelete;
    this.archiveDir = resolve(options.archiveDir ?? join(this.dataDir, ARCHIVE_DIRECTORY_NAME));

    this.store = new SegmentStore({
      dataDir: this.dataDir,
      segmentMaxBytes: this.segmentMaxBytes,
      segmentMaxPerDay: this.segmentMaxPerDay,
      cacheFdGroups: this.cacheFdGroups,
    });
    this.reader = new SegmentReader({ store: this.store, cacheBlocks: this.cacheBlocks });
    this.lock = new DataRootLock({ dataDir: this.dataDir });
    this.bufferPool = new BufferPool();
  }

  /* ---------- Lifecycle ---------- */

  /** Whether already open */
  get isOpen(): boolean {
    return this.opened;
  }

  /**
   * Open the engine: acquire the data root lock -> startup recovery (segment inspection + WAL replay) -> read
   * retention overrides -> start the 5s fallback timer and the 1h retention sweep (§2.8, §2.9)
   *
   * On failure, releases the lock already held and rethrows; opening again throws `E_INTERNAL`.
   */
  async open(): Promise<void> {
    if (this.opened) {
      throw new RtdbError(ERROR_CODE.Internal, `Engine is already open: ${this.dataDir}`);
    }
    // Auto-create the data root if it does not exist (§6.2.1: any writable path; auto-created if missing); failure maps to E_IO
    try {
      mkdirSync(this.dataDir, { recursive: true });
    } catch (error) {
      throw new RtdbError(
        ERROR_CODE.Io,
        `Failed to create the data root directory: ${this.dataDir} (${(error as Error).message})`,
      );
    }
    this.lock.acquire();
    try {
      const report = recoverDataRoot({ store: this.store, reader: this.reader });
      for (const databaseReport of report.databases) {
        if (databaseReport.replayedEntries.length > 0) this.replayDatabase(databaseReport);
      }
      this.loadRetentionOverrides();
      this.flushTimer = setInterval(() => this.runFlushTimer(), this.flushIntervalMs);
      this.flushTimer.unref();
      this.retentionTimer = setInterval(() => this.runRetentionTimer(), RETENTION_SWEEP_INTERVAL_MS);
      this.retentionTimer.unref();
      this.opened = true;
      this.openedAt = Date.now();
      this.startGcObserver();
    } catch (error) {
      this.lock.release();
      throw error;
    }
  }

  /**
   * Close the engine: stop timers -> flush each database's buffer + seal the current day's segment + complete
   * remaining batches + close the WAL -> release the Buffer pool -> close the segment store -> release the data
   * root lock
   *
   * Idempotent; collects the first error from each step and rethrows at the end (best-effort completes all
   * cleanup, avoiding leftover handles from a half close).
   */
  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retentionTimer !== null) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.gcObserver !== null) {
      this.gcObserver.disconnect();
      this.gcObserver = null;
    }
    let firstError: unknown = null;
    const capture = (error: unknown): void => {
      if (firstError === null) firstError = error;
    };
    for (const context of this.contexts.values()) {
      try {
        context.writer.close();
        this.tryCompleteBatches(context);
        context.wal.close();
      } catch (error) {
        capture(error);
      }
    }
    this.contexts.clear();
    this.bufferPool.dispose();
    try {
      this.store.close();
    } catch (error) {
      capture(error);
    }
    try {
      this.lock.release();
    } catch (error) {
      capture(error);
    }
    if (firstError !== null) throw firstError;
  }

  /* ---------- Write ---------- */

  /**
   * Write a batch of points (the only write entry point besides the four primitives)
   *
   * Order is as in the file header; any failure of `E_INVALID_POINT` / `E_TYPE_MISMATCH` / `E_RATE_LIMITED`
   * **rejects the whole batch and does not append to the WAL**.
   * Returns `accepted` = points actually buffered (after dedupe).
   */
  async writeBatch(database: string, points: WritePoint[]): Promise<{ accepted: number }> {
    this.requireOpen();
    if (points.length === 0) return { accepted: 0 };

    const context = this.requireContext(database);
    // 1. Whole-batch validation + two-watermark backpressure (zero state change; a rejected batch never enters the WAL)
    context.writer.checkBatch(points);
    // 2. In-batch (metric, ts) dedupe (keep the first)
    const { points: deduped, duplicateCount } = dedupeBatch(points);
    // 3. WAL append (consistency point)
    const receipt = context.wal.append(deduped);
    // 4. Buffer + block formation
    const result = context.writer.append(deduped);
    // 5. Batch ledger -> completion decision -> safe point
    this.recordBatch(context, receipt.batchId, deduped);
    this.duplicatePointCount += duplicateCount;
    this.acceptedPointCount += result.accepted;
    if (this.firstWriteEpochMs === 0) this.firstWriteEpochMs = Date.now();
    this.tryCompleteBatches(context);
    return { accepted: result.accepted };
  }

  /* ---------- Query four primitives ---------- */

  /**
   * Range read (ascending/descending + count limit), source is a merge of in-segment points and unblocked
   * buffered points. The response also carries `received` — the aggregated server receive-time window of the
   * hit blocks plus buffered points (block/batch granularity; independent of the returned point limit;
   * absent when no hit point carries one, e.g. legacy-only blocks).
   */
  async queryRange(database: string, metricName: string, opts: RangeOptions): Promise<Series> {
    this.requireOpen();
    const startedAt = performance.now();
    this.validateRange(opts.start, opts.end);
    const limit = opts.limit ?? DEFAULT_RANGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RtdbError(ERROR_CODE.InvalidRange, `Illegal limit: ${String(opts.limit)}`);
    }
    const order = opts.order ?? 'asc';
    // Ascending takes the first limit; descending reads the "latest limit entries" directly (bounded memory
    // on both paths — neither materializes more than `limit` unique points, 2026-10-18 bounded-memory refactor)
    const receivedOut = { min: 0, max: 0 };
    const points =
      order === 'desc'
        ? this.collectDescendingPoints(database, metricName, opts.start, opts.end, limit, receivedOut)
        : this.collectAscendingPoints(database, metricName, opts.start, opts.end, limit, receivedOut).slice(0, limit);
    const series: Series = { metricName, points };
    if (receivedOut.min !== 0 && receivedOut.max !== 0) series.received = receivedOut;
    return this.finishQuery(startedAt, series);
  }

  /** Get the latest point at or before `before` (`before` defaults to the latest overall; used for report endpoint difference boundary backfill) */
  async queryLast(database: string, metricName: string, opts?: { before?: number }): Promise<Point | null> {
    this.requireOpen();
    const startedAt = performance.now();
    const before = opts?.before ?? Number.MAX_SAFE_INTEGER;
    return this.finishQuery(startedAt, this.latestPointAtOrBefore(database, metricName, before));
  }

  /**
   * Range point count: defaults to an index estimate (sum of the `pointCount` of hit blocks + unblocked buffer
   * count); `exact=true` counts point by point
   */
  async queryCount(
    database: string,
    metricName: string,
    opts: { start: number; end: number; exact?: boolean },
  ): Promise<number> {
    this.requireOpen();
    const startedAt = performance.now();
    this.validateRange(opts.start, opts.end);
    if (opts.exact === true) {
      // Bounded-memory exact count: consume the merged cursor point by point without materializing
      // the point array (2026-10-18 fix for the ~2 GB heap growth on full-day `count exact` queries)
      let count = 0;
      const cursor = this.mergedPointCursor(database, metricName, opts.start, opts.end, 'asc');
      let next = cursor.next();
      while (!next.done) {
        count += 1;
        next = cursor.next();
      }
      return this.finishQuery(startedAt, count);
    }
    let estimate = 0;
    for (const location of this.reader.locateBlocks(database, metricName, opts.start, opts.end)) {
      estimate += location.entry.pointCount;
    }
    const context = this.contexts.get(database);
    if (context !== undefined) {
      const buffered = context.writer.bufferedPointsOf(metricName);
      for (const point of buffered) {
        if (point.timestamp >= opts.start && point.timestamp <= opts.end) estimate += 1;
      }
    }
    return this.finishQuery(startedAt, estimate);
  }

  /**
   * Window aggregation (six operators): window `[start + k*windowMs, start + (k+1)*windowMs)`, the last window
   * **backfilled at the boundary** by the window width
   *
   * `avg` is the **time-weighted average** (the point sequence in the window + the interpolated neighbors
   * before/after the window; accumulated time area / window width); the point-equal-weight mean is computed by
   * the client using `sum` / `count`. Operators are narrowed by the metric value type (§2.2).
   */
  async queryAggregate(
    database: string,
    metricName: string,
    opts: { start: number; end: number; type: AggregateType; windowMs: number },
  ): Promise<AggregateWindow[]> {
    this.requireOpen();
    const startedAt = performance.now();
    this.validateRange(opts.start, opts.end);
    if (!Number.isInteger(opts.windowMs) || opts.windowMs <= 0) {
      throw new RtdbError(ERROR_CODE.InvalidRange, `Illegal aggregate window width: windowMs=${String(opts.windowMs)}`);
    }
    const windowCount = Math.floor((opts.end - opts.start) / opts.windowMs) + 1;
    if (windowCount > MAX_AGGREGATE_WINDOWS) {
      throw new RtdbError(
        ERROR_CODE.InvalidRange,
        `Aggregate window count exceeds the limit: ${windowCount} > ${MAX_AGGREGATE_WINDOWS} (windowMs=${opts.windowMs})`,
      );
    }
    const lastWindowEnd = opts.start + windowCount * opts.windowMs;

    // Streaming aggregation (2026-10-18 bounded-memory refactor): points are fed once in ascending
    // order and each window is finalized as soon as the first point at/after its end arrives, so
    // memory stays bounded by the per-window accumulators instead of the hit point count. Output is
    // bit-identical to the former materialized implementation (same pair order, same edge handling).
    // The before/after edge neighbors only participate in the time-weighted `avg` integral, so they
    // are fetched lazily for `avg` alone.
    const aggregator = new StreamingWindowAggregator(
      opts.type,
      metricName,
      opts.start,
      opts.windowMs,
      windowCount,
    );
    if (opts.type === 'avg') {
      const before = this.latestPointAtOrBefore(database, metricName, opts.start - 1);
      if (before !== null) aggregator.feed(before, false);
    }
    let interiorCount = 0;
    for (const point of this.mergedPointCursor(database, metricName, opts.start, lastWindowEnd - 1, 'asc')) {
      aggregator.feed(point, true);
      interiorCount += 1;
    }
    if (opts.type === 'avg') {
      const after = this.earliestPointAtOrAfter(database, metricName, lastWindowEnd);
      if (after !== null) aggregator.feed(after, false);
    } else if (interiorCount === 0) {
      // Preserve the materialized-implementation semantics: as long as the metric holds any point (even
      // outside the queried range) all windows are returned; only a completely empty metric yields [].
      const before = this.latestPointAtOrBefore(database, metricName, opts.start - 1);
      if (before !== null) aggregator.feed(before, false);
      if (!aggregator.hasPoints) {
        const after = this.earliestPointAtOrAfter(database, metricName, lastWindowEnd);
        if (after !== null) aggregator.feed(after, false);
      }
    }
    if (!aggregator.hasPoints) return this.finishQuery(startedAt, []);
    return this.finishQuery(startedAt, aggregator.finish());
  }

  /**
   * Batch point-in-time lookup (fifth query primitive; Interpolation Detailed Design §3/§4)
   *
   * `mode='step'` (default): previous-value hold — the value of the latest real point at or before
   * `t` (so the state is always 'exact' when a point exists);
   * `mode='linear'`: piecewise-linear between the two real neighbors of `t` ('interpolated'); before
   * the first / after the last data point the nearest point is flat-extracted ('extrapolated').
   * Only f64/i64 metrics support linear (E_TYPE_MISMATCH otherwise, same gate as the aggregate
   * operators); i64 results are rounded back to bigint (type contract preserved).
   * Unblocked buffered points participate, so data written just before the query is visible (same
   * merge + "segments win" dedupe scope as `queryRange`).
   */
  async queryAt(
    database: string,
    metricName: string,
    opts: { timestamps: number[]; mode?: 'step' | 'linear' },
  ): Promise<AtPoint[]> {
    this.requireOpen();
    const startedAt = performance.now();
    const mode = opts.mode ?? 'step';
    if (mode !== 'step' && mode !== 'linear') {
      throw new RtdbError(ERROR_CODE.InvalidPoint, `Illegal interpolation mode: ${String(opts.mode)}`);
    }
    const timestamps = opts.timestamps;
    if (!Array.isArray(timestamps) || timestamps.length === 0) {
      throw new RtdbError(ERROR_CODE.InvalidPoint, 'queryAt requires a non-empty timestamps array');
    }
    if (timestamps.length > MAX_QUERY_AT_TIMESTAMPS) {
      throw new RtdbError(
        ERROR_CODE.InvalidPoint,
        `queryAt accepts at most ${MAX_QUERY_AT_TIMESTAMPS} timestamps per call (got ${timestamps.length})`,
      );
    }
    for (let index = 0; index < timestamps.length; index += 1) {
      if (!Number.isInteger(timestamps[index])) {
        throw new RtdbError(
          ERROR_CODE.InvalidPoint,
          `queryAt timestamps must be integer ms epoch (index ${index}: ${String(timestamps[index])})`,
        );
      }
    }

    // Results echo the request order; evaluate in ascending order with a monotonic two-pointer scan over
    // the merged point cursor (bounded memory: only the two neighbors around the current request are held,
    // edge neighbors are fetched lazily at most once — 2026-10-18 bounded-memory refactor)
    const order = timestamps
      .map((timestamp, index) => ({ timestamp, index }))
      .sort((left, right) => left.timestamp - right.timestamp);
    const min = order[0].timestamp;
    const max = order[order.length - 1].timestamp;

    const results: AtPoint[] = new Array(timestamps.length);
    const cursor = this.mergedPointCursor(database, metricName, min, max, 'asc');
    let cursorNext = cursor.next();
    let left: Point | null = null; // latest point <= current t
    let beforeFirst: Point | null = null;
    let beforeFirstFetched = false;
    let afterLast: Point | null = null;
    let afterLastFetched = false;
    let valueTypeGateDone = mode !== 'linear';
    // Type gate for linear (same operator x value-type matrix as the aggregate primitives); runs once on
    // the first point seen from any source (covered points or edge neighbors, homogeneous per metric)
    const gateLinearValueType = (point: Point): void => {
      if (valueTypeGateDone) return;
      valueTypeGateDone = true;
      const valueType = inferValueTypeFromValue(point.value);
      if (valueType !== ValueType.Float64 && valueType !== ValueType.Int64) {
        throw new RtdbError(
          ERROR_CODE.TypeMismatch,
          `Interpolation mode 'linear' only supports f64/i64; metric ${metricName} is ${valueTypeName(valueType)}`,
        );
      }
    };
    try {
      for (const request of order) {
        while (!cursorNext.done && cursorNext.value.timestamp <= request.timestamp) {
          gateLinearValueType(cursorNext.value);
          left = cursorNext.value;
          cursorNext = cursor.next();
        }
        const right = cursorNext.done ? null : cursorNext.value;
        if (right !== null) gateLinearValueType(right);
        // Left edge neighbor: needed only when no covered point <= t exists yet
        if (left === null && !beforeFirstFetched) {
          beforeFirstFetched = true;
          beforeFirst = this.latestPointAtOrBefore(database, metricName, min);
          if (beforeFirst !== null) gateLinearValueType(beforeFirst);
        }
        // Right edge neighbor (linear only): the true right neighbor may live beyond `max`
        if (mode === 'linear' && right === null && !afterLastFetched) {
          afterLastFetched = true;
          afterLast = this.earliestPointAtOrAfter(database, metricName, max);
          if (afterLast !== null) gateLinearValueType(afterLast);
        }
        results[request.index] = evaluateQueryAtPoint(mode, request.timestamp, left, right, beforeFirst, afterLast);
      }
    } finally {
      // Release the underlying block iteration early when the cursor is not exhausted
      cursor.return();
    }
    return this.finishQuery(startedAt, results);
  }

  /* ---------- Management ---------- */

  /** Database name list under the data root (including databases created this session) */
  async listDatabases(): Promise<string[]> {
    this.requireOpen();
    return this.listDatabaseNamesSync();
  }

  /** Metric summary of a database (in-segment index + unblocked buffer; ascending by metric name) */
  async listMetrics(database: string): Promise<MetricSummary[]> {
    this.requireOpen();
    return this.listMetricsSync(database);
  }

  /** Set a database's retention days (clamped 0~3650; written to `{database}/retention.json`, still effective after restart) */
  async setRetention(database: string, days: number): Promise<void> {
    this.requireOpen();
    const clamped = clampEngineOption('retentionDays', days);
    this.store.ensureDatabase(database);
    this.writeRetentionFile(database, clamped);
    this.retentionByDatabase.set(database, clamped);
  }

  /**
   * Per-database index/WAL/retention snapshot for the management console.
   *
   * Cost: O(segments + index entries); no block payload is decoded (the value type is probed from the first
   * block header of each metric). Disk footprint is measured separately by `measureDatabaseSize` (core/size.ts).
   */
  async databaseStats(database: string): Promise<DatabaseRuntimeStats> {
    this.requireOpen();
    const metrics = this.databaseMetricStatsSync(database);

    let points = 0;
    let firstTs: number | null = null;
    let lastTs: number | null = null;
    for (const metric of metrics) {
      points += metric.points;
      if (metric.points === 0) continue;
      if (firstTs === null || metric.firstTs < firstTs) firstTs = metric.firstTs;
      if (lastTs === null || metric.lastTs > lastTs) lastTs = metric.lastTs;
    }

    const descriptors = this.reader.listSegments(database);
    const sealed = descriptors.filter((descriptor) => descriptor.sealed).length;
    const context = this.contexts.get(database);
    const override = this.retentionByDatabase.get(database) ?? null;
    return {
      metrics,
      points,
      range: { firstTs, lastTs },
      segments: { count: descriptors.length, sealed, active: descriptors.length - sealed },
      wal: {
        pendingBytes: context === undefined ? 0 : context.wal.pendingBytes,
        outstandingBatches: context === undefined ? 0 : context.wal.outstandingBatchIds.length,
      },
      retention: { days: override, effectiveDays: override ?? this.retentionDays },
    };
  }

  /* ---------- Status instrumentation (§3.4) ---------- */

  /** Register the GC observer (best-effort: unavailable platforms simply leave `gc.*` at zero) */
  private startGcObserver(): void {
    if (this.gcObserver !== null) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.gcCycleCount += 1;
          this.gcTotalPauseMs += entry.duration;
          if (entry.duration > this.gcMaxPauseMs) this.gcMaxPauseMs = entry.duration;
        }
      });
      observer.observe({ entryTypes: ['gc'] });
      this.gcObserver = observer;
    } catch {
      this.gcObserver = null;
    }
  }

  /** Record one successful query's latency into the ring window (called from `finishQuery`) */
  private recordQueryLatency(startedAt: number): void {
    this.queryExecutionCount += 1;
    const samples = this.queryLatencySamplesMs;
    samples.push(performance.now() - startedAt);
    if (samples.length > QUERY_LATENCY_SAMPLE_WINDOW) samples.shift();
  }

  /** Wrap a query primitive's result so its latency is sampled exactly once (single exit point per primitive) */
  private finishQuery<T>(startedAt: number, result: T): T {
    this.recordQueryLatency(startedAt);
    return result;
  }

  /** Runtime metrics snapshot (§3.4) */
  async stats(): Promise<EngineStats> {
    this.requireOpen();
    const databaseNames = this.listDatabaseNamesSync();
    let metrics = 0;
    for (const database of databaseNames) metrics += this.listMetricsSync(database).length;

    let bufferedPoints = 0;
    let walPendingBytes = 0;
    let outstandingBatches = 0;
    let walPendingPoints = 0;
    let walLastFsyncMs = 0;
    for (const context of this.contexts.values()) {
      bufferedPoints += context.writer.pendingPointCount;
      walPendingBytes += context.wal.pendingBytes;
      outstandingBatches += context.wal.outstandingBatchIds.length;
      // Buffered points are exactly the points accepted but not yet flushed into segments: a batch
      // completes only after every one of its points is in a segment. Deriving this from the batch
      // ledger's cumulative counters instead would add the oldest outstanding batch's *absolute*
      // cumulative total (cumulative counters are process-wide, not per batch), inflating the metric.
      walPendingPoints += context.writer.pendingPointCount;
      if (context.wal.lastFsyncMs > walLastFsyncMs) walLastFsyncMs = context.wal.lastFsyncMs;
    }

    const todayDateNumber = dateNumberFromTimestamp(Date.now());
    let bytesToday = 0;
    for (const database of databaseNames) {
      bytesToday += this.store.measureDayDirectoryBytes(database, todayDateNumber);
    }

    const cacheLookups = this.reader.blockCacheHitCount + this.reader.blockCacheMissCount;
    const memory = process.memoryUsage();
    const sortedLatencies = [...this.queryLatencySamplesMs].sort((left, right) => left - right);

    return {
      uptimeMs: this.openedAt === 0 ? 0 : Date.now() - this.openedAt,
      databases: databaseNames.length,
      metrics,
      write: {
        acceptedPoints: this.acceptedPointCount,
        bufferedPoints,
        duplicatePoints: this.duplicatePointCount,
        pointsPerSec: this.sessionPointsPerSecond(),
      },
      wal: {
        pendingBytes: walPendingBytes,
        outstandingBatches,
        pendingPoints: walPendingPoints,
        lastFsyncMs: walLastFsyncMs,
      },
      segments: { openFiles: this.store.openDescriptorCount, bytesToday },
      cache: {
        blocks: this.reader.cachedBlockCount,
        blockHitRate: cacheLookups === 0 ? 0 : this.reader.blockCacheHitCount / cacheLookups,
        heapUsedMb: memory.heapUsed / MEBIBYTE,
        externalMb: memory.external / MEBIBYTE,
      },
      gc: { count: this.gcCycleCount, totalMs: this.gcTotalPauseMs, maxMs: this.gcMaxPauseMs },
      query: {
        count: this.queryExecutionCount,
        p50Ms: quantileOfSortedAscending(sortedLatencies, 0.5),
        p95Ms: quantileOfSortedAscending(sortedLatencies, 0.95),
        p99Ms: quantileOfSortedAscending(sortedLatencies, 0.99),
        maxMs: sortedLatencies.length === 0 ? 0 : sortedLatencies[sortedLatencies.length - 1],
      },
    };
  }

  /** Session-average accepted points per second (`acceptedPoints` / seconds since the first write) */
  private sessionPointsPerSecond(): number {
    if (this.firstWriteEpochMs === 0) return 0;
    const elapsedMs = Date.now() - this.firstWriteEpochMs;
    if (elapsedMs <= 0) return 0;
    return Math.round((this.acceptedPointCount / elapsedMs) * 1000);
  }

  /* ---------- Retention and operations (§2.9) ---------- */

  /**
   * Run a retention sweep immediately (per database; the same path the 1h timer triggers automatically, for the
   * CLI `retention` and manual unit-test triggering)
   *
   * Expiration test = `day directory date + retentionDays < today`, and **never deletes** today and the day
   * directory holding the database's active segment; before deletion, if that day's WAL is non-empty (data not
   * yet flushed to segments), that directory is skipped (recorded in `skippedDateNumbers`), ensuring "accepted
   * points are 100% queryable" is not broken by the retention policy.
   */
  async runRetention(): Promise<RetentionSweepResult[]> {
    this.requireOpen();
    return this.sweepAllDatabases();
  }

  /**
   * Back up a database to `{targetDir}/{database}` (whole-database directory replacing copy)
   *
   * Copied content = sealed capacity segments + the current day's active segment snapshot + `.idx` + `.wal` +
   * retention policy file; executed synchronously internally (single-threaded run-to-completion), so it is a
   * **consistent snapshot** and needs no write pause. The backup directory can be restored by another instance
   * via `restore` as a standalone data directory.
   */
  async backup(database: string, targetDir: string): Promise<BackupResult> {
    this.requireOpen();
    const sourceDirectory = this.store.databaseDirectoryPath(database);
    if (!existsSync(sourceDirectory)) {
      throw new RtdbError(ERROR_CODE.DatabaseNotFound, `Database does not exist; cannot back up: ${database}`);
    }
    const targetDirectory = join(resolve(targetDir), database);
    const copied = copyDirectoryReplacing(sourceDirectory, targetDirectory);
    return { database, targetDirectory, fileCount: copied.fileCount, totalBytes: copied.totalBytes };
  }

  /**
   * Restore a database from `{targetDir}/{database}` (whole-database directory replacement)
   *
   * Order: close that database's write context (flush buffer + seal active segment + close WAL) first -> release
   * segment/WAL/block cache handles -> replace the database directory -> rerun that database's startup recovery
   * (half-block truncation + `.idx` rebuild + WAL replay) -> re-read retention overrides.
   * After restore the database is immediately readable/writable; subsequent first writes recreate the write
   * context as needed.
   */
  async restore(targetDir: string, database: string): Promise<RestoreResult> {
    this.requireOpen();
    const sourceDirectory = join(resolve(targetDir), database);
    if (!existsSync(sourceDirectory)) {
      throw new RtdbError(ERROR_CODE.DatabaseNotFound, `The database does not exist in the backup: ${sourceDirectory}`);
    }
    const targetDirectory = this.store.databaseDirectoryPath(database);

    this.closeDatabaseContext(database);
    this.store.closeDescriptorsUnder(targetDirectory);
    this.reader.evictDatabase(database);

    const copied = copyDirectoryReplacing(sourceDirectory, targetDirectory);

    const report = recoverDataRoot({ store: this.store, reader: this.reader, databases: [database] });
    const databaseReport = report.databases[0];
    if (databaseReport !== undefined && databaseReport.replayedEntries.length > 0) {
      this.replayDatabase(databaseReport);
    }

    const days = this.readRetentionFile(database);
    if (days !== null) this.retentionByDatabase.set(database, days);
    else this.retentionByDatabase.delete(database);

    return { database, sourceDirectory, fileCount: copied.fileCount, totalBytes: copied.totalBytes };
  }

  /* ---------- Internal: context and ledger ---------- */

  /** Get (creating if necessary) a database context: writer + WAL (on open, register existing WAL content as an adopted batch) */
  private requireContext(database: string): DatabaseContext {
    const existing = this.contexts.get(database);
    if (existing !== undefined) return existing;

    const context: DatabaseContext = {
      database,
      writer: new SegmentWriter({
        store: this.store,
        database,
        blockTargetPoints: this.blockTargetPoints,
        blockMinPoints: this.blockMinPoints,
        maxBufferBytes: this.maxBufferBytes,
        maxPendingPoints: this.maxPendingPoints,
        bufferPool: this.bufferPool,
        // The WAL safe point must not be advanced before the segment's copy is on stable storage;
        // with `fsyncPolicy='none'` (reloadable scenarios) the extra fsync is skipped.
        fsyncSegments: this.fsyncPolicy === 'wal',
      }),
      wal: new WriteAheadLog({
        store: this.store,
        database,
        enabled: this.walEnabled,
        fsyncPolicy: this.fsyncPolicy,
        adoptExistingLines: true,
      }),
      appendedByMetric: new Map<string, number>(),
      outstandingBatches: [],
    };
    this.contexts.set(database, context);
    return context;
  }

  /**
   * Close and remove a database's write context (flush buffer + seal active segment + complete remaining batches
   * + close WAL)
   *
   * Must be called before the restore flow replaces the database directory: guarantees that the database has no
   * active segment write handle or WAL handle, and that points already accepted in the buffer are all flushed to
   * segments before replacement (otherwise they would be overwritten and lost). Returns silently if there is no
   * context.
   */
  private closeDatabaseContext(database: string): void {
    const context = this.contexts.get(database);
    if (context === undefined) return;
    context.writer.close();
    this.tryCompleteBatches(context);
    context.wal.close();
    this.contexts.delete(database);
  }

  /** Register a batch's cumulative appended count into the ledger (FIFO) */
  private recordBatch(context: DatabaseContext, batchId: number, points: readonly WritePoint[]): void {
    const batchCounts = new Map<string, number>();
    for (const point of points) {
      batchCounts.set(point.metricName, (batchCounts.get(point.metricName) ?? 0) + 1);
    }
    const cumulativeByMetric = new Map<string, number>();
    for (const [metricName, count] of batchCounts) {
      const total = (context.appendedByMetric.get(metricName) ?? 0) + count;
      context.appendedByMetric.set(metricName, total);
      cumulativeByMetric.set(metricName, total);
    }
    context.outstandingBatches.push({ batchId, cumulativeByMetric });
  }

  /** FIFO completion decision: when the head batch is satisfied, `completeBatch` and advance the safe point, until the head is not completed */
  private tryCompleteBatches(context: DatabaseContext): void {
    let completedAny = false;
    while (context.outstandingBatches.length > 0) {
      const head = context.outstandingBatches[0];
      if (!this.isBatchCompleted(context, head)) break;
      context.wal.completeBatch(head.batchId);
      context.outstandingBatches.shift();
      completedAny = true;
    }
    if (completedAny) context.wal.commitSafePoint();
  }

  /** A batch is considered complete once "flushed count >= cumulative appended count" for every metric in the batch */
  private isBatchCompleted(context: DatabaseContext, batch: OutstandingBatch): boolean {
    for (const [metricName, cumulative] of batch.cumulativeByMetric) {
      const appended = context.appendedByMetric.get(metricName) ?? 0;
      const pending = context.writer.pendingPointsOf(metricName);
      if (appended - pending < cumulative) return false;
    }
    return true;
  }

  /** 5s fallback: flush metrics that have reached the lower bound per database, and advance the batch safe point */
  private runFlushTimer(): void {
    if (!this.opened) return;
    for (const context of [...this.contexts.values()]) {
      try {
        context.writer.flush();
        this.tryCompleteBatches(context);
      } catch (error) {
        console.error('[ss-rtdb] Scheduled block flush failed:', error);
      }
    }
  }

  /* ---------- Internal: retention sweep (§2.9) ---------- */

  /** 1h retention sweep timer callback: sweep each database; a single database failure does not affect the others */
  private runRetentionTimer(): void {
    if (!this.opened) return;
    try {
      this.sweepAllDatabases();
    } catch (error) {
      console.error('[ss-rtdb] Retention sweep failed:', error);
    }
  }

  /** Sweep each database's retention (the database list comes from the data root directory, not depending on the write context) */
  private sweepAllDatabases(): RetentionSweepResult[] {
    const results: RetentionSweepResult[] = [];
    for (const database of this.store.listDatabases()) {
      try {
        results.push(this.sweepDatabase(database));
      } catch (error) {
        console.error(`[ss-rtdb] Retention sweep failed (database ${database}):`, error);
      }
    }
    return results;
  }

  /**
   * Single-database retention sweep: plan expired day directories -> check safety conditions one by one ->
   * release handles -> archive as needed -> whole-group deletion
   *
   * Safety conditions (skip that day, do not delete, if any is unmet):
   *   1. That day's WAL is empty (no unflushed data) — otherwise deletion would lose accepted points
   *   2. That day is neither today nor the day holding the database's active segment (already excluded by
   *      `planExpiredDayDirectories`)
   */
  private sweepDatabase(database: string): RetentionSweepResult {
    const retentionDays = this.retentionByDatabase.get(database) ?? this.retentionDays;
    const result: RetentionSweepResult = {
      database,
      retentionDays,
      deletedDateNumbers: [],
      archived: [],
      skippedDateNumbers: [],
      deletedBytes: 0,
    };
    if (retentionDays <= 0) return result;

    const now = Date.now();
    const excludedDateNumbers: number[] = [dateNumberFromTimestamp(now)];
    const activeSegment = this.store.getActiveSegment(database);
    if (activeSegment !== null) excludedDateNumbers.push(activeSegment.dateNumber);

    const candidates = planExpiredDayDirectories(
      this.store.listDayDirectories(database),
      retentionDays,
      now,
      excludedDateNumbers,
    );

    for (const dateNumber of candidates) {
      const walBytes = this.store.segmentFileBytes(this.store.walFilePath(database, dateNumber));
      if (walBytes !== null && walBytes > 0) {
        result.skippedDateNumbers.push(dateNumber);
        console.warn(
          `[ss-rtdb] Retention sweep skipped day directory (WAL non-empty, unflushed data present): ${database}/${dateNumber} (${walBytes}B)`,
        );
        continue;
      }

      const dayDirectory = this.store.dayDirectoryPath(database, dateNumber);
      this.releaseDayHandles(database, dateNumber, dayDirectory);

      if (this.archiveBeforeDelete) {
        const archive = archiveDayDirectory({
          database,
          dateNumber,
          sourceDayDirectory: dayDirectory,
          archiveDirectory: this.archiveDir,
        });
        result.archived.push({
          dateNumber,
          archiveFilePath: archive.archiveFilePath,
          totalBytes: archive.totalBytes,
        });
      }

      result.deletedBytes += deleteDayDirectory(dayDirectory);
      result.deletedDateNumbers.push(dateNumber);
    }
    return result;
  }

  /** Before deleting/replacing a day (or whole database) directory, release the segment handles, WAL day-file handle, and decoded block cache under that directory */
  private releaseDayHandles(database: string, dateNumber: number, dayDirectoryPath: string): void {
    this.store.closeDescriptorsUnder(dayDirectoryPath);
    const context = this.contexts.get(database);
    if (context !== undefined) context.wal.releaseCommittedDayFile(dateNumber);
    this.reader.evictDatabase(database);
  }

  /* ---------- Internal: startup recovery ---------- */

  /**
   * Replay a database's complete WAL lines: skip `(metric, ts)` already present in segments (idempotent) then
   * buffer, and register the entire WAL segment as an **adopted batch** (clearable after the completion decision).
   */
  private replayDatabase(databaseReport: DatabaseRecoveryReport): void {
    const database = databaseReport.database;
    const context = this.requireContext(database);

    const byMetric = new Map<string, WalEntry[]>();
    for (const entry of databaseReport.replayedEntries) {
      const list = byMetric.get(entry.metricName);
      if (list === undefined) byMetric.set(entry.metricName, [entry]);
      else list.push(entry);
    }

    const replayedWritePoints: WritePoint[] = [];
    for (const [metricName, entries] of byMetric) {
      let minTimestamp = Number.POSITIVE_INFINITY;
      let maxTimestamp = Number.NEGATIVE_INFINITY;
      for (const entry of entries) {
        if (entry.timestamp < minTimestamp) minTimestamp = entry.timestamp;
        if (entry.timestamp > maxTimestamp) maxTimestamp = entry.timestamp;
      }
      const existingTimestamps = new Set<number>();
      if (Number.isFinite(minTimestamp)) {
        const existing = this.reader.readMetricPoints(database, metricName, {
          start: minTimestamp,
          end: maxTimestamp,
          limit: Number.MAX_SAFE_INTEGER,
          order: 'asc',
        });
        for (const point of existing) existingTimestamps.add(point.timestamp);
      }
      for (const entry of entries) {
        if (existingTimestamps.has(entry.timestamp)) {
          this.duplicatePointCount += 1;
          continue;
        }
        replayedWritePoints.push({
          metricName,
          timestamp: entry.timestamp,
          value: entry.value,
          quality: entry.quality,
        });
      }
    }

    if (replayedWritePoints.length > 0) {
      const result = context.writer.append(replayedWritePoints);
      this.acceptedPointCount += result.accepted;
    }
    this.recordBatch(context, WAL_ADOPTED_BATCH_ID, replayedWritePoints);
    this.tryCompleteBatches(context);
  }

  /** Read each database's `retention.json` override (databases missing it are not registered, falling back to the global default) */
  private loadRetentionOverrides(): void {
    for (const database of this.store.listDatabases()) {
      const days = this.readRetentionFile(database);
      if (days !== null) this.retentionByDatabase.set(database, days);
    }
  }

  /* ---------- Internal: query helpers ---------- */

  /**
   * Merge "in-segment points (ascending, bounded by `segmentLimit`)" and "unblocked buffered points (range
   * filtered, ascending)" into an ascending deduplicated sequence
   *
   * Dedupe scope: for the same `(metric, ts)`, **in-segment points win** (§2.7 "primary segment wins"); for the
   * same ts, only the first is kept.
   */
  private collectAscendingPoints(
    database: string,
    metricName: string,
    start: number,
    end: number,
    segmentLimit: number,
    receivedOut?: { min: number; max: number },
  ): Point[] {
    const segmentPoints = this.reader.readMetricPoints(
      database,
      metricName,
      {
        start,
        end,
        limit: segmentLimit,
        order: 'asc',
      },
      receivedOut,
    );
    const context = this.contexts.get(database);
    if (context === undefined) return segmentPoints;

    const buffered = context.writer
      .bufferedPointsOf(metricName)
      .filter((point) => point.timestamp >= start && point.timestamp <= end);
    if (buffered.length === 0) return segmentPoints;
    // The buffered points' arrival window merges into the same out param (block/batch granularity)
    if (receivedOut !== undefined) {
      const bufferedWindow = context.writer.bufferedReceivedWindowOf(metricName);
      if (bufferedWindow !== null) {
        receivedOut.min = receivedOut.min === 0 ? bufferedWindow.min : Math.min(receivedOut.min, bufferedWindow.min);
        receivedOut.max = Math.max(receivedOut.max, bufferedWindow.max);
      }
    }
    return mergeAscending(segmentPoints, buffered);
  }

  /**
   * Same scope as `collectAscendingPoints`, but **descending**: the in-segment part is already truncated to
   * `limit` unique points by `readMetricPoints` (bounded memory), then merged with the in-range buffered
   * points; the first `limit` entries of the descending merge are exactly the newest `limit` unique points.
   */
  private collectDescendingPoints(
    database: string,
    metricName: string,
    start: number,
    end: number,
    limit: number,
    receivedOut?: { min: number; max: number },
  ): Point[] {
    const segmentPoints = this.reader.readMetricPoints(
      database,
      metricName,
      { start, end, limit, order: 'desc' },
      receivedOut,
    );
    const context = this.contexts.get(database);
    if (context === undefined) return segmentPoints.slice(0, limit);
    const buffered = context.writer
      .bufferedPointsOf(metricName)
      .filter((point) => point.timestamp >= start && point.timestamp <= end)
      .sort((left, right) => right.timestamp - left.timestamp);
    // The buffered points' arrival window merges into the same out param (block/batch granularity)
    if (receivedOut !== undefined) {
      const bufferedWindow = context.writer.bufferedReceivedWindowOf(metricName);
      if (bufferedWindow !== null) {
        receivedOut.min = receivedOut.min === 0 ? bufferedWindow.min : Math.min(receivedOut.min, bufferedWindow.min);
        receivedOut.max = Math.max(receivedOut.max, bufferedWindow.max);
      }
    }
    const merged: Point[] = [];
    let segmentIndex = 0;
    let bufferedIndex = 0;
    let lastTimestamp: number | null = null;
    while ((segmentIndex < segmentPoints.length || bufferedIndex < buffered.length) && merged.length < limit) {
      let point: Point;
      if (segmentIndex >= segmentPoints.length) point = buffered[bufferedIndex++];
      else if (bufferedIndex >= buffered.length) point = segmentPoints[segmentIndex++];
      else if (segmentPoints[segmentIndex].timestamp >= buffered[bufferedIndex].timestamp) {
        point = segmentPoints[segmentIndex++];
      } else point = buffered[bufferedIndex++];
      if (lastTimestamp !== null && point.timestamp === lastTimestamp) continue;
      lastTimestamp = point.timestamp;
      merged.push(point);
    }
    return merged;
  }

  /**
   * Segment stream + buffered point merge cursor (the same source scope as `collectAscendingPoints` /
   * `collectDescendingPoints`, but **pull-based**): the consumer stops via `break`, so memory stays bounded
   * by the visited blocks instead of the hit point count. Segment points win on equal timestamps (same
   * dedupe precedence as `mergeAscending`).
   */
  private *mergedPointCursor(
    database: string,
    metricName: string,
    start: number,
    end: number,
    order: 'asc' | 'desc',
  ): Generator<Point, void, undefined> {
    const context = this.contexts.get(database);
    const buffered = (context === undefined ? [] : context.writer.bufferedPointsOf(metricName))
      .filter((point) => point.timestamp >= start && point.timestamp <= end);
    if (order === 'desc') buffered.reverse();
    const segments = this.reader.iterateMetricPoints(database, metricName, { start, end, order });
    let segmentNext = segments.next();
    let bufferedIndex = 0;
    let lastEmitted: number | null = null;
    while (!segmentNext.done || bufferedIndex < buffered.length) {
      let point: Point;
      let fromSegment = false;
      if (!segmentNext.done && bufferedIndex < buffered.length) {
        const segmentWins =
          order === 'asc'
            ? segmentNext.value.timestamp <= buffered[bufferedIndex].timestamp
            : segmentNext.value.timestamp >= buffered[bufferedIndex].timestamp;
        if (segmentWins) {
          point = segmentNext.value;
          fromSegment = true;
        } else point = buffered[bufferedIndex++];
      } else if (!segmentNext.done) {
        point = segmentNext.value;
        fromSegment = true;
      } else point = buffered[bufferedIndex++];
      if (fromSegment) segmentNext = segments.next();
      if (lastEmitted !== null && (order === 'asc' ? point.timestamp <= lastEmitted : point.timestamp >= lastEmitted)) {
        continue;
      }
      lastEmitted = point.timestamp;
      yield point;
    }
  }

  /**
   * The latest point at or before `before` (take the newer of in-segment and buffered points)
   *
   * The segment search expands **backwards over day directories** (1 day, then 8×, …) instead of
   * scanning the whole history: each extra day costs one segment-descriptor load in `locateBlocks`, so a
   * full-database lookup would cost ~1 ms per day of history (measured: ~126 ms over 100 days, paid by
   * every `avg` aggregation / `linear` interpolation edge-neighbor fetch). Dense metrics resolve inside
   * the first day; the geometric growth keeps the sparse worst case close to a single full scan.
   */
  private latestPointAtOrBefore(database: string, metricName: string, before: number): Point | null {
    let best: Point | null = null;
    const consider = (point: Point): void => {
      if (point.timestamp > before) return;
      if (best === null || point.timestamp > best.timestamp) best = point;
    };
    const context = this.contexts.get(database);
    if (context !== undefined) {
      for (const point of context.writer.bufferedPointsOf(metricName)) consider(point);
    }
    const dayNumbers = this.store.listDayDirectories(database);
    if (dayNumbers.length === 0) return best;
    const earliestDayStart = timestampFromDateNumber(dayNumbers[0]);
    const latestDayEnd = nextDayTimestampFromDateNumber(dayNumbers[dayNumbers.length - 1]) - 1;
    // `before` may be MAX_SAFE_INTEGER (`queryLast` without a boundary): start from the last day
    const upper = Math.min(before, latestDayEnd);
    if (upper < earliestDayStart) return best;

    let spanDays = 1;
    for (;;) {
      const windowStart = Math.max(earliestDayStart, upper - spanDays * DAY_MS);
      const locations = this.reader.locateBlocks(database, metricName, windowStart, upper);
      if (locations.length > 0) {
        let minTimestamp = Number.POSITIVE_INFINITY;
        for (const location of locations) {
          if (location.entry.timestampMin < minTimestamp) minTimestamp = location.entry.timestampMin;
        }
        if (Number.isFinite(minTimestamp)) {
          const segmentPoints = this.reader.readMetricPoints(database, metricName, {
            start: minTimestamp,
            end: upper,
            limit: 1,
            order: 'desc',
          });
          if (segmentPoints.length > 0) consider(segmentPoints[0]);
        }
        return best;
      }
      if (windowStart === earliestDayStart) return best;
      spanDays *= 8;
    }
  }

  /** The earliest point at or after `after` (take the earlier of in-segment and buffered points; day-expanding search, see `latestPointAtOrBefore`) */
  private earliestPointAtOrAfter(database: string, metricName: string, after: number): Point | null {
    let best: Point | null = null;
    const consider = (point: Point): void => {
      if (point.timestamp < after) return;
      if (best === null || point.timestamp < best.timestamp) best = point;
    };
    const context = this.contexts.get(database);
    if (context !== undefined) {
      for (const point of context.writer.bufferedPointsOf(metricName)) consider(point);
    }
    const dayNumbers = this.store.listDayDirectories(database);
    if (dayNumbers.length === 0) return best;
    const earliestDayStart = timestampFromDateNumber(dayNumbers[0]);
    const latestDayEnd = nextDayTimestampFromDateNumber(dayNumbers[dayNumbers.length - 1]) - 1;
    const lower = Math.max(after, earliestDayStart);
    if (lower > latestDayEnd) return best;

    let spanDays = 1;
    for (;;) {
      const windowEnd = Math.min(latestDayEnd, lower + spanDays * DAY_MS);
      const locations = this.reader.locateBlocks(database, metricName, lower, windowEnd);
      if (locations.length > 0) {
        let maxTimestamp = Number.NEGATIVE_INFINITY;
        for (const location of locations) {
          if (location.entry.timestampMax > maxTimestamp) maxTimestamp = location.entry.timestampMax;
        }
        if (Number.isFinite(maxTimestamp) && maxTimestamp >= lower) {
          const segmentPoints = this.reader.readMetricPoints(database, metricName, {
            start: lower,
            end: maxTimestamp,
            limit: 1,
            order: 'asc',
          });
          if (segmentPoints.length > 0) consider(segmentPoints[0]);
        }
        return best;
      }
      if (windowEnd === latestDayEnd) return best;
      spanDays *= 8;
    }
  }

  /* ---------- Internal: database and metric lists ---------- */

  private listDatabaseNamesSync(): string[] {
    const names = new Set(this.store.listDatabases());
    for (const database of this.contexts.keys()) names.add(database);
    return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  /**
   * Aggregate per-metric statistics from the segment indexes (mirror `.idx` when present, otherwise a rebuilt
   * scan of the block region), plus metrics that currently exist only in the unflushed buffer.
   */
  private databaseMetricStatsSync(database: string): DatabaseMetricStats[] {
    const byMetric = new Map<string, DatabaseMetricStats>();
    for (const descriptor of this.reader.listSegments(database)) {
      const entries = this.reader.loadIndexEntries(database, descriptor.dateNumber, descriptor.sequence);
      for (const entry of entries) {
        let stats = byMetric.get(entry.metricName);
        if (stats === undefined) {
          stats = {
            metricName: entry.metricName,
            firstTs: entry.timestampMin,
            lastTs: entry.timestampMax,
            valueType: null,
            points: 0,
            blocks: 0,
            bytes: 0,
          };
          byMetric.set(entry.metricName, stats);
        }
        stats.points += entry.pointCount;
        stats.blocks += 1;
        stats.bytes += entry.length;
        if (entry.timestampMin < stats.firstTs) stats.firstTs = entry.timestampMin;
        if (entry.timestampMax > stats.lastTs) stats.lastTs = entry.timestampMax;
        if (stats.valueType === null) stats.valueType = this.reader.readBlockValueType(descriptor, entry);
      }
    }

    // A metric written but not flushed yet has no index entry; still list it so the console does not "lose" it
    // for a few seconds (counts stay 0 until the block lands).
    const context = this.contexts.get(database);
    if (context !== undefined) {
      for (const metricName of context.writer.bufferedMetricNames()) {
        if (byMetric.has(metricName)) continue;
        byMetric.set(metricName, {
          metricName,
          firstTs: 0,
          lastTs: 0,
          valueType: null,
          points: 0,
          blocks: 0,
          bytes: 0,
        });
      }
    }

    return [...byMetric.values()].sort((left, right) =>
      left.metricName < right.metricName ? -1 : left.metricName > right.metricName ? 1 : 0,
    );
  }

  private listMetricsSync(database: string): MetricSummary[] {
    const ranges = new Map<string, { firstTs: number; lastTs: number }>();
    const valueTypes = new Map<string, ValueType>();
    const merge = (metricName: string, timestampMin: number, timestampMax: number): void => {
      const existing = ranges.get(metricName);
      if (existing === undefined) {
        ranges.set(metricName, { firstTs: timestampMin, lastTs: timestampMax });
        return;
      }
      if (timestampMin < existing.firstTs) existing.firstTs = timestampMin;
      if (timestampMax > existing.lastTs) existing.lastTs = timestampMax;
    };
    /** Capture a metric's locked type from its first block header (one small read per metric, no payload decode) */
    const mergeValueType = (
      descriptor: ReturnType<SegmentReader['listSegments']>[number],
      entry: SegmentBlockIndexEntry,
    ): void => {
      if (valueTypes.has(entry.metricName)) return;
      const valueType = this.reader.readBlockValueType(descriptor, entry);
      if (valueType !== null) valueTypes.set(entry.metricName, valueType);
    };

    for (const descriptor of this.reader.listSegments(database)) {
      const entries = this.reader.loadIndexEntries(database, descriptor.dateNumber, descriptor.sequence);
      for (const entry of entries) {
        merge(entry.metricName, entry.timestampMin, entry.timestampMax);
        mergeValueType(descriptor, entry);
      }
    }
    const context = this.contexts.get(database);
    if (context !== undefined) {
      for (const metricName of context.writer.bufferedMetricNames()) {
        for (const point of context.writer.bufferedPointsOf(metricName)) {
          merge(metricName, point.timestamp, point.timestamp);
        }
      }
    }

    return [...ranges.entries()]
      .map(([metricName, range]) => ({
        metricName,
        firstTs: range.firstTs,
        lastTs: range.lastTs,
        valueType: valueTypes.get(metricName) ?? context?.writer.valueTypeOf(metricName) ?? null,
      }))
      .sort((left, right) => (left.metricName < right.metricName ? -1 : left.metricName > right.metricName ? 1 : 0));
  }

  /* ---------- Internal: retention policy file ---------- */

  private retentionFilePath(database: string): string {
    return join(this.store.databaseDirectoryPath(database), RETENTION_FILE_NAME);
  }

  private readRetentionFile(database: string): number | null {
    let text: string;
    try {
      text = readFileSync(this.retentionFilePath(database), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new RtdbError(
        ERROR_CODE.Io,
        `Failed to read the retention policy file: ${this.retentionFilePath(database)} (${(error as Error).message})`,
      );
    }
    try {
      const parsed = JSON.parse(text) as { retentionDays?: unknown };
      const days = parsed.retentionDays;
      if (typeof days !== 'number' || !Number.isInteger(days)) return null;
      return clampEngineOption('retentionDays', days);
    } catch {
      return null;
    }
  }

  private writeRetentionFile(database: string, days: number): void {
    const filePath = this.retentionFilePath(database);
    const temporaryFilePath = `${filePath}.tmp`;
    try {
      writeFileSync(temporaryFilePath, `${JSON.stringify({ retentionDays: days })}\n`, 'utf8');
      renameSync(temporaryFilePath, filePath);
    } catch (error) {
      try {
        unlinkSync(temporaryFilePath);
      } catch {
        // Cleanup failure does not affect the main flow (`.tmp` does not match the database/day directory naming, so scanners naturally ignore it)
      }
      throw new RtdbError(ERROR_CODE.Io, `Failed to write the retention policy file: ${filePath} (${(error as Error).message})`);
    }
  }

  /* ---------- Internal: guards ---------- */

  private requireOpen(): void {
    if (!this.opened) {
      throw new RtdbError(ERROR_CODE.Internal, `Engine is not open yet (open() must be called first): ${this.dataDir}`);
    }
  }

  private validateRange(start: number, end: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      throw new RtdbError(ERROR_CODE.InvalidRange, `Illegal query range: start=${String(start)}, end=${String(end)}`);
    }
  }
}

/* ---------- Internal: batch dedupe ---------- */

/** In-batch `(metricName, timestamp)` dedupe: keep the first, return the deduped batch and the duplicate count */
function dedupeBatch(points: readonly WritePoint[]): { points: WritePoint[]; duplicateCount: number } {
  const seen = new Map<string, Set<number>>();
  const out: WritePoint[] = [];
  let duplicateCount = 0;
  for (const point of points) {
    let timestamps = seen.get(point.metricName);
    if (timestamps === undefined) {
      timestamps = new Set<number>();
      seen.set(point.metricName, timestamps);
    }
    if (timestamps.has(point.timestamp)) {
      duplicateCount += 1;
      continue;
    }
    timestamps.add(point.timestamp);
    out.push(point);
  }
  return { points: out, duplicateCount };
}

/* ---------- Internal: merge ---------- */

/** Merge-dedupe two **ascending** point sequences: for the same ts, `segmentPoints` wins (§2.7 "primary segment wins"); output strictly increasing */
function mergeAscending(segmentPoints: readonly Point[], bufferedPoints: readonly Point[]): Point[] {
  const merged: Point[] = [];
  let segmentIndex = 0;
  let bufferedIndex = 0;
  while (segmentIndex < segmentPoints.length || bufferedIndex < bufferedPoints.length) {
    let takeSegment: boolean;
    if (segmentIndex >= segmentPoints.length) takeSegment = false;
    else if (bufferedIndex >= bufferedPoints.length) takeSegment = true;
    else takeSegment = segmentPoints[segmentIndex].timestamp <= bufferedPoints[bufferedIndex].timestamp;

    const point = takeSegment ? segmentPoints[segmentIndex++] : bufferedPoints[bufferedIndex++];
    if (merged.length > 0 && merged[merged.length - 1].timestamp === point.timestamp) continue;
    merged.push(point);
  }
  return merged;
}

/* ---------- Internal: aggregation ---------- */

/** Value -> number (for numeric aggregation; string has already been rejected by type narrowing before the call, bool maps to 0/1) */
function valueToNumber(value: Point['value']): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return Number.NaN;
}

/** Value -> value type (inferred by JS type, same scope as the write entry point `inferValueType`) */
function inferValueTypeFromValue(value: Point['value']): ValueType {
  switch (typeof value) {
    case 'number':
      return ValueType.Float64;
    case 'bigint':
      return ValueType.Int64;
    case 'boolean':
      return ValueType.Bool;
    case 'string':
      return ValueType.String;
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Unknown value type: ${typeof value}`);
  }
}

/** Operator x metric value type support matrix gate (§2.2) */
function assertAggregateSupported(type: AggregateType, valueType: ValueType, metricName: string): void {
  switch (type) {
    case 'avg':
    case 'sum':
      if (valueType !== ValueType.Float64 && valueType !== ValueType.Int64) {
        throw new RtdbError(
          ERROR_CODE.TypeMismatch,
          `Aggregate ${type} only supports f64/i64; metric ${metricName} is ${valueTypeName(valueType)}`,
        );
      }
      break;
    case 'min':
    case 'max':
      if (valueType === ValueType.String) {
        throw new RtdbError(
          ERROR_CODE.TypeMismatch,
          `Aggregate ${type} does not support string; metric ${metricName}`,
        );
      }
      break;
    case 'count':
    case 'last':
      break;
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Unknown aggregate operator: ${String(type)}`);
  }
}

function valueTypeName(valueType: ValueType): string {
  switch (valueType) {
    case ValueType.Float64:
      return 'f64';
    case ValueType.Int64:
      return 'i64';
    case ValueType.Bool:
      return 'bool';
    case ValueType.String:
      return 'string';
    default:
      return `unknown(${String(valueType)})`;
  }
}

/** Aggregate value comparison (min/max; same metric value type is homogeneous, bool as false<true) */
function compareAggregateValues(left: Point['value'], right: Point['value']): number {
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return (left ? 1 : 0) - (right ? 1 : 0);
  }
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const leftNumber = valueToNumber(left);
  const rightNumber = valueToNumber(right);
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}

/**
 * Evaluate one `queryAt` request (Interpolation Detailed Design §3)
 *
 * `left`/`right` are the covered points around `t` (null at the edges); `beforeFirst`/`afterLast`
 * are the edge neighbors outside the covered range (may be null). An exact hit always wins.
 */
function evaluateQueryAtPoint(
  mode: 'step' | 'linear',
  t: number,
  left: Point | null,
  right: Point | null,
  beforeFirst: Point | null,
  afterLast: Point | null,
): AtPoint {
  if (left !== null && left.timestamp === t) {
    return { timestamp: t, value: left.value, state: 'exact' };
  }

  if (mode === 'step') {
    // `left` is the latest covered point <= t; when absent, `beforeFirst` (the latest point before
    // the covered range) is the latest <= t. Previous-value hold returns a real point -> 'exact'.
    const source = left ?? beforeFirst;
    return source === null
      ? { timestamp: t, value: null, state: 'no-data' }
      : { timestamp: t, value: source.value, state: 'exact' };
  }

  const leftNeighbor = left ?? beforeFirst;
  const rightNeighbor = right ?? afterLast;
  if (leftNeighbor !== null && rightNeighbor !== null && leftNeighbor.timestamp < t && t < rightNeighbor.timestamp) {
    return {
      timestamp: t,
      value: interpolateQueryAtValue(leftNeighbor, rightNeighbor, t),
      state: 'interpolated',
    };
  }
  // Outside the data range: flat from the nearest real point ('extrapolated'); nothing at all -> no-data
  if (leftNeighbor !== null) return { timestamp: t, value: leftNeighbor.value, state: 'extrapolated' };
  if (rightNeighbor !== null) return { timestamp: t, value: rightNeighbor.value, state: 'extrapolated' };
  return { timestamp: t, value: null, state: 'no-data' };
}

/** Linear interpolation between two real points at `t` (i64 stays i64: rounded back to bigint) */
function interpolateQueryAtValue(leftPoint: Point, rightPoint: Point, t: number): Point['value'] {
  const leftValue = valueToNumber(leftPoint.value);
  const rightValue = valueToNumber(rightPoint.value);
  const span = rightPoint.timestamp - leftPoint.timestamp;
  const ratio = span <= 0 ? 0 : (t - leftPoint.timestamp) / span;
  const value = leftValue + (rightValue - leftValue) * ratio;
  if (typeof leftPoint.value === 'bigint' && typeof rightPoint.value === 'bigint') {
    return BigInt(Math.round(value));
  }
  return value;
}

/* ---------- Internal: streaming window aggregation ---------- */

/**
 * Per-window running aggregate for [StreamingWindowAggregator](#streamingwindowaggregator): interior
 * points update the point statistics; completed point pairs update the time-integral area (`avg` only).
 * Field semantics mirror the former materialized `computeWindowAggregate` / `integrateValueArea` exactly.
 */
class WindowAccumulator {
  count = 0;
  sum = 0;
  min: Point['value'] | null = null;
  max: Point['value'] | null = null;
  last: Point['value'] | null = null;
  area = 0;

  /** Feed one interior point of this window (ascending timestamp order) */
  addPoint(point: Point): void {
    this.count += 1;
    this.sum += valueToNumber(point.value);
    if (this.min === null || compareAggregateValues(point.value, this.min) < 0) this.min = point.value;
    if (this.max === null || compareAggregateValues(point.value, this.max) > 0) this.max = point.value;
    this.last = point.value;
  }

  /** Add the pair's trapezoid contribution clipped to `[windowStart, windowEnd)` (same formula as `integrateValueArea`) */
  addPairArea(leftPoint: Point, rightPoint: Point, windowStart: number, windowEnd: number): void {
    const segmentStart = Math.max(windowStart, leftPoint.timestamp);
    const segmentEnd = Math.min(windowEnd, rightPoint.timestamp);
    if (segmentEnd <= segmentStart) return;
    const leftValue = valueToNumber(leftPoint.value);
    const rightValue = valueToNumber(rightPoint.value);
    const span = rightPoint.timestamp - leftPoint.timestamp;
    if (span <= 0) {
      this.area += leftValue * (segmentEnd - segmentStart);
      return;
    }
    const startValue = leftValue + ((rightValue - leftValue) * (segmentStart - leftPoint.timestamp)) / span;
    const endValue = leftValue + ((rightValue - leftValue) * (segmentEnd - leftPoint.timestamp)) / span;
    this.area += ((startValue + endValue) / 2) * (segmentEnd - segmentStart);
  }
}

/**
 * Streaming `queryAggregate` driver: points are fed once in ascending order (the `before` neighbor first,
 * interior points with `countsAsInterior=true`, the `after` neighbor last) and each window is finalized as
 * soon as the first point at/after its end arrives, so memory stays bounded by one accumulator per window
 * instead of the hit point count (2026-10-18 bounded-memory refactor).
 *
 * Output is bit-identical to the former materialized implementation: point pairs are distributed to every
 * overlapping window in feed order (`integrateValueArea` accumulates each window's pairs in index order),
 * the leading-edge flat extrapolation is appended at finalize time, and the trailing-edge flat
 * extrapolation only applies to windows still open at `finish` — a trigger point at/after the window end
 * always suppresses it, which matches the global `last.timestamp` check of `integrateValueArea`.
 */
class StreamingWindowAggregator {
  private readonly type: AggregateType;
  private readonly metricName: string;
  private readonly start: number;
  private readonly windowMs: number;
  private readonly windowCount: number;
  private readonly accumulators: WindowAccumulator[];
  private currentWindowIndex = 0;
  private prevPoint: Point | null = null;
  private firstPoint: Point | null = null;
  private lastPoint: Point | null = null;
  private readonly windows: AggregateWindow[] = [];

  constructor(
    type: AggregateType,
    metricName: string,
    start: number,
    windowMs: number,
    windowCount: number,
  ) {
    this.type = type;
    this.metricName = metricName;
    this.start = start;
    this.windowMs = windowMs;
    this.windowCount = windowCount;
    this.accumulators = Array.from({ length: windowCount }, () => new WindowAccumulator());
  }

  /** True once any point has been fed (mirrors the former empty-series early return) */
  get hasPoints(): boolean {
    return this.firstPoint !== null;
  }

  /** Feed one series point; `countsAsInterior` is false for the before/after edge neighbors */
  feed(point: Point, countsAsInterior: boolean): void {
    if (this.firstPoint === null) {
      this.firstPoint = point;
      assertAggregateSupported(this.type, inferValueTypeFromValue(point.value), this.metricName);
    }
    if (countsAsInterior) {
      const index = Math.min(Math.floor((point.timestamp - this.start) / this.windowMs), this.windowCount - 1);
      this.accumulators[index].addPoint(point);
    }
    if (this.prevPoint !== null) this.distributePair(this.prevPoint, point);
    this.lastPoint = point;
    this.prevPoint = point;
    this.finalizeWindowsUpTo(point.timestamp);
  }

  /** Finalize every remaining window (call after the last point has been fed) */
  finish(): AggregateWindow[] {
    while (this.currentWindowIndex < this.windowCount) {
      this.finalizeWindow(this.currentWindowIndex, false);
      this.currentWindowIndex += 1;
    }
    return this.windows;
  }

  /** Distribute the pair's trapezoid contribution to every overlapping open window (ascending window order) */
  private distributePair(leftPoint: Point, rightPoint: Point): void {
    const firstIndex = Math.max(
      this.currentWindowIndex,
      Math.floor((leftPoint.timestamp - this.start) / this.windowMs),
    );
    const lastIndex = Math.min(
      this.windowCount - 1,
      Math.floor((rightPoint.timestamp - this.start) / this.windowMs),
    );
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      this.accumulators[index].addPairArea(
        leftPoint,
        rightPoint,
        this.start + index * this.windowMs,
        this.start + (index + 1) * this.windowMs,
      );
    }
  }

  /** Finalize windows whose end the freshly fed point has reached (the point acts as their trigger) */
  private finalizeWindowsUpTo(timestamp: number): void {
    while (this.currentWindowIndex < this.windowCount) {
      const windowEnd = this.start + (this.currentWindowIndex + 1) * this.windowMs;
      if (windowEnd > timestamp) break;
      this.finalizeWindow(this.currentWindowIndex, true);
      this.currentWindowIndex += 1;
    }
  }

  private finalizeWindow(index: number, triggeredByPoint: boolean): void {
    const accumulator = this.accumulators[index];
    const windowStart = this.start + index * this.windowMs;
    const windowEnd = windowStart + this.windowMs;
    let value: Point['value'];
    switch (this.type) {
      case 'count':
        value = accumulator.count;
        break;
      case 'avg':
        value = this.finalizeAvg(accumulator, windowStart, windowEnd, triggeredByPoint);
        break;
      case 'sum':
        value = accumulator.sum;
        break;
      case 'min':
        value = accumulator.min ?? Number.NaN;
        break;
      case 'max':
        value = accumulator.max ?? Number.NaN;
        break;
      case 'last':
        value = accumulator.last ?? Number.NaN;
        break;
      default:
        throw new RtdbError(ERROR_CODE.Internal, `Unknown aggregate operator: ${String(this.type)}`);
    }
    this.windows.push({ start: windowStart, end: windowEnd, value, count: accumulator.count });
  }

  /** Time-weighted average of one window (same NaN conditions, edge handling and add order as `integrateValueArea`) */
  private finalizeAvg(
    accumulator: WindowAccumulator,
    windowStart: number,
    windowEnd: number,
    triggeredByPoint: boolean,
  ): number {
    const first = this.firstPoint;
    const last = this.lastPoint;
    if (first === null || last === null) return Number.NaN;
    if (windowEnd <= first.timestamp || windowStart > last.timestamp) return Number.NaN;
    if (this.firstPoint === this.lastPoint) return valueToNumber(first.value);
    let area = accumulator.area;
    // Leading edge flat extrapolation (windowStart is earlier than the first point)
    if (windowStart < first.timestamp) {
      const edgeEnd = Math.min(windowEnd, first.timestamp);
      if (edgeEnd > windowStart) area += valueToNumber(first.value) * (edgeEnd - windowStart);
    }
    // Trailing edge flat extrapolation (windowEnd is later than the last point; a trigger point at or
    // after windowEnd always suppresses it, matching the global last-point check)
    if (!triggeredByPoint && windowEnd > last.timestamp) {
      const edgeStart = Math.max(windowStart, last.timestamp);
      if (windowEnd > edgeStart) area += valueToNumber(last.value) * (windowEnd - edgeStart);
    }
    return area / (windowEnd - windowStart);
  }
}

/* ---------- Internal: config clamp warning ---------- */

/** Container-level clamp with warning (out-of-range clamps to the boundary, does not block startup; §6.2.2 / §6.5) */
function clampAndWarn(name: EngineOptionName, raw: number): number {
  const clamped = clampEngineOption(name, raw);
  if (clamped !== Math.trunc(raw)) {
    console.warn(`[ss-rtdb] Config item ${name}=${String(raw)} is out of range; clamped to ${clamped}`);
  }
  return clamped;
}

/* ---------- Internal: statistics ---------- */

/** Nearest-rank quantile over an ascending sample array (0 samples → 0; `quantile` ∈ [0,1]) */
function quantileOfSortedAscending(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) return 0;
  const rank = Math.ceil(quantile * samples.length);
  const index = Math.min(Math.max(rank - 1, 0), samples.length - 1);
  return samples[index];
}
