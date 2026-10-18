// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Segment writer: per-metric memory buffer -> encode into blocks -> segment append (aligned with Detailed
 * Design v1.8 §2.6)
 *
 * Responsibility boundary: this file only handles the **data plane** (buffering, validation, value type
 * locking, block triggering, block encoding, backpressure); the lifecycle of files and segments (directory,
 * segment sequence, rolling, block append, Footer seal, `.idx` mirror) is all delegated to `SegmentStore`.
 *
 * Block triggers (four, mapped one by one to the design):
 *   1. `blockTargetPoints` (primary): once the buffered point count reaches the target block size after an
 *      append, blocks are formed continuously, with the remainder left for next time
 *   2. 5s fallback (the engine calls `flush()` on a timer): only forms blocks for metrics that have reached
 *      `blockMinPoints` (preventing sparse high-frequency fragmented blocks)
 *   3. Cross-day: when the first point of this batch enters a new day, **first** flush all of the old day's
 *      buffer to disk, then accept the new points (day directory boundary integrity)
 *   4. `close()`: full flush + seal the current day's segment
 *
 * Validation scope: **reject the whole batch** — any illegal point throws E_INVALID_POINT (with the in-batch
 * index) and does not modify any buffer state; metric first-write locking (value type mismatch throws
 * E_TYPE_MISMATCH), the lock table is kept for the lifetime of this writer.
 *
 * Backpressure scope (**whichever of two watermarks comes first**, aligned with §2.6 / §6.2.3): after the
 * whole-batch validation and before buffering and cross-day flushing, test
 *   `pendingBytes + this batch's estimated bytes > maxBufferBytes` **or**
 *   `pendingPointCount + this batch's point count > maxPendingPoints`
 *   -> throw `E_RATE_LIMITED` and **reject the whole batch, leaving state unchanged** (no buffering, no type
 *   locking, no flushing).
 *   Testing before the cross-day flush is deliberately conservative: the watermark is a memory safety gate
 *   and is not relaxed just because "this batch happens to flush to disk".
 *
 * Value type inference (the single scope of the write entry point, see the Point comment in `types.ts`):
 *   `number` -> f64 (must be finite) / `bigint` -> i64 (|v| <= 2^53) / `boolean` -> bool / `string` -> string
 *   (<= 256B UTF-8)
 *
 * IO scope: consistent with the store, it uses `node:fs` synchronous primitives to write segment files; the
 * index is registered only after the block write via `store.appendBlock` succeeds, naturally satisfying
 * "the index is visible only after the block is written" (the read side never sees a half block).
 *
 * Memory scope: block bytes are borrowed from `BufferPool` in power-of-two size classes and returned
 * immediately after `appendBlock` completes (the store only registers index metadata and does not hold the
 * block bytes, so returning is safe); when a pool is injected, the caller is responsible for `dispose`, and
 * if not injected this writer creates its own and releases it via `dispose()` (`close()` only finishes the
 * data plane and does not release the pool).
 */

import {
  CODEC_ID,
  encodeTimestamps,
  encodeValues,
  TIMESTAMP_CODEC_ID,
} from './encoder/registry.ts';
import type { EncodableValues } from './encoder/registry.ts';
import { ERROR_CODE, RtdbError } from './errors.ts';
import {
  BLOCK_FLAG,
  BLOCK_RECEIVED_WINDOW_SIZE,
  SEGMENT_HEADER_FLAG,
  blockDataCrc32WithReceived,
  dateNumberFromTimestamp,
  encodeBlockHeader,
} from './format.ts';
import { BufferPool } from './pool.ts';
import type { SealedSegment, SegmentStore } from './segment-store.ts';
import { ENGINE_DEFAULTS, VALUE_TYPE_NAME, ValueType, WRITE_LIMITS, clampEngineOption } from './types.ts';
import type { Point, WritePoint } from './types.ts';

/* ---------- Public types ---------- */

