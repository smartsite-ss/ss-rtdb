// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Segment store: database directory / day directory / capacity segment lifecycle, capacity segment rolling,
 * cross-day rotation, segment file handle LRU (aligned with Detailed Design v1.6 §2.3, §2.5, §2.6)
 *
 * Two-level storage units (architecture design §3):
 *   - Day directory `{dataDir}/{database}/yyyyMMdd/`: retention / backup / corruption quarantine unit
 *     (deleting the whole directory = expiration)
 *   - Capacity segment `yyyyMMdd-NNN.seg`: physical IO / recovery unit; the 3-digit zero-padded sequence makes
 *     **lexicographic order = time order**
 *
 * Rolling scope (§2.5): **before** appending a block, test "current segment bytes + estimated block size >
 * segmentMaxBytes" -> seal this segment + create NNN+1.
 *   - **A block never splits across segments**: a soft limit, the segment tail may exceed a single block size
 *     at most; an empty segment (no block yet) does not roll, avoiding infinite rolling triggered by an
 *     oversized single block
 *   - Once the day's segment count reaches the format limit (`MAX_SEGMENT_SEQUENCE` = 999), stop rolling and
 *     keep appending to the current segment (rather exceed the soft limit than lose data)
 *
 * Cross-day rotation uses "pre-creation": when a write touches a new date, **synchronously** create the next
 * day's directory and new segment (mkdir + create, <1ms), and automatically seal the old segment (Footer +
 * `.idx` mirror), so the boundary is always complete when querying with day pruning.
 *
 * Responsibility boundary: this file only handles the **lifecycle of files and segments** (directory, segment
 * sequence, rolling, block append, seal, `.idx` mirror); data buffering and block triggering belong to
 * `segment-writer.ts`, block location and decode belong to `segment-reader.ts`.
 *
 * IO scope: all use `node:fs` **synchronous** primitives (unit-test determinism + no interleaving with the 5s
 * timer); the engine layer (§2.2) wraps async on top.
 * fsync only covers segment files and `.idx` themselves; parent directory entry persistence is out of M0
 * scope (§2.6 consistency point is borne by the WAL).
 */

import type { Dirent } from 'node:fs';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { ERROR_CODE, RtdbError, isRtdbError } from './errors.ts';
import {
  MAX_SEGMENT_SEQUENCE,
  SEGMENT_FOOTER_SIZE,
  createSegmentHeader,
  dateNumberFromTimestamp,
  encodeIndexRegion,
  encodeSegmentFooter,
  encodeSegmentHeader,
  formatDateFolderName,
  formatSegmentFileName,
  formatWalFileName,
  indexFileNameOfSegmentFileName,
  parseDateFolderName,
  parseSegmentFileName,
} from './format.ts';
import type { SegmentBlockIndexEntry } from './format.ts';
import { ENGINE_DEFAULTS, clampEngineOption } from './types.ts';

/* ---------- Constants ---------- */

/** Segment header flags field offset (aligned with the format.ts Header layout: 0x0A u16) */
const SEGMENT_HEADER_FLAGS_OFFSET = 0x0a;

/* ---------- Public types ---------- */

export interface SegmentStoreOptions {
  /** Data root directory (database directories are auto-created under it) */
  dataDir: string;
  /** Capacity segment soft limit (bytes, counts only `.seg`), default 200MB, clamped 16MB~4GB */
  segmentMaxBytes?: number;
  /** Single-day capacity segment count limit, default 1000, clamped 1~1000 and constrained by the format limit 999 */
  segmentMaxPerDay?: number;
  /** Segment file handle LRU entries (per segment), default 32, clamped 4~256 */
  cacheFdGroups?: number;
}

