// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Write-ahead log (WAL): JSONL append + group fsync + safe-point truncation (aligned with Detailed
 * Design v1.7 §2.5, §2.6)
 *
 * Consistency point: a successful WAL append (or, with `fsyncPolicy='wal'`, after it has landed on disk)
 * means "recoverable after a power loss from here on"; data already flushed to segments is released on
 * the next truncation — so the WAL only carries points **not yet persisted to segments**.
 *
 * Line format (one line each, terminated by `\n`; metric names forbid newlines and NUL, so JSONL is
 * naturally safe):
 *   `{"m":"metric","t":1699999999999,"v":1.5}`            f64 / bool / string
 *   `{"m":"metric","t":1699999999999,"v":"12345678901","vt":2}`   i64 (JSON has no BigInt; the value is
 *   written as decimal text)
 *   A non-zero quality adds `"q":n` (the M0 write path rejects non-zero, so this usually does not appear)
 *
 * Batches and safe points: `append` treats "one call = one batch" as its unit, returning a `batchId` plus
 * the on-disk offset ranges within each day's file; the caller invokes `completeBatch(batchId)` after all
 * points of the batch have been flushed into segments, then calls `commitSafePoint()` — the truncation
 * position = **the start of the earliest incomplete batch** (or, if there is no incomplete batch, the
 * entire file is cleared). Truncation uses either "clear the whole file (path truncation `truncateSync`)"
 * or "atomic tail rewrite (tmp + fsync + rename, then reopen the append handle)", guaranteeing that a
 * power loss during truncation cannot corrupt the retained region.
 *
 * "Adopted batch" (`WAL_ADOPTED_BATCH_ID`): if the day's WAL already has content on open (leftover from a
 * previous crash), it is registered wholesale as one incomplete batch, so the instance that takes over and
 * continues writing advances the safe point correctly (otherwise the leftover lines would never be released).
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeSync } from 'node:fs';

import { ERROR_CODE, RtdbError, isRtdbError } from './errors.ts';
import { dateNumberFromTimestamp } from './format.ts';
import type { SegmentStore } from './segment-store.ts';
import { ValueType } from './types.ts';
import type { Point, WritePoint } from './types.ts';

/* ---------- Constants ---------- */

/** Adopted batch id (the batch the pre-existing WAL content belongs to on open; the caller advances it normally with `completeBatch`) */
export const WAL_ADOPTED_BATCH_ID = 0;

/** WAL line separator */
const LINE_SEPARATOR = 0x0a;

/** In-line i64 marker field name (value type field) */
const WAL_VALUE_TYPE_FIELD = 'vt';

/** Shared UTF-8 codecs */
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/* ---------- Public types ---------- */

export interface WriteAheadLogOptions {
  /** Segment store (only uses its directory/path scope and database-name scope) */
  store: SegmentStore;
  /** Target database name */
  database: string;
  /** When false, all writes are no-ops (only batch ids are counted), for "reloadable scenarios"; default true */
  enabled?: boolean;
  /** Default `'wal'`: per-batch group fsync; `'none'` does no fsync (only for reloadable scenarios) */
  fsyncPolicy?: 'wal' | 'none';
  /** Whether to register pre-existing WAL content as an "adopted batch" on open; default true */
  adoptExistingLines?: boolean;
}

/** The on-disk range of a batch within a day's WAL file (offsets are byte offsets within the file) */
export interface WalFileRange {
  dateNumber: number;
  startOffset: number;
  endOffset: number;
}

export interface WalAppendReceipt {
  batchId: number;
  pointCount: number;
  /** Whether this batch has been fsynced (`fsyncPolicy='none'` / WAL disabled / empty batch are always false) */
  synced: boolean;
  /** On-disk file ranges of this batch (a batch crossing midnight may span two day files; empty when WAL is disabled) */
  fileRanges: WalFileRange[];
}