export interface SegmentWriterOptions {
  /** Segment store (file and segment lifecycle are all delegated to it) */
  store: SegmentStore;
  /** Target database name (writes auto-create databases) */
  database: string;
  /** Target block size (the primary block trigger), default 16384, clamped 4096~65536 */
  blockTargetPoints?: number;
  /** Point count lower bound for the 5s fallback block trigger, default 1024, clamped 64~65536 and not exceeding `blockTargetPoints` */
  blockMinPoints?: number;
  /** Memory watermark (bytes) for unblocked points, default 256MB, clamps see `ENGINE_CLAMPS.maxBufferBytes` */
  maxBufferBytes?: number;
  /** Point count watermark for unflushed points, default 2_000_000, clamps see `ENGINE_CLAMPS.maxPendingPoints` */
  maxPendingPoints?: number;
  /** Block byte buffer pool; if not provided the writer creates its own and releases it in `close()` (if provided, its lifetime belongs to the caller) */
  bufferPool?: BufferPool;
  /**
   * `fsync` the active segment after committed blocks, before the caller may release those points from the
   * WAL. Default true: the WAL safe point (engine) is only allowed to truncate once the segment's copy is on
   * stable storage. Set false only together with `fsyncPolicy='none'` (reloadable scenarios).
   */
  fsyncSegments?: boolean;
}

/** The result of one flush action (shared by `append` / `flush` / `flushAll` / `close`) */
export interface WriterFlushResult {
  /** Blocks produced by this flush */
  blockCount: number;
  /** Points within the blocks produced by this flush (= points moved out of the buffer) */
  pointCount: number;
  /** Segments auto-sealed during this flush (rolling / cross-day / `close` seal) */
  sealedSegments: SealedSegment[];
}

export interface WriteResult extends WriterFlushResult {
  /** Points of this batch accepted (buffered); a validation failure throws and never reaches here */
  accepted: number;
}

/** Single-metric buffer: timestamps and values as parallel arrays; `bytes` is the memory usage estimate (used by the watermark getters, not for rejection) */
interface MetricBuffer {
  metricName: string;
  valueType: ValueType;
  timestamps: number[];
  values: Array<Point['value']>;
  bytes: number;
  /**
   * Server receive-time window of the points currently buffered (ms epoch; null = no points tracked
   * since the last drain). O(1) per batch — block-granularity arrival traceability without per-point cost.
   */
  receivedMin: number | null;
  receivedMax: number | null;
}

/* ---------- Constants ---------- */

/** Base point memory usage estimate (timestamp number slot) */
const TIMESTAMP_COST_BYTES = 8;
/** string value memory baseline (rough overhead of the object header + length field, etc.) */
const STRING_BASE_COST_BYTES = 16;
/** Bytes per UTF-16 code unit (a JS string is measured internally at 2 bytes/unit) */
const UTF16_BYTES_PER_CODE_UNIT = 2;

/* ---------- Writer ---------- */

export class SegmentWriter {
  private readonly store: SegmentStore;
  readonly database: string;
  /** Effective target block size (already clamped) */
  readonly blockTargetPoints: number;
  /** Effective fallback block lower bound (already clamped and not exceeding `blockTargetPoints`) */
  readonly blockMinPoints: number;
  /** Effective memory watermark (bytes) for unblocked points (already clamped) */
  readonly maxBufferBytes: number;
  /** Effective point count watermark for unflushed points (already clamped) */
  readonly maxPendingPoints: number;
  /** Block byte buffer pool (if injected, its lifetime belongs to the caller; if self-created, released by `close()`) */
  readonly bufferPool: BufferPool;

  /** Whether the buffer pool is self-created (decides whether `close()` disposes it) */
  private readonly ownsBufferPool: boolean;
  /** `fsync` the active segment after committed blocks (see `SegmentWriterOptions.fsyncSegments`) */
  private readonly fsyncSegments: boolean;
  /** Blocks committed since the last segment `fsync` (drives the end-of-operation sync) */
  private blocksSinceSegmentFsync = 0;
  /** Per-metric unblocked buffer (the entry is removed once the buffer is emptied, avoiding memory growth on long runs) */
  private readonly buffers = new Map<string, MetricBuffer>();
  /** Value type locked on the metric's first write (persists for the writer's lifetime; cross-process locking awaits the S4 recovery flow) */
  private readonly lockedValueTypes = new Map<string, ValueType>();
  /** The most recently seen date number, used for the cross-day test (null = not written yet) */
  private latestSeenDateNumber: number | null = null;

