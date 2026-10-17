// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * In-memory block index: metric → list of block header metadata (aligned with Detailed Design v1.6 §2.3)
 *
 * Responsibility: keep the parse result of "segment manifest → intra-segment index" resident in memory,
 * so queries can locate candidate blocks directly by metric and time range, avoiding re-reading the
 * `.idx` file on every query. The source of index entries is identical to `SegmentReader`:
 *   - Primary path: the `.idx` mirror of a sealed segment (loaded once)
 *   - Fallback: when `.idx` is missing/corrupt (including the active segment), `SegmentReader`
 *     rebuilds it by sequentially scanning blocks from `.seg`
 *
 * Structure: `Map<database, Map<metricName, BlockLocation[]>>`, entries sorted ascending by
 * `(timestampMin, offset)`, which naturally satisfies "block location = binary search for the first
 * timestampMax ≥ start, then a linear scan to timestampMin ≤ end".
 *
 * Consistency scope: loading is an **idempotent full rebuild** (`loadDatabase`); `loadSegment` is also
 * provided for incremental registration by the write path; when a segment is replaced/deleted (backfill,
 * backup restore, retention), it is invalidated via `evictDatabase`/`evictSegment` and reloaded.
 */

import {
  nextDayTimestampFromDateNumber,
  timestampFromDateNumber,
} from './format.ts';
import { ERROR_CODE, RtdbError } from './errors.ts';
import type { BlockLocation, SegmentReader } from './segment-reader.ts';

/* ---------- Public types ---------- */

export interface MemoryIndexOptions {
  /** Segment reader (delegates the segment manifest, `.idx` loading and block-scan rebuild entirely to it) */
  reader: SegmentReader;
}

/** Per-database index (metric → block location list) */
interface DatabaseBlockIndex {
  /** metric → block locations (ascending by `timestampMin`) */
  readonly metrics: Map<string, BlockLocation[]>;
  /** Cumulative block entry count */
  blockCount: number;
}

/* ---------- In-memory block index ---------- */

export class MemoryIndex {
  private readonly reader: SegmentReader;
  private readonly databases = new Map<string, DatabaseBlockIndex>();

  constructor(options: MemoryIndexOptions) {
    this.reader = options.reader;
  }

  /**
   * Full load (idempotent rebuild): scan all day directories and segments in the database, loading the
   * block index segment by segment
   *
   * Returns the cumulative block entry count.
   */
  loadDatabase(database: string): number {
    const metrics = new Map<string, BlockLocation[]>();
    let blockCount = 0;
    for (const descriptor of this.reader.listSegments(database)) {
      const entries = this.reader.loadIndexEntries(database, descriptor.dateNumber, descriptor.sequence);
      for (const entry of entries) {
        let locations = metrics.get(entry.metricName);
        if (locations === undefined) {
          locations = [];
          metrics.set(entry.metricName, locations);
        }
        locations.push({ database, segmentFilePath: descriptor.segmentFilePath, entry });
        blockCount += 1;
      }
    }
    for (const locations of metrics.values()) sortByTimestamp(locations);
    this.databases.set(database, { metrics, blockCount });
    return blockCount;
  }

  /**
   * Incrementally register a single segment (called by the write path after sealing/rolling): parse that
   * segment's block index and merge it into the existing index
   *
   * If the database is not yet loaded, do a full load first; a segment registered again is handled by
   * "remove the old entries of the same segment first, then add the new entries", keeping it idempotent.
   * Returns the block entry count contributed by this segment.
   */
  loadSegment(database: string, dateNumber: number, sequence: number): number {
    const index = this.databases.get(database) ?? this.loadAndGet(database);
    const descriptor = this.describeOneSegment(database, dateNumber, sequence);
    if (descriptor === null) {
      throw new RtdbError(
        ERROR_CODE.DatabaseNotFound,
        `Segment file does not exist; cannot register in the memory index: ${database}/${dateNumber}/${sequence}`,
      );
    }

    const entries = this.reader.loadIndexEntries(database, dateNumber, sequence);
    const affectedMetrics = new Set<string>();
    let added = 0;
    let removed = 0;
    for (const entry of entries) {
      let locations = index.metrics.get(entry.metricName);
      if (locations === undefined) {
        locations = [];
        index.metrics.set(entry.metricName, locations);
      }
      // Idempotent: remove the stale entries of this segment first, then add the new entries
      const staleIndex = locations.findIndex(
        (location) => location.segmentFilePath === descriptor.segmentFilePath,
      );
      if (staleIndex >= 0) {
        locations.splice(staleIndex, 1);
        removed += 1;
      }
      locations.push({ database, segmentFilePath: descriptor.segmentFilePath, entry });
      added += 1;
      affectedMetrics.add(entry.metricName);
    }
    for (const metricName of affectedMetrics) sortByTimestamp(index.metrics.get(metricName) ?? []);
    index.blockCount += added - removed;
    return added;
  }

