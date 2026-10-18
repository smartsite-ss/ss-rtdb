// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Segment file binary format (aligned with Detailed Design v1.6 §2.5, format version 1)
 *
 * Segment file physical layout (all integers are little-endian LE except magic):
 *
 * ```
 * Header (32B)                0x00 .. 0x1F
 *   magic        8B  "SSRTDB01"
 *   version      u16 = 1
 *   flags        u16 bit0=whole-block zlib bit1=contains backfill block
 *   date         u32 yyyyMMdd
 *   createdAt    i64 ms epoch
 *   reserved     8B  0
 * Block[N] (append-only, blocks never split across segments)
 *   BlockHeader (fixed 41B + metric bytes)
 *     metricLen     u16
 *     metric        metricLen B UTF-8
 *     pointCount    u32
 *     valueType     u8   1=f64 2=i64 3=bool 4=string
 *     tsCodec       u8
 *     valCodec      u8
 *     tsRawLen      u32  on-disk payload byte count (splits BlockData on the read side)
 *     valRawLen     u32  on-disk payload byte count
 *     tsMin         i64
 *     tsMax         i64
 *     flags         u16  bit0=backfill
 *     reserved      u16
 *     crc32         u32  (over the whole BlockData)
 *   BlockData     tsEncoded(tsRawLen B) ++ valEncoded(valRawLen B)
 * Footer (16B)                 immediately after the last block
 *   indexOffset   u64  start of the intra-segment index region (= Footer start + 16)
 *   crc32         u32  (over Header 32B ++ indexOffset 8B)
 *   reserved      u32
 * Intra-segment index region (indexOffset .. EOF)
 *   [metricLen u16][metric][offset u64][len u64][pointCount u32][tsMin i64][tsMax i64]*
 * ```
 *
 * Index region semantics: `offset` = absolute byte offset of the block start **within the segment
 * file**; `len` = whole-block byte count (block header + data), so a query can read the whole block
 * with a single seek (no need to recompute the block header length).
 */

import { crc32 as zlibCrc32 } from 'node:zlib';

import { TIMESTAMP_CODEC_ID } from './encoder/timestamp-codec.ts';
import { ERROR_CODE, RtdbError } from './errors.ts';
import type { ValueType } from './types.ts';

/* ---------- Constants ---------- */

/** Segment file magic (8B ASCII, fixed for format version 1) */
export const SEGMENT_MAGIC = 'SSRTDB01';

/** Format version (Header.version) */
export const FORMAT_VERSION = 1;

/** Segment file and index file extensions */
export const SEGMENT_EXTENSION = '.seg';
export const INDEX_EXTENSION = '.idx';
export const WAL_EXTENSION = '.wal';

/** Backfill sidecar marker (`yyyyMMdd.bfill.seg` / `yyyyMMdd.bfill.idx`) */
export const BACKFILL_MARKER = 'bfill';

/** Fixed structure sizes (bytes) */
export const SEGMENT_HEADER_SIZE = 32;
export const SEGMENT_FOOTER_SIZE = 16;
/** Fixed block header part (excluding metric bytes) = metricLen 2B + field region 39B */
export const BLOCK_HEADER_FIXED_SIZE = 41;
/** Fixed index entry part (excluding metric bytes) = metricLen 2B + field region 36B */
export const INDEX_ENTRY_FIXED_SIZE = 38;

/** Segment sequence: 3-digit zero-padded (lexicographic order = time order); format version 1 caps at 999 segments/day */
export const SEGMENT_SEQUENCE_DIGITS = 3;
export const MAX_SEGMENT_SEQUENCE = 999;

/** Header.flags bit definitions */
export const SEGMENT_HEADER_FLAG = {
  /** bit0: the segment contains a data block wrapped by whole-block zlib */
  zlibBlock: 0b0000_0001,
  /** bit1: the segment contains an out-of-order backfill block */
  hasBackfillBlock: 0b0000_0010,
} as const;