  constructor(options: SegmentWriterOptions) {
    this.store = options.store;
    this.database = options.database;
    this.fsyncSegments = options.fsyncSegments ?? true;
    const blockTargetPoints = clampEngineOption(
      'blockTargetPoints',
      options.blockTargetPoints ?? ENGINE_DEFAULTS.blockTargetPoints,
    );
    this.blockTargetPoints = blockTargetPoints;
    this.blockMinPoints = Math.min(
      clampEngineOption('blockMinPoints', options.blockMinPoints ?? ENGINE_DEFAULTS.blockMinPoints),
      blockTargetPoints,
    );
    this.maxBufferBytes = clampEngineOption(
      'maxBufferBytes',
      options.maxBufferBytes ?? ENGINE_DEFAULTS.maxBufferBytes,
    );
    this.maxPendingPoints = clampEngineOption(
      'maxPendingPoints',
      options.maxPendingPoints ?? ENGINE_DEFAULTS.maxPendingPoints,
    );

    this.ownsBufferPool = options.bufferPool === undefined;
    this.bufferPool = options.bufferPool ?? new BufferPool();
  }

  /* ---------- Write entry points ---------- */

  /**
   * Dry-run validation (**zero state change**): used by the upper layer (engine) to decide whether a batch can
   * be accepted **before** writing it to the WAL.
   *
   * Order is exactly the same as `append`: empty batch returns immediately -> `validateBatch` (naming/ts/value
   * range/type locking) -> `enforceBackpressure` (two-watermark projection).
   * A rejected batch produces no state change (no buffering, no value type locking, no flushing), so the caller
   * can safely drop it before the WAL append, fundamentally avoiding "rejected points still entering the WAL"
   * causing ghost data on replay after restart.
   */
  checkBatch(points: readonly WritePoint[]): void {
    if (points.length === 0) return;
    const { bytes } = this.validateBatch(points);
    this.enforceBackpressure(points.length, bytes);
  }

  /**
   * Append a batch of points: whole-batch validation -> two-watermark backpressure -> cross-day flushes the old
   * day's buffer first -> buffer -> primary trigger continuous block formation.
   *
   * Any rejection along the way (`E_INVALID_POINT` / `E_TYPE_MISMATCH` / `E_RATE_LIMITED`) does not modify any
   * buffer state.
   */
  append(points: readonly WritePoint[]): WriteResult {
    const result: WriterFlushResult = { blockCount: 0, pointCount: 0, sealedSegments: [] };
    if (points.length === 0) return { ...result, accepted: 0 };

    const { valueTypes: batchValueTypes, bytes: batchBytes } = this.validateBatch(points);
    this.enforceBackpressure(points.length, batchBytes);

    const firstDateNumber = dateNumberFromTimestamp(points[0].timestamp);
    const lastDateNumber = dateNumberFromTimestamp(points[points.length - 1].timestamp);
    if (this.latestSeenDateNumber !== null && firstDateNumber > this.latestSeenDateNumber) {
      // Cross-day: the old day's buffer must be flushed first (the active segment is still the old day's segment at this point), then write the new day's data to trigger day directory rotation
      const flushed = this.flushAll();
      result.blockCount += flushed.blockCount;
      result.pointCount += flushed.pointCount;
      result.sealedSegments.push(...flushed.sealedSegments);
    }
    this.latestSeenDateNumber =
      this.latestSeenDateNumber === null
        ? lastDateNumber
        : Math.max(this.latestSeenDateNumber, lastDateNumber);

    const receivedAt = Date.now();
    for (const point of points) {
      const buffer = this.requireBuffer(point.metricName, batchValueTypes);
      buffer.timestamps.push(point.timestamp);
      buffer.values.push(point.value);
      buffer.bytes += pointCostBytes(buffer.valueType, point.value);
      if (buffer.receivedMin === null) buffer.receivedMin = receivedAt;
      buffer.receivedMax = receivedAt;
    }

    for (const metricName of batchValueTypes.keys()) {
      const buffer = this.buffers.get(metricName);
      if (buffer !== undefined) this.drainBuffer(buffer, false, result);
    }
    // Blocks appended inside this append may already complete a WAL batch on the caller's side, so the
    // segment must be durable before `append()` returns (engine: append -> safe point).
    this.syncSegmentsIfNeeded();
    return { ...result, accepted: points.length };
  }

  /**
   * 5s fallback block formation: only flushes metrics that have reached `blockMinPoints` (prevents sparse
   * high-frequency measurement points from producing many fragmented blocks)
   */
  flush(): WriterFlushResult {
    return this.flushMetrics(this.readyMetricNames());
  }

