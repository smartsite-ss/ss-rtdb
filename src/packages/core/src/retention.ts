// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Retention and operations primitives: whole-group deletion of expired day directories, whole-day tar.gz
 * archiving, directory-replacing copy (aligned with Detailed Design v2.0 §2.9, §6.2.1)
 *
 * Expiration unit = the **entire day directory** (`{dataDir}/{database}/yyyyMMdd/`): all capacity segments +
 * `.idx` + `.wal` + the backfill sidecar (`yyyyMMdd.bfill.seg/.idx`) in the directory disappear as a group —
 * there are no cross-file references, so whole-group deletion is inherently safe and requires no segment
 * merge (the landing point of the architecture design §3 retention degradation).
 *
 * This file provides only **pure arithmetic + filesystem primitives**; in-process orchestration (when to
 * scan, handle release order, batch safe points) belongs to `engine.ts`:
 *   - `isDayDirectoryExpired` / `planExpiredDayDirectories`: expiration test and scan plan (pure functions,
 *     directly unit-testable)
 *   - `archiveDayDirectory`: pack a whole day into `{archiveDir}/{database}/yyyyMMdd.tar.gz` (USTAR + gzip,
 *     zero third-party dependencies)
 *   - `listArchivedDays`: list a database's already-landed day archives (ascending by date)
 *   - `readTarGzipEntries` / `extractTarGzipArchive`: read an archive back and extract it into a day directory
 *     (the inverse of archiving; the byte basis of "archived bytes are restorable bytes")
 *   - `deleteDayDirectory`: recursively delete a whole day directory and return the released byte count
 *   - `copyDirectoryReplacing`: "clear the target first, then copy wholesale", shared by backup/restore
 *
 * IO scope: consistent with the rest of core, it uses `node:fs` **synchronous** primitives — under a single
 * thread, synchronous execution is "snapshot-consistent" and no write path can interleave during backup
 * (run-to-completion), so no extra locking is needed.
 */

