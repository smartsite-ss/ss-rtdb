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
import { dateNumberFromTimestamp } from './format.ts';
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

  /** Range read (ascending/descending + count limit), source is a merge of in-segment points and unblocked buffered points */
  async queryRange(database: string, metricName: string, opts: RangeOptions): Promise<Series> {
    this.requireOpen();
    const startedAt = performance.now();
    this.validateRange(opts.start, opts.end);
    const limit = opts.limit ?? DEFAULT_RANGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RtdbError(ERROR_CODE.InvalidRange, `Illegal limit: ${String(opts.limit)}`);
    }
    const order = opts.order ?? 'asc';
    // Ascending takes the first limit; descending means "the latest limit entries", so take all ascending first and then take the tail reversed
    const ascending = this.collectAscendingPoints(
      database,
      metricName,
      opts.start,
      opts.end,
      order === 'asc' ? limit : Number.MAX_SAFE_INTEGER,
    );
    const points =
      order === 'desc'
        ? ascending.slice(Math.max(0, ascending.length - limit)).reverse()
        : ascending.slice(0, limit);
    return this.finishQuery(startedAt, { metricName, points });
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
      return this.finishQuery(
        startedAt,
        this.collectAscendingPoints(database, metricName, opts.start, opts.end, Number.MAX_SAFE_INTEGER).length,
      );
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

    const interior = this.collectAscendingPoints(
      database,
      metricName,
      opts.start,
      lastWindowEnd - 1,
      Number.MAX_SAFE_INTEGER,
    );
    const before = this.latestPointAtOrBefore(database, metricName, opts.start - 1);
    const after = this.earliestPointAtOrAfter(database, metricName, lastWindowEnd);

    const seriesPoints: Point[] = [];
    if (before !== null) seriesPoints.push(before);
    for (const point of interior) seriesPoints.push(point);
    if (after !== null) seriesPoints.push(after);
    if (seriesPoints.length === 0) return this.finishQuery(startedAt, []);

    const valueType = inferValueTypeFromValue(seriesPoints[0].value);
    assertAggregateSupported(opts.type, valueType, metricName);

    const windows: AggregateWindow[] = [];
    let cursorStart = 0;
    for (let index = 0; index < windowCount; index += 1) {
      const windowStart = opts.start + index * opts.windowMs;
      const windowEnd = windowStart + opts.windowMs;
      while (cursorStart < interior.length && interior[cursorStart].timestamp < windowStart) cursorStart += 1;
      let cursorEnd = cursorStart;
      while (cursorEnd < interior.length && interior[cursorEnd].timestamp < windowEnd) cursorEnd += 1;
      const windowPoints = interior.slice(cursorStart, cursorEnd);
      cursorStart = cursorEnd;
      windows.push({
        start: windowStart,
        end: windowEnd,
        value: computeWindowAggregate(opts.type, windowPoints, seriesPoints, windowStart, windowEnd),
        count: windowPoints.length,
      });
    }
    return this.finishQuery(startedAt, windows);
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

  /** Points held in this database's outstanding (accepted but not yet flushed into segments) batches */
  private pendingWalPointsOf(context: DatabaseContext): number {
    let total = 0;
    const previousByMetric = new Map<string, number>();
    for (const batch of context.outstandingBatches) {
      for (const [metricName, cumulativeCount] of batch.cumulativeByMetric) {
        total += cumulativeCount - (previousByMetric.get(metricName) ?? 0);
        previousByMetric.set(metricName, cumulativeCount);
      }
    }
    return total;
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
      walPendingPoints += this.pendingWalPointsOf(context);
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
        console.error('[ss-rtdb] Scheduled block formation failed:', error);
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
  ): Point[] {
    const segmentPoints = this.reader.readMetricPoints(database, metricName, {
      start,
      end,
      limit: segmentLimit,
      order: 'asc',
    });
    const context = this.contexts.get(database);
    if (context === undefined) return segmentPoints;

    const buffered = context.writer
      .bufferedPointsOf(metricName)
      .filter((point) => point.timestamp >= start && point.timestamp <= end);
    if (buffered.length === 0) return segmentPoints;
    return mergeAscending(segmentPoints, buffered);
  }

  /** The latest point at or before `before` (take the newer of in-segment and buffered points) */
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
    const locations = this.reader.locateBlocks(database, metricName, Number.NEGATIVE_INFINITY, before);
    if (locations.length > 0) {
      let minTimestamp = Number.POSITIVE_INFINITY;
      for (const location of locations) {
        if (location.entry.timestampMin < minTimestamp) minTimestamp = location.entry.timestampMin;
      }
      if (Number.isFinite(minTimestamp)) {
        const segmentPoints = this.reader.readMetricPoints(database, metricName, {
          start: minTimestamp,
          end: before,
          limit: Number.MAX_SAFE_INTEGER,
          order: 'desc',
        });
        if (segmentPoints.length > 0) consider(segmentPoints[0]);
      }
    }
    return best;
  }

  /** The earliest point at or after `after` (take the earlier of in-segment and buffered points) */
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
    const locations = this.reader.locateBlocks(database, metricName, after, Number.POSITIVE_INFINITY);
    if (locations.length > 0) {
      let maxTimestamp = Number.NEGATIVE_INFINITY;
      for (const location of locations) {
        if (location.entry.timestampMax > maxTimestamp) maxTimestamp = location.entry.timestampMax;
      }
      if (Number.isFinite(maxTimestamp) && maxTimestamp >= after) {
        const segmentPoints = this.reader.readMetricPoints(database, metricName, {
          start: after,
          end: maxTimestamp,
          limit: 1,
          order: 'asc',
        });
        if (segmentPoints.length > 0) consider(segmentPoints[0]);
      }
    }
    return best;
  }

  /* ---------- Internal: database and metric lists ---------- */

  private listDatabaseNamesSync(): string[] {
    const names = new Set(this.store.listDatabases());
    for (const database of this.contexts.keys()) names.add(database);
    return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  private listMetricsSync(database: string): MetricSummary[] {
    const ranges = new Map<string, { firstTs: number; lastTs: number }>();
    const merge = (metricName: string, timestampMin: number, timestampMax: number): void => {
      const existing = ranges.get(metricName);
      if (existing === undefined) {
        ranges.set(metricName, { firstTs: timestampMin, lastTs: timestampMax });
        return;
      }
      if (timestampMin < existing.firstTs) existing.firstTs = timestampMin;
      if (timestampMax > existing.lastTs) existing.lastTs = timestampMax;
    };

    for (const descriptor of this.reader.listSegments(database)) {
      const entries = this.reader.loadIndexEntries(database, descriptor.dateNumber, descriptor.sequence);
      for (const entry of entries) merge(entry.metricName, entry.timestampMin, entry.timestampMax);
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
      .map(([metricName, range]) => ({ metricName, firstTs: range.firstTs, lastTs: range.lastTs }))
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

/** Single-window aggregate value: count -> number; avg -> time-weighted; sum -> number; min/max -> the base value type; last -> the last value in the window (empty window -> NaN) */
function computeWindowAggregate(
  type: AggregateType,
  windowPoints: readonly Point[],
  seriesPoints: readonly Point[],
  windowStart: number,
  windowEnd: number,
): Point['value'] {
  switch (type) {
    case 'count':
      return windowPoints.length;
    case 'avg':
      return integrateValueArea(seriesPoints, windowStart, windowEnd);
    case 'sum': {
      let total = 0;
      for (const point of windowPoints) total += valueToNumber(point.value);
      return total;
    }
    case 'min': {
      if (windowPoints.length === 0) return Number.NaN;
      let best = windowPoints[0].value;
      for (const point of windowPoints) {
        if (compareAggregateValues(point.value, best) < 0) best = point.value;
      }
      return best;
    }
    case 'max': {
      if (windowPoints.length === 0) return Number.NaN;
      let best = windowPoints[0].value;
      for (const point of windowPoints) {
        if (compareAggregateValues(point.value, best) > 0) best = point.value;
      }
      return best;
    }
    case 'last':
      return windowPoints.length === 0 ? Number.NaN : windowPoints[windowPoints.length - 1].value;
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Unknown aggregate operator: ${String(type)}`);
  }
}

/**
 * Time-weighted average: integrate `[windowStart, windowEnd)` **piecewise-linearly** and then divide by the
 * window width (§2.2)
 *
 * The part with no data outside the window is **flat-extrapolated** by the nearest point; returns `NaN` when
 * the window has no intersection with the data range at all
 * (the window is left-closed right-open `[windowStart, windowEnd)`: `windowEnd <= first point` excludes the
 * first point, i.e. no intersection; but when `windowStart == last point` the last point is still in the
 * window, so the right end counts as no intersection only when `windowStart > last point`).
 * `seriesPoints` must be ascending and already include the interpolated neighbors before/after the window.
 */
function integrateValueArea(points: readonly Point[], windowStart: number, windowEnd: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (windowEnd <= first.timestamp || windowStart > last.timestamp) return Number.NaN;
  if (points.length === 1) return valueToNumber(first.value);

  let area = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    const segmentStart = Math.max(windowStart, left.timestamp);
    const segmentEnd = Math.min(windowEnd, right.timestamp);
    if (segmentEnd <= segmentStart) continue;

    const leftValue = valueToNumber(left.value);
    const rightValue = valueToNumber(right.value);
    const span = right.timestamp - left.timestamp;
    if (span <= 0) {
      area += leftValue * (segmentEnd - segmentStart);
      continue;
    }
    const startValue = leftValue + ((rightValue - leftValue) * (segmentStart - left.timestamp)) / span;
    const endValue = leftValue + ((rightValue - leftValue) * (segmentEnd - left.timestamp)) / span;
    area += ((startValue + endValue) / 2) * (segmentEnd - segmentStart);
  }

  // Leading edge flat extrapolation (windowStart is earlier than the first point)
  if (windowStart < first.timestamp) {
    const edgeEnd = Math.min(windowEnd, first.timestamp);
    if (edgeEnd > windowStart) area += valueToNumber(first.value) * (edgeEnd - windowStart);
  }
  // Trailing edge flat extrapolation (windowEnd is later than the last point)
  if (windowEnd > last.timestamp) {
    const edgeStart = Math.max(windowStart, last.timestamp);
    if (windowEnd > edgeStart) area += valueToNumber(last.value) * (windowEnd - edgeStart);
  }
  return area / (windowEnd - windowStart);
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
