// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Data root lock: only one process may open a data root directory at a time (aligned with
 * Detailed Design v1.7 §2.3, §2.8)
 *
 * Purpose: Form A (direct library integration) and Form B (rtdb-server) share the same directory
 * format; if two processes opened it simultaneously, interleaved segment/index/WAL writes would
 * corrupt the data. Hence a "data root + exclusive lock file" guarantees mutual exclusion.
 *
 * Implementation scope:
 *   - Lock file `{dataDir}/lock`, whose content is JSON `{"processId":1234,"acquiredAt":1699999999999}`
 *   - Acquisition uses **O_EXCL exclusive creation** (`'wx'`) + immediate write + fsync, avoiding the
 *     window where "the file exists but its content has not landed"
 *   - Conflict determination: the lock file exists and its owner process is **alive** → throws
 *     `E_DB_LOCKED`; if the process no longer exists (stale lock), it is cleaned up and retried
 *   - If an instance in this process already holds it → throws `E_DB_LOCKED` directly (two instances
 *     in the same process are mutually exclusive, preventing release from deleting another's lock)
 *
 * Liveness scope: `process.kill(processId, 0)` succeeding or throwing `EPERM` (process exists but no
 *             permission) counts as alive; `ESRCH` and other failures plus invalid pids (≤0 /
 *             non-integer) all count as dead.
 */

import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ERROR_CODE, RtdbError, isRtdbError } from './errors.ts';

/* ---------- Constants ---------- */

/** Lock file name (under the data root directory) */
export const LOCK_FILE_NAME = 'lock';

/** Data root lock paths already held in this process (cross-instance exclusion check) */
const IN_PROCESS_HELD_LOCK_PATHS = new Set<string>();

/* ---------- Public types ---------- */

export interface DataRootLockOptions {
  /** Data root directory (same directory as `SegmentStore.dataDir`) */
  dataDir: string;
}

/** Lock owner info (lock file content) */
export interface LockOwner {
  /** Owner process id */
  processId: number;
  /** Acquisition time (ms epoch) */
  acquiredAt: number;
}

export interface LockAcquisition {
  owner: LockOwner;
  /** Whether this acquisition cleaned up a stale lock (for the startup recovery log) */
  reclaimedStale: boolean;
}

/* ---------- Data root lock ---------- */

export class DataRootLock {
  /** Data root directory (absolute path) */
  readonly dataDir: string;
  /** Absolute path of the lock file */
  readonly lockFilePath: string;

  private held = false;

  constructor(options: DataRootLockOptions) {
    this.dataDir = resolve(options.dataDir);
    this.lockFilePath = join(this.dataDir, LOCK_FILE_NAME);
  }

  /** Whether this instance holds the lock */
  get isHeld(): boolean {
    return this.held;
  }

  /**
   * Acquire the lock: exclusive creation → write owner → fsync; throws `E_DB_LOCKED` if held by a
   * live process
   *
   * A stale lock (whose owner process is dead) is cleaned up automatically and retried once;
   * acquiring again on the same instance throws `E_INTERNAL`.
   */
  acquire(): LockAcquisition {
    if (this.held) {
      throw new RtdbError(ERROR_CODE.Internal, `This instance already holds the data root lock: ${this.lockFilePath}`);
    }
    if (IN_PROCESS_HELD_LOCK_PATHS.has(this.lockFilePath)) {
      throw new RtdbError(
        ERROR_CODE.DatabaseLocked,
        `Data root already opened by another instance in this process: ${this.dataDir}`,
      );
    }

    let reclaimedStale = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const owner: LockOwner = { processId: process.pid, acquiredAt: Date.now() };
      try {
        const fileDescriptor = openSync(this.lockFilePath, 'wx');
        try {
          const line = `${JSON.stringify(owner)}\n`;
          writeSync(fileDescriptor, line, null, 'utf8');
          fsyncSync(fileDescriptor);
        } finally {
          closeSync(fileDescriptor);
        }
        IN_PROCESS_HELD_LOCK_PATHS.add(this.lockFilePath);
        this.held = true;
        return { owner, reclaimedStale };
      } catch (error) {
        if (isRtdbError(error)) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new RtdbError(
            ERROR_CODE.Io,
            `Failed to create the data root lock file: ${this.lockFilePath} (${(error as Error).message})`,
          );
        }
      }

      const existing = this.readOwner();
      if (existing !== null && isProcessAlive(existing.processId)) {
        throw new RtdbError(
          ERROR_CODE.DatabaseLocked,
          `Data root already opened by process ${existing.processId} (acquiredAt=${new Date(existing.acquiredAt).toISOString()}): ${this.dataDir}`,
        );
      }

      // Stale lock: owner process is dead / lock file content is unparsable → clean up and retry
      try {
        unlinkSync(this.lockFilePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new RtdbError(
            ERROR_CODE.Io,
            `Failed to clean up the stale lock file: ${this.lockFilePath} (${(error as Error).message})`,
          );
        }
      }
      reclaimedStale = true;
    }

    throw new RtdbError(ERROR_CODE.DatabaseLocked, `Data root lock contention failed (still occupied after retry): ${this.dataDir}`);
  }

  /** Release the lock (idempotent): deletes the lock file only when this instance holds it; returns false silently otherwise */
  release(): boolean {
    if (!this.held) return false;
    IN_PROCESS_HELD_LOCK_PATHS.delete(this.lockFilePath);
    this.held = false;
    try {
      unlinkSync(this.lockFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new RtdbError(
          ERROR_CODE.Io,
          `Failed to delete the data root lock file: ${this.lockFilePath} (${(error as Error).message})`,
        );
      }
    }
    return true;
  }

  /** Read the current lock file owner; returns null if the file is missing or its content is unparsable (= treated as a stale lock) */
  readOwner(): LockOwner | null {
    let text: string;
    try {
      text = readFileSync(this.lockFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new RtdbError(
        ERROR_CODE.Io,
        `Failed to read the data root lock file: ${this.lockFilePath} (${(error as Error).message})`,
      );
    }
    try {
      const parsed = JSON.parse(text) as { processId?: unknown; acquiredAt?: unknown };
      const processId = parsed.processId;
      const acquiredAt = parsed.acquiredAt;
      if (typeof processId !== 'number' || !Number.isInteger(processId) || processId <= 0) return null;
      if (typeof acquiredAt !== 'number' || !Number.isFinite(acquiredAt)) return null;
      return { processId, acquiredAt };
    } catch {
      return null;
    }
  }
}

/* ---------- Utilities ---------- */

/** Process liveness check: success or `EPERM` (exists but no permission) counts as alive; invalid pids and other failures count as dead */
export function isProcessAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