/** BlockHeader.flags bit definitions */
export const BLOCK_FLAG = {
  /** bit0: out-of-order backfill block */
  backfill: 0b0000_0001,
  /** bit2 reserved: quality-flags persisted marker (M0 decision: all-zero is not persisted, so this bit is always 0; enabling it later once the enumeration table is fixed won't change the format) */
  qualityPresent: 0b0000_0100,
  /**
   * bit3: the block carries a server receive-time window — 16B appended after BlockData
   * (`[receivedMin i64][receivedMax i64]`, included in `totalLength` and in the block CRC scope).
   * Written for backfill traceability and client→server latency observation; old v1 blocks without
   * the flag read unchanged (`receivedMin/receivedMax` = null).
   */
  receivedTime: 0b0000_1000,
} as const;

/** Byte size of the appended server receive-time window (`receivedMin` + `receivedMax`, two i64) */
export const BLOCK_RECEIVED_WINDOW_SIZE = 16;

/** Valid codecId set (0=raw 1=tsDoD 2=Gorilla 4=zlib 5=i64delta 6=boolRLE 7=stringDict; 3 reserved unused) */
const KNOWN_VALUE_CODEC_IDS: ReadonlySet<number> = new Set([0, 2, 4, 5, 6, 7]);

/** Valid value type set (1=f64 2=i64 3=bool 4=string) */
const KNOWN_VALUE_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4]);

/** Shared UTF-8 codecs (hot path of segment scanning; do not create per block) */
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/* ---------- CRC32 ---------- */

/**
 * CRC-32 (IEEE 802.3, same as zlib/PNG; a compatible replacement for crc32fast / xxHash)
 *
 * Supports chained accumulation: `crc32(B, crc32(A)) === crc32(A ++ B)`, used to "verify across
 * multiple segments in one pass".
 */
export function crc32(data: Uint8Array, seed = 0): number {
  return zlibCrc32(data, seed) >>> 0;
}

/* ---------- Dates and file names ---------- */

const DATE_FOLDER_NAME_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const SEGMENT_FILE_NAME_PATTERN = /^(\d{8})-(\d{3})\.seg$/;