export interface WalTruncationResult {
  /** Bytes released (truncated off) this time */
  releasedBytes: number;
  /** Bytes still retained after truncation (= the byte volume of incomplete batches) */
  remainingBytes: number;
  /** Number of files that were truncated */
  filesTruncated: number;
}

/** Replay entry (WAL line parse result) */
export interface WalEntry {
  metricName: string;
  /** ms epoch */
  timestamp: number;
  value: Point['value'];
  quality: number;
}

export interface WalReadReport {
  dateNumber: number;
  walFilePath: string;
  /** Entries parsed from complete lines (write order) */
  entries: WalEntry[];
  /** Byte count covered by complete lines (the retention boundary for `repairWalFileTail`) */
  validBytes: number;
  /** Byte count of the trailing partial line (a half line from a power loss without a trailing `\n`) */
  discardedTailBytes: number;
  fileBytes: number;
}

/* ---------- WAL ---------- */

interface WalBatchRecord {
  batchId: number;
  startOffset: number;
  endOffset: number;
  completed: boolean;
}

interface WalFileState {
  dateNumber: number;
  filePath: string;
  fileDescriptor: number;
  /** Current physical byte count */
  bytes: number;
  /** Batch ranges in write order (contiguously arranged from the start of the file) */
  records: WalBatchRecord[];
}

export class WriteAheadLog {
  readonly store: SegmentStore;
  readonly database: string;
  readonly enabled: boolean;
  readonly fsyncPolicy: 'wal' | 'none';

  private readonly files = new Map<number, WalFileState>();
  private nextBatchId = WAL_ADOPTED_BATCH_ID + 1;
  /** Epoch ms of the last group fsync (0 = no fsync yet; stays 0 when `fsyncPolicy != 'wal'`) */
  private lastFsyncEpochMs = 0;

  constructor(options: WriteAheadLogOptions) {
    this.store = options.store;
    this.database = options.database;
    this.enabled = options.enabled ?? true;
    this.fsyncPolicy = options.fsyncPolicy ?? 'wal';
    if (this.enabled && (options.adoptExistingLines ?? true)) this.adoptExistingFiles();
  }

  /* ---------- Write entry points ---------- */

  /**
   * Append a batch of points (group fsync: each day file touched by this batch is fsynced only once)
   *
   * Precondition: the points have already passed write-path validation (metric name / timestamp / value
   * type); the WAL does not re-validate.
   * Returns a batch receipt; the caller invokes `completeBatch(receipt.batchId)` after all points of the
   * batch have been persisted to segments.
   */
  append(points: readonly WritePoint[]): WalAppendReceipt {
    const receipt: WalAppendReceipt = {
      batchId: this.nextBatchId,
      pointCount: points.length,
      synced: false,
      fileRanges: [],
    };
    this.nextBatchId += 1;
    if (!this.enabled || points.length === 0) return receipt;

    // Group by day (a batch crossing midnight lands in two WAL files at once; the same batch still fsyncs each file only once)
    const lineGroups = new Map<number, string[]>();
    for (const point of points) {
      const dateNumber = dateNumberFromTimestamp(point.timestamp);
      const lines = lineGroups.get(dateNumber);
      if (lines === undefined) lineGroups.set(dateNumber, [encodeWalLine(point)]);
      else lines.push(encodeWalLine(point));
    }

    const touched: WalFileState[] = [];
    for (const [dateNumber, lines] of lineGroups) {
      const state = this.requireFileState(dateNumber);
      const bytes = UTF8_ENCODER.encode(lines.join(''));
      const startOffset = state.bytes;
      writeAppend(state.fileDescriptor, bytes, state.filePath);
      state.bytes += bytes.length;
      state.records.push({
        batchId: receipt.batchId,
        startOffset,
        endOffset: state.bytes,
        completed: false,
      });
      receipt.fileRanges.push({ dateNumber, startOffset, endOffset: state.bytes });
      touched.push(state);
    }

    if (this.fsyncPolicy === 'wal') {
      for (const state of touched) syncFile(state.fileDescriptor, state.filePath);
      receipt.synced = true;
      this.lastFsyncEpochMs = Date.now();
    }
    return receipt;
  }