  /**
   * Metric names whose buffer reached `blockMinPoints` (fallback-flush candidates, in map order).
   *
   * Exposed so the periodic flush can be **sliced**: encoding a block is CPU work on the caller's thread, and
   * flushing every ready metric at once blocked the event loop for hundreds of milliseconds at high write rates
   * (44 metrics x ~2 300 points measured as a ~270ms stall every 5s). The engine snapshots this list and flushes
   * it a few metrics per event-loop turn instead.
   */
  readyMetricNames(): string[] {
    const names: string[] = [];
    for (const buffer of this.buffers.values()) {
      if (buffer.timestamps.length >= this.blockMinPoints) names.push(buffer.metricName);
    }
    return names;
  }

  /**
   * Flush the given metrics only (a slice of `readyMetricNames()`); unknown/emptied names are skipped, so a slice
   * taken before a concurrent append stays valid.
   *
   * Blocks appended by the call are made durable at the end unless `syncSegments` is false — a sliced sweep passes
   * false for every slice but the last, so one `fsync` covers the whole sweep instead of one per slice.
   */
  flushMetrics(metricNames: readonly string[], syncSegments = true): WriterFlushResult {
    const result: WriterFlushResult = { blockCount: 0, pointCount: 0, sealedSegments: [] };
    for (const metricName of metricNames) {
      const buffer = this.buffers.get(metricName);
      if (buffer === undefined || buffer.timestamps.length < this.blockMinPoints) continue;
      this.drainBuffer(buffer, true, result);
    }
    if (syncSegments) this.syncSegmentsIfNeeded();
    return result;
  }

  /** Full flush: all buffers (regardless of whether the point count reaches the lower bound) form blocks; used for cross-day, `close()` and tests */
  flushAll(): WriterFlushResult {
    const result: WriterFlushResult = { blockCount: 0, pointCount: 0, sealedSegments: [] };
    for (const buffer of [...this.buffers.values()]) this.drainBuffer(buffer, true, result);
    this.syncSegmentsIfNeeded();
    return result;
  }

  /**
   * Make the blocks appended since the last sync durable. Called once per write/flush operation (not per
   * block): one `fsync` amortized over all the blocks of a drain keeps the overhead at the WAL's own group
   * commit level, and the WAL safe point may only be advanced after this returns.
   */
  private syncSegmentsIfNeeded(): void {
    if (!this.fsyncSegments || this.blocksSinceSegmentFsync === 0) return;
    this.blocksSinceSegmentFsync = 0;
    this.store.fsyncActiveSegment(this.database);
  }

  /**
   * Close: full flush + seal the current active segment (idempotent; `close()` only finishes the data plane;
   * new segments can still be written afterwards)
   *
   * Releasing the buffer pool is **not done here** (see `dispose()`): after `close()` the writer can still be
   * used for the next day/segment; disposing the buffer pool along the way would make continued writes fail
   * because the pool has been released.
   */
  close(): WriterFlushResult {
    const result = this.flushAll();
    const sealed = this.store.sealActiveSegment(this.database);
    if (sealed !== null) result.sealedSegments.push(sealed);
    return result;
  }

  /**
   * Release the self-created buffer pool (idempotent; returns whether it was actually released). When a pool is
   * injected it is not disposed on the caller's behalf, and its lifetime still belongs to the caller.
   *
   * After this call the writer **can no longer write** (the pool has been released); the shutdown path (engine)
   * should call this method after the data `close()`.
   */
  dispose(): boolean {
    if (!this.ownsBufferPool) return false;
    return this.bufferPool.dispose();
  }

  /* ---------- Watermarks and state ---------- */