import type { Dirent } from 'node:fs';
import {
  closeSync,
  cpSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { ERROR_CODE, RtdbError, isRtdbError } from './errors.ts';
import {
  dateNumberFromTimestamp,
  formatDateFolderName,
  parseDateFolderName,
  timestampFromDateNumber,
} from './format.ts';

/* ---------- Constants ---------- */

/** Retention sweep interval (ms): once per hour (Detailed Design §2.9) */
export const RETENTION_SWEEP_INTERVAL_MS = 3_600_000;

/** Archive directory name (default landing point under the data root `{dataDir}/archive`, Detailed Design §6.2.1) */
export const ARCHIVE_DIRECTORY_NAME = 'archive';

/** Archive file extension (`yyyyMMdd.tar.gz`) */
export const ARCHIVE_FILE_EXTENSION = '.tar.gz';

/** Milliseconds per day (for retention cutoff boundary arithmetic; DST crossing is approximated, the boundary is exact to "local-timezone day start") */
const MILLISECONDS_PER_DAY = 86_400_000;

/** USTAR header length (bytes) */
const TAR_HEADER_SIZE = 512;

/** USTAR archive end-marker length (two all-zero blocks) */
const TAR_END_MARKER_SIZE = 1_024;

/** USTAR file name limit (bytes; this module's archive names are always `yyyyMMdd/file name`, far below this value) */
const TAR_NAME_MAX_BYTES = 100;

/* ---------- Public types ---------- */

/** Single day directory archive result */
export interface ArchiveResult {
  /** Absolute path of the archive file */
  archiveFilePath: string;
  /** Number of files packed */
  entryCount: number;
  /** Archive file byte count (after gzip) */
  totalBytes: number;
}

/** Whole-directory copy result (shared by backup and restore) */
export interface DirectoryCopyResult {
  /** Number of files copied */
  fileCount: number;
  /** Number of bytes copied */
  totalBytes: number;
}

/** One already-landed day archive under `{archiveDirectory}/{database}` (`yyyyMMdd.tar.gz`) */
export interface ArchivedDayEntry {
  dateNumber: number;
  /** Absolute path of the archive file */
  archiveFilePath: string;
  /** Archive file byte count (after gzip) */
  totalBytes: number;
}

/** Single-database retention sweep result (output of engine `runRetention`, for CLI / status reporting) */
export interface RetentionSweepResult {
  database: string;
  /** Effective retention days (database-level override wins; 0 = permanent, no scan) */
  retentionDays: number;
  /** Date numbers of day directories deleted this time (ascending) */
  deletedDateNumbers: number[];
  /** Day directories archived this time (packed before deletion) */
  archived: Array<{ dateNumber: number; archiveFilePath: string; totalBytes: number }>;
  /** Date numbers of day directories skipped because the day's WAL was non-empty (data not yet flushed to segments) */
  skippedDateNumbers: number[];
  /** Bytes released this time (sum of all files in the deleted day directories) */
  deletedBytes: number;
}

/* ---------- Expiration test (pure functions) ---------- */

/**
 * Whether a day directory is expired: `day directory date + retentionDays < today`
 *
 * - `retentionDays <= 0` = permanent retention (default), never expires
 * - Today never expires (`dayStart + days*DAY >= todayStart` holds for all days >= 1, naturally excluding today)
 * - Boundary scope: retaining N days = retaining "today, yesterday, ..., N days ago", N+1 day directories
 */
export function isDayDirectoryExpired(dateNumber: number, retentionDays: number, nowMs: number): boolean {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return false;
  const dayStart = timestampFromDateNumber(dateNumber);
  const todayStart = timestampFromDateNumber(dateNumberFromTimestamp(nowMs));
  return dayStart + retentionDays * MILLISECONDS_PER_DAY < todayStart;
}

/**
 * Scan plan: pick this run's deletion candidates from the existing day directories (ascending)
 *
 * `excludedDateNumbers` are date numbers that are **never deleted** (today + the day holding the database's
 * active segment), avoiding deletion of the directory where active writes live, which would invalidate
 * segment handles or cause data races.
 */
export function planExpiredDayDirectories(
  dayDirectories: readonly number[],
  retentionDays: number,
  nowMs: number,
  excludedDateNumbers: readonly number[] = [],
): number[] {
  const excluded = new Set(excludedDateNumbers);
  return [...dayDirectories]
    .filter((dateNumber) => !excluded.has(dateNumber) && isDayDirectoryExpired(dateNumber, retentionDays, nowMs))
    .sort((left, right) => left - right);
}

/* ---------- Whole-day archive (USTAR + gzip) ---------- */

/**
 * Pack a day directory into `{archiveDirectory}/{database}/yyyyMMdd.tar.gz`
 *
 * Every **regular file** in the directory becomes an entry in the archive, with entry name =
 * `yyyyMMdd/{file name}` (including `.seg/.idx/.wal` and the backfill sidecar), so that after extraction it
 * can be restored directly to a day directory of the same name. Archive directories are split by database to
 * prevent same-day archives of multiple databases from overwriting each other.
 */
export function archiveDayDirectory(options: {
  database: string;
  dateNumber: number;
  sourceDayDirectory: string;
  archiveDirectory: string;
}): ArchiveResult {
  const targetDirectory = join(options.archiveDirectory, options.database);
  try {
    mkdirSync(targetDirectory, { recursive: true });
  } catch (error) {
    throw toIoError(`Failed to create the archive directory ${targetDirectory}`, error);
  }

  const archiveFilePath = join(
    targetDirectory,
    `${formatDateFolderName(options.dateNumber)}${ARCHIVE_FILE_EXTENSION}`,
  );
  const prefix = formatDateFolderName(options.dateNumber);
  const entries: TarEntry[] = [];
  for (const entry of listFileEntries(options.sourceDayDirectory)) {
    entries.push({
      name: `${prefix}/${entry.name}`,
      bytes: readFileBytes(join(options.sourceDayDirectory, entry.name)),
    });
  }

  const totalBytes = writeTarGzipArchive(archiveFilePath, entries);
  return { archiveFilePath, entryCount: entries.length, totalBytes };
}

/**
 * List a database's already-landed day archives under `{archiveDirectory}/{database}` (ascending by date)
 *
 * Only `yyyyMMdd.tar.gz` files are recognized; the `.tmp` side files of an incomplete archive write do not match
 * the archive extension and are thereby skipped. A missing directory returns an empty array.
 */
export function listArchivedDays(archiveDirectory: string, database: string): ArchivedDayEntry[] {
  const directory = join(archiveDirectory, database);
  const archives: ArchivedDayEntry[] = [];
  for (const entry of listDirectoryEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(ARCHIVE_FILE_EXTENSION)) continue;
    const label = entry.name.slice(0, entry.name.length - ARCHIVE_FILE_EXTENSION.length);
    const dateNumber = parseDateFolderName(label);
    if (dateNumber === null) continue;
    const archiveFilePath = join(directory, entry.name);
    archives.push({ dateNumber, archiveFilePath, totalBytes: statSync(archiveFilePath).size });
  }
  return archives.sort((left, right) => left.dateNumber - right.dateNumber);
}

