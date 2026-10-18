// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Quality store policy and quality propagation tests (Storage Design §3.1.5 / §3.1.6):
 * global `qualityStore` / `qualityOnReject`, per-database `quality.json` overrides, the
 * `write.qualityDropped` counter, and `queryAt` quality inheritance / interpolation.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { RtdbEngine } from '../packages/core/src/engine.ts';
import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import {
  QUALITY,
  QUALITY_REASON,
  QUALITY_SEVERITY,
  QUALITY_SOURCE,
  composeQuality,
} from '../packages/core/src/quality.ts';
import type { EngineOptions, WritePoint } from '../packages/core/src/types.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-quality-'));
/** Fixed base day (10:00) keeps timestamps away from day boundaries */
const BASE = new Date(2026, 0, 12, 10, 0, 0).getTime();
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

function createDataDir(): string {
  caseCounter += 1;
  return join(rootDirectory, `case-${caseCounter}`);
}

async function openEngine(dataDir: string, options: Omit<EngineOptions, 'dataDir'> = {}): Promise<RtdbEngine> {
  const engine = new RtdbEngine({ dataDir, ...options });
  await engine.open();
  return engine;
}

/** Uncertain / Process / OutOfRange (0x43) */
const UNCERTAIN_OUT_OF_RANGE = composeQuality(
  QUALITY_SEVERITY.uncertain,
  QUALITY_SOURCE.process,
  QUALITY_REASON.outOfRange,
);

describe('quality store: global defaults and reject', () => {
  it('default all keeps Good / Uncertain / Bad and leaves qualityDropped at 0', async () => {
    const engine = await openEngine(createDataDir());
    try {
      const points: WritePoint[] = [
        { metricName: 'm', timestamp: BASE, value: 1, quality: QUALITY.good },
        { metricName: 'm', timestamp: BASE + 1000, value: 2, quality: UNCERTAIN_OUT_OF_RANGE },
        { metricName: 'm', timestamp: BASE + 2000, value: 3, quality: QUALITY.badCommFailure },
      ];
      const result = await engine.writeBatch('plant', points);
      assert.equal(result.accepted, 3);

      const series = await engine.queryRange('plant', 'm', { start: BASE, end: BASE + 2000 });
      assert.equal(series.points.length, 3);
      assert.deepStrictEqual(series.points[0], { timestamp: BASE, value: 1 });
      assert.equal(series.points[1].quality, UNCERTAIN_OUT_OF_RANGE);
      assert.equal(series.points[2].quality, QUALITY.badCommFailure);

      const stats = await engine.stats();
      assert.equal(stats.write.qualityDropped, 0);
    } finally {
      await engine.close();
    }
  });

  it("store='good' + onReject='reject' fails the whole batch with E_QUALITY_REJECTED before the WAL", async () => {
    const engine = await openEngine(createDataDir(), { qualityStore: 'good' });
    try {
      await assert.rejects(
        engine.writeBatch('plant', [
          { metricName: 'm', timestamp: BASE, value: 1 },
          { metricName: 'm', timestamp: BASE + 1000, value: 2, quality: QUALITY.badStale },
        ]),
        (error) => isRtdbError(error) && error.code === ERROR_CODE.QualityRejected,
      );

      const stats = await engine.stats();
      assert.equal(stats.write.acceptedPoints, 0);
      assert.equal(stats.write.qualityDropped, 0);
      assert.equal(stats.wal.pendingBytes, 0, 'rejected batch must not reach the WAL');

      const series = await engine.queryRange('plant', 'm', { start: BASE, end: BASE + 1000 });
      assert.equal(series.points.length, 0);
    } finally {
      await engine.close();
    }
  });
});

describe('quality store: drop and good-uncertain', () => {
  it("store='good' + onReject='drop' drops Bad, keeps Good and counts qualityDropped", async () => {
    const engine = await openEngine(createDataDir(), { qualityStore: 'good', qualityOnReject: 'drop' });
    try {
      const result = await engine.writeBatch('plant', [
        { metricName: 'm', timestamp: BASE, value: 1 },
        { metricName: 'm', timestamp: BASE + 1000, value: 2, quality: QUALITY.badStale },
        { metricName: 'm', timestamp: BASE + 2000, value: 3, quality: QUALITY.uncertain },
        { metricName: 'm', timestamp: BASE + 3000, value: 4 },
      ]);
      assert.equal(result.accepted, 2, 'only the Good points are accepted');

      const series = await engine.queryRange('plant', 'm', { start: BASE, end: BASE + 3000 });
      assert.deepStrictEqual(
        series.points.map((point) => point.timestamp),
        [BASE, BASE + 3000],
      );

      const stats = await engine.stats();
      assert.equal(stats.write.qualityDropped, 2);
      assert.equal(stats.write.acceptedPoints, 2);
    } finally {
      await engine.close();
    }
  });

  it("store='good-uncertain' + drop drops Bad and Reserved but keeps Uncertain", async () => {
    const engine = await openEngine(createDataDir(), {
      qualityStore: 'good-uncertain',
      qualityOnReject: 'drop',
    });
    try {
      const reserved = composeQuality(
        QUALITY_SEVERITY.reserved,
        QUALITY_SOURCE.process,
        QUALITY_REASON.none,
      );
      const result = await engine.writeBatch('plant', [
        { metricName: 'm', timestamp: BASE, value: 1, quality: QUALITY.uncertain },
        { metricName: 'm', timestamp: BASE + 1000, value: 2, quality: reserved },
        { metricName: 'm', timestamp: BASE + 2000, value: 3, quality: QUALITY.bad },
      ]);
      assert.equal(result.accepted, 1, 'Reserved is read as Bad and rejected by the policy');

      const stats = await engine.stats();
      assert.equal(stats.write.qualityDropped, 2);
    } finally {
      await engine.close();
    }
  });

  it('a fully dropped batch returns accepted=0 and leaves nothing queryable', async () => {
    const engine = await openEngine(createDataDir(), { qualityStore: 'good', qualityOnReject: 'drop' });
    try {
      const result = await engine.writeBatch('plant', [
        { metricName: 'm', timestamp: BASE, value: 1, quality: QUALITY.bad },
      ]);
      assert.equal(result.accepted, 0);
      const series = await engine.queryRange('plant', 'm', { start: BASE, end: BASE });
      assert.equal(series.points.length, 0);
      const stats = await engine.stats();
      assert.equal(stats.write.qualityDropped, 1);
      assert.equal(stats.write.pointsPerSec, 0, 'no accepted point means no throughput base');
    } finally {
      await engine.close();
    }
  });
});