/** Active (unsealed) capacity segment handle: held by the store and returned to the write side */
export interface ActiveSegmentHandle {
  database: string;
  /** yyyyMMdd (local timezone scope) */
  dateNumber: number;
  sequence: number;
  fileName: string;
  filePath: string;
  /** Bytes written (including the 32B segment header; excludes Footer and in-segment index region before seal) */
  bytesWritten: number;
  /** Blocks appended (= in-segment index entries) */
  blockCount: number;
  /** Segment header bytes (for Footer CRC computation on seal) */
  headerBytes: Uint8Array;
  /** Write-side file handle (always pinned in the handle LRU, not subject to eviction) */
  fileDescriptor: number;
}

/** Segment acquisition reason: create / reuse / cross-day rotation / capacity segment rolling */
export const SEGMENT_OPEN_REASON = {
  created: 'created',
  appended: 'appended',
  dayRotated: 'day-rotated',
  sizeRolled: 'size-rolled',
} as const;
export type SegmentOpenReason = (typeof SEGMENT_OPEN_REASON)[keyof typeof SEGMENT_OPEN_REASON];

/** Block append metadata (index entry fields other than offset/length) */
export interface BlockAppendMetadata {
  metricName: string;
  pointCount: number;
  /** ms epoch */
  timestampMin: number;
  /** ms epoch */
  timestampMax: number;
}

export interface OpenedSegment {
  handle: ActiveSegmentHandle;
  reason: SegmentOpenReason;
  /** The previous segment auto-sealed during rotation (null for `created` / `appended`) */
  sealed: SealedSegment | null;
}

export interface SealedSegment {
  database: string;
  dateNumber: number;
  sequence: number;
  segmentFilePath: string;
  indexFilePath: string;
  /** Total byte count after seal (including Footer and in-segment index region) */
  bytes: number;
  /** In-segment index region start offset (= Footer start + `SEGMENT_FOOTER_SIZE`) */
  indexOffset: number;
  blockCount: number;
}

/* ---------- Internals: file handle LRU ---------- */

interface SegmentDescriptorEntry {
  fileDescriptor: number;
  /** Reference count: >0 means in use, not subject to LRU eviction */
  pinCount: number;
}

/**
 * Segment file handle LRU (per segment, `cacheFdGroups` entries)
 *
 * - The write side (active segment) is permanently pinned after acquire and **never evicted**; the read side
 *   uses acquire/release in pairs
 * - Eviction only happens on acquire / release, closing only the least recently used entry with a reference
 *   count of 0
 * - When all handles are pinned, a temporary overage is allowed (in-use handles are not closed; rather exceed
 *   the entry limit)
 */
class SegmentDescriptorCache {
  private readonly maxGroups: number;
  private readonly entries = new Map<string, SegmentDescriptorEntry>();

  constructor(maxGroups: number) {
    this.maxGroups = maxGroups;
  }

  /** Open (or reuse) a handle and increment the reference; `flags` takes effect only on the first open */
  acquire(filePath: string, flags: string): number {
    const existing = this.entries.get(filePath);
    if (existing !== undefined) {
      existing.pinCount += 1;
      this.touch(filePath, existing);
      return existing.fileDescriptor;
    }
    let fileDescriptor: number;
    try {
      fileDescriptor = openSync(filePath, flags);
    } catch (error) {
      throw toIoError(`Failed to open the segment file ${filePath}`, error);
    }
    this.entries.set(filePath, { fileDescriptor, pinCount: 1 });
    this.evictIfNeeded();
    return fileDescriptor;
  }

  /** Decrement the reference (the handle stays in the cache for LRU eviction) */
  release(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (entry === undefined || entry.pinCount === 0) {
      throw new RtdbError(ERROR_CODE.Internal, `Handle reference count is unbalanced: ${filePath}`);
    }
    entry.pinCount -= 1;
    this.evictIfNeeded();
  }

  /** Close immediately and remove from the cache (seal path: the segment can no longer be appended to) */
  closeAndForget(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (entry === undefined) return;
    this.entries.delete(filePath);
    closeSync(entry.fileDescriptor);
  }

  /** Current live handle count (including pinned ones) */
  get openCount(): number {
    return this.entries.size;
  }