  /**
   * Mark a batch as fully flushed into segments (eligible for truncation); an unknown batch id returns 0
   * silently (the recovery-time ledger may not contain that batch)
   *
   * Returns the number of ranges marked (2 for a batch crossing midnight).
   */
  completeBatch(batchId: number): number {
    let marked = 0;
    for (const state of this.files.values()) {
      for (const record of state.records) {
        if (record.batchId !== batchId || record.completed) continue;
        record.completed = true;
        marked += 1;
      }
    }
    return marked;
  }

  /**
   * Advance the safe point and truncate as needed (each day file is determined independently)
   *
   * Truncation position = **the start of the earliest incomplete batch** in that file; if there is no
   * incomplete batch, the whole file is cleared (its content has all been persisted to segments).
   */
  commitSafePoint(): WalTruncationResult {
    let releasedBytes = 0;
    let remainingBytes = 0;
    let filesTruncated = 0;
    for (const state of this.files.values()) {
      const firstUncompleted = state.records.find((record) => !record.completed);
      const targetBytes = firstUncompleted === undefined ? 0 : firstUncompleted.startOffset;
      const released = this.truncateFileTo(state, targetBytes);
      if (released > 0) filesTruncated += 1;
      releasedBytes += released;
      remainingBytes += state.bytes;
    }
    return { releasedBytes, remainingBytes, filesTruncated };
  }

  /* ---------- Status readings ---------- */

  /** Batch ids not yet completed (not flushed to segments), including the adopted batch, ascending */
  get outstandingBatchIds(): number[] {
    const ids = new Set<number>();
    for (const state of this.files.values()) {
      for (const record of state.records) {
        if (!record.completed) ids.add(record.batchId);
      }
    }
    return [...ids].sort((left, right) => left - right);
  }

  /** Current bytes occupied by the WAL (= the unreleased part, the sum over day files) */
  get pendingBytes(): number {
    let total = 0;
    for (const state of this.files.values()) total += state.bytes;
    return total;
  }

  /** Number of day files with open handles */
  get openFileCount(): number {
    return this.files.size;
  }

  /** Total number of batches issued (including the adopted batch and empty batches) */
  get issuedBatchCount(): number {
    return this.nextBatchId;
  }

  /** Epoch ms of the last WAL group fsync (0 = no fsync yet; always 0 when `fsyncPolicy != 'wal'`) */
  get lastFsyncMs(): number {
    return this.lastFsyncEpochMs;
  }

  /** Close: fsync + close all day file handles (idempotent; this instance cannot be used again after this call) */
  close(): void {
    for (const state of this.files.values()) {
      try {
        if (this.fsyncPolicy === 'wal') syncFile(state.fileDescriptor, state.filePath);
      } finally {
        closeSync(state.fileDescriptor);
      }
    }
    this.files.clear();
  }

  /**
   * Release a day's WAL file handle and remove it from the ledger (called when that day's data has all
   * been persisted to segments; the next append reopens it automatically)
   *
   * Purpose: the retention policy **must release the handle before** deleting the entire day directory —
   * on Windows a directory entry cannot be deleted for an open file.
   * Precondition: that day's file has passed the safe point (0 bytes and no incomplete batch); otherwise
   * throws `E_INTERNAL` (a caller logic bug).
   * Returns whether that day's file existed and was released.
   */
  releaseCommittedDayFile(dateNumber: number): boolean {
    const state = this.files.get(dateNumber);
    if (state === undefined) return false;
    const hasUncompleted = state.records.some((record) => !record.completed);
    if (state.bytes !== 0 || hasUncompleted) {
      throw new RtdbError(
        ERROR_CODE.Internal,
        `Refusing to release a non-empty WAL day file: ${state.filePath} (bytes=${state.bytes}, hasUncompletedBatch=${hasUncompleted})`,
      );
    }
    closeSync(state.fileDescriptor);
    this.files.delete(dateNumber);
    return true;
  }

