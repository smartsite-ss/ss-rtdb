// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Public export surface of `@ss/rtdb-core` (Detailed Design §2.1 / §2.4)
 *
 * Constraint: this package has zero runtime dependencies; public types and encoder primitives are
 *       exposed uniformly from here, and both Form A (library integration) and Form B
 *       (rtdb-server) depend only on this entry point.
 */

/* ---------- Types and configuration ---------- */
export {
  DEFAULT_RANGE_LIMIT,
  ENGINE_CLAMPS,
  ENGINE_DEFAULTS,
  VALUE_TYPE_NAME,
  ValueType,
  WRITE_LIMITS,
  clampEngineOption,
} from './types.ts';
export type {
  AggregateType,
  AggregateWindow,
  EngineOptionName,
  EngineOptions,
  Point,
  RangeOptions,
  Series,
  WritePoint,
} from './types.ts';

/* ---------- Errors ---------- */
export { ERROR_CODE, ERROR_CODE_HTTP_STATUS, RtdbError, isRtdbError } from './errors.ts';
export type { ErrorCode } from './errors.ts';

/* ---------- Segment file format (§2.5) ---------- */
export {
  BACKFILL_MARKER,
  BLOCK_FLAG,
  BLOCK_HEADER_FIXED_SIZE,
  FORMAT_VERSION,
  INDEX_ENTRY_FIXED_SIZE,
  INDEX_EXTENSION,
  MAX_SEGMENT_SEQUENCE,
  SEGMENT_EXTENSION,
  SEGMENT_FOOTER_SIZE,
  SEGMENT_HEADER_FLAG,
  SEGMENT_HEADER_SIZE,
  SEGMENT_MAGIC,
  SEGMENT_SEQUENCE_DIGITS,
  WAL_EXTENSION,
  blockDataCrc32,
  crc32,
  createSegmentHeader,
  dateNumberFromTimestamp,
  encodeBlockHeader,
  encodeIndexEntry,
  encodeIndexRegion,
  encodeSegmentFooter,
  encodeSegmentHeader,
  footerCrc32,
  formatBackfillSegmentFileName,
  formatDateFolderName,
  formatSegmentFileName,
  formatWalFileName,
  indexEntryLength,
  indexFileNameOfSegmentFileName,
  isSegmentFileName,
  nextDayTimestampFromDateNumber,
  parseDateFolderName,
  parseIndexRegion,
  parseSegmentFileName,
  parseSegmentFooter,
  parseSegmentHeader,
  timestampFromDateNumber,
  tryParseBlockHeader,
} from './format.ts';
export type {
  BlockHeader,
  BlockHeaderInput,
  SegmentBlockIndexEntry,
  SegmentFooter,
  SegmentHeader,
} from './format.ts';

/* ---------- Segment store (§2.3 / §2.6) ---------- */
export { SEGMENT_OPEN_REASON, SegmentStore } from './segment-store.ts';
export type {
  ActiveSegmentHandle,
  BlockAppendMetadata,
  OpenedSegment,
  SealedSegment,
  SegmentOpenReason,
  SegmentStoreOptions,
} from './segment-store.ts';

/* ---------- Segment writer (§2.6) ---------- */
export { SegmentWriter, utf8ByteLength } from './segment-writer.ts';
export type {
  SegmentWriterOptions,
  WriteResult,
  WriterFlushResult,
} from './segment-writer.ts';

/* ---------- Buffer pool (§2.3 / §2.6) ---------- */
export { BUFFER_POOL_CLAMPS, BUFFER_POOL_DEFAULTS, BufferPool } from './pool.ts';
export type { BufferPoolOptions, BufferPoolStats } from './pool.ts';

/* ---------- Segment reader (§2.3) ---------- */
export { SegmentReader } from './segment-reader.ts';
export type {
  BlockLocation,
  SegmentFileDescriptor,
  SegmentInspection,
  SegmentReaderOptions,
} from './segment-reader.ts';

/* ---------- In-memory block index (§2.3) ---------- */
export { MemoryIndex } from './memory-index.ts';
export type { MemoryIndexOptions } from './memory-index.ts';