  /**
   * Close and remove all **idle** handles "located under the specified directory" (forced release before
   * retention deletion / restore replacement)
   *
   * Handles currently referenced (active segment write side, segments being read) are left untouched; returns
   * the number closed.
   */
  closeUnder(directoryPrefix: string): number {
    let closed = 0;
    for (const [filePath, entry] of [...this.entries]) {
      if (entry.pinCount > 0) continue;
      if (!isPathUnder(filePath, directoryPrefix)) continue;
      this.entries.delete(filePath);
      closeSync(entry.fileDescriptor);
      closed += 1;
    }
    return closed;
  }

  closeAll(): void {
    for (const entry of this.entries.values()) {
      closeSync(entry.fileDescriptor);
    }
    this.entries.clear();
  }

  private touch(filePath: string, entry: SegmentDescriptorEntry): void {
    this.entries.delete(filePath);
    this.entries.set(filePath, entry);
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxGroups) return;
    for (const [filePath, entry] of this.entries) {
      if (this.entries.size <= this.maxGroups) break;
      if (entry.pinCount > 0) continue;
      this.entries.delete(filePath);
      closeSync(entry.fileDescriptor);
    }
  }
}

/* ---------- Segment store ---------- */

export class SegmentStore {
  /** Data root directory (absolute path) */
  readonly dataDir: string;
  /** Effective capacity segment soft limit (already clamped) */
  readonly segmentMaxBytes: number;
  /** Effective single-day segment count limit (already clamped and not exceeding the format limit 999) */
  readonly segmentMaxPerDay: number;
  /** Effective handle LRU entries (already clamped) */
  readonly cacheFdGroups: number;

  private readonly descriptorCache: SegmentDescriptorCache;
  private readonly activeSegments = new Map<string, ActiveSegmentHandle>();
  private readonly indexEntries = new Map<string, SegmentBlockIndexEntry[]>();

  constructor(options: SegmentStoreOptions) {
    this.dataDir = resolve(options.dataDir);
    this.segmentMaxBytes = clampEngineOption(
      'segmentMaxBytes',
      options.segmentMaxBytes ?? ENGINE_DEFAULTS.segmentMaxBytes,
    );
    this.segmentMaxPerDay = Math.min(
      clampEngineOption('segmentMaxPerDay', options.segmentMaxPerDay ?? ENGINE_DEFAULTS.segmentMaxPerDay),
      MAX_SEGMENT_SEQUENCE,
    );
    this.cacheFdGroups = clampEngineOption(
      'cacheFdGroups',
      options.cacheFdGroups ?? ENGINE_DEFAULTS.cacheFdGroups,
    );
    this.descriptorCache = new SegmentDescriptorCache(this.cacheFdGroups);
  }

  /* ---------- Directories and paths ---------- */

  /** Database directory: `{dataDir}/{database}` */
  databaseDirectoryPath(database: string): string {
    return join(this.dataDir, database);
  }

  /** Ensure the database directory exists (writes auto-create databases, §6.2.2) */
  ensureDatabase(database: string): void {
    try {
      mkdirSync(this.databaseDirectoryPath(database), { recursive: true });
    } catch (error) {
      throw toIoError(`Failed to create the database directory ${this.databaseDirectoryPath(database)}`, error);
    }
  }

  /** Day directory: `{dataDir}/{database}/yyyyMMdd` */
  dayDirectoryPath(database: string, dateNumber: number): string {
    return join(this.databaseDirectoryPath(database), formatDateFolderName(dateNumber));
  }

  ensureDayDirectory(database: string, dateNumber: number): void {
    try {
      mkdirSync(this.dayDirectoryPath(database, dateNumber), { recursive: true });
    } catch (error) {
      throw toIoError(`Failed to create the day directory ${this.dayDirectoryPath(database, dateNumber)}`, error);
    }
  }