/** Archive entry (file name + content) */
export interface TarEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * Write a USTAR + gzip archive (atomic: tmp + fsync + rename), returning the archive file byte count
 *
 * Zero third-party dependencies: the tar header is hand-assembled per the USTAR spec, compression goes
 * through `node:zlib` (the same scope as `encoder/zlib-wrap.ts`).
 */
export function writeTarGzipArchive(
  archiveFilePath: string,
  entries: readonly TarEntry[],
  modifiedAtMs = Date.now(),
): number {
  const modifiedAtSeconds = Math.floor(modifiedAtMs / 1000);
  const chunks: Uint8Array[] = [];
  let tarBytes = 0;

  for (const entry of entries) {
    const header = buildTarHeader(entry.name, entry.bytes.length, modifiedAtSeconds);
    const padding = buildPadding(entry.bytes.length);
    chunks.push(header, entry.bytes, padding);
    tarBytes += TAR_HEADER_SIZE + entry.bytes.length + padding.length;
  }
  chunks.push(new Uint8Array(TAR_END_MARKER_SIZE));
  tarBytes += TAR_END_MARKER_SIZE;

  const tar = concatChunks(chunks, tarBytes);
  const gzipBytes = gzipSync(tar);

  const temporaryFilePath = `${archiveFilePath}.tmp`;
  try {
    const fileDescriptor = openSync(temporaryFilePath, 'w');
    try {
      let written = 0;
      while (written < gzipBytes.length) {
        const chunk = writeSync(
          fileDescriptor,
          gzipBytes,
          written,
          gzipBytes.length - written,
          written,
        );
        if (chunk <= 0) {
          throw new RtdbError(ERROR_CODE.Io, `Archive write made no progress: ${temporaryFilePath}`);
        }
        written += chunk;
      }
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    renameSync(temporaryFilePath, archiveFilePath);
  } catch (error) {
    try {
      unlinkSync(temporaryFilePath);
    } catch {
      // Cleanup failure does not affect the main flow (the temporary file does not match the archive naming, so scanners naturally ignore it)
    }
    throw toIoError(`Failed to write the archive file ${archiveFilePath}`, error);
  }
  return gzipBytes.length;
}

/**
 * Read an archive's entries back (gunzip + USTAR block scan) — the inverse of `writeTarGzipArchive`
 *
 * Entry names keep their `yyyyMMdd/{file name}` form. A truncated block, an out-of-range entry, or a decompression
 * failure throws `E_IO` instead of returning partial content, so a restore path never consumes a half-readable
 * archive.
 */
export function readTarGzipEntries(archiveFilePath: string): TarEntry[] {
  const gzipBytes = readFileBytes(archiveFilePath);
  let tarBytes: Uint8Array;
  try {
    tarBytes = new Uint8Array(gunzipSync(gzipBytes));
  } catch (error) {
    throw toIoError(`Failed to decompress the archive file ${archiveFilePath}`, error);
  }

  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + TAR_HEADER_SIZE <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + TAR_HEADER_SIZE);
    if (isZeroBlock(header)) break; // End marker (two all-zero blocks); the second one is reached on the next round
    const name = readTarText(header, 0, TAR_NAME_MAX_BYTES);
    if (name.length === 0) break;
    const size = readTarOctal(header, 124, 12, archiveFilePath);
    const dataStart = offset + TAR_HEADER_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBytes.length) {
      throw new RtdbError(ERROR_CODE.Io, `Archive entry exceeds the archive length: ${name} (${archiveFilePath})`);
    }
    entries.push({ name, bytes: tarBytes.slice(dataStart, dataEnd) });
    offset = dataStart + Math.ceil(size / TAR_HEADER_SIZE) * TAR_HEADER_SIZE;
  }
  return entries;
}

/**
 * Extract a day archive back into a day directory (whole-day restoration) — the inverse of `archiveDayDirectory`
 *
 * Each entry's `yyyyMMdd/` prefix is stripped and the remaining file is written into `targetDayDirectory`, so the
 * restored directory's byte content equals the original one ("archived bytes are restorable bytes"). Extraction
 * goes through a sibling `{target}.extracting` directory followed by a rename and wholesale target replacement, so
 * an interrupted extraction never leaves a half-written day directory in the data root.
 */