  /* ---------- Internals ---------- */

  /** Get (opening if necessary) a day's WAL file state; if the file does not exist, append creates it */
  private requireFileState(dateNumber: number): WalFileState {
    const existing = this.files.get(dateNumber);
    if (existing !== undefined) return existing;

    this.store.ensureDayDirectory(this.database, dateNumber);
    const filePath = this.store.walFilePath(this.database, dateNumber);
    let fileDescriptor: number;
    try {
      fileDescriptor = openSync(filePath, 'a');
    } catch (error) {
      throw new RtdbError(
        ERROR_CODE.Io,
        `Failed to open the WAL file: ${filePath} (${(error as Error).message})`,
      );
    }
    let bytes = 0;
    try {
      bytes = statSync(filePath).size;
    } catch (error) {
      closeSync(fileDescriptor);
      throw new RtdbError(
        ERROR_CODE.Io,
        `Failed to read the WAL file size: ${filePath} (${(error as Error).message})`,
      );
    }
    const state: WalFileState = { dateNumber, filePath, fileDescriptor, bytes, records: [] };
    this.files.set(dateNumber, state);
    return state;
  }

  /** On open, register pre-existing WAL content as an "adopted batch" (only non-empty files are registered, so the safe point advances correctly) */
  private adoptExistingFiles(): void {
    for (const dateNumber of this.store.listDayDirectories(this.database)) {
      const filePath = this.store.walFilePath(this.database, dateNumber);
      let bytes: number;
      try {
        bytes = statSync(filePath).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new RtdbError(
          ERROR_CODE.Io,
          `Failed to read the WAL file size: ${filePath} (${(error as Error).message})`,
        );
      }
      if (bytes === 0) continue;
      const state = this.requireFileState(dateNumber);
      state.records.push({
        batchId: WAL_ADOPTED_BATCH_ID,
        startOffset: 0,
        endOffset: bytes,
        completed: false,
      });
    }
  }

  /**
   * Truncate a day's file to `targetBytes` (0 = clear)
   *
   * - Clearing uses **path truncation** (`truncateSync(path, 0)`, the handle stays the same) — on Windows
   *   calling `ftruncate` on a handle opened with `'a'` (FILE_APPEND_DATA) returns EPERM
   * - When the retained region is non-empty, it uses an "atomic tail rewrite" (tmp + fsync + rename) and
   *   then reopens the append handle — rewriting in place would lose the data of incomplete batches if a
   *   power loss occurred during the rewrite, violating "accepted points are 100% queryable"
   */
  private truncateFileTo(state: WalFileState, targetBytes: number): number {
    if (targetBytes === state.bytes) return 0;
    const before = state.bytes;

    if (targetBytes === 0) {
      // Note: on Windows, calling `ftruncate` on a handle opened with `'a'` (FILE_APPEND_DATA) returns
      // EPERM, so clearing always uses **path truncation**; the append handle always writes at the end of
      // the file, so it need not be reopened
      try {
        truncateSync(state.filePath, 0);
      } catch (error) {
        throw new RtdbError(
          ERROR_CODE.Io,
          `Failed to clear the WAL file: ${state.filePath} (${(error as Error).message})`,
        );
      }
      state.bytes = 0;
      state.records = [];
      return before;
    }

    let tail: Uint8Array;
    try {
      tail = new Uint8Array(readFileSync(state.filePath).subarray(targetBytes, before));
    } catch (error) {
      throw new RtdbError(
        ERROR_CODE.Io,
        `Failed to read the WAL tail to be retained: ${state.filePath} (${(error as Error).message})`,
      );
    }
    closeSync(state.fileDescriptor);
    writeWalFileAtomic(state.filePath, tail);
    try {
      state.fileDescriptor = openSync(state.filePath, 'a');
    } catch (error) {
      throw new RtdbError(
        ERROR_CODE.Io,
        `Failed to reopen the WAL file after truncation: ${state.filePath} (${(error as Error).message})`,
      );
    }
    state.records = state.records
      .filter((record) => record.startOffset >= targetBytes)
      .map((record) => ({
        ...record,
        startOffset: record.startOffset - targetBytes,
        endOffset: record.endOffset - targetBytes,
      }));
    state.bytes = before - targetBytes;
    return targetBytes;
  }
}