/** yyyyMMdd number → year/month/day (strict validation, returns null if invalid) */
function splitDateNumber(dateNumber: number): { year: number; month: number; day: number } | null {
  if (!Number.isInteger(dateNumber) || dateNumber < 1 || dateNumber > 9_999_12_31) return null;
  const year = Math.floor(dateNumber / 10_000);
  const month = Math.floor((dateNumber % 10_000) / 100);
  const day = dateNumber % 100;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** Timestamp (ms epoch) → yyyyMMdd computed in the **local timezone** (day directory and cross-day determination both use the local timezone) */
export function dateNumberFromTimestamp(timestampMs: number): number {
  const date = new Date(timestampMs);
  return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** yyyyMMdd → timestamp of 00:00:00.000 local time that day (invalid date throws an E_CORRUPT_SEGMENT-level internal error) */
export function timestampFromDateNumber(dateNumber: number): number {
  const parts = splitDateNumber(dateNumber);
  if (parts === null) {
    throw new RtdbError(ERROR_CODE.Internal, `Invalid date number: ${dateNumber}`);
  }
  return new Date(parts.year, parts.month - 1, parts.day).getTime();
}

/** Timestamp of 00:00:00.000 of the next day of yyyyMMdd (right boundary for per-day query trimming; DST-safe) */
export function nextDayTimestampFromDateNumber(dateNumber: number): number {
  const parts = splitDateNumber(dateNumber);
  if (parts === null) {
    throw new RtdbError(ERROR_CODE.Internal, `Invalid date number: ${dateNumber}`);
  }
  return new Date(parts.year, parts.month - 1, parts.day + 1).getTime();
}

/** yyyyMMdd → `yyyyMMdd` directory name */
export function formatDateFolderName(dateNumber: number): string {
  if (splitDateNumber(dateNumber) === null) {
    throw new RtdbError(ERROR_CODE.Internal, `Invalid date number: ${dateNumber}`);
  }
  return String(dateNumber);
}

/** `yyyyMMdd` directory name → date number; returns null if not a day directory */
export function parseDateFolderName(folderName: string): number | null {
  const matched = DATE_FOLDER_NAME_PATTERN.exec(folderName);
  if (matched === null) return null;
  const dateNumber = Number(folderName);
  return splitDateNumber(dateNumber) === null ? null : dateNumber;
}

/** Segment file name: `yyyyMMdd-NNN.seg` */
export function formatSegmentFileName(dateNumber: number, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_SEGMENT_SEQUENCE) {
    throw new RtdbError(ERROR_CODE.Internal, `Segment sequence out of range (1~${MAX_SEGMENT_SEQUENCE}): ${sequence}`);
  }
  return `${formatDateFolderName(dateNumber)}-${String(sequence).padStart(SEGMENT_SEQUENCE_DIGITS, '0')}${SEGMENT_EXTENSION}`;
}

/** Segment file name → date number and sequence; returns null if not a segment */
export function parseSegmentFileName(fileName: string): { dateNumber: number; sequence: number } | null {
  const matched = SEGMENT_FILE_NAME_PATTERN.exec(fileName);
  if (matched === null) return null;
  const dateNumber = Number(matched[1]);
  if (splitDateNumber(dateNumber) === null) return null;
  const sequence = Number(matched[2]);
  if (sequence < 1) return null;
  return { dateNumber, sequence };
}

export function isSegmentFileName(fileName: string): boolean {
  return parseSegmentFileName(fileName) !== null;
}

/** Index file name: `.idx` for a segment or `.bfill.idx` for a backfill */
export function indexFileNameOfSegmentFileName(segmentFileName: string): string {
  if (!segmentFileName.endsWith(SEGMENT_EXTENSION)) {
    throw new RtdbError(ERROR_CODE.Internal, `Not a segment file name: ${segmentFileName}`);
  }
  return `${segmentFileName.slice(0, -SEGMENT_EXTENSION.length)}${INDEX_EXTENSION}`;
}

/** Backfill sidecar segment file name: `yyyyMMdd.bfill.seg` */
export function formatBackfillSegmentFileName(dateNumber: number): string {
  return `${formatDateFolderName(dateNumber)}.${BACKFILL_MARKER}${SEGMENT_EXTENSION}`;
}

/** WAL file name for the day: `yyyyMMdd.wal` */
export function formatWalFileName(dateNumber: number): string {
  return `${formatDateFolderName(dateNumber)}${WAL_EXTENSION}`;
}

/* ---------- Header ---------- */

export interface SegmentHeader {
  version: number;
  flags: number;
  /** yyyyMMdd */
  date: number;
  /** ms epoch */
  createdAt: number;
}

export function createSegmentHeader(dateNumber: number, createdAt: number): SegmentHeader {
  return { version: FORMAT_VERSION, flags: 0, date: dateNumber, createdAt };
}

export function encodeSegmentHeader(header: SegmentHeader): Uint8Array {
  const out = new Uint8Array(SEGMENT_HEADER_SIZE);
  for (let index = 0; index < SEGMENT_MAGIC.length; index += 1) {
    out[index] = SEGMENT_MAGIC.charCodeAt(index);
  }
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(0x08, header.version, true);
  view.setUint16(0x0a, header.flags, true);
  view.setUint32(0x0c, header.date, true);
  view.setBigInt64(0x10, BigInt(Math.trunc(header.createdAt)), true);
  // 0x18..0x1F reserved stays 0
  return out;
}

/** Parse the segment header; mismatched magic/version or out-of-range throws E_CORRUPT_SEGMENT */
export function parseSegmentHeader(buffer: Uint8Array, offset = 0): SegmentHeader {
  if (offset < 0 || offset + SEGMENT_HEADER_SIZE > buffer.length) {
    throw new RtdbError(
      ERROR_CODE.CorruptSegment,
      `Segment header out of range: offset=${offset}, length=${buffer.length}`,
    );
  }
  for (let index = 0; index < SEGMENT_MAGIC.length; index += 1) {
    if (buffer[offset + index] !== SEGMENT_MAGIC.charCodeAt(index)) {
      throw new RtdbError(ERROR_CODE.CorruptSegment, 'Segment header magic mismatch (not an ss-rtdb segment file)');
    }
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset, SEGMENT_HEADER_SIZE);
  const version = view.getUint16(0x08, true);
  if (version !== FORMAT_VERSION) {
    throw new RtdbError(
      ERROR_CODE.CorruptSegment,
      `Unsupported segment format version: file v${version}, local v${FORMAT_VERSION}`,
    );
  }
  return {
    version,
    flags: view.getUint16(0x0a, true),
    date: view.getUint32(0x0c, true),
    createdAt: Number(view.getBigInt64(0x10, true)),
  };
}

/* ---------- BlockHeader ---------- */

export interface BlockHeader {
  /** Absolute byte offset of the block start within the segment file (filled in during parse) */
  offset: number;
  metricName: string;
  /** metric UTF-8 byte length */
  metricLength: number;
  pointCount: number;
  valueType: ValueType;
  timestampCodecId: number;
  valueCodecId: number;
  /** On-disk payload byte count (used by the read side to split BlockData) */
  timestampRawLength: number;
  valueRawLength: number;
  /** ms epoch */
  timestampMin: number;
  /** ms epoch */
  timestampMax: number;
  flags: number;
  crc32: number;
  /**
   * Whole-block byte count = block header + data (+ receive window when the `receivedTime` flag is set)
   */
  totalLength: number;
  /** Earliest server receive time within the block (ms epoch); null for blocks without the `receivedTime` flag */
  receivedMin: number | null;
  /** Latest server receive time within the block (ms epoch); null for blocks without the `receivedTime` flag */
  receivedMax: number | null;
}

export interface BlockHeaderInput {
  metricName: string;
  pointCount: number;
  valueType: ValueType;
  timestampCodecId: number;
  valueCodecId: number;
  timestampRawLength: number;
  valueRawLength: number;
  timestampMin: number;
  timestampMax: number;
  flags: number;
  crc32: number;
}

/** Encode the block header (fixed 41B + metric bytes) */
export function encodeBlockHeader(input: BlockHeaderInput): Uint8Array {
  const metricBytes = UTF8_ENCODER.encode(input.metricName);
  if (metricBytes.length < 1 || metricBytes.length > 0xffff) {
    throw new RtdbError(
      ERROR_CODE.BadMetricName,
      `metric name UTF-8 byte length out of range (1~65535): ${metricBytes.length}`,
    );
  }
  const headerLength = BLOCK_HEADER_FIXED_SIZE + metricBytes.length;
  const out = new Uint8Array(headerLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(0, metricBytes.length, true);
  out.set(metricBytes, 2);
  const fieldsOffset = 2 + metricBytes.length;
  view.setUint32(fieldsOffset, input.pointCount, true);
  view.setUint8(fieldsOffset + 4, input.valueType);
  view.setUint8(fieldsOffset + 5, input.timestampCodecId);
  view.setUint8(fieldsOffset + 6, input.valueCodecId);
  view.setUint32(fieldsOffset + 7, input.timestampRawLength, true);
  view.setUint32(fieldsOffset + 11, input.valueRawLength, true);
  view.setBigInt64(fieldsOffset + 15, BigInt(Math.trunc(input.timestampMin)), true);
  view.setBigInt64(fieldsOffset + 23, BigInt(Math.trunc(input.timestampMax)), true);
  view.setUint16(fieldsOffset + 31, input.flags, true);
  view.setUint16(fieldsOffset + 33, 0, true);
  view.setUint32(fieldsOffset + 35, input.crc32, true);
  return out;
}

/**
 * Parse a block header; returns null on any out-of-range/invalid field (used by segment scanning
 * to detect the "end of the block region" = Footer start)
 *
 * `limit` is the maximum allowed end offset for this block (usually the segment file length).
 */
export function tryParseBlockHeader(
  buffer: Uint8Array,
  offset: number,
  limit = buffer.length,
): BlockHeader | null {
  if (offset < 0 || offset + BLOCK_HEADER_FIXED_SIZE > limit || limit > buffer.length) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const metricLength = view.getUint16(offset, true);
  if (metricLength < 1 || offset + 2 + metricLength + BLOCK_HEADER_FIXED_SIZE - 2 > limit) return null;
  const fieldsOffset = offset + 2 + metricLength;
  const pointCount = view.getUint32(fieldsOffset, true);
  if (pointCount < 1) return null;
  const rawValueType = view.getUint8(fieldsOffset + 4);
  if (!KNOWN_VALUE_TYPES.has(rawValueType)) return null;
  const timestampCodecId = view.getUint8(fieldsOffset + 5);
  if (timestampCodecId !== TIMESTAMP_CODEC_ID) return null;
  const valueCodecId = view.getUint8(fieldsOffset + 6);
  if (!KNOWN_VALUE_CODEC_IDS.has(valueCodecId)) return null;
  const timestampRawLength = view.getUint32(fieldsOffset + 7, true);
  const valueRawLength = view.getUint32(fieldsOffset + 11, true);
  const dataOffset = fieldsOffset + BLOCK_HEADER_FIXED_SIZE - 2;
  const dataLength = timestampRawLength + valueRawLength;
  if (dataOffset + dataLength > limit) return null;
  const timestampMin = Number(view.getBigInt64(fieldsOffset + 15, true));
  const timestampMax = Number(view.getBigInt64(fieldsOffset + 23, true));
  if (timestampMax < timestampMin) return null;
  const flags = view.getUint16(fieldsOffset + 31, true);
  if ((flags & ~(BLOCK_FLAG.backfill | BLOCK_FLAG.qualityPresent | BLOCK_FLAG.receivedTime)) !== 0) return null;

  const hasReceivedTime = (flags & BLOCK_FLAG.receivedTime) !== 0;
  let receivedMin: number | null = null;
  let receivedMax: number | null = null;
  let totalLength = BLOCK_HEADER_FIXED_SIZE + metricLength + dataLength;
  if (hasReceivedTime) {
    if (dataOffset + dataLength + BLOCK_RECEIVED_WINDOW_SIZE > limit) return null;
    receivedMin = Number(view.getBigInt64(dataOffset + dataLength, true));
    receivedMax = Number(view.getBigInt64(dataOffset + dataLength + 8, true));
    if (receivedMin <= 0 || receivedMin > receivedMax) return null;
    totalLength += BLOCK_RECEIVED_WINDOW_SIZE;
  }

  return {
    offset,
    metricName: UTF8_DECODER.decode(buffer.subarray(offset + 2, offset + 2 + metricLength)),
    metricLength,
    pointCount,
    valueType: rawValueType as ValueType,
    timestampCodecId,
    valueCodecId,
    timestampRawLength,
    valueRawLength,
    timestampMin,
    timestampMax,
    flags,
    crc32: view.getUint32(fieldsOffset + 35, true),
    totalLength,
    receivedMin,
    receivedMax,
  };
}

/**
 * Read only the value type out of a block's **fixed header region**, without the payload.
 *
 * `limit` must cover `2 + metricLength + BLOCK_HEADER_FIXED_SIZE - 2` bytes (the metric name plus the fixed
 * field region); a caller that knows the metric-name length can therefore probe the type from a small read
 * instead of buffering the whole block. Returns null when the region is incomplete or the codes are unknown.
 */
export function tryParseBlockValueType(buffer: Uint8Array, offset = 0, limit = buffer.length): ValueType | null {
  if (offset < 0 || offset + BLOCK_HEADER_FIXED_SIZE > limit || limit > buffer.length) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const metricLength = view.getUint16(offset, true);
  if (metricLength < 1 || offset + 2 + metricLength + BLOCK_HEADER_FIXED_SIZE - 2 > limit) return null;
  const fieldsOffset = offset + 2 + metricLength;
  if (view.getUint32(fieldsOffset, true) < 1) return null;
  const rawValueType = view.getUint8(fieldsOffset + 4);
  if (!KNOWN_VALUE_TYPES.has(rawValueType)) return null;
  if (view.getUint8(fieldsOffset + 5) !== TIMESTAMP_CODEC_ID) return null;
  if (!KNOWN_VALUE_CODEC_IDS.has(view.getUint8(fieldsOffset + 6))) return null;
  return rawValueType as ValueType;
}

/* ---------- Footer ---------- */

export interface SegmentFooter {
  /** Start of the intra-segment index region (= Footer start + 16) */
  indexOffset: number;
  crc32: number;
}

/** Footer CRC scope: over Header 32B ++ indexOffset (u64 LE, 8B total) */
export function footerCrc32(headerBytes: Uint8Array, indexOffset: number): number {
  if (headerBytes.length !== SEGMENT_HEADER_SIZE) {
    throw new RtdbError(
      ERROR_CODE.Internal,
      `Footer verification needs a ${SEGMENT_HEADER_SIZE}B segment header, got ${headerBytes.length}B`,
    );
  }
  const indexOffsetBytes = new Uint8Array(8);
  new DataView(indexOffsetBytes.buffer, indexOffsetBytes.byteOffset, 8).setBigUint64(
    0,
    BigInt(indexOffset),
    true,
  );
  return crc32(indexOffsetBytes, crc32(headerBytes));
}

export function encodeSegmentFooter(headerBytes: Uint8Array, indexOffset: number): Uint8Array {
  const out = new Uint8Array(SEGMENT_FOOTER_SIZE);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigUint64(0, BigInt(indexOffset), true);
  view.setUint32(8, footerCrc32(headerBytes, indexOffset), true);
  // 12..15 reserved stays 0
  return out;
}

/** Parse the Footer and verify its CRC; on failure throws E_CORRUPT_SEGMENT */
export function parseSegmentFooter(
  buffer: Uint8Array,
  offset: number,
  headerBytes: Uint8Array,
): SegmentFooter {
  if (offset < 0 || offset + SEGMENT_FOOTER_SIZE > buffer.length) {
    throw new RtdbError(
      ERROR_CODE.CorruptSegment,
      `Footer out of range: offset=${offset}, length=${buffer.length}`,
    );
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset, SEGMENT_FOOTER_SIZE);
  const indexOffset = Number(view.getBigUint64(0, true));
  const expected = footerCrc32(headerBytes, indexOffset);
  const actual = view.getUint32(8, true);
  if (expected !== actual) {
    throw new RtdbError(
      ERROR_CODE.CorruptSegment,
      `Footer CRC verification failed: expected ${expected}, actual ${actual}`,
    );
  }
  if (indexOffset !== offset + SEGMENT_FOOTER_SIZE) {
    throw new RtdbError(
      ERROR_CODE.CorruptSegment,
      `Footer.indexOffset does not match the layout: expected ${offset + SEGMENT_FOOTER_SIZE}, actual ${indexOffset}`,
    );
  }
  return { indexOffset, crc32: actual };
}

/* ---------- Intra-segment index region ---------- */

/** Index entry for each block (`.idx` shares the same layout as the intra-segment index region; fixed 38B + metric) */
export interface SegmentBlockIndexEntry {
  metricName: string;
  /** Absolute byte offset of the block start within the segment file */
  offset: number;
  /** Whole-block byte count (block header + data) */
  length: number;
  pointCount: number;
  /** ms epoch */
  timestampMin: number;
  /** ms epoch */
  timestampMax: number;
}

function encodeIndexEntryInto(entry: SegmentBlockIndexEntry, writer: BufferBuilder): void {
  const metricBytes = UTF8_ENCODER.encode(entry.metricName);
  if (metricBytes.length < 1 || metricBytes.length > 0xffff) {
    throw new RtdbError(
      ERROR_CODE.BadMetricName,
      `metric name UTF-8 byte length out of range (1~65535): ${metricBytes.length}`,
    );
  }
  writer.writeUint16(metricBytes.length);
  writer.writeBytes(metricBytes);
  writer.writeBigUint64(entry.offset);
  writer.writeBigUint64(entry.length);
  writer.writeUint32(entry.pointCount);
  writer.writeBigInt64(entry.timestampMin);
  writer.writeBigInt64(entry.timestampMax);
}

/** Index entry byte count (38 + metric bytes) */
export function indexEntryLength(metricName: string): number {
  return INDEX_ENTRY_FIXED_SIZE + UTF8_ENCODER.encode(metricName).length;
}

export function encodeIndexEntry(entry: SegmentBlockIndexEntry): Uint8Array {
  const builder = new BufferBuilder(indexEntryLength(entry.metricName));
  encodeIndexEntryInto(entry, builder);
  return builder.toUint8Array();
}

/** Encode the entire index region (`.idx` file content is fully isomorphic to the intra-segment index region) */
export function encodeIndexRegion(entries: readonly SegmentBlockIndexEntry[]): Uint8Array {
  let total = 0;
  for (const entry of entries) total += indexEntryLength(entry.metricName);
  const builder = new BufferBuilder(total);
  for (const entry of entries) encodeIndexEntryInto(entry, builder);
  return builder.toUint8Array();
}

/** Parse the index region (from `indexOffset` to `endOffset`; endOffset defaults to the end of the buffer) */
export function parseIndexRegion(
  buffer: Uint8Array,
  indexOffset: number,
  endOffset: number = buffer.length,
): SegmentBlockIndexEntry[] {
  if (indexOffset < 0 || endOffset > buffer.length || indexOffset > endOffset) {
    throw new RtdbError(
      ERROR_CODE.CorruptSegment,
      `Index region out of range: indexOffset=${indexOffset}, endOffset=${endOffset}, length=${buffer.length}`,
    );
  }
  const entries: SegmentBlockIndexEntry[] = [];
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let cursor = indexOffset;
  while (cursor < endOffset) {
    if (cursor + 2 > endOffset) {
      throw new RtdbError(ERROR_CODE.CorruptSegment, `Trailing partial entry at the index region tail: offset=${cursor}`);
    }
    const metricLength = view.getUint16(cursor, true);
    const entryLength = INDEX_ENTRY_FIXED_SIZE + metricLength;
    if (metricLength < 1 || cursor + entryLength > endOffset) {
      throw new RtdbError(
        ERROR_CODE.CorruptSegment,
        `Index entry out of range: offset=${cursor}, metricLength=${metricLength}`,
      );
    }
    const fieldsOffset = cursor + 2 + metricLength;
    entries.push({
      metricName: UTF8_DECODER.decode(buffer.subarray(cursor + 2, fieldsOffset)),
      offset: Number(view.getBigUint64(fieldsOffset, true)),
      length: Number(view.getBigUint64(fieldsOffset + 8, true)),
      pointCount: view.getUint32(fieldsOffset + 16, true),
      timestampMin: Number(view.getBigInt64(fieldsOffset + 20, true)),
      timestampMax: Number(view.getBigInt64(fieldsOffset + 28, true)),
    });
    cursor += entryLength;
  }
  return entries;
}

/* ---------- Block data CRC ---------- */

/** BlockHeader.crc32 scope: over the whole BlockData (tsEncoded ++ valEncoded) */
export function blockDataCrc32(timestampEncoded: Uint8Array, valueEncoded: Uint8Array): number {
  return crc32(valueEncoded, crc32(timestampEncoded));
}

/** Block CRC scope when the `receivedTime` flag is set: chained over BlockData ++ receive window */
export function blockDataCrc32WithReceived(
  timestampEncoded: Uint8Array,
  valueEncoded: Uint8Array,
  receivedEncoded: Uint8Array,
): number {
  return crc32(receivedEncoded, crc32(valueEncoded, crc32(timestampEncoded)));
}

/* ---------- Internal: fixed-size little-endian write buffer ---------- */

class BufferBuilder {
  private readonly buffer: Uint8Array;
  private readonly view: DataView;
  private cursor = 0;

  constructor(capacityBytes: number) {
    this.buffer = new Uint8Array(Math.max(16, capacityBytes));
    this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
  }

  writeUint16(value: number): void {
    this.view.setUint16(this.cursor, value, true);
    this.cursor += 2;
  }

  writeUint32(value: number): void {
    this.view.setUint32(this.cursor, value, true);
    this.cursor += 4;
  }

  writeBigUint64(value: number): void {
    this.view.setBigUint64(this.cursor, BigInt(value), true);
    this.cursor += 8;
  }

  writeBigInt64(value: number): void {
    this.view.setBigInt64(this.cursor, BigInt(Math.trunc(value)), true);
    this.cursor += 8;
  }

  writeBytes(source: Uint8Array): void {
    this.buffer.set(source, this.cursor);
    this.cursor += source.length;
  }

  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.cursor);
  }
}