/* ---------- Data root lock (§2.3 / §2.8) ---------- */
export { DataRootLock, LOCK_FILE_NAME, isProcessAlive } from './lock.ts';
export type { DataRootLockOptions, LockAcquisition, LockOwner } from './lock.ts';

/* ---------- Write-ahead log (§2.5 / §2.6) ---------- */
export {
  WAL_ADOPTED_BATCH_ID,
  WriteAheadLog,
  readWalFileEntries,
  repairWalFileTail,
} from './wal.ts';
export type {
  WalAppendReceipt,
  WalEntry,
  WalFileRange,
  WalReadReport,
  WalTruncationResult,
  WriteAheadLogOptions,
} from './wal.ts';

/* ---------- Startup recovery (§2.8) ---------- */
export { recoverDataRoot } from './recovery.ts';
export type {
  DatabaseRecoveryReport,
  RecoveryOptions,
  RecoveryReport,
  SegmentRecoveryReport,
  WalRecoveryReport,
} from './recovery.ts';

/* ---------- Encoders ---------- */
export {
  CODEC_ID,
  decodeTimestamps,
  decodeValues,
  encodeTimestamps,
  encodeValues,
  encodeValuesWithCodec,
  TIMESTAMP_CODEC_ID,
} from './encoder/registry.ts';
export type { DecodedValues, EncodableValues, EncodedValues } from './encoder/registry.ts';

export { BitReader, BitWriter } from './encoder/bit-stream.ts';
export {
  ByteReader,
  ByteWriter,
  decodeZigZagBigint,
  decodeZigZagNumber,
  encodeZigZagBigint,
  encodeZigZagNumber,
} from './encoder/varint.ts';
export {
  STRING_ENCODING_MODE,
  decodeStringValues,
  encodeStringValues,
} from './encoder/string-codec.ts';
export { ZLIB_WRAP_CODEC_ID, unwrapZlib, wrapWithZlib } from './encoder/zlib-wrap.ts';
export type { UnwrappedPayload } from './encoder/zlib-wrap.ts';
export { decodeFloat64Values, encodeFloat64Values } from './encoder/gorilla-codec.ts';
export { decodeInt64Values, encodeInt64Values } from './encoder/int64-codec.ts';
export { decodeBoolValues, encodeBoolValues } from './encoder/bool-codec.ts';
export { decodeRawValues, encodeRawValues } from './encoder/raw-codec.ts';
export {
  normalizeBoolValues,
  normalizeFloat64Values,
  normalizeInt64Values,
  normalizeStringValues,
} from './encoder/values.ts';

/* ---------- Engine facade (§2.2) ---------- */
export { MAX_AGGREGATE_WINDOWS, RETENTION_FILE_NAME, RtdbEngine } from './engine.ts';
export type {
  BackupResult,
  DatabaseMetricStats,
  DatabaseRuntimeStats,
  EngineStats,
  MetricSummary,
  RestoreResult,
} from './engine.ts';

/* ---------- On-disk measurement (management API + `rtdbctl size`) ---------- */
export { measureDatabaseSize, readDatabaseRetentionDays } from './size.ts';
export type { DatabaseSizeBreakdown, DatabaseSizeReport, DaySizeEntry } from './size.ts';

/* ---------- Retention and operations (§2.9) ---------- */
export {
  ARCHIVE_DIRECTORY_NAME,
  ARCHIVE_FILE_EXTENSION,
  RETENTION_SWEEP_INTERVAL_MS,
  archiveDayDirectory,
  copyDirectoryReplacing,
  deleteDayDirectory,
  directoryExists,
  extractTarGzipArchive,
  isDayDirectoryExpired,
  listArchivedDays,
  measureDirectory,
  planExpiredDayDirectories,
  readTarGzipEntries,
  writeTarGzipArchive,
} from './retention.ts';
export type {
  ArchiveResult,
  ArchivedDayEntry,
  DirectoryCopyResult,
  RetentionSweepResult,
  TarEntry,
} from './retention.ts';