/* ---------- Read side and repair (recovery path, pure file operations) ---------- */

/**
 * Read all complete lines of a day's WAL (returns an empty report if the file does not exist)
 *
 * A trailing partial line with no `\n` (a half line from a power loss) is not counted in `entries`; its
 * byte count is reported by `discardedTailBytes`. A parse failure on a middle line is treated as real
 * corruption and throws `E_CORRUPT_SEGMENT`.
 */
export function readWalFileEntries(walFilePath: string, dateNumber: number): WalReadReport {
  let fileBytes = 0;
  let bytes = new Uint8Array(0);
  try {
    const buffer = readFileSync(walFilePath);
    bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    fileBytes = bytes.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new RtdbError(
        ERROR_CODE.Io,
        `Failed to read the WAL file: ${walFilePath} (${(error as Error).message})`,
      );
    }
  }

  const entries: WalEntry[] = [];
  let cursor = 0;
  let validBytes = 0;
  while (cursor < fileBytes) {
    const newlineIndex = bytes.indexOf(LINE_SEPARATOR, cursor);
    if (newlineIndex < 0) break; // Trailing partial line: no terminating newline
    const line = UTF8_DECODER.decode(bytes.subarray(cursor, newlineIndex)).trim();
    if (line.length > 0) entries.push(parseWalLine(line, entries.length, walFilePath));
    cursor = newlineIndex + 1;
    validBytes = cursor;
  }

  return {
    dateNumber,
    walFilePath,
    entries,
    validBytes,
    discardedTailBytes: fileBytes - validBytes,
    fileBytes,
  };
}

/** Discard the WAL trailing partial line: truncate to `validBytes`; returns the discarded byte count (returns 0 if the file is missing or no truncation is needed) */
export function repairWalFileTail(walFilePath: string, validBytes: number): number {
  let fileBytes: number;
  try {
    fileBytes = statSync(walFilePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new RtdbError(ERROR_CODE.Io, `Failed to read the WAL file size: ${walFilePath} (${(error as Error).message})`);
  }
  if (validBytes >= fileBytes) return 0;
  try {
    truncateSync(walFilePath, validBytes);
  } catch (error) {
    throw new RtdbError(ERROR_CODE.Io, `Failed to truncate the WAL partial line: ${walFilePath} (${(error as Error).message})`);
  }
  return fileBytes - validBytes;
}

/* ---------- Line encoding/decoding ---------- */

/** Single point → WAL line (i64 values use decimal text + `"vt":2`; a non-zero quality adds `"q"`) */
function encodeWalLine(point: WritePoint): string {
  const head = `{"m":${JSON.stringify(point.metricName)},"t":${point.timestamp}`;
  const value = point.value;
  if (typeof value === 'bigint') {
    return `${head},"v":"${value.toString()}","${WAL_VALUE_TYPE_FIELD}":${ValueType.Int64}}\n`;
  }
  const quality = point.quality ?? 0;
  const qualityField = quality === 0 ? '' : `,"q":${quality}`;
  return `${head},"v":${JSON.stringify(value)}${qualityField}}\n`;
}

/** WAL line → entry; a missing field / mismatched type / illegal integer text all throw `E_CORRUPT_SEGMENT` */
function parseWalLine(line: string, lineIndex: number, walFilePath: string): WalEntry {
  const context = `${walFilePath} line ${lineIndex + 1}`;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new RtdbError(ERROR_CODE.CorruptSegment, `WAL line is not valid JSON: ${context}`);
  }
  if (raw === null || typeof raw !== 'object') {
    throw new RtdbError(ERROR_CODE.CorruptSegment, `WAL line is not an object: ${context}`);
  }
  const record = raw as Record<string, unknown>;
  const metricName = record.m;
  const timestamp = record.t;
  if (typeof metricName !== 'string' || metricName.length === 0) {
    throw new RtdbError(ERROR_CODE.CorruptSegment, `WAL line has an illegal metric: ${context}`);
  }
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) {
    throw new RtdbError(ERROR_CODE.CorruptSegment, `WAL line has an illegal timestamp: ${context}`);
  }

  const quality = record.q ?? 0;
  if (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 0 || quality > 0xff) {
    throw new RtdbError(ERROR_CODE.CorruptSegment, `WAL line has illegal quality flags: ${context}`);
  }

  return {
    metricName,
    timestamp,
    value: parseWalValue(record, lineIndex, walFilePath),
    quality,
  };
}

