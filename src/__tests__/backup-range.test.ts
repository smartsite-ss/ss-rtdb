// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Day-granular range backup and merge restore (Detailed Design §2.9):
 *
 * - a range backup copies only the selected day directories (plus the retention policy file) and writes a
 *   `manifest.json`
 * - restoring a range backup merges those days into the target database and never deletes days outside the
 *   backup (a full backup keeps replacing the whole database)
 * - invalid ranges, empty ranges and malformed manifests fail loudly instead of degrading into a whole
 *   database replacement
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BACKUP_MANIFEST_FILE_NAME, RtdbEngine } from '../packages/core/src/engine.ts';
import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import { dateNumberFromTimestamp } from '../packages/core/src/format.ts';
import type { WritePoint } from '../packages/core/src/types.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-backup-range-'));
const DAY_MS = 86_400_000;
const METRIC = 'backup.range.signal';
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/* ---------- Fixtures ---------- */

function createWorkDir(): string {
  caseCounter += 1;
  return join(rootDirectory, `case-${caseCounter}`);
}

function expectCode(error: unknown, code: string): boolean {
  return isRtdbError(error) && error.code === code;
}

/** Local midnight of 2026-03-10 + `offset` days (day directories follow the local timezone) */
function dayStartAt(offset: number): number {
  return new Date(2026, 2, 10 + offset, 0, 0, 0, 0).getTime();
}

function dayNumberOf(offset: number): number {
  return dateNumberFromTimestamp(dayStartAt(offset));
}

function pointOnDay(offset: number, value: number): WritePoint {
  return { metricName: METRIC, timestamp: dayStartAt(offset) + 3_600_000, value };
}

async function openEngine(dataDir: string): Promise<RtdbEngine> {
  const engine = new RtdbEngine({ dataDir });
  await engine.open();
  return engine;
}

/* ---------- Range backup ---------- */

describe('Range backup', () => {
  it('copies only the selected day directory and records a manifest', async () => {
    const engine = await openEngine(join(createWorkDir(), 'data'));
    const backupRoot = join(createWorkDir(), 'backup');
    try {
      for (let offset = 0; offset < 3; offset += 1) {
        await engine.writeBatch('db', [pointOnDay(offset, offset + 1)]);
      }

      const result = await engine.backup('db', backupRoot, {
        startDay: dayNumberOf(1),
        endDay: dayNumberOf(1),
      });

      assert.equal(result.partial, true);
      assert.deepStrictEqual(result.days, [dayNumberOf(1)]);
      assert.equal(result.range?.startDay, dayNumberOf(1));
      assert.equal(result.range?.endDay, dayNumberOf(1));
      assert.equal(result.range?.dayCount, 1);
      assert.equal(result.range?.startTimestamp, dayStartAt(1));
      assert.equal(result.range?.endTimestamp, dayStartAt(2) - 1);
      assert.ok(result.fileCount > 0);

      const backupDirectory = join(backupRoot, 'db');
      assert.equal(existsSync(join(backupDirectory, String(dayNumberOf(0)))), false);
      assert.equal(existsSync(join(backupDirectory, String(dayNumberOf(1)))), true);
      assert.equal(existsSync(join(backupDirectory, String(dayNumberOf(2)))), false);

      const manifest = JSON.parse(readFileSync(join(backupDirectory, BACKUP_MANIFEST_FILE_NAME), 'utf8')) as {
        mode: string;
        days: number[];
      };
      assert.equal(manifest.mode, 'range');
      assert.deepStrictEqual(manifest.days, [dayNumberOf(1)]);
    } finally {
      await engine.close();
    }
  });

  it('an unbounded range only needs one bound and clamps to the available days', async () => {
    const engine = await openEngine(join(createWorkDir(), 'data'));
    const backupRoot = join(createWorkDir(), 'backup');
    try {
      for (let offset = 0; offset < 3; offset += 1) {
        await engine.writeBatch('db', [pointOnDay(offset, offset + 1)]);
      }
      const result = await engine.backup('db', backupRoot, { startDay: dayNumberOf(1) });
      assert.equal(result.partial, true);
      assert.deepStrictEqual(result.days, [dayNumberOf(1), dayNumberOf(2)]);
      assert.equal(result.range?.endDay, dayNumberOf(2));
    } finally {
      await engine.close();
    }
  });

  it('a whole-database backup carries no manifest and is not partial', async () => {
    const engine = await openEngine(join(createWorkDir(), 'data'));
    const backupRoot = join(createWorkDir(), 'backup');
    try {
      await engine.writeBatch('db', [pointOnDay(0, 1), pointOnDay(1, 2)]);
      const result = await engine.backup('db', backupRoot);
      assert.equal(result.partial, false);
      assert.equal(result.range, undefined);
      assert.equal(existsSync(join(backupRoot, 'db', BACKUP_MANIFEST_FILE_NAME)), false);
      assert.equal(existsSync(join(backupRoot, 'db', String(dayNumberOf(0)))), true);
      assert.equal(existsSync(join(backupRoot, 'db', String(dayNumberOf(1)))), true);
    } finally {
      await engine.close();
    }
  });

  it('rejects an inverted, empty or invalid range', async () => {
    const engine = await openEngine(join(createWorkDir(), 'data'));
    const backupRoot = join(createWorkDir(), 'backup');
    try {
      await engine.writeBatch('db', [pointOnDay(1, 1)]);

      await assert.rejects(
        engine.backup('db', backupRoot, { startDay: dayNumberOf(2), endDay: dayNumberOf(1) }),
        (error) => expectCode(error, ERROR_CODE.InvalidRange),
      );
      await assert.rejects(
        engine.backup('db', backupRoot, { startDay: 20200101, endDay: 20200102 }),
        (error) => expectCode(error, ERROR_CODE.InvalidRange),
      );
      await assert.rejects(
        engine.backup('db', backupRoot, { startDay: 20260230 }),
        (error) => expectCode(error, ERROR_CODE.InvalidRange),
      );
    } finally {
      await engine.close();
    }
  });
});

