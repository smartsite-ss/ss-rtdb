// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `rtdbctl` offline operations against a local data root (aligned with "Detailed Design v2.2" §5)
 *
 * Why offline: the S8 HTTP surface has **no** `restore` / `size` / `repair` / `archive` routes (only `backup` is
 * exposed). These commands therefore open the local data root directly and reuse core primitives, which also keeps
 * them usable when no server is running:
 *   - `size`: `SegmentStore` path scope + `measureDirectory` (pure filesystem arithmetic, no locking)
 *   - `repair`: `DataRootLock` + `recoverDataRoot` (idempotent half-block truncation + `.idx` mirror rebuild)
 *   - `restore`: `RtdbEngine.open()` + `RtdbEngine.restore()` (that database's startup recovery is rerun)
 *   - `archive`: `DataRootLock` + `archiveDayDirectory` (whole day packed to `{dataDir}/archive/{db}/yyyyMMdd.tar.gz`)
 *   - `restore --archive`: `DataRootLock` + `extractTarGzipArchive` + `recoverDataRoot` (byte-exact day restoration)
 *
 * Constraint: every offline command needs exclusive access to the data root — the server holds the data root
 * lock while running, so these commands fail with `E_DB_LOCKED` in that case (an intentional safety gate).
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { RtdbEngine } from '../../core/src/engine.ts';
import { ERROR_CODE, RtdbError } from '../../core/src/errors.ts';
import { formatDateFolderName } from '../../core/src/format.ts';
import { DataRootLock } from '../../core/src/lock.ts';
import { recoverDataRoot } from '../../core/src/recovery.ts';
import {
  ARCHIVE_DIRECTORY_NAME,
  ARCHIVE_FILE_EXTENSION,
  archiveDayDirectory,
  directoryExists,
  extractTarGzipArchive,
  listArchivedDays,
} from '../../core/src/retention.ts';
import { SegmentStore } from '../../core/src/segment-store.ts';

/* ---------- Public types ---------- */

/* `DatabaseSizeReport` / `DaySizeEntry` live in `core/size.ts` (shared with the server management API) */
export type { DatabaseSizeReport, DaySizeEntry } from '../../core/src/size.ts';

export interface RepairSummary {
  database: string;
  /** `null` = the whole database is reported; a date number = the report was filtered to that day */
  dateNumber: number | null;
  segmentCount: number;
  truncatedSegmentCount: number;
  truncatedBytes: number;
  rebuiltIndexCount: number;
  rebuiltSegmentIndexes: number[];
  replayedEntryCount: number;
  discardedWalTailBytes: number;
}

export interface RestoreSummary {
  database: string;
  /** Absolute directory the backup was read from */
  sourceDirectory: string;
  /** Absolute database directory that was replaced (or merged into) */
  targetDirectory: string;
  fileCount: number;
  totalBytes: number;
  /** `replace` = whole-database replacement; `merge` = a range backup merged into the existing database */
  mode: 'replace' | 'merge';
  /** Day directories written by a merge restore (`yyyyMMdd`, ascending; empty for a full restore) */
  days: number[];
}

/** One already-landed day archive of a database */
export interface ArchivedDaySummary {
  dateNumber: number;
  /** `yyyyMMdd` label */
  dayLabel: string;
  archiveFilePath: string;
  totalBytes: number;
}

/** Result of manually archiving one day directory */
export interface ArchiveDaySummary {
  database: string;
  dateNumber: number;
  dayLabel: string;
  archiveFilePath: string;
  /** Number of files packed */
  entryCount: number;
  totalBytes: number;
}

/** Result of restoring one archived day directory */
export interface RestoreDaySummary {
  database: string;
  dateNumber: number;
  dayLabel: string;
  /** Absolute archive file the day was extracted from */
  sourceArchiveFilePath: string;
  /** Absolute day directory that was replaced */
  targetDayDirectory: string;
  fileCount: number;
  totalBytes: number;
}

/* ---------- size ---------- */

/* Implemented in core so the server management API can reuse it without a `server -> cli` dependency */
export { measureDatabaseSize } from '../../core/src/size.ts';

/* ---------- repair ---------- */

/**
 * Run startup-style recovery on a database (rebuild the `.idx` mirror from the scanned block region, truncate
 * a trailing half block, and truncate a trailing partial WAL line)
 *
 * `dateNumber` only narrows the **reported** detail: recovery itself is database-scoped and idempotent, so a
 * filtered run repairs exactly the same bytes as an unfiltered one.
 */
export function repairDatabase(dataDir: string, database: string, dateNumber: number | null): RepairSummary {
  const store = new SegmentStore({ dataDir });
  const directory = store.databaseDirectoryPath(database);
  if (!directoryExists(directory)) {
    throw new RtdbError(ERROR_CODE.DatabaseNotFound, `Database does not exist: ${directory}`);
  }

  const lock = new DataRootLock({ dataDir: store.dataDir });
  lock.acquire();
  try {
    const report = recoverDataRoot({ store, databases: [database] });
    const databaseReport = report.databases[0];
    const segments =
      databaseReport === undefined
        ? []
        : dateNumber === null
          ? databaseReport.segments
          : databaseReport.segments.filter((segment) => segment.dateNumber === dateNumber);
    const walFiles =
      databaseReport === undefined
        ? []
        : dateNumber === null
          ? databaseReport.walFiles
          : databaseReport.walFiles.filter((walFile) => walFile.dateNumber === dateNumber);

    const rebuiltSegmentIndexes: number[] = [];
    let truncatedSegmentCount = 0;
    let truncatedBytes = 0;
    let rebuiltIndexCount = 0;
    for (const segment of segments) {
      if (segment.truncatedBytes > 0) truncatedSegmentCount += 1;
      truncatedBytes += segment.truncatedBytes;
      if (segment.indexRebuilt) {
        rebuiltIndexCount += 1;
        rebuiltSegmentIndexes.push(segment.dateNumber * 1000 + segment.sequence);
      }
    }

    let replayedEntryCount = 0;
    let discardedWalTailBytes = 0;
    for (const walFile of walFiles) {
      replayedEntryCount += walFile.entryCount;
      discardedWalTailBytes += walFile.discardedTailBytes;
    }

    return {
      database,
      dateNumber,
      segmentCount: segments.length,
      truncatedSegmentCount,
      truncatedBytes,
      rebuiltIndexCount,
      rebuiltSegmentIndexes,
      replayedEntryCount,
      discardedWalTailBytes,
    };
  } finally {
    store.close();
    lock.release();
  }
}

/* ---------- restore ---------- */

/**
 * Restore a database from `{backupDirectory}/{database}` into the local data root (whole-directory replacement)
 *
 * The engine is opened only for the duration of the restore: opening acquires the data root lock and reruns the
 * database's startup recovery, so restored data is immediately consistent.
 */
export async function restoreDatabase(
  dataDir: string,
  database: string,
  backupDirectory: string,
): Promise<RestoreSummary> {
  const engine = new RtdbEngine({ dataDir });
  await engine.open();
  try {
    const result = await engine.restore(backupDirectory, database);
    return {
      database: result.database,
      sourceDirectory: result.sourceDirectory,
      targetDirectory: engine.dataDir,
      fileCount: result.fileCount,
      totalBytes: result.totalBytes,
      mode: result.mode ?? 'replace',
      days: result.days ?? [],
    };
  } finally {
    await engine.close();
  }
}

/* ---------- archive (offline) ---------- */

/** Archive root of a data root (`{dataDir}/archive`, the same default landing point as the engine) */
export function archiveDirectoryPath(dataDir: string): string {
  return join(resolve(dataDir), ARCHIVE_DIRECTORY_NAME);
}

/** List a database's already-landed day archives (ascending by date; reading the directory needs no data root lock) */
export function listDatabaseArchives(dataDir: string, database: string): ArchivedDaySummary[] {
  return listArchivedDays(archiveDirectoryPath(dataDir), database).map((entry) => ({
    dateNumber: entry.dateNumber,
    dayLabel: formatDateFolderName(entry.dateNumber),
    archiveFilePath: entry.archiveFilePath,
    totalBytes: entry.totalBytes,
  }));
}

/**
 * Manually archive one day directory to `{dataDir}/archive/{database}/yyyyMMdd.tar.gz`
 *
 * Takes the data root lock: the day being archived may still hold the database's active segment, and packing it
 * while writes are in flight would tear the archive.
 */
export function archiveDatabaseDay(dataDir: string, database: string, dateNumber: number): ArchiveDaySummary {
  const store = new SegmentStore({ dataDir });
  const databaseDirectory = store.databaseDirectoryPath(database);
  if (!directoryExists(databaseDirectory)) {
    throw new RtdbError(ERROR_CODE.DatabaseNotFound, `Database does not exist: ${databaseDirectory}`);
  }
  const dayDirectory = store.dayDirectoryPath(database, dateNumber);
  if (!directoryExists(dayDirectory)) {
    throw new RtdbError(ERROR_CODE.DatabaseNotFound, `Day directory does not exist: ${dayDirectory}`);
  }

  const lock = new DataRootLock({ dataDir: store.dataDir });
  lock.acquire();
  try {
    const result = archiveDayDirectory({
      database,
      dateNumber,
      sourceDayDirectory: dayDirectory,
      archiveDirectory: archiveDirectoryPath(store.dataDir),
    });
    return {
      database,
      dateNumber,
      dayLabel: formatDateFolderName(dateNumber),
      archiveFilePath: result.archiveFilePath,
      entryCount: result.entryCount,
      totalBytes: result.totalBytes,
    };
  } finally {
    store.close();
    lock.release();
  }
}

/**
 * Restore one archived day directory back into the data root (whole-day replacement)
 *
 * Byte-exact extraction followed by that database's recovery pass, so the restored day directory is immediately
 * consistent (a half block left by an interrupted extraction is truncated and a missing `.idx` is rebuilt).
 */
export function restoreDatabaseDayFromArchive(
  dataDir: string,
  database: string,
  dateNumber: number,
): RestoreDaySummary {
  const store = new SegmentStore({ dataDir });
  const databaseDirectory = store.databaseDirectoryPath(database);
  if (!directoryExists(databaseDirectory)) {
    throw new RtdbError(ERROR_CODE.DatabaseNotFound, `Database does not exist: ${databaseDirectory}`);
  }
  const dayLabel = formatDateFolderName(dateNumber);
  const archiveFilePath = join(
    archiveDirectoryPath(store.dataDir),
    database,
    `${dayLabel}${ARCHIVE_FILE_EXTENSION}`,
  );
  if (!existsSync(archiveFilePath)) {
    throw new RtdbError(ERROR_CODE.DatabaseNotFound, `Day archive does not exist: ${archiveFilePath}`);
  }

  const lock = new DataRootLock({ dataDir: store.dataDir });
  lock.acquire();
  try {
    const targetDayDirectory = store.dayDirectoryPath(database, dateNumber);
    const extracted = extractTarGzipArchive({ archiveFilePath, targetDayDirectory });
    recoverDataRoot({ store, databases: [database] });
    return {
      database,
      dateNumber,
      dayLabel,
      sourceArchiveFilePath: archiveFilePath,
      targetDayDirectory,
      fileCount: extracted.fileCount,
      totalBytes: extracted.totalBytes,
    };
  } finally {
    store.close();
    lock.release();
  }
}

/* ---------- retention (read-only) ---------- */

/** Read the database-level retention override from `{dataDir}/{database}/retention.json`; `null` when absent */
export { readDatabaseRetentionDays as readRetentionDays } from '../../core/src/size.ts';