describe('quality store: per-database quality.json override', () => {
  it('quality.json {store:"good"} overrides the global all and survives a restart', async () => {
    const dataDir = createDataDir();
    const first = await openEngine(dataDir);
    await first.writeBatch('plant', [{ metricName: 'm', timestamp: BASE, value: 1 }]);
    await first.close();

    writeFileSync(join(dataDir, 'plant', 'quality.json'), `${JSON.stringify({ store: 'good' })}\n`, 'utf8');

    const second = await openEngine(dataDir);
    try {
      await assert.rejects(
        second.writeBatch('plant', [
          { metricName: 'm', timestamp: BASE + 1000, value: 2, quality: QUALITY.bad },
        ]),
        (error) => isRtdbError(error) && error.code === ERROR_CODE.QualityRejected,
      );
      // Another database without the override still uses the global `all`
      const other = await second.writeBatch('other', [
        { metricName: 'm', timestamp: BASE, value: 1, quality: QUALITY.bad },
      ]);
      assert.equal(other.accepted, 1);
    } finally {
      await second.close();
    }
  });

  it('an unknown store value in quality.json inherits the global default', async () => {
    const dataDir = createDataDir();
    const first = await openEngine(dataDir);
    await first.writeBatch('plant', [{ metricName: 'm', timestamp: BASE, value: 1 }]);
    await first.close();

    writeFileSync(join(dataDir, 'plant', 'quality.json'), '{"store":"unknown"}\n', 'utf8');

    const second = await openEngine(dataDir);
    try {
      const result = await second.writeBatch('plant', [
        { metricName: 'm', timestamp: BASE + 1000, value: 2, quality: QUALITY.bad },
      ]);
      assert.equal(result.accepted, 1);
    } finally {
      await second.close();
    }
  });
});

describe('queryAt quality propagation (Storage Design §3.1.6)', () => {
  it('exact/step inherit the stored flag; linear uses the worse severity, Interpolated source and worse reason', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('plant', [
        { metricName: 'm', timestamp: BASE, value: 10 },
        { metricName: 'm', timestamp: BASE + 1000, value: 20, quality: UNCERTAIN_OUT_OF_RANGE },
        { metricName: 'm', timestamp: BASE + 2000, value: 30, quality: QUALITY.badCommFailure },
      ]);

      const exact = await engine.queryAt('plant', 'm', { timestamps: [BASE, BASE + 1000] });
      assert.deepStrictEqual(exact[0], { timestamp: BASE, value: 10, state: 'exact' });
      assert.equal(exact[1].quality, UNCERTAIN_OUT_OF_RANGE);
      assert.equal(exact[1].state, 'exact');

      const step = await engine.queryAt('plant', 'm', { timestamps: [BASE + 500] });
      assert.equal(step[0].value, 10);
      assert.equal(step[0].quality, undefined);
      assert.equal(step[0].state, 'exact');

      const linear = await engine.queryAt('plant', 'm', {
        timestamps: [BASE + 1500],
        mode: 'linear',
      });
      assert.equal(linear[0].value, 25);
      assert.equal(linear[0].state, 'interpolated');
      assert.equal(
        linear[0].quality,
        composeQuality(
          QUALITY_SEVERITY.bad,
          QUALITY_SOURCE.interpolated,
          QUALITY_REASON.commFailure,
        ),
      );

      const extrapolated = await engine.queryAt('plant', 'm', {
        timestamps: [BASE - 1000, BASE + 3000],
        mode: 'linear',
      });
      assert.equal(extrapolated[0].state, 'extrapolated');
      assert.equal(extrapolated[0].quality, undefined, 'Good quality is omitted');
      assert.equal(extrapolated[1].quality, QUALITY.badCommFailure);
    } finally {
      await engine.close();
    }
  });
});