  /** Unblocked point count (one of the two-watermark backpressure criteria) */
  get pendingPointCount(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) total += buffer.timestamps.length;
    return total;
  }

  /** Memory usage estimate for unblocked points (bytes, one of the two-watermark backpressure criteria) */
  get pendingBytes(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) total += buffer.bytes;
    return total;
  }

  /** Number of metrics that still have an unblocked buffer */
  get bufferedMetricCount(): number {
    return this.buffers.size;
  }

  /** Unblocked point count of a metric */
  pendingPointsOf(metricName: string): number {
    return this.buffers.get(metricName)?.timestamps.length ?? 0;
  }

  /** Value type of a metric (including metrics that are locked but currently unbuffered); returns null if unknown */
  valueTypeOf(metricName: string): ValueType | null {
    return this.lockedValueTypes.get(metricName) ?? null;
  }

  /** Names of metrics that currently still have an unblocked buffer (ascending; for queries to merge "accepted but not yet flushed" points) */
  bufferedMetricNames(): string[] {
    return [...this.buffers.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  /**
   * Get a **copy** of a metric's currently unblocked buffered points (ascending by timestamp; equal timestamps
   * keep write order)
   *
   * Purpose: the query path merges "accepted but not yet flushed" points, making them visible immediately after
   * `writeBatch` (real-time database semantics); returns a new array and new point objects, so caller
   * modifications do not affect the internal buffer.
   */
  bufferedPointsOf(metricName: string): Point[] {
    const buffer = this.buffers.get(metricName);
    if (buffer === undefined) return [];
    const points: Point[] = new Array(buffer.timestamps.length);
    for (let index = 0; index < buffer.timestamps.length; index += 1) {
      points[index] = { timestamp: buffer.timestamps[index], value: buffer.values[index] };
    }
    points.sort((left, right) => left.timestamp - right.timestamp);
    return points;
  }

  /**
   * Server receive-time window of a metric's currently unblocked buffered points (ms epoch;
   * null = the buffer is empty or tracks no arrival window). O(1); used by the query path to
   * merge the window of "accepted but not yet flushed" points into the range response.
   */
  bufferedReceivedWindowOf(metricName: string): { min: number; max: number } | null {
    const buffer = this.buffers.get(metricName);
    if (buffer === undefined || buffer.receivedMin === null || buffer.receivedMax === null) return null;
    return { min: buffer.receivedMin, max: buffer.receivedMax };
  }

  /* ---------- Internals: validation and backpressure ---------- */

  /**
   * Whole-batch validation: returns this batch's metric -> value type (including in-batch consistency and
   * comparison with existing locks) and this batch's memory usage estimate; any illegal point throws (the
   * validation phase does not modify any state).
   */
  private validateBatch(points: readonly WritePoint[]): {
    valueTypes: Map<string, ValueType>;
    bytes: number;
  } {
    const batchValueTypes = new Map<string, ValueType>();
    let batchBytes = 0;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const valueType = validateWritePoint(point, index);
      batchBytes += pointCostBytes(valueType, point.value);
      const existing = batchValueTypes.get(point.metricName);
      if (existing === undefined) {
        batchValueTypes.set(point.metricName, valueType);
        continue;
      }
      if (existing !== valueType) {
        throw new RtdbError(
          ERROR_CODE.TypeMismatch,
          `metric ${point.metricName} has an inconsistent value type within the same batch: ${VALUE_TYPE_NAME[existing]} and ${VALUE_TYPE_NAME[valueType]} (index=${index})`,
        );
      }
    }
    for (const [metricName, valueType] of batchValueTypes) {
      const locked = this.lockedValueTypes.get(metricName);
      if (locked !== undefined && locked !== valueType) {
        throw new RtdbError(
          ERROR_CODE.TypeMismatch,
          `metric ${metricName} is locked on first write to ${VALUE_TYPE_NAME[locked]}, this write is ${VALUE_TYPE_NAME[valueType]}`,
        );
      }
    }
    return { valueTypes: batchValueTypes, bytes: batchBytes };
  }

  /**
   * Two-watermark backpressure (whichever comes first): if this batch makes "buffered amount + this batch"
   * exceed either watermark, reject the whole batch.
   *
   * The watermark test uses **projected values** (already buffered + this batch) rather than "buffer first,
   * then test" — this way rejection produces no state change and also avoids "blow up memory then roll back".
   * The single-batch limit (server layer `E_BATCH_TOO_LARGE` = 1,000,000 points) is always smaller than the
   * default point watermark (2,000,000), so a legal single batch is never wrongly rejected by the projection
   * scope.
   */
  private enforceBackpressure(batchPointCount: number, batchBytes: number): void {
    const projectedPointCount = this.pendingPointCount + batchPointCount;
    if (projectedPointCount > this.maxPendingPoints) {
      throw new RtdbError(
        ERROR_CODE.RateLimited,
        `Unflushed point count watermark exceeded: pending=${this.pendingPointCount}, batch=${batchPointCount}, maxPendingPoints=${this.maxPendingPoints}`,
      );
    }
    const projectedBytes = this.pendingBytes + batchBytes;
    if (projectedBytes > this.maxBufferBytes) {
      throw new RtdbError(
        ERROR_CODE.RateLimited,
        `Unblocked point memory watermark exceeded: pendingBytes=${this.pendingBytes}, batchBytes=${batchBytes}, maxBufferBytes=${this.maxBufferBytes}`,
      );
    }
  }

  /** Get (creating and locking if necessary) a metric's buffer */
  private requireBuffer(
    metricName: string,
    batchValueTypes: ReadonlyMap<string, ValueType>,
  ): MetricBuffer {
    const valueType = batchValueTypes.get(metricName);
    if (valueType === undefined) {
      throw new RtdbError(ERROR_CODE.Internal, `The batch is missing the value type for metric ${metricName}; cannot buffer`);
    }
    const existing = this.buffers.get(metricName);
    if (existing !== undefined) return existing;

    if (!this.lockedValueTypes.has(metricName)) this.lockedValueTypes.set(metricName, valueType);
    const buffer: MetricBuffer = {
      metricName,
      valueType,
      timestamps: [],
      values: [],
      bytes: 0,
      receivedMin: null,
      receivedMax: null,
    };
    this.buffers.set(metricName, buffer);
    return buffer;
  }

  /* ---------- Internals: block formation ---------- */

  /**
   * Flush the buffered head points to disk.
   *
   * `drainAll=false` (primary trigger): forms a block only when the remaining point count reaches one full
   * target block, leaving the remainder for next time;
   * `drainAll=true` (fallback / full flush): forms a block even when the remaining point count is below the
   * target block, until the buffer is emptied.
   */
  private drainBuffer(
    buffer: MetricBuffer,
    drainAll: boolean,
    result: WriterFlushResult,
  ): void {
    while (buffer.timestamps.length > 0) {
      if (!drainAll && buffer.timestamps.length < this.blockTargetPoints) break;
      const count = Math.min(this.blockTargetPoints, buffer.timestamps.length);
      this.commitBlock(buffer, count, result);
    }
    if (buffer.timestamps.length === 0) this.buffers.delete(buffer.metricName);
  }

  /**
   * Encode and remove `count` points from the buffer, appending to the active segment (the store completes
   * rolling / cross-day sealing if needed)
   *
   * Block bytes are borrowed from `bufferPool` and returned immediately after `appendBlock` (the store does not
   * hold the block bytes, it only registers index metadata); if an error is thrown between borrow and return
   * due to rolling / sealing / IO failure, `finally` guarantees the buffer is still returned (no pool entry
   * leak).
   */
  private commitBlock(buffer: MetricBuffer, count: number, result: WriterFlushResult): void {
    const timestamps = buffer.timestamps.splice(0, count);
    const values = buffer.values.splice(0, count);
    let releasedBytes = 0;
    for (const value of values) releasedBytes += pointCostBytes(buffer.valueType, value);
    buffer.bytes -= releasedBytes;

    // Defensive fallback: the arrival window is recorded on append; a null here can only come from a
    // path that bypassed `append` (kept for safety), stamped with the flush time instead.
    // On partial drains the window carries over and stays a **superset** of the remainder's actual
    // receive times (invariant: every point's receive time ∈ [receivedMin, receivedMax]).
    const receivedMin = buffer.receivedMin ?? Date.now();
    const receivedMax = buffer.receivedMax ?? receivedMin;
    const block = encodeSegmentBlock(
      this.bufferPool,
      buffer.metricName,
      buffer.valueType,
      timestamps,
      values,
      receivedMin,
      receivedMax,
    );

    try {
      const opened = this.store.openActiveSegment(this.database, block.timestampMin, block.blockBytes.length);
      if (opened.sealed !== null) result.sealedSegments.push(opened.sealed);

      // Set the segment header flag when the block has zlib whole-block wrapping (must be done before sealing, otherwise the in-memory header covered by the Footer CRC does not match the actual one)
      if (block.valueCodecId === CODEC_ID.zlibWrap) {
        this.store.setSegmentHeaderFlag(this.database, SEGMENT_HEADER_FLAG.zlibBlock);
      }

      this.store.appendBlock(this.database, block.blockBytes, {
        metricName: buffer.metricName,
        pointCount: block.pointCount,
        timestampMin: block.timestampMin,
        timestampMax: block.timestampMax,
      });
      this.blocksSinceSegmentFsync += 1;
    } finally {
      this.bufferPool.release(block.blockBytes);
    }
    result.blockCount += 1;
    result.pointCount += block.pointCount;
  }
}