  /** Whether the database is loaded */
  isLoaded(database: string): boolean {
    return this.databases.has(database);
  }

  /** Invalidate the whole-database index (called after a segment is deleted/replaced; auto-reloads on next access) */
  evictDatabase(database: string): void {
    this.databases.delete(database);
  }

  /** List of metric names of a loaded database (ascending) */
  metricNames(database: string): string[] {
    return [...this.ensureLoaded(database).metrics.keys()].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  }

  /** Total block entries of a loaded database */
  blockCount(database: string): number {
    return this.ensureLoaded(database).blockCount;
  }

  /** All block locations of a metric (ascending by `timestampMin`; returns an empty array for an unregistered metric) */
  blocksOf(database: string, metricName: string): readonly BlockLocation[] {
    return this.ensureLoaded(database).metrics.get(metricName) ?? [];
  }

  /**
   * Trim out candidate blocks by time range (blocks intersecting the range); results sorted ascending by
   * `timestampMin`
   *
   * Same scope as `SegmentReader.locateBlocks`, but performs **no file IO at all** (metadata is already
   * in memory).
   */
  queryBlocks(
    database: string,
    metricName: string,
    startTimestamp: number,
    endTimestamp: number,
  ): BlockLocation[] {
    const candidates = this.blocksOf(database, metricName);
    if (candidates.length === 0) return [];

    let low = 0;
    let high = candidates.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[middle].entry.timestampMax < startTimestamp) low = middle + 1;
      else high = middle;
    }

    const matched: BlockLocation[] = [];
    for (let index = low; index < candidates.length; index += 1) {
      const location = candidates[index];
      if (location.entry.timestampMin > endTimestamp) break;
      matched.push(location);
    }
    return matched;
  }

  /* ---------- Internals ---------- */

  /** Get the database index; if not loaded, do a full load first */
  private ensureLoaded(database: string): DatabaseBlockIndex {
    return this.databases.get(database) ?? this.loadAndGet(database);
  }

  private loadAndGet(database: string): DatabaseBlockIndex {
    this.loadDatabase(database);
    const index = this.databases.get(database);
    if (index === undefined) {
      throw new RtdbError(ERROR_CODE.Internal, `Memory index still missing after loading: ${database}`);
    }
    return index;
  }

  /** Locate a single segment descriptor (using the segment manifest's day-directory trimming, to avoid adding a store dependency just to get a path) */
  private describeOneSegment(
    database: string,
    dateNumber: number,
    sequence: number,
  ): { segmentFilePath: string } | null {
    const dayStart = timestampFromDateNumber(dateNumber);
    const dayEnd = nextDayTimestampFromDateNumber(dateNumber) - 1;
    for (const descriptor of this.reader.listSegments(database, dayStart, dayEnd)) {
      if (descriptor.sequence === sequence) return descriptor;
    }
    return null;
  }
}

/* ---------- Internal utilities ---------- */

/** Sort ascending by `(timestampMin, offset)`: guarantees the binary-search precondition; ties on the same start are stably ordered by physical order within the segment */
function sortByTimestamp(locations: BlockLocation[]): void {
  locations.sort((left, right) =>
    left.entry.timestampMin === right.entry.timestampMin
      ? left.entry.offset - right.entry.offset
      : left.entry.timestampMin - right.entry.timestampMin,
  );
}