/** WAL line value field → `Point['value']` (`"vt":2` uses decimal text → bigint, symmetric with the write side) */
function parseWalValue(record: Record<string, unknown>, lineIndex: number, walFilePath: string): Point['value'] {
  const context = `${walFilePath} line ${lineIndex + 1}`;
  const value = record.v;
  const valueType = record[WAL_VALUE_TYPE_FIELD];
  if (valueType === undefined) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
    throw new RtdbError(ERROR_CODE.CorruptSegment, `WAL line has an illegal value: ${context}`);
  }
  if (valueType !== ValueType.Int64 || typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new RtdbError(
      ERROR_CODE.CorruptSegment,
      `WAL line has an illegal i64 value (requires decimal integer text and ${WAL_VALUE_TYPE_FIELD}=${ValueType.Int64}): ${context}`,
    );
  }
  return BigInt(value);
}

/* ---------- Internal: file writes ---------- */

/** Append write (the handle is opened with `'a'`; writes always land at the end of the file) */
function writeAppend(fileDescriptor: number, bytes: Uint8Array, filePath: string): void {
  let written = 0;
  while (written < bytes.length) {
    let chunk: number;
    try {
      chunk = writeSync(fileDescriptor, bytes, written, bytes.length - written, null);
    } catch (error) {
      throw new RtdbError(ERROR_CODE.Io, `Failed to write the WAL file: ${filePath} (${(error as Error).message})`);
    }
    if (chunk <= 0) {
      throw new RtdbError(ERROR_CODE.Io, `WAL file write made no progress: ${filePath}`);
    }
    written += chunk;
  }
}

function syncFile(fileDescriptor: number, filePath: string): void {
  try {
    fsyncSync(fileDescriptor);
  } catch (error) {
    throw new RtdbError(ERROR_CODE.Io, `Failed to fsync the WAL file: ${filePath} (${(error as Error).message})`);
  }
}

/** Atomically rewrite the WAL file (tmp + fsync + rename; best-effort cleanup of tmp on failure) */
function writeWalFileAtomic(filePath: string, bytes: Uint8Array): void {
  const temporaryFilePath = `${filePath}.tmp`;
  try {
    const fileDescriptor = openSync(temporaryFilePath, 'w');
    try {
      let written = 0;
      while (written < bytes.length) {
        const chunk = writeSync(fileDescriptor, bytes, written, bytes.length - written, null);
        if (chunk <= 0) {
          throw new RtdbError(ERROR_CODE.Io, `WAL temporary file write made no progress: ${temporaryFilePath}`);
        }
        written += chunk;
      }
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    renameSync(temporaryFilePath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryFilePath);
    } catch {
      // Cleanup failure does not affect the main flow: `.tmp` does not match the WAL/segment naming, so scanners naturally ignore it
    }
    if (isRtdbError(error)) throw error;
    throw new RtdbError(ERROR_CODE.Io, `Failed to atomically rewrite the WAL file: ${filePath} (${(error as Error).message})`);
  }
}