/* ---------- Internals: single-point validation ---------- */

/** Validate a single point and return the inferred value type; throws E_INVALID_POINT (with the in-batch index) on failure */
function validateWritePoint(point: WritePoint, index: number): ValueType {
  if (typeof point.timestamp !== 'number' || !Number.isInteger(point.timestamp)) {
    throw new RtdbError(
      ERROR_CODE.InvalidPoint,
      `The timestamp must be an integer number of milliseconds: index=${index}, value=${String(point.timestamp)}`,
    );
  }
  validateMetricName(point.metricName, index);

  const value = point.value;
  const valueType = inferValueType(value, index);
  switch (valueType) {
    case ValueType.Float64:
      if (!Number.isFinite(value as number)) {
        throw new RtdbError(
          ERROR_CODE.InvalidPoint,
          `f64 values must be finite numbers (NaN/Infinity are not supported): index=${index}, value=${String(value)}`,
        );
      }
      break;
    case ValueType.Int64: {
      const magnitude = (value as bigint) < 0n ? -(value as bigint) : (value as bigint);
      if (magnitude > BigInt(WRITE_LIMITS.int64MaxSafeInteger)) {
        throw new RtdbError(
          ERROR_CODE.InvalidPoint,
          `i64 value exceeds ±2^53 (to keep SDK numbers exact): index=${index}, value=${String(value)}`,
        );
      }
      break;
    }
    case ValueType.String: {
      const bytes = utf8ByteLength(value as string);
      if (bytes > WRITE_LIMITS.stringValueMaxBytes) {
        throw new RtdbError(
          ERROR_CODE.InvalidPoint,
          `string value exceeds the ${WRITE_LIMITS.stringValueMaxBytes}B UTF-8 limit: index=${index}, actual ${bytes}B`,
        );
      }
      break;
    }
    case ValueType.Bool:
      break;
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Unknown value type: ${String(valueType)}`);
  }

  // M0 decision (00-pre-development confirmation checklist §2.2): all-zero quality is not persisted; non-zero quality is explicitly rejected until the enum table is finalized (to avoid silent loss)
  if (point.quality !== undefined && point.quality !== 0) {
    throw new RtdbError(
      ERROR_CODE.InvalidPoint,
      `M0 only supports quality 0 (all-zero is not persisted); received quality=${String(point.quality)} (index=${index})`,
    );
  }

  return valueType;
}

/** Metric naming constraints: non-empty, <=512B UTF-8, forbids `\n` and NUL (aligned with Detailed Design §2.1) */
function validateMetricName(metricName: string, index: number): void {
  if (typeof metricName !== 'string' || metricName.length === 0) {
    throw new RtdbError(ERROR_CODE.BadMetricName, `The metric name cannot be empty: index=${index}`);
  }
  if (metricName.includes('\n') || metricName.includes('\0')) {
    throw new RtdbError(
      ERROR_CODE.BadMetricName,
      `The metric name must not contain newlines or NUL characters: index=${index}, metric=${JSON.stringify(metricName)}`,
    );
  }
  const bytes = utf8ByteLength(metricName);
  if (bytes > WRITE_LIMITS.metricNameMaxBytes) {
    throw new RtdbError(
      ERROR_CODE.BadMetricName,
      `The metric name exceeds the ${WRITE_LIMITS.metricNameMaxBytes}B UTF-8 limit: index=${index}, actual ${bytes}B`,
    );
  }
}

/** Value type inference (the single scope of the write entry point, see the Point comment in types.ts) */
function inferValueType(value: Point['value'], index: number): ValueType {
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
      throw new RtdbError(
        ERROR_CODE.InvalidPoint,
        `Unsupported value type (only number/bigint/boolean/string): index=${index}, type=${typeof value}`,
      );
  }
}

/** UTF-8 byte length (no allocation: surrogate pairs count 4B, lone surrogates count 3B) */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Single-point memory usage estimate (for watermark readings; not used for backpressure rejection) */
function pointCostBytes(valueType: ValueType, value: Point['value']): number {
  switch (valueType) {
    case ValueType.Float64:
    case ValueType.Int64:
      return TIMESTAMP_COST_BYTES + 8;
    case ValueType.Bool:
      return TIMESTAMP_COST_BYTES + 1;
    case ValueType.String:
      return (
        TIMESTAMP_COST_BYTES + STRING_BASE_COST_BYTES + (value as string).length * UTF16_BYTES_PER_CODE_UNIT
      );
    default:
      return TIMESTAMP_COST_BYTES + 8;
  }
}

/* ---------- Internals: block encoding ---------- */

interface EncodedSegmentBlock {
  /** Whole block bytes (block header ++ ts encoding ++ val encoding), can be passed directly to `store.appendBlock` */
  blockBytes: Uint8Array;
  pointCount: number;
  timestampMin: number;
  timestampMax: number;
  valueCodecId: number;
}

/**
 * Encode one data block (timestamps within the block are stably sorted ascending; `timestampRawLength` /
 * `valueRawLength` take the **on-disk payload byte count**, which the read side uses to split BlockData; the
 * decompressed length must not be filled in).
 *
 * Block bytes are borrowed from `pool` (the length is exactly the total block byte count); the caller is
 * responsible for returning them after flushing.
 */
function encodeSegmentBlock(
  pool: BufferPool,
  metricName: string,
  valueType: ValueType,
  unsortedTimestamps: readonly number[],
  unsortedValues: readonly Point['value'][],
  receivedMin: number,
  receivedMax: number,
): EncodedSegmentBlock {
  const count = unsortedTimestamps.length;
  if (count < 1) {
    throw new RtdbError(ERROR_CODE.Internal, `The block point count cannot be 0: metric=${metricName}`);
  }

  const sorted = sortByTimestamp(unsortedTimestamps, unsortedValues);
  const timestampEncoded = encodeTimestamps(sorted.timestamps, count);
  const encodedValues = encodeValues(
    valueType,
    toEncodableValues(valueType, sorted.values, count),
    count,
  );

  // Server receive-time window: 16B appended after BlockData (flag bit3), included in the CRC scope
  const receivedBytes = new Uint8Array(BLOCK_RECEIVED_WINDOW_SIZE);
  const receivedView = new DataView(receivedBytes.buffer);
  receivedView.setBigInt64(0, BigInt(Math.trunc(receivedMin)), true);
  receivedView.setBigInt64(8, BigInt(Math.trunc(receivedMax)), true);

  const timestampMin = sorted.timestamps[0];
  const timestampMax = sorted.timestamps[count - 1];
  const blockHeader = encodeBlockHeader({
    metricName,
    pointCount: count,
    valueType,
    timestampCodecId: TIMESTAMP_CODEC_ID,
    valueCodecId: encodedValues.codecId,
    timestampRawLength: timestampEncoded.length,
    valueRawLength: encodedValues.payload.length,
    timestampMin,
    timestampMax,
    flags: BLOCK_FLAG.receivedTime,
    crc32: blockDataCrc32WithReceived(timestampEncoded, encodedValues.payload, receivedBytes),
  });

  return {
    blockBytes: concatBytes(pool, [blockHeader, timestampEncoded, encodedValues.payload, receivedBytes]),
    pointCount: count,
    timestampMin,
    timestampMax,
    valueCodecId: encodedValues.codecId,
  };
}

/** Stable ascending sort of block timestamps (equal timestamps keep write order) */
function sortByTimestamp(
  timestamps: readonly number[],
  values: readonly Point['value'][],
): { timestamps: number[]; values: Array<Point['value']> } {
  const order = new Array<number>(timestamps.length);
  for (let index = 0; index < timestamps.length; index += 1) order[index] = index;
  order.sort((left, right) => timestamps[left] - timestamps[right]);

  const sortedTimestamps = new Array<number>(timestamps.length);
  const sortedValues = new Array<Point['value']>(timestamps.length);
  for (let index = 0; index < order.length; index += 1) {
    const source = order[index];
    sortedTimestamps[index] = timestamps[source];
    sortedValues[index] = values[source];
  }
  return { timestamps: sortedTimestamps, values: sortedValues };
}

/** Buffered values -> encoder input container (four narrow types, avoiding the encoder doing Number/BigInt round-trips point by point) */
function toEncodableValues(
  valueType: ValueType,
  values: readonly Point['value'][],
  count: number,
): EncodableValues {
  switch (valueType) {
    case ValueType.Float64: {
      const out = new Float64Array(count);
      for (let index = 0; index < count; index += 1) out[index] = values[index] as number;
      return out;
    }
    case ValueType.Int64: {
      const out = new BigInt64Array(count);
      for (let index = 0; index < count; index += 1) out[index] = values[index] as bigint;
      return out;
    }
    case ValueType.Bool: {
      const out = new Uint8Array(count);
      for (let index = 0; index < count; index += 1) out[index] = values[index] === true ? 1 : 0;
      return out;
    }
    case ValueType.String:
      // The value type is locked to string and the content must be string (guaranteed by the same-batch validation); this is only a container type narrowing
      return values as unknown as readonly string[];
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Unknown value type: ${String(valueType)}`);
  }
}

/** Concatenate byte segments in order (capacity is borrowed from `pool` with length exactly the sum of parts; the caller returns it after flushing) */
function concatBytes(pool: BufferPool, parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = pool.acquire(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
