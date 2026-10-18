// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Segment reader: segment manifest scan -> block location (`.idx` binary search) -> block decode -> merge
 * (aligned with Detailed Design v1.6 §2.3, §2.5)
 *
 * Responsibility boundary: this file only does **location and decode**; directory/segment naming, the
 * segment handle LRU, and file reads are all delegated to `SegmentStore`.
 * Index source: prefer the `.idx` mirror (atomically written on seal); when missing/corrupt, **rebuild by
 * sequentially scanning blocks from `.seg`** (fallback).
 *
 * Read path (three layers of pruning, narrowing IO layer by layer from top to bottom):
 *   1. Day directory pruning: day directories are bucketed by local timezone; a directory is skipped whole
 *      when `[dayStart, nextDayStart)` has no intersection with the query range
 *   2. In-segment block pruning: binary search by the index entry's `timestampMin`/`timestampMax` + linear
 *      tail (intersect blocks with the range)
 *   3. In-block pruning: after decoding, filter by the point-level range (a block is the smallest IO unit;
 *      no second seek within a block)
 *
 * Merge scope: multiple blocks of the same metric may have overlapping ranges (out-of-order append,
 * cross-segment); after decoding they are stably sorted by `(timestamp, block order)` and deduplicated by
 * timestamp (keeping the first occurrence), guaranteeing the returned sequence has strictly increasing
 * timestamps.
 *
 * Value type locking is re-checked on the read side: if the `valueType` of blocks for the same metric is
 * inconsistent, throws E_TYPE_MISMATCH (a gate re-check of the write side's first-write lock).
 */

import { readFileSync } from 'node:fs';
import { sep } from 'node:path';

import { decodeTimestamps, decodeValues } from './encoder/registry.ts';
import { ERROR_CODE, RtdbError, isRtdbError } from './errors.ts';
import {
  BLOCK_FLAG,
  BLOCK_HEADER_FIXED_SIZE,
  SEGMENT_FOOTER_SIZE,
  SEGMENT_HEADER_SIZE,
  blockDataCrc32,
  blockDataCrc32WithReceived,
  footerCrc32,
  nextDayTimestampFromDateNumber,
  parseIndexRegion,
  parseSegmentHeader,
  timestampFromDateNumber,
  tryParseBlockHeader,
} from './format.ts';
import type { BlockHeader, SegmentBlockIndexEntry, SegmentHeader } from './format.ts';
import { DEFAULT_RANGE_LIMIT, ENGINE_DEFAULTS, VALUE_TYPE_NAME, ValueType, clampEngineOption } from './types.ts';
import type { Point, RangeOptions } from './types.ts';
import type { SegmentStore } from './segment-store.ts';

/* ---------- Public types ---------- */

export interface SegmentReaderOptions {
  /** Segment store (directory, segment naming, file reads, and the handle LRU are all delegated to it) */
  store: SegmentStore;
  /** Decoded block cache LRU entries; default 256, clamped to 16~4096 */
  cacheBlocks?: number;
}

/** Segment file descriptor (read-side manifest entry) */
export interface SegmentFileDescriptor {
  database: string;
  /** yyyyMMdd (local timezone scope) */
  dateNumber: number;
  sequence: number;
  segmentFilePath: string;
  indexFilePath: string;
  /** Total segment file byte count */
  bytes: number;
  /** Block region end (sealed segment = Footer start; active segment = file end) */
  blockRegionEnd: number;
  /** Whether sealed (Footer CRC check passed) */
  sealed: boolean;
}

/** Block location result (index entry + owning segment) */
export interface BlockLocation {
  database: string;
  segmentFilePath: string;
  entry: SegmentBlockIndexEntry;
}

/**
 * Segment inspection result (recovery path only): measured against "consistent with the actual block
 * region", to drive half-block truncation and `.idx` rebuild decisions
 */
export interface SegmentInspection {
  database: string;
  dateNumber: number;
  sequence: number;
  segmentFilePath: string;
  indexFilePath: string;
  /** Current segment file byte count */
  fileBytes: number;
  /** Sealed (a valid Footer exists at the block region end) */
  sealed: boolean;
  /** Actual block region end (after the last complete block; sealed segment = Footer start) */
  blockRegionEnd: number;
  /** Index entries rebuilt by sequential block scan (the last block is excluded when its CRC re-check fails) */
  entries: SegmentBlockIndexEntry[];
  /** Trailing garbage bytes to be truncated (half block / tail of an unsealed segment; always 0 for sealed segments) */
  truncatedBytes: number;
  /** Whether the `.idx` mirror must be rebuilt (only for sealed segments whose mirror is missing/inconsistent with the actual block region; always false for unsealed segments) */
  indexMirrorRebuildNeeded: boolean;
}

/** Decoded block content (block cache entry) */
interface DecodedBlock {
  metricName: string;
  valueType: ValueType;
  timestamps: number[];
  values: Array<Point['value']>;
  /** Server receive-time window carried by the block; null for blocks without the `receivedTime` flag */
  receivedMin: number | null;
  receivedMax: number | null;
}

/* ---------- Segment reader ---------- */

export class SegmentReader {
  private readonly store: SegmentStore;
  /** Effective decoded block cache entries (already clamped) */
  readonly cacheBlocks: number;

  private readonly blockCache = new Map<string, DecodedBlock>();
  /** Cumulative block cache hits / misses this session (status only; no behavioral effect) */
  private blockCacheHitTotal = 0;
  private blockCacheMissTotal = 0;

  constructor(options: SegmentReaderOptions) {
    this.store = options.store;
    this.cacheBlocks = clampEngineOption(
      'cacheBlocks',
      options.cacheBlocks ?? ENGINE_DEFAULTS.cacheBlocks,
    );
  }

  /**
   * Segment manifest (ascending by date and segment sequence = time order); a query range may be passed for
   * coarse day directory pruning
   *
   * Only reads directory- and file-level metadata (segment size + block region end); does not load the index.
   */
  listSegments(
    database: string,
    startTimestamp = Number.NEGATIVE_INFINITY,
    endTimestamp = Number.POSITIVE_INFINITY,
  ): SegmentFileDescriptor[] {
    const descriptors: SegmentFileDescriptor[] = [];
    for (const dateNumber of this.store.listDayDirectories(database)) {
      const dayStart = timestampFromDateNumber(dateNumber);
      const dayEnd = nextDayTimestampFromDateNumber(dateNumber);
      if (dayEnd <= startTimestamp || dayStart > endTimestamp) continue;

      for (const sequence of this.store.listSegmentSequences(database, dateNumber)) {
        const descriptor = this.describeSegment(database, dateNumber, sequence);
        if (descriptor !== null) descriptors.push(descriptor);
      }
    }
    return descriptors;
  }

  /**
   * Load the block index entries of a segment: prefer the `.idx` mirror (verify Footer CRC and layout),
   * rebuild by scanning blocks from `.seg` on failure
   *
   * The returned value is ordered by **write order** (consistent with the block region order within the segment).
   */
  loadIndexEntries(database: string, dateNumber: number, sequence: number): SegmentBlockIndexEntry[] {
    const descriptor = this.describeSegment(database, dateNumber, sequence);
    if (descriptor === null) {
      throw new RtdbError(
        ERROR_CODE.DatabaseNotFound,
        `Segment file does not exist: ${this.store.segmentFilePath(database, dateNumber, sequence)}`,
      );
    }
    const fromIndexFile = this.loadIndexEntriesFromMirror(descriptor);
    if (fromIndexFile !== null) return fromIndexFile;
    return this.rebuildIndexEntries(descriptor);
  }

  /**
   * Read only a block header and return its value type (management statistics: avoids decoding the payload).
   *
   * Reads at most the fixed header plus a metric-name window, so the cost is one small read per metric rather
   * than one block decode. Returns `null` when the header cannot be parsed (the caller then reports `unknown`).
   */
  readBlockValueType(descriptor: SegmentFileDescriptor, entry: SegmentBlockIndexEntry): ValueType | null {
    const probeLength = Math.min(entry.length, BLOCK_HEADER_FIXED_SIZE + 1024);
    if (probeLength <= 0) return null;
    const bytes = this.store.readSegmentSlice(descriptor.segmentFilePath, entry.offset, probeLength);
    const header = tryParseBlockHeader(bytes, 0, bytes.length);
    return header === null ? null : header.valueType;
  }

  /**
   * Block location: index entries of the same metric are located by binary search on `timestampMin` + linear
   * tail (intersect blocks with the range); the result is ascending by time
   *
   * The block order within a segment is not guaranteed monotonic (out-of-order append), so sort by
   * `timestampMin` before binary search; blocks with `timestampMax < start` are skipped whole.
   */
  locateBlocks(
    database: string,
    metricName: string,
    startTimestamp: number,
    endTimestamp: number,
  ): BlockLocation[] {
    const locations: BlockLocation[] = [];
    for (const descriptor of this.listSegments(database, startTimestamp, endTimestamp)) {
      const entries = this.loadIndexEntries(descriptor.database, descriptor.dateNumber, descriptor.sequence);
      const candidates: SegmentBlockIndexEntry[] = [];
      for (const entry of entries) {
        if (entry.metricName !== metricName) continue;
        if (entry.timestampMax < startTimestamp || entry.timestampMin > endTimestamp) continue;
        candidates.push(entry);
      }
      if (candidates.length === 0) continue;

      candidates.sort((left, right) => left.timestampMin - right.timestampMin);
      let low = 0;
      let high = candidates.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (candidates[middle].timestampMax < startTimestamp) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < candidates.length; index += 1) {
        const entry = candidates[index];
        if (entry.timestampMin > endTimestamp) break;
        locations.push({ database, segmentFilePath: descriptor.segmentFilePath, entry });
      }
    }
    return locations;
  }

  /**
   * Read the points of a metric within a range (decode + merge + dedupe; the S6 four query primitives build
   * limit/order/aggregation on top of this)
   *
   * `order` defaults to `asc`; `limit` defaults to 100_000 (the same scope as `RangeOptions`).
   * When `receivedOut` is given, the aggregated server receive-time window of the visited blocks
   * (min of `receivedMin` / max of `receivedMax`; null when no block carries one) is written into it.
   *
   * Implemented on top of [iterateMetricPoints](#iteratemetricpoints): the visitor stops as soon as
   * `limit` unique points have been collected, so memory is bounded by the limit instead of the hit
   * point count (2026-10-18 bounded-memory refactor).
   */
  readMetricPoints(
    database: string,
    metricName: string,
    options: RangeOptions,
    receivedOut?: { min: number; max: number },
  ): Point[] {
    if (!Number.isFinite(options.start) || !Number.isFinite(options.end) || options.start > options.end) {
      throw new RtdbError(
        ERROR_CODE.InvalidRange,
        `Illegal query range: start=${options.start}, end=${options.end}`,
      );
    }
    const limit = options.limit ?? DEFAULT_RANGE_LIMIT;
    const points: Point[] = [];
    const out = { valueType: null as ValueType | null, receivedMin: 0, receivedMax: 0 };
    for (const point of this.iterateMetricPoints(
      database,
      metricName,
      { start: options.start, end: options.end, order: options.order },
      out,
    )) {
      points.push(point);
      if (points.length >= limit) break;
    }
    if (receivedOut !== undefined) {
      receivedOut.min = out.receivedMin;
      receivedOut.max = out.receivedMax;
    }
    return points;
  }

  /**
   * Sweep a metric's points in `[start, end]` in **timestamp order** (unique `(metric, ts)`, one point per
   * step). Consume with `for...of`; `break` stops the underlying block decoding early.
   *
   * Memory is bounded by the largest overlapping block cluster instead of the hit point count — the fix
   * for the 2026-10-18 incident "one long-range query materialized every point (~2 GB heap)". Blocks are
   * chained into clusters by `[timestampMin, timestampMax]` overlap at the index level; a single-block
   * cluster streams its points directly, a multi-block cluster (backfill overlap) materializes and merges
   * within the cluster only. Output order and unique-ts semantics are identical to the previous
   * sort-everything implementation (equal ts keeps the first in collection order; stored values for the
   * same `(metric, ts)` are identical under write idempotency anyway).
   *
   * `out` (optional) receives the visited blocks' value type and the aggregated server receive-time
   * window (same scope as the old `receivedOut`).
   */
  *iterateMetricPoints(
    database: string,
    metricName: string,
    options: { start: number; end: number; order?: 'asc' | 'desc' },
    out?: { valueType: ValueType | null; receivedMin: number; receivedMax: number },
  ): Generator<Point, void, undefined> {
    if (!Number.isFinite(options.start) || !Number.isFinite(options.end) || options.start > options.end) {
      throw new RtdbError(
        ERROR_CODE.InvalidRange,
        `Illegal query range: start=${options.start}, end=${options.end}`,
      );
    }
    const order = options.order ?? 'asc';
    const locations = this.locateBlocks(database, metricName, options.start, options.end);
    // Global block ordering (index-level sort; a few hundred entries even for a whole-day scan).
    // `sequence` is assigned in **ascending** block order regardless of the output direction, so the
    // "equal ts keeps the first in collection order" dedupe matches the old sort-everything behavior.
    const orderedLocations = locations.map((location, sequence) => ({ location, sequence }));
    if (order === 'desc') {
      orderedLocations.sort(
        (left, right) =>
          right.location.entry.timestampMax - left.location.entry.timestampMax ||
          right.location.entry.timestampMin - left.location.entry.timestampMin,
      );
    } else {
      orderedLocations.sort(
        (left, right) =>
          left.location.entry.timestampMin - right.location.entry.timestampMin ||
          left.location.entry.timestampMax - right.location.entry.timestampMax,
      );
    }

    // Chain blocks whose ranges overlap into clusters (still index-level only)
    const clusters: Array<Array<{ location: BlockLocation; sequence: number }>> = [];
    let clusterMax = Number.NEGATIVE_INFINITY;
    let clusterMin = Number.POSITIVE_INFINITY;
    for (const item of orderedLocations) {
      const last = clusters[clusters.length - 1];
      const joins =
        last !== undefined &&
        (order === 'asc'
          ? item.location.entry.timestampMin <= clusterMax
          : item.location.entry.timestampMax >= clusterMin);
      if (last === undefined || !joins) {
        clusters.push([item]);
        clusterMax = item.location.entry.timestampMax;
        clusterMin = item.location.entry.timestampMin;
        continue;
      }
      last.push(item);
      if (item.location.entry.timestampMax > clusterMax) clusterMax = item.location.entry.timestampMax;
      if (item.location.entry.timestampMin < clusterMin) clusterMin = item.location.entry.timestampMin;
    }

    let lastEmitted: number | null = null;

    const checkBlockMeta = (block: DecodedBlock): void => {
      if (out === undefined) return;
      if (out.valueType === null) out.valueType = block.valueType;
      else if (out.valueType !== block.valueType) {
        throw new RtdbError(
          ERROR_CODE.TypeMismatch,
          `metric ${metricName} has an inconsistent value type: already decoded ${VALUE_TYPE_NAME[out.valueType]}, but a hit block is ${VALUE_TYPE_NAME[block.valueType]}`,
        );
      }
      if (block.receivedMin !== null && block.receivedMax !== null) {
        out.receivedMin = out.receivedMin === 0 ? block.receivedMin : Math.min(out.receivedMin, block.receivedMin);
        out.receivedMax = Math.max(out.receivedMax, block.receivedMax);
      }
    };

    const visitBlock = function* (block: DecodedBlock, indexOrder: 'asc' | 'desc'): Generator<Point> {
      checkBlockMeta(block);
      const step = indexOrder === 'asc' ? 1 : -1;
      // Descending starts at the block's last index (block timestamps are stored ascending) and walks
      // backwards; the bounds guard keeps the loop from stepping past either end of the typed array.
      const firstIndex = indexOrder === 'asc' ? 0 : block.timestamps.length - 1;
      for (let index = firstIndex; index >= 0 && index < block.timestamps.length; index += step) {
        const timestamp = block.timestamps[index];
        if (timestamp < options.start || timestamp > options.end) continue;
        if (lastEmitted !== null && (order === 'asc' ? timestamp <= lastEmitted : timestamp >= lastEmitted)) continue;
        lastEmitted = timestamp;
        yield { timestamp, value: block.values[index] };
      }
    };

    for (const cluster of clusters) {
      if (cluster.length === 1) {
        yield* visitBlock(this.readBlock(cluster[0].location.segmentFilePath, cluster[0].location.entry), order);
        continue;
      }
      // Multi-block overlapping cluster (backfill overlap): materialize inside the cluster only, then
      // merge + dedupe — same result as the old global sort, bounded by the cluster size
      const collected: Array<{ timestamp: number; value: Point['value']; order: number }> = [];
      for (const item of cluster) {
        const block = this.readBlock(item.location.segmentFilePath, item.location.entry);
        checkBlockMeta(block);
        for (let index = 0; index < block.timestamps.length; index += 1) {
          const timestamp = block.timestamps[index];
          if (timestamp < options.start || timestamp > options.end) continue;
          collected.push({ timestamp, value: block.values[index], order: item.sequence });
        }
      }
      collected.sort(
        order === 'asc'
          ? (left, right) => left.timestamp - right.timestamp || left.order - right.order
          : (left, right) => right.timestamp - left.timestamp || left.order - right.order,
      );
      let clusterPrevious: number | null = null;
      for (const item of collected) {
        if (clusterPrevious !== null && item.timestamp === clusterPrevious) continue;
        if (lastEmitted !== null && (order === 'asc' ? item.timestamp <= lastEmitted : item.timestamp >= lastEmitted)) {
          clusterPrevious = item.timestamp;
          continue;
        }
        clusterPrevious = item.timestamp;
        lastEmitted = item.timestamp;
        yield { timestamp: item.timestamp, value: item.value };
      }
    }
  }

  /**
   * Segment inspection (recovery path): does not consult `.idx`; always **sequentially scans blocks** to get
   * the real block region, and re-checks the **last block BlockData CRC**
   *
   * Criteria (aligned with Detailed Design v1.7 §2.8):
   *   - Last block CRC failure (power-loss half block / tail) -> drop that last block, `blockRegionEnd` falls
   *     back to after the previous complete block
   *   - A valid Footer at the block region end -> sealed, trailing garbage byte count is 0 (the tail bytes =
   *     Footer + index region, which is structural data)
   *   - Not sealed -> tail = file end - block region end; >0 means truncation is needed (half-block truncation
   *     path)
   *   - `.idx` rebuild is only decided on **sealed segments** (the mirror of an unsealed segment does not
   *     participate in the read path anyway)
   *
   * Returns null if the segment file does not exist; throws `E_CORRUPT_SEGMENT` if the segment header is
   * illegal (a file at least `SEGMENT_HEADER_SIZE` bytes long with a bad magic is a genuine corruption).
   *
   * A file **shorter than the segment header** is not corruption but an **interrupted creation**: the exclusive
   * create (`wx+`) succeeded and the process died before the 32B header was written. Such a file can never hold
   * a complete block, so it is reported as an empty, unsealed segment (`entries: []`, `truncatedBytes: 0`)
   * instead of failing the whole data root — otherwise a single SIGKILL inside that tiny window would leave the
   * database unopenable (the "zero damage after a power loss" gate).
   */
  inspectSegment(database: string, dateNumber: number, sequence: number): SegmentInspection | null {
    const segmentFilePath = this.store.segmentFilePath(database, dateNumber, sequence);
    const indexFilePath = this.store.indexFilePathOfSegment(database, dateNumber, sequence);
    const fileBytes = this.store.segmentFileBytes(segmentFilePath);
    if (fileBytes === null) return null;
    if (fileBytes < SEGMENT_HEADER_SIZE) {
      return {
        database,
        dateNumber,
        sequence,
        segmentFilePath,
        indexFilePath,
        fileBytes,
        sealed: false,
        blockRegionEnd: fileBytes,
        entries: [],
        truncatedBytes: 0,
        indexMirrorRebuildNeeded: false,
      };
    }
    requireSegmentHeader(this.store, segmentFilePath);

    // Scan blocks with "file end" as the block region upper bound, letting the endpoint be fully determined by the block structure (without reverse-engineering via `.idx`)
    const rawDescriptor: SegmentFileDescriptor = {
      database,
      dateNumber,
      sequence,
      segmentFilePath,
      indexFilePath,
      bytes: fileBytes,
      blockRegionEnd: fileBytes,
      sealed: false,
    };
    const scanned = this.scanBlockHeaders(rawDescriptor);
    let headers = scanned.headers;
    let blockRegionEnd = scanned.regionEnd;

    // Last block BlockData CRC re-check (half-block truncation criterion: a partial block written during a power loss may happen to satisfy the length check)
    const lastHeader = headers.length === 0 ? null : headers[headers.length - 1];
    if (lastHeader !== null && !this.blockDataCrcMatches(segmentFilePath, lastHeader)) {
      headers = headers.slice(0, -1);
      const previousHeader = headers.length === 0 ? null : headers[headers.length - 1];
      blockRegionEnd =
        previousHeader === null ? SEGMENT_HEADER_SIZE : previousHeader.offset + previousHeader.totalLength;
    }

    const entries = headers.map((block) => ({
      metricName: block.metricName,
      offset: block.offset,
      length: block.totalLength,
      pointCount: block.pointCount,
      timestampMin: block.timestampMin,
      timestampMax: block.timestampMax,
    }));

    const sealed = this.footerMatches(segmentFilePath, blockRegionEnd);
    return {
      database,
      dateNumber,
      sequence,
      segmentFilePath,
      indexFilePath,
      fileBytes,
      sealed,
      blockRegionEnd,
      entries,
      truncatedBytes: sealed ? 0 : fileBytes - blockRegionEnd,
      indexMirrorRebuildNeeded: sealed && !this.indexMirrorMatches(rawDescriptor, entries, blockRegionEnd),
    };
  }

  /* ---------- Block cache ---------- */

  /** Current decoded block cache entries */
  get cachedBlockCount(): number {
    return this.blockCache.size;
  }

  /** Cumulative block cache hits this session (for `status.cache.blockHitRate`) */
  get blockCacheHitCount(): number {
    return this.blockCacheHitTotal;
  }

  /** Cumulative block cache misses this session */
  get blockCacheMissCount(): number {
    return this.blockCacheMissTotal;
  }

  clearBlockCache(): void {
    this.blockCache.clear();
  }

  /**
   * Evict all decoded block cache entries of a database (must be called after deleting a day directory /
   * restoring a replaced database directory)
   *
   * Cache keys are prefixed with the segment file absolute path, so eviction is by database directory prefix;
   * returns the number of evicted entries.
   * Avoids reading stale decoded results of deleted files when "the same path gets new content".
   */
  evictDatabase(database: string): number {
    const prefix = `${this.store.databaseDirectoryPath(database)}${sep}`;
    let evicted = 0;
    for (const cacheKey of [...this.blockCache.keys()]) {
      if (!cacheKey.startsWith(prefix)) continue;
      this.blockCache.delete(cacheKey);
      evicted += 1;
    }
    return evicted;
  }

  /* ---------- Internals: segment description ---------- */

  /** Read segment file and `.idx` metadata, verify the Footer (decides seal and block region end); returns null if the file is missing */
  private describeSegment(
    database: string,
    dateNumber: number,
    sequence: number,
  ): SegmentFileDescriptor | null {
    const segmentFilePath = this.store.segmentFilePath(database, dateNumber, sequence);
    const indexFilePath = this.store.indexFilePathOfSegment(database, dateNumber, sequence);
    const bytes = this.store.segmentFileBytes(segmentFilePath);
    if (bytes === null) return null;
    // Tolerance mirrored from `inspectSegment`: a file shorter than the segment header is an interrupted
    // creation with no complete block. It is described as an empty, unsealed segment so the read path lists and
    // skips it (block scan starts at SEGMENT_HEADER_SIZE, hence yields no entry) instead of failing the query.
    if (bytes < SEGMENT_HEADER_SIZE) {
      return {
        database,
        dateNumber,
        sequence,
        segmentFilePath,
        indexFilePath,
        bytes,
        blockRegionEnd: bytes,
        sealed: false,
      };
    }
    requireSegmentHeader(this.store, segmentFilePath);

    // Sealed segment: the `.idx` length is the in-segment index region length -> Footer start = file end - index region - 16, allowing precise location and CRC verification
    const indexBytes = readFileBytesIfExists(indexFilePath);
    if (indexBytes !== null && bytes >= SEGMENT_HEADER_SIZE + SEGMENT_FOOTER_SIZE + indexBytes.length) {
      const footerStart = bytes - indexBytes.length - SEGMENT_FOOTER_SIZE;
      if (this.footerMatches(segmentFilePath, footerStart)) {
        return {
          database,
          dateNumber,
          sequence,
          segmentFilePath,
          indexFilePath,
          bytes,
          blockRegionEnd: footerStart,
          sealed: true,
        };
      }
    }

    // Active segment (no Footer yet) or untrusted `.idx`: the block region extends to the file end, and the block region end is detected by block scanning
    return {
      database,
      dateNumber,
      sequence,
      segmentFilePath,
      indexFilePath,
      bytes,
      blockRegionEnd: bytes,
      sealed: false,
    };
  }

  /** Verify the Footer CRC and `indexOffset` layout at `footerStart` (same scope as `parseSegmentFooter`) */
  private footerMatches(segmentFilePath: string, footerStart: number): boolean {
    try {
      const headerBytes = this.store.readSegmentSlice(segmentFilePath, 0, SEGMENT_HEADER_SIZE);
      const footerBytes = this.store.readSegmentSlice(segmentFilePath, footerStart, SEGMENT_FOOTER_SIZE);
      const view = new DataView(footerBytes.buffer, footerBytes.byteOffset, footerBytes.byteLength);
      const indexOffset = Number(view.getBigUint64(0, true));
      if (indexOffset !== footerStart + SEGMENT_FOOTER_SIZE) return false;
      return footerCrc32(headerBytes, indexOffset) === view.getUint32(8, true);
    } catch (error) {
      if (isRtdbError(error)) return false;
      throw error;
    }
  }

  /* ---------- Internals: index load and rebuild ---------- */

  /** Load index entries from the `.idx` mirror; returns null if the file is missing/length mismatch/Footer verification fails (falls back to rebuild) */
  private loadIndexEntriesFromMirror(descriptor: SegmentFileDescriptor): SegmentBlockIndexEntry[] | null {
    if (!descriptor.sealed) return null;
    const indexBytes = readFileBytesIfExists(descriptor.indexFilePath);
    if (indexBytes === null) return null;
    if (descriptor.bytes - descriptor.blockRegionEnd !== SEGMENT_FOOTER_SIZE + indexBytes.length) return null;
    try {
      return parseIndexRegion(indexBytes, 0, indexBytes.length);
    } catch (error) {
      if (isRtdbError(error)) return null;
      throw error;
    }
  }

  /** Rebuild the index by sequentially scanning blocks from `.seg` (fallback when `.idx` is missing/corrupt) */
  private rebuildIndexEntries(descriptor: SegmentFileDescriptor): SegmentBlockIndexEntry[] {
    const blocks = this.scanBlockHeaders(descriptor).headers;
    return blocks.map((block) => ({
      metricName: block.metricName,
      offset: block.offset,
      length: block.totalLength,
      pointCount: block.pointCount,
      timestampMin: block.timestampMin,
      timestampMax: block.timestampMax,
    }));
  }

  /** Single-block BlockData CRC re-check (reads only that block's bytes, no decode); any IO/out-of-bounds failure is treated as a mismatch */
  private blockDataCrcMatches(segmentFilePath: string, header: BlockHeader): boolean {
    try {
      const blockBytes = this.store.readSegmentSlice(segmentFilePath, header.offset, header.totalLength);
      const hasReceived = (header.flags & BLOCK_FLAG.receivedTime) !== 0;
      const dataEnd = hasReceived ? header.totalLength - 16 : header.totalLength;
      const dataOffset = dataEnd - header.timestampRawLength - header.valueRawLength;
      const timestampEncoded = blockBytes.subarray(dataOffset, dataOffset + header.timestampRawLength);
      const valueEncoded = blockBytes.subarray(dataOffset + header.timestampRawLength, dataEnd);
      if (hasReceived) {
        const receivedEncoded = blockBytes.subarray(dataEnd, header.totalLength);
        return blockDataCrc32WithReceived(timestampEncoded, valueEncoded, receivedEncoded) === header.crc32;
      }
      return blockDataCrc32(timestampEncoded, valueEncoded) === header.crc32;
    } catch (error) {
      if (isRtdbError(error)) return false;
      throw error;
    }
  }

  /**
   * Whether the `.idx` mirror matches "the actual block scan result + the sealed layout" (the mirror rebuild
   * criterion of the recovery path)
   *
   * Triple check: (1) the mirror length is exactly `file end - block region end - 16`; (2) the mirror is
   * parseable; (3) the entry count and every field are all equal entry by entry.
   */
  private indexMirrorMatches(
    descriptor: SegmentFileDescriptor,
    entries: readonly SegmentBlockIndexEntry[],
    blockRegionEnd: number,
  ): boolean {
    const indexBytes = readFileBytesIfExists(descriptor.indexFilePath);
    if (indexBytes === null) return false;
    if (descriptor.bytes - blockRegionEnd !== SEGMENT_FOOTER_SIZE + indexBytes.length) return false;

    let mirrorEntries: SegmentBlockIndexEntry[];
    try {
      mirrorEntries = parseIndexRegion(indexBytes, 0, indexBytes.length);
    } catch (error) {
      if (isRtdbError(error)) return false;
      throw error;
    }
    if (mirrorEntries.length !== entries.length) return false;
    for (let index = 0; index < entries.length; index += 1) {
      const expected = entries[index];
      const actual = mirrorEntries[index];
      if (
        actual.metricName !== expected.metricName ||
        actual.offset !== expected.offset ||
        actual.length !== expected.length ||
        actual.pointCount !== expected.pointCount ||
        actual.timestampMin !== expected.timestampMin ||
        actual.timestampMax !== expected.timestampMax
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Sequential block scan: read the 2B metricLen -> read the block header -> `tryParseBlockHeader`
   * verification; any illegal step is treated as the block region end
   *
   * Two pitfalls: (1) `tryParseBlockHeader`'s out-of-bounds check requires the block data to be in the
   * buffer too, so compute `totalLength` from the block header fields first and then read the whole block for
   * verification; (2) when `.idx` is missing, the block region end can only be detected by "block header
   * parse failure", and Footer bytes may be misjudged as a block header, so **probe for the Footer at every
   * block boundary first** (when `.idx` exists this probe never hits, at the cost of one extra small read).
   */
  private scanBlockHeaders(descriptor: SegmentFileDescriptor): { headers: BlockHeader[]; regionEnd: number } {
    const headers: BlockHeader[] = [];
    let offset = SEGMENT_HEADER_SIZE;
    while (offset + 2 <= descriptor.blockRegionEnd) {
      if (this.footerMatches(descriptor.segmentFilePath, offset)) return { headers, regionEnd: offset };

      const prefix = this.store.readSegmentSlice(descriptor.segmentFilePath, offset, 2);
      const metricLength = new DataView(prefix.buffer, prefix.byteOffset, 2).getUint16(0, true);
      if (metricLength < 1 || metricLength > 0xffff) break;

      const headerLength = metricLength + BLOCK_HEADER_FIXED_SIZE;
      if (offset + headerLength > descriptor.blockRegionEnd) break;
      const headerBytes = this.store.readSegmentSlice(descriptor.segmentFilePath, offset, headerLength);
      const headerView = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
      const fieldsOffset = 2 + metricLength;
      const timestampRawLength = headerView.getUint32(fieldsOffset + 7, true);
      const valueRawLength = headerView.getUint32(fieldsOffset + 11, true);
      const flags = headerView.getUint16(fieldsOffset + 31, true);
      const totalLength =
        headerLength + timestampRawLength + valueRawLength + ((flags & BLOCK_FLAG.receivedTime) !== 0 ? 16 : 0);
      if (offset + totalLength > descriptor.blockRegionEnd) break;

      const blockBytes = this.store.readSegmentSlice(descriptor.segmentFilePath, offset, totalLength);
      const header = tryParseBlockHeader(blockBytes, 0, totalLength);
      if (header === null) break;

      headers.push({ ...header, offset });
      offset += header.totalLength;
    }
    return { headers, regionEnd: offset };
  }

  /* ---------- Internals: block reads ---------- */

  /** Read and decode one block (return directly on a block cache hit; on a miss, read the block + verify BlockData CRC + decode the value type) */
  private readBlock(segmentFilePath: string, entry: SegmentBlockIndexEntry): DecodedBlock {
    const cacheKey = `${segmentFilePath}#${entry.offset}`;
    const cached = this.blockCache.get(cacheKey);
    if (cached !== undefined) {
      this.blockCache.delete(cacheKey);
      this.blockCache.set(cacheKey, cached);
      this.blockCacheHitTotal += 1;
      return cached;
    }
    this.blockCacheMissTotal += 1;

    const blockBytes = this.store.readSegmentSlice(segmentFilePath, entry.offset, entry.length);
    const header = tryParseBlockHeader(blockBytes, 0, blockBytes.length);
    if (header === null || header.totalLength !== blockBytes.length) {
      throw new RtdbError(
        ERROR_CODE.CorruptBlock,
        `Block header parse failed or length mismatch: ${segmentFilePath}@${entry.offset} (index length ${entry.length}B)`,
      );
    }
    if (header.pointCount !== entry.pointCount) {
      throw new RtdbError(
        ERROR_CODE.CorruptBlock,
        `Block header point count does not match the index: ${segmentFilePath}@${entry.offset} (block ${header.pointCount}, index ${entry.pointCount})`,
      );
    }

    const hasReceived = (header.flags & BLOCK_FLAG.receivedTime) !== 0;
    const dataEnd = hasReceived ? header.totalLength - 16 : header.totalLength;
    const dataOffset = dataEnd - header.timestampRawLength - header.valueRawLength;
    const timestampEncoded = blockBytes.subarray(dataOffset, dataOffset + header.timestampRawLength);
    const valueEncoded = blockBytes.subarray(dataOffset + header.timestampRawLength, dataEnd);
    if (hasReceived) {
      const receivedEncoded = blockBytes.subarray(dataEnd, header.totalLength);
      if (blockDataCrc32WithReceived(timestampEncoded, valueEncoded, receivedEncoded) !== header.crc32) {
        throw new RtdbError(
          ERROR_CODE.CorruptBlock,
          `Block data CRC verification failed: ${segmentFilePath}@${entry.offset} (metric=${header.metricName})`,
        );
      }
    } else if (blockDataCrc32(timestampEncoded, valueEncoded) !== header.crc32) {
      throw new RtdbError(
        ERROR_CODE.CorruptBlock,
        `Block data CRC verification failed: ${segmentFilePath}@${entry.offset} (metric=${header.metricName})`,
      );
    }

    const decodedTimestamps = decodeTimestamps(timestampEncoded, header.pointCount);
    const timestamps: number[] = new Array(header.pointCount);
    for (let index = 0; index < header.pointCount; index += 1) timestamps[index] = decodedTimestamps[index];

    const decoded = decodeValues(header.valueType, header.valueCodecId, valueEncoded, header.pointCount);
    const values = toPointValues(header.valueType, decoded, header.pointCount);

    const block: DecodedBlock = {
      metricName: header.metricName,
      valueType: header.valueType,
      timestamps,
      values,
      receivedMin: header.receivedMin,
      receivedMax: header.receivedMax,
    };
    this.blockCache.set(cacheKey, block);
    this.evictBlockCache();
    return block;
  }

  /** Block cache LRU eviction (evicts only the least recently used entries; the entry count is bounded by `cacheBlocks`) */
  private evictBlockCache(): void {
    while (this.blockCache.size > this.cacheBlocks) {
      const oldestKey = this.blockCache.keys().next();
      if (oldestKey.done === true) return;
      this.blockCache.delete(oldestKey.value);
    }
  }
}

/* ---------- Internal utilities ---------- */

/** Read file bytes; returns null if the file does not exist, other failures throw E_IO */
function readFileBytesIfExists(filePath: string): Uint8Array | null {
  try {
    const buffer = readFileSync(filePath);
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RtdbError(ERROR_CODE.Io, `Failed to read the file: ${filePath} (${(error as Error).message})`);
  }
}

/** Parse the segment header (the read side does not verify anything beyond the magic, reusing format's verification scope) */
function requireSegmentHeader(store: SegmentStore, segmentFilePath: string): SegmentHeader {
  return parseSegmentHeader(store.readSegmentSlice(segmentFilePath, 0, SEGMENT_HEADER_SIZE), 0);
}

/** Decoded container -> `Point['value']` (i64 -> bigint, bool -> boolean) */
function toPointValues(
  valueType: ValueType,
  decoded: ReturnType<typeof decodeValues>,
  count: number,
): Array<Point['value']> {
  const values = new Array<Point['value']>(count);
  switch (valueType) {
    case ValueType.Float64: {
      const source = decoded as Float64Array;
      for (let index = 0; index < count; index += 1) values[index] = source[index];
      return values;
    }
    case ValueType.Int64: {
      const source = decoded as BigInt64Array;
      for (let index = 0; index < count; index += 1) values[index] = source[index];
      return values;
    }
    case ValueType.Bool: {
      const source = decoded as Uint8Array;
      for (let index = 0; index < count; index += 1) values[index] = source[index] !== 0;
      return values;
    }
    case ValueType.String: {
      const source = decoded as string[];
      for (let index = 0; index < count; index += 1) values[index] = source[index];
      return values;
    }
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Unknown value type: ${String(valueType)}`);
  }
}
