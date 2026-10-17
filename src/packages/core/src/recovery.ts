// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Startup recovery: per-segment inspection (half-block truncation + `.idx` mirror rebuild) -> WAL replay
 * (aligned with Detailed Design v1.7 §2.8)
 *
 * Call sequence (the data root lock is held by the caller first; this module does **not** lock):
 *   1. `DataRootLock.acquire()` (step 1 of engine.open)
 *   2. `recoverDataRoot()`:
 *      a. Walk every day directory of every database -> per capacity segment: sequentially scan blocks to get
 *         the real block region + re-check the last block CRC
 *         - Last block CRC failure / trailing partial block -> truncate to after the last complete block
 *           (recorded in the report)
 *         - Sealed but `.idx` missing or inconsistent with the actual block region -> atomically rebuild the
 *           mirror from the scan result
 *      b. Read `.wal` per day: complete lines are parsed into entries and returned; **a trailing power-loss
 *         half line is truncated** (`repairWalFileTail`)
 *   3. The caller feeds `replayedEntries` into the write-path buffer (skipping `(metric, ts)` already present
 *      in segments for idempotency)
 *
 * Idempotency: the segment side only does "truncate + mirror rebuild", so repeated runs leave the result
 * unchanged; the WAL side only does "read + half-line truncation" and does not delete complete lines —
 * cleanup of complete lines is handled by the safe-point truncation after the write path flushes segments
 * (see `wal.ts`).
 *
 * Not done (M0 boundary): segments with a corrupt segment header are not quarantined (the quarantine unit is
 * the day directory, part of S7); sealed segments are neither reordered nor rewritten; unsealed segments
 * left over from the previous crash are not auto-sealed (the read path already supports Footer-less
 * segments; `.idx` rebuild only applies to sealed segments).
 */

import { truncateSync } from 'node:fs';

import { ERROR_CODE, RtdbError } from './errors.ts';
import { SegmentReader } from './segment-reader.ts';
import type { SegmentStore } from './segment-store.ts';
import { readWalFileEntries, repairWalFileTail } from './wal.ts';
import type { WalEntry } from './wal.ts';

/* ---------- Public types ---------- */

export interface RecoveryOptions {
  /** Segment store (provides the data root/database/day directory/segment path scope) */
  store: SegmentStore;
  /** Segment reader (created by default; pass one to reuse its block cache and handle LRU) */
  reader?: SegmentReader;
  /** Databases to limit recovery to (defaults to scanning all database directories under the data root) */
  databases?: readonly string[];
  /** Whether to verify and rebuild the `.idx` mirror when inconsistent; default true */
  verifyIndexMirror?: boolean;
}

export interface SegmentRecoveryReport {
  database: string;
  dateNumber: number;
  sequence: number;
  segmentFilePath: string;
  /** Whether it was sealed at inspection time (a valid Footer exists at the end of the block region) */
  sealed: boolean;
  /** Number of complete blocks found by scanning */
  scannedBlockCount: number;
  /** Trailing garbage bytes truncated this time (0 = no truncation) */
  truncatedBytes: number;
  /** Whether the `.idx` mirror was rebuilt */
  indexRebuilt: boolean;
}

export interface WalRecoveryReport {
  database: string;
  dateNumber: number;
  walFilePath: string;
  /** Number of entries parsed from complete lines */
  entryCount: number;
  /** Bytes of the trailing partial line that were truncated */
  discardedTailBytes: number;
  fileBytes: number;
}

export interface DatabaseRecoveryReport {
  database: string;
  segments: SegmentRecoveryReport[];
  walFiles: WalRecoveryReport[];
  /** Entries for the caller to replay (concatenated per day file, in write order) */
  replayedEntries: WalEntry[];
}

export interface RecoveryReport {
  databases: DatabaseRecoveryReport[];
  /** Number of segments inspected */
  segmentCount: number;
  /** Number of segments with a truncated half block */
  truncatedSegmentCount: number;
  /** Total truncated bytes */
  truncatedBytes: number;
  /** Number of segments whose `.idx` mirror was rebuilt */
  rebuiltIndexCount: number;
  /** Total WAL replay entries */
  replayedEntryCount: number;
  /** Total discarded WAL trailing partial-line bytes */
  discardedWalTailBytes: number;
}

/* ---------- Recovery entry point ---------- */

/**
 * Perform data root recovery (idempotent); the caller must obtain the data root lock **first**
 *
 * When the data root does not exist (no database yet), returns an empty report without throwing.
 */
export function recoverDataRoot(options: RecoveryOptions): RecoveryReport {
  const store = options.store;
  const reader = options.reader ?? new SegmentReader({ store });
  const verifyIndexMirror = options.verifyIndexMirror ?? true;
  const databases = options.databases === undefined ? store.listDatabases() : [...options.databases];

  const report: RecoveryReport = {
    databases: [],
    segmentCount: 0,
    truncatedSegmentCount: 0,
    truncatedBytes: 0,
    rebuiltIndexCount: 0,
    replayedEntryCount: 0,
    discardedWalTailBytes: 0,
  };

  for (const database of databases) {
    const databaseReport: DatabaseRecoveryReport = {
      database,
      segments: [],
      walFiles: [],
      replayedEntries: [],
    };

    for (const dateNumber of store.listDayDirectories(database)) {
      for (const sequence of store.listSegmentSequences(database, dateNumber)) {
        const inspection = reader.inspectSegment(database, dateNumber, sequence);
        if (inspection === null) continue;

        let truncatedBytes = 0;
        if (inspection.truncatedBytes > 0) {
          try {
            truncateSync(inspection.segmentFilePath, inspection.blockRegionEnd);
          } catch (error) {
            throw new RtdbError(
              ERROR_CODE.Io,
              `Failed to truncate the segment file tail: ${inspection.segmentFilePath} (${(error as Error).message})`,
            );
          }
          truncatedBytes = inspection.truncatedBytes;
        }

        let indexRebuilt = false;
        if (verifyIndexMirror && inspection.indexMirrorRebuildNeeded) {
          store.writeIndexMirror(database, dateNumber, sequence, inspection.entries);
          indexRebuilt = true;
        }

        databaseReport.segments.push({
          database,
          dateNumber,
          sequence,
          segmentFilePath: inspection.segmentFilePath,
          sealed: inspection.sealed,
          scannedBlockCount: inspection.entries.length,
          truncatedBytes,
          indexRebuilt,
        });
        report.segmentCount += 1;
        report.truncatedBytes += truncatedBytes;
        if (truncatedBytes > 0) report.truncatedSegmentCount += 1;
        if (indexRebuilt) report.rebuiltIndexCount += 1;
      }

      const walFilePath = store.walFilePath(database, dateNumber);
      const walReport = readWalFileEntries(walFilePath, dateNumber);
      if (walReport.fileBytes === 0) continue;

      const discardedTailBytes = repairWalFileTail(walFilePath, walReport.validBytes);
      databaseReport.walFiles.push({
        database,
        dateNumber,
        walFilePath,
        entryCount: walReport.entries.length,
        discardedTailBytes,
        fileBytes: walReport.fileBytes,
      });
      databaseReport.replayedEntries.push(...walReport.entries);
      report.replayedEntryCount += walReport.entries.length;
      report.discardedWalTailBytes += discardedTailBytes;
    }

    report.databases.push(databaseReport);
  }

  return report;
}