export function extractTarGzipArchive(options: {
  archiveFilePath: string;
  targetDayDirectory: string;
}): DirectoryCopyResult {
  const entries = readTarGzipEntries(options.archiveFilePath);
  const temporaryDirectory = `${options.targetDayDirectory}.extracting`;
  let totalBytes = 0;
  try {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    mkdirSync(temporaryDirectory, { recursive: true });
    for (const entry of entries) {
      const fileName = archiveEntryFileName(entry.name, options.archiveFilePath);
      writeFileDurably(join(temporaryDirectory, fileName), entry.bytes);
      totalBytes += entry.bytes.length;
    }
    rmSync(options.targetDayDirectory, { recursive: true, force: true });
    mkdirSync(dirname(options.targetDayDirectory), { recursive: true });
    renameSync(temporaryDirectory, options.targetDayDirectory);
  } catch (error) {
    try {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    } catch {
      // Cleanup failure does not affect the main flow (the `.extracting` suffix does not match day-directory naming, so scanners ignore it)
    }
    throw toIoError(`Failed to extract the archive file ${options.archiveFilePath}`, error);
  }
  return { fileCount: entries.length, totalBytes };
}

/* ---------- Whole-group deletion ---------- */

/** Recursively delete the entire day directory and return the released byte count (a missing directory is treated as already deleted; returns 0) */
export function deleteDayDirectory(dayDirectoryPath: string): number {
  const releasedBytes = measureDirectory(dayDirectoryPath).totalBytes;
  try {
    rmSync(dayDirectoryPath, { recursive: true, force: true });
  } catch (error) {
    throw toIoError(`Failed to delete the day directory ${dayDirectoryPath}`, error);
  }
  return releasedBytes;
}

/* ---------- Directory-replacing copy (backup / restore) ---------- */

/**
 * Clear the target directory first, then copy the source directory wholesale into the target (shared by
 * backup and restore)
 *
 * When the target already exists it is **replaced wholesale** (idempotent re-backup / restore overwriting
 * old data), returning the number of files and bytes copied.
 * Copy scope: all files in the source directory (sealed segments + the current day's active segment
 * snapshot + `.idx` + `.wal` + retention policy files) are copied together, making the target a standalone
 * data directory that can be opened directly (the restore side runs startup recovery's tail truncation +
 * `.idx` rebuild on the current day's active segment snapshot).
 */
export function copyDirectoryReplacing(sourceDirectory: string, targetDirectory: string): DirectoryCopyResult {
  if (!directoryExists(sourceDirectory)) {
    throw new RtdbError(ERROR_CODE.DatabaseNotFound, `Source directory does not exist: ${sourceDirectory}`);
  }
  try {
    rmSync(targetDirectory, { recursive: true, force: true });
    mkdirSync(dirname(targetDirectory), { recursive: true });
    cpSync(sourceDirectory, targetDirectory, { recursive: true, force: true });
  } catch (error) {
    throw toIoError(`Failed to copy the directory ${sourceDirectory} -> ${targetDirectory}`, error);
  }
  return measureDirectory(targetDirectory);
}

/** Whether the directory already exists */
export function directoryExists(directoryPath: string): boolean {
  try {
    return statSync(directoryPath).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw toIoError(`Failed to read the directory status ${directoryPath}`, error);
  }
}

/** Count the number of files and total bytes in a directory (recursive; a missing directory returns 0) */
export function measureDirectory(directoryPath: string): DirectoryCopyResult {
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of listDirectoryEntries(directoryPath)) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nested = measureDirectory(entryPath);
      fileCount += nested.fileCount;
      totalBytes += nested.totalBytes;
      continue;
    }
    if (!entry.isFile()) continue;
    totalBytes += statSync(entryPath).size;
    fileCount += 1;
  }
  return { fileCount, totalBytes };
}

/* ---------- Internals: USTAR assembly ---------- */

/** Build a USTAR header (512B; octal numeric fields + checksum field) */
function buildTarHeader(name: string, size: number, modifiedAtSeconds: number): Uint8Array {
  const nameBytes = Buffer.from(name, 'utf8').length;
  if (nameBytes > TAR_NAME_MAX_BYTES) {
    throw new RtdbError(ERROR_CODE.Internal, `Archive entry name is too long (${nameBytes}B > ${TAR_NAME_MAX_BYTES}B): ${name}`);
  }

  const header = Buffer.alloc(TAR_HEADER_SIZE);
  header.write(name, 0, TAR_NAME_MAX_BYTES, 'utf8');
  header.write(octalField(0o644, 8), 100, 8, 'latin1'); // mode
  header.write(octalField(0, 8), 108, 8, 'latin1'); // uid
  header.write(octalField(0, 8), 116, 8, 'latin1'); // gid
  header.write(octalField(size, 12), 124, 12, 'latin1'); // size
  header.write(octalField(modifiedAtSeconds, 12), 136, 12, 'latin1'); // mtime
  header.write('        ', 148, 8, 'latin1'); // chksum placeholder (fill 8 spaces first)
  header.write('0', 156, 1, 'latin1'); // typeflag: regular file
  header.write('ustar\0', 257, 6, 'latin1'); // magic
  header.write('00', 263, 2, 'latin1'); // version

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return header;
}