/* ---------- Merge restore ---------- */

describe('Merge restore', () => {
  it('merges the backed-up days into the database and keeps every other day', async () => {
    const source = await openEngine(join(createWorkDir(), 'source'));
    const backupRoot = join(createWorkDir(), 'backup');
    try {
      for (let offset = 0; offset < 3; offset += 1) {
        await source.writeBatch('db', [pointOnDay(offset, offset + 1)]);
      }
      await source.backup('db', backupRoot, { startDay: dayNumberOf(1), endDay: dayNumberOf(1) });
    } finally {
      await source.close();
    }

    const target = await openEngine(join(createWorkDir(), 'target'));
    try {
      // The live database holds the neighbouring days; the range restore must not delete them.
      await target.writeBatch('db', [pointOnDay(0, 100), pointOnDay(2, 300)]);

      const restored = await target.restore(backupRoot, 'db');
      assert.equal(restored.mode, 'merge');
      assert.deepStrictEqual(restored.days, [dayNumberOf(1)]);
      assert.equal(existsSync(join(backupRoot, 'db', BACKUP_MANIFEST_FILE_NAME)), true);

      const series = await target.queryRange('db', METRIC, {
        start: dayStartAt(0),
        end: dayStartAt(2) + DAY_MS - 1,
      });
      assert.deepStrictEqual(
        series.points.map((point) => point.value),
        [100, 2, 300],
      );
    } finally {
      await target.close();
    }
  });

  it('a full backup still replaces the whole database', async () => {
    const source = await openEngine(join(createWorkDir(), 'source'));
    const backupRoot = join(createWorkDir(), 'backup');
    try {
      await source.writeBatch('db', [pointOnDay(1, 2)]);
      await source.backup('db', backupRoot);
    } finally {
      await source.close();
    }

    const target = await openEngine(join(createWorkDir(), 'target'));
    try {
      await target.writeBatch('db', [pointOnDay(0, 100), pointOnDay(2, 300)]);
      const restored = await target.restore(backupRoot, 'db');
      assert.equal(restored.mode, 'replace');

      const series = await target.queryRange('db', METRIC, {
        start: dayStartAt(0),
        end: dayStartAt(2) + DAY_MS - 1,
      });
      assert.deepStrictEqual(
        series.points.map((point) => point.value),
        [2],
      );
    } finally {
      await target.close();
    }
  });

  it('a malformed manifest fails the restore instead of replacing the database', async () => {
    const source = await openEngine(join(createWorkDir(), 'source'));
    const backupRoot = join(createWorkDir(), 'backup');
    try {
      await source.writeBatch('db', [pointOnDay(1, 2)]);
      await source.backup('db', backupRoot, { startDay: dayNumberOf(1), endDay: dayNumberOf(1) });
    } finally {
      await source.close();
    }
    writeFileSync(join(backupRoot, 'db', BACKUP_MANIFEST_FILE_NAME), '{ not json', 'utf8');

    const target = await openEngine(join(createWorkDir(), 'target'));
    try {
      await target.writeBatch('db', [pointOnDay(0, 100)]);
      await assert.rejects(
        target.restore(backupRoot, 'db'),
        (error) => expectCode(error, ERROR_CODE.Io),
      );
      // The live day survives the failed restore.
      const series = await target.queryRange('db', METRIC, {
        start: dayStartAt(0),
        end: dayStartAt(0) + DAY_MS - 1,
      });
      assert.deepStrictEqual(
        series.points.map((point) => point.value),
        [100],
      );
    } finally {
      await target.close();
    }
  });
});
