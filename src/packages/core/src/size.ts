// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * On-disk measurement of a database (whole directory + per-day detail) and the retention-policy read.
 *
 * Why this lives in `core`: both `rtdbctl size` (offline) and the server's management API (online, see
 * `GET /api/v1/databases/{db}`) need the same arithmetic. Keeping it in `cli` would force `server -> cli`,
 * which inverts the dependency direction (`cli` already depends on `server`).
 *
 * Scope: pure filesystem arithmetic — **no data-root lock is taken**. It is intentionally safe to run while
 * the server is writing: sizes are a point-in-time snapshot (an active segment may grow right after the
 * measurement), which matches the "statistics are cacheable" contract of the management console.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

import { ERROR_CODE, RtdbError } from './errors.ts';
import { INDEX_EXTENSION, SEGMENT_EXTENSION, WAL_EXTENSION, formatDateFolderName } from './format.ts';
import { directoryExists, measureDirectory } from './retention.ts';
import { SegmentStore } from './segment-store.ts';

/* ---------- Public types ---------- */

/** Footprint of one day directory (`yyyyMMdd/`) */
export interface DaySizeEntry {
  dateNumber: number;
  /** `yyyyMMdd` label */
  dayLabel: string;
  fileCount: number;
  totalBytes: number;
}

/** Byte split by file role (management console shows segments / WAL / index separately) */
export interface DatabaseSizeBreakdown {
  segmentBytes: number;
  indexBytes: number;
  walBytes: number;
  otherBytes: number;
}

/** On-disk footprint of a database */
export interface DatabaseSizeReport {
  database: string;
  /** Absolute database directory */
  directory: string;
  fileCount: number;
  totalBytes: number;
  /** Byte split by file role */
  breakdown: DatabaseSizeBreakdown;
  /** Database-level retention override from `retention.json`; `null` = absent (global default applies) */
  retentionDays: number | null;
  /** Per-day detail (`yyyyMMdd` ascending) */
  days: DaySizeEntry[];
}

/* ---------- Measurement ---------- */

/** Measure the on-disk footprint of a database (recursive; the whole database directory plus the per-day detail) */
export function measureDatabaseSize(dataDir: string, database: string): DatabaseSizeReport {
  const store = new SegmentStore({ dataDir });
  const directory = store.databaseDirectoryPath(database);
  if (!directoryExists(directory)) {
    throw new RtdbError(ERROR_CODE.DatabaseNotFound, `Database does not exist: ${directory}`);
  }
  try {
    const total = measureDirectory(directory);
    const days: DaySizeEntry[] = store.listDayDirectories(database).map((dateNumber) => {
      const measured = measureDirectory(store.dayDirectoryPath(database, dateNumber));
      return {
        dateNumber,
        dayLabel: formatDateFolderName(dateNumber),
        fileCount: measured.fileCount,
        totalBytes: measured.totalBytes,
      };
    });
    return {
      database,
      directory,
      fileCount: total.fileCount,
      totalBytes: total.totalBytes,
      breakdown: measureBreakdown(directory, store.listDayDirectories(database)),
      retentionDays: readDatabaseRetentionDays(dataDir, database),
      days,
    };
  } finally {
    store.close();
  }
}

/** Split a database's bytes by file role (`.seg` / `.idx` / `.wal` / everything else) */
function measureBreakdown(databaseDirectory: string, dayNumbers: readonly number[]): DatabaseSizeBreakdown {
  const breakdown: DatabaseSizeBreakdown = {
    segmentBytes: 0,
    indexBytes: 0,
    walBytes: 0,
    otherBytes: 0,
  };
  const collect = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      let bytes = 0;
      try {
        bytes = statSync(join(directory, entry.name)).size;
      } catch {
        continue;
      }
      if (entry.name.endsWith(SEGMENT_EXTENSION)) breakdown.segmentBytes += bytes;
      else if (entry.name.endsWith(INDEX_EXTENSION)) breakdown.indexBytes += bytes;
      else if (entry.name.endsWith(WAL_EXTENSION)) breakdown.walBytes += bytes;
      else breakdown.otherBytes += bytes;
    }
  };
  collect(databaseDirectory);
  for (const dateNumber of dayNumbers) {
    collect(join(databaseDirectory, formatDateFolderName(dateNumber)));
  }
  return breakdown;
}

/**
 * Read the database-level retention override from `{dataDir}/{database}/retention.json`; `null` when absent.
 *
 * The file name is duplicated from `engine.ts` on purpose: `engine.ts` imports this module, so importing the
 * constant back would create a cycle.
 */
export function readDatabaseRetentionDays(dataDir: string, database: string): number | null {
  return readRetentionDaysFromDirectory(join(resolve(dataDir), database));
}

const RETENTION_FILE_NAME = 'retention.json';

function readRetentionDaysFromDirectory(directory: string): number | null {
  let text: string;
  try {
    text = readFileSync(join(directory, RETENTION_FILE_NAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RtdbError(
      ERROR_CODE.Io,
      `Failed to read the retention policy file under ${directory}: ${(error as Error).message}`,
    );
  }
  let parsed: { retentionDays?: unknown };
  try {
    parsed = JSON.parse(text) as { retentionDays?: unknown };
  } catch {
    return null;
  }
  const days = parsed.retentionDays;
  if (typeof days !== 'number' || !Number.isInteger(days)) return null;
  return days;
}