/** Octal numeric field: left-pad with zeros to `length - 1` digits and terminate with NUL */
function octalField(value: number, length: number): string {
  const digits = Math.max(0, Math.trunc(value)).toString(8);
  if (digits.length > length - 1) {
    throw new RtdbError(ERROR_CODE.Io, `USTAR numeric field overflow (${value} does not fit in a ${length}B octal field)`);
  }
  return `${digits.padStart(length - 1, '0')}\0`;
}

/** 512B block-aligned zero padding (returns an empty array when it is exactly a whole block) */
function buildPadding(byteLength: number): Uint8Array {
  const remainder = byteLength % TAR_HEADER_SIZE;
  return remainder === 0 ? new Uint8Array(0) : new Uint8Array(TAR_HEADER_SIZE - remainder);
}

/** Concatenate byte chunks (the caller must pre-sum the total length) */
function concatChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Whether a 512B block is all zeros (the USTAR end marker) */
function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/** Read a NUL-terminated USTAR string field */
function readTarText(block: Uint8Array, offset: number, maxLength: number): string {
  let end = offset;
  while (end < offset + maxLength && block[end] !== 0) end += 1;
  return Buffer.from(block.subarray(offset, end)).toString('utf8');
}

/** Read a USTAR octal numeric field (empty or non-octal content throws E_IO) */
function readTarOctal(block: Uint8Array, offset: number, length: number, archiveFilePath: string): number {
  const text = readTarText(block, offset, length).trim();
  const value = Number.parseInt(text, 8);
  if (!Number.isInteger(value) || value < 0) {
    throw new RtdbError(ERROR_CODE.Io, `Invalid USTAR numeric field "${text}" (${archiveFilePath})`);
  }
  return value;
}

/** Strip the `yyyyMMdd/` prefix from an archive entry name; names that would escape the target directory throw E_IO */
function archiveEntryFileName(entryName: string, archiveFilePath: string): string {
  const separatorIndex = entryName.indexOf('/');
  const fileName = separatorIndex < 0 ? entryName : entryName.slice(separatorIndex + 1);
  if (
    fileName.length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\')
  ) {
    throw new RtdbError(ERROR_CODE.Io, `Unsafe archive entry name: ${entryName} (${archiveFilePath})`);
  }
  return fileName;
}

/* ---------- Internals: filesystem ---------- */

/** Directory entry enumeration: a missing directory returns an empty array; other failures throw E_IO */
function listDirectoryEntries(directoryPath: string): Dirent[] {
  try {
    return readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw toIoError(`Failed to read the directory ${directoryPath}`, error);
  }
}

/** Regular-file entries in a directory (ascending, for a deterministic archive entry order) */
function listFileEntries(directoryPath: string): Dirent[] {
  return listDirectoryEntries(directoryPath)
    .filter((entry) => entry.isFile())
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** Read file bytes (throws E_IO on failure) */
function readFileBytes(filePath: string): Uint8Array {
  try {
    const buffer = readFileSync(filePath);
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  } catch (error) {
    throw toIoError(`Failed to read the file ${filePath}`, error);
  }
}

/** Write file bytes and fsync (extracted files are durable data-root payloads, not temporary caches) */
function writeFileDurably(filePath: string, bytes: Uint8Array): void {
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(filePath, 'w');
  } catch (error) {
    throw toIoError(`Failed to create the file ${filePath}`, error);
  }
  try {
    let written = 0;
    while (written < bytes.length) {
      const chunk = writeSync(fileDescriptor, bytes, written, bytes.length - written, written);
      if (chunk <= 0) {
        throw new RtdbError(ERROR_CODE.Io, `Extraction write made no progress: ${filePath}`);
      }
      written += chunk;
    }
    fsyncSync(fileDescriptor);
  } catch (error) {
    throw toIoError(`Failed to write the file ${filePath}`, error);
  } finally {
    closeSync(fileDescriptor);
  }
}

/** Uniformly map an underlying IO exception to E_IO (an RtdbError is thrown as-is) */
function toIoError(action: string, error: unknown): RtdbError {
  if (isRtdbError(error)) return error;
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  return new RtdbError(ERROR_CODE.Io, `${action}: ${code === undefined ? message : `${code} ${message}`}`);
}