  /** Capacity segment file path: `{day directory}/yyyyMMdd-NNN.seg` */
  segmentFilePath(database: string, dateNumber: number, sequence: number): string {
    return join(this.dayDirectoryPath(database, dateNumber), formatSegmentFileName(dateNumber, sequence));
  }

  /** Segment index mirror path: `{day directory}/yyyyMMdd-NNN.idx` */
  indexFilePathOfSegment(database: string, dateNumber: number, sequence: number): string {
    return join(
      this.dayDirectoryPath(database, dateNumber),
      indexFileNameOfSegmentFileName(formatSegmentFileName(dateNumber, sequence)),
    );
  }

  /** The day's WAL path: `{day directory}/yyyyMMdd.wal` */
  walFilePath(database: string, dateNumber: number): string {
    return join(this.dayDirectoryPath(database, dateNumber), formatWalFileName(dateNumber));
  }

  /**
   * Database names under the data root (ascending); returns an empty array if the directory does not exist
   *
   * Scope: **subdirectories** of the root directory whose names are not valid day directory names
   * (`yyyyMMdd`) are treated as database directories — day directories only appear inside database
   * directories, so this test does not conflict with day directories; hence **a database name cannot be an
   * 8-digit date string like `yyyyMMdd`**.
   */
  listDatabases(): string[] {
    const names: string[] = [];
    for (const entry of listDirectoryEntries(this.dataDir)) {
      if (!entry.isDirectory()) continue;
      if (parseDateFolderName(entry.name) !== null) continue;
      names.push(entry.name);
    }
    return names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  /** Existing day directories within a database (ascending); returns an empty array if the database directory does not exist */
  listDayDirectories(database: string): number[] {
    const directoryPath = this.databaseDirectoryPath(database);
    const dateNumbers: number[] = [];
    for (const entry of listDirectoryEntries(directoryPath)) {
      if (!entry.isDirectory()) continue;
      const dateNumber = parseDateFolderName(entry.name);
      if (dateNumber !== null) dateNumbers.push(dateNumber);
    }
    return dateNumbers.sort((left, right) => left - right);
  }

  /** Existing capacity segment sequences within a day directory (ascending = time order); returns an empty array if the directory does not exist */
  listSegmentSequences(database: string, dateNumber: number): number[] {
    const sequences: number[] = [];
    for (const entry of listDirectoryEntries(this.dayDirectoryPath(database, dateNumber))) {
      if (!entry.isFile()) continue;
      const parsed = parseSegmentFileName(entry.name);
      if (parsed === null || parsed.dateNumber !== dateNumber) continue;
      sequences.push(parsed.sequence);
    }
    return sequences.sort((left, right) => left - right);
  }

  /**
   * Total bytes occupied by a day directory's files (`.seg` + `.idx` + `.wal`; a missing directory returns 0)
   *
   * Purpose: report `status.segments.bytesToday` without a full-tree walk (only today's directory is measured).
   */
  measureDayDirectoryBytes(database: string, dateNumber: number): number {
    let totalBytes = 0;
    for (const entry of listDirectoryEntries(this.dayDirectoryPath(database, dateNumber))) {
      if (!entry.isFile()) continue;
      try {
        totalBytes += statSync(join(this.dayDirectoryPath(database, dateNumber), entry.name)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw toIoError(`Failed to read the file size under the day directory`, error);
      }
    }
    return totalBytes;
  }

  /** Next available segment sequence (largest existing sequence + 1; 1 if none) */
  nextSegmentSequence(database: string, dateNumber: number): number {
    const sequences = this.listSegmentSequences(database, dateNumber);
    const sequence = sequences.length === 0 ? 1 : sequences[sequences.length - 1] + 1;
    if (sequence > MAX_SEGMENT_SEQUENCE) {
      throw new RtdbError(
        ERROR_CODE.CorruptSegment,
        `The capacity segments for date ${dateNumber} have reached the format limit ${MAX_SEGMENT_SEQUENCE}; cannot create a new segment`,
      );
    }
    return sequence;
  }

  /* ---------- Active segment and rolling ---------- */

  /** Current active (unsealed) segment; returns null if not open */
  getActiveSegment(database: string): ActiveSegmentHandle | null {
    return this.activeSegments.get(database) ?? null;
  }

  /**
   * Get the database's active segment (create / cross-day rotate / capacity segment roll if needed).
   *
   * `estimatedBlockBytes` is the byte count of the "about-to-append block" (exactly known from the encoded
   * block length); when a rotation occurs, the old segment is **auto-sealed** by this method (Footer +
   * in-segment index region + fsync + `.idx` mirror).
   */
  openActiveSegment(database: string, timestampMs: number, estimatedBlockBytes = 0): OpenedSegment {
    const dateNumber = dateNumberFromTimestamp(timestampMs);
    const active = this.activeSegments.get(database) ?? null;

    if (active === null) {
      return {
        handle: this.createSegment(database, dateNumber, this.nextSegmentSequence(database, dateNumber)),
        reason: SEGMENT_OPEN_REASON.created,
        sealed: null,
      };
    }

    if (active.dateNumber !== dateNumber) {
      const sealed = this.sealActiveSegment(database);
      return {
        handle: this.createSegment(database, dateNumber, this.nextSegmentSequence(database, dateNumber)),
        reason: SEGMENT_OPEN_REASON.dayRotated,
        sealed,
      };
    }

    if (this.shouldRoll(active, estimatedBlockBytes)) {
      const sealed = this.sealActiveSegment(database);
      return {
        handle: this.createSegment(database, dateNumber, active.sequence + 1),
        reason: SEGMENT_OPEN_REASON.sizeRolled,
        sealed,
      };
    }

    return { handle: active, reason: SEGMENT_OPEN_REASON.appended, sealed: null };
  }

  /** Capacity segment rolling criterion (tested **before** appending a block; `estimatedBlockBytes` is the byte count of the about-to-append block) */
  shouldRoll(handle: ActiveSegmentHandle, estimatedBlockBytes: number): boolean {
    // An empty segment does not roll: a block never splits across segments, and an oversized single block merely exceeds the soft limit, avoiding the "roll immediately after creation" infinite loop
    if (handle.blockCount === 0) return false;
    // Single-day segment count limit reached: stop rolling, keep appending to the current segment (no data loss)
    if (handle.sequence >= this.segmentMaxPerDay) return false;
    return handle.bytesWritten + estimatedBlockBytes > this.segmentMaxBytes;
  }

  /** Create a new capacity segment: exclusive create (`wx+`) + write 32B segment header + fsync; the handle stays pinned */
  createSegment(database: string, dateNumber: number, sequence: number): ActiveSegmentHandle {
    if (this.activeSegments.has(database)) {
      throw new RtdbError(ERROR_CODE.Internal, `Database ${database} already has an active segment; seal it before creating a new one`);
    }
    this.ensureDayDirectory(database, dateNumber);

    const fileName = formatSegmentFileName(dateNumber, sequence);
    const filePath = join(this.dayDirectoryPath(database, dateNumber), fileName);
    const headerBytes = encodeSegmentHeader(createSegmentHeader(dateNumber, Date.now()));

    const fileDescriptor = this.descriptorCache.acquire(filePath, 'wx+');
    try {
      writeAll(fileDescriptor, headerBytes, 0, filePath);
      fsyncSync(fileDescriptor);
    } catch (error) {
      this.descriptorCache.closeAndForget(filePath);
      throw error;
    }

    const handle: ActiveSegmentHandle = {
      database,
      dateNumber,
      sequence,
      fileName,
      filePath,
      bytesWritten: headerBytes.length,
      blockCount: 0,
      headerBytes,
      fileDescriptor,
    };
    this.activeSegments.set(database, handle);
    this.indexEntries.set(database, []);
    return handle;
  }

  /**
   * Set the active segment header `flags` (bitwise OR, idempotent): the in-memory `headerBytes` and the on-disk
   * u16 at 0x0A are updated in sync.
   *
   * The write side calls this after appending a block with zlib whole-block wrapping
   * (`SEGMENT_HEADER_FLAG.zlibBlock`).
   * **The in-memory header must be updated in sync**: on seal the Footer CRC covers the in-memory
   * `headerBytes`, and an inconsistency with the on-disk header would make the read side's verification fail.
   */
  setSegmentHeaderFlag(database: string, flag: number): void {
    const handle = this.activeSegments.get(database);
    if (handle === undefined) {
      throw new RtdbError(ERROR_CODE.Internal, `Database ${database} has no active segment; cannot set the segment header flags`);
    }
    const view = new DataView(
      handle.headerBytes.buffer,
      handle.headerBytes.byteOffset,
      handle.headerBytes.byteLength,
    );
    const currentFlags = view.getUint16(SEGMENT_HEADER_FLAGS_OFFSET, true);
    const nextFlags = (currentFlags | flag) & 0xffff;
    if (nextFlags === currentFlags) return;

    view.setUint16(SEGMENT_HEADER_FLAGS_OFFSET, nextFlags, true);
    writeAll(
      handle.fileDescriptor,
      handle.headerBytes.subarray(SEGMENT_HEADER_FLAGS_OFFSET, SEGMENT_HEADER_FLAGS_OFFSET + 2),
      SEGMENT_HEADER_FLAGS_OFFSET,
      handle.filePath,
    );
  }

  /**
   * Append a complete block (block header ++ block data) and register the in-segment index entry; returns the
   * block's absolute start offset.
   *
   * The caller (segment-writer) must **first** obtain the target segment via `openActiveSegment` and complete
   * the rolling decision.
   */
  appendBlock(database: string, blockBytes: Uint8Array, metadata: BlockAppendMetadata): number {
    const handle = this.activeSegments.get(database);
    if (handle === undefined) {
      throw new RtdbError(ERROR_CODE.Internal, `Database ${database} has no active segment; cannot append a block`);
    }
    const offset = handle.bytesWritten;
    writeAll(handle.fileDescriptor, blockBytes, offset, handle.filePath);
    handle.bytesWritten += blockBytes.length;
    handle.blockCount += 1;
    this.requireIndexEntries(database).push({
      metricName: metadata.metricName,
      offset,
      length: blockBytes.length,
      pointCount: metadata.pointCount,
      timestampMin: metadata.timestampMin,
      timestampMax: metadata.timestampMax,
    });
    return offset;
  }

  /**
   * Flush the active segment's appended blocks to stable storage (`fsync`), so the write-ahead log may
   * safely release those points.
   *
   * Durability ordering: block bytes reach the OS page cache with `writeAll`; only after `fsync` is the
   * segment's copy durable. The WAL is truncated to the safe point **after** this call returns (engine: block
   * append -> segment fsync -> safe point), so the "points not yet in a segment" invariant never leaves the
   * newest block with page-cache-only copies across a power loss.
   *
   * Returns `false` when the database has no active segment (nothing was appended yet / just sealed).
   */
  fsyncActiveSegment(database: string): boolean {
    const handle = this.activeSegments.get(database);
    if (handle === undefined) return false;
    fsyncSync(handle.fileDescriptor);
    return true;
  }

  /**
   * Seal the active segment: append Footer + in-segment index region -> fsync -> close the write-side handle ->
   * atomically rewrite the `.idx` mirror.
   *
   * After sealing, the segment can no longer be appended to (immutable, satisfying the "copy it out = backup"
   * semantics); returns null if there is no active segment.
   */
  sealActiveSegment(database: string): SealedSegment | null {
    const handle = this.activeSegments.get(database);
    if (handle === undefined) return null;

    const entries = this.indexEntries.get(database) ?? [];
    if (entries.length !== handle.blockCount) {
      throw new RtdbError(
        ERROR_CODE.Internal,
        `Segment index entry count does not match the block count: database ${database} segment ${handle.fileName} (entries ${entries.length}, blocks ${handle.blockCount})`,
      );
    }

    const footerStart = handle.bytesWritten;
    const indexOffset = footerStart + SEGMENT_FOOTER_SIZE;
    const footerBytes = encodeSegmentFooter(handle.headerBytes, indexOffset);
    const indexRegionBytes = encodeIndexRegion(entries);
    writeAll(handle.fileDescriptor, footerBytes, footerStart, handle.filePath);
    writeAll(handle.fileDescriptor, indexRegionBytes, indexOffset, handle.filePath);
    fsyncSync(handle.fileDescriptor);
    this.descriptorCache.closeAndForget(handle.filePath);

    this.activeSegments.delete(database);
    this.indexEntries.delete(database);

    const indexFilePath = this.indexFilePathOfSegment(database, handle.dateNumber, handle.sequence);
    writeIndexFileAtomic(indexFilePath, indexRegionBytes);

    return {
      database,
      dateNumber: handle.dateNumber,
      sequence: handle.sequence,
      segmentFilePath: handle.filePath,
      indexFilePath,
      bytes: indexOffset + indexRegionBytes.length,
      indexOffset,
      blockCount: handle.blockCount,
    };
  }

  /** Seal all active segments (engine `close()` path); returns the list of seal results */
  sealAll(): SealedSegment[] {
    const sealed: SealedSegment[] = [];
    for (const database of [...this.activeSegments.keys()]) {
      const result = this.sealActiveSegment(database);
      if (result !== null) sealed.push(result);
    }
    return sealed;
  }

  /** Close: seal all active segments + release all handles (idempotent) */
  close(): SealedSegment[] {
    const sealed = this.sealAll();
    this.descriptorCache.closeAll();
    return sealed;
  }

  /* ---------- Read side ---------- */

  /** Segment file byte count; returns null if the file does not exist */
  segmentFileBytes(segmentFilePath: string): number | null {
    try {
      return statSync(segmentFilePath).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw toIoError(`Failed to read the segment file size ${segmentFilePath}`, error);
    }
  }

  /** Whether the segment file already exists */
  segmentFileExists(segmentFilePath: string): boolean {
    return this.segmentFileBytes(segmentFilePath) !== null;
  }

  /**
   * Read a segment file slice at an absolute offset (goes through the read-side handle LRU and auto-releases
   * after use)
   *
   * Throws E_CORRUPT_SEGMENT when the read length is insufficient (out of bounds / file truncated), for
   * half-block truncation and corruption quarantine decisions.
   */
  readSegmentSlice(segmentFilePath: string, position: number, length: number): Uint8Array {
    if (length < 0 || position < 0) {
      throw new RtdbError(
        ERROR_CODE.Internal,
        `Segment file read parameters out of bounds: position=${position}, length=${length}`,
      );
    }
    const out = new Uint8Array(length);
    if (length === 0) return out;

    const fileDescriptor = this.descriptorCache.acquire(segmentFilePath, 'r');
    try {
      let read = 0;
      while (read < length) {
        const chunk = readSync(fileDescriptor, out, read, length - read, position + read);
        if (chunk <= 0) {
          throw new RtdbError(
            ERROR_CODE.CorruptSegment,
            `Segment file read insufficient: ${segmentFilePath} (position=${position + read}, expected ${length - read}B)`,
          );
        }
        read += chunk;
      }
      return out;
    } finally {
      this.descriptorCache.release(segmentFilePath);
    }
  }

  /** Current live segment handle count (including the active segment write-side handle), for handle LRU unit tests and status output */
  get openDescriptorCount(): number {
    return this.descriptorCache.openCount;
  }

  /**
   * Close all idle segment handles "located under the specified directory" (forced release before retention
   * day directory deletion / restore database directory replacement)
   *
   * On Windows an opened file's directory entry cannot be deleted, so it must be released before delete/replace;
   * handles in use are left untouched, and the caller must first ensure there is no active segment under that
   * directory. Returns the number of closed handles.
   */
  closeDescriptorsUnder(directoryPath: string): number {
    return this.descriptorCache.closeUnder(resolve(directoryPath));
  }

  /**
   * Atomically rewrite a segment's `.idx` mirror (recovery path only: rebuilt by the recovery flow when the
   * mirror is missing/inconsistent with the actual block region)
   *
   * Shares the same atomic-write implementation as the seal path (tmp + fsync + rename); returns the mirror
   * file path.
   */
  writeIndexMirror(
    database: string,
    dateNumber: number,
    sequence: number,
    entries: readonly SegmentBlockIndexEntry[],
  ): string {
    const indexFilePath = this.indexFilePathOfSegment(database, dateNumber, sequence);
    writeIndexFileAtomic(indexFilePath, encodeIndexRegion(entries));
    return indexFilePath;
  }

  /* ---------- Internals ---------- */

  private requireIndexEntries(database: string): SegmentBlockIndexEntry[] {
    const entries = this.indexEntries.get(database);
    if (entries === undefined) {
      throw new RtdbError(ERROR_CODE.Internal, `Database ${database} has no active segment index region; cannot register a block`);
    }
    return entries;
  }
}

/* ---------- Internal utilities ---------- */

/** Whether the path is located **under** the specified directory (strict subpath; the directory itself returns false) */
function isPathUnder(filePath: string, directoryPrefix: string): boolean {
  const prefix = directoryPrefix.endsWith(sep) ? directoryPrefix : `${directoryPrefix}${sep}`;
  return filePath.startsWith(prefix);
}

/** Directory entry enumeration: a missing directory returns an empty array; other failures throw E_IO */
function listDirectoryEntries(directoryPath: string): Dirent[] {
  try {
    return readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw toIoError(`Failed to read the directory ${directoryPath}`, error);
  }
}

/** Write the whole byte sequence at the specified offset (`writeSync` may advance in chunks; loop until done) */
function writeAll(fileDescriptor: number, bytes: Uint8Array, position: number, filePath: string): void {
  let written = 0;
  while (written < bytes.length) {
    let chunk: number;
    try {
      chunk = writeSync(fileDescriptor, bytes, written, bytes.length - written, position + written);
    } catch (error) {
      throw toIoError(`Failed to write the segment file ${filePath}`, error);
    }
    if (chunk <= 0) {
      throw new RtdbError(
        ERROR_CODE.Io,
        `Segment file write made no progress: ${filePath} (position=${position + written})`,
      );
    }
    written += chunk;
  }
}

/** `.idx` mirror atomic rewrite: write a temporary file -> fsync -> rename over it (rename within the same directory is atomic) */
function writeIndexFileAtomic(indexFilePath: string, indexRegionBytes: Uint8Array): void {
  const temporaryFilePath = `${indexFilePath}.tmp`;
  try {
    const fileDescriptor = openSync(temporaryFilePath, 'w');
    try {
      writeAll(fileDescriptor, indexRegionBytes, 0, temporaryFilePath);
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    renameSync(temporaryFilePath, indexFilePath);
  } catch (error) {
    try {
      unlinkSync(temporaryFilePath);
    } catch {
      // Cleanup failure does not affect the main flow (the temporary file will not match the segment/index naming, so scanners naturally ignore it)
    }
    throw toIoError(`Failed to atomically write the index file ${indexFilePath}`, error);
  }
}

/** Uniformly map an underlying IO exception to E_IO (an RtdbError is thrown as-is) */
function toIoError(action: string, error: unknown): RtdbError {
  if (isRtdbError(error)) return error;
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  return new RtdbError(ERROR_CODE.Io, `${action}: ${code === undefined ? message : `${code} ${message}`}`);
}
