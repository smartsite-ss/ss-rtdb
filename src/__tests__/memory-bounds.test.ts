// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Memory-bound regression tests (2026-10-18 incident: one long-range query materialized every hit
 * point, ~2 GB heap growth on a full-day `count exact` over ~11.65M points/day)
 *
 * The suites below write 1M points into sealed blocks and then run the query primitives that used to
 * materialize the full hit set (`count exact`, window aggregation, `queryAt`, descending range read).
 * Heap growth across each query must stay far below the materialized baseline. Functional assertions
 * (counts, window values, ordering) guard the bounded rewrite against semantic drift.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { RtdbEngine } from '../packages/core/src/engine.ts';
import type { WritePoint } from '../packages/core/src/types.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-memory-'));
const POINT_COUNT = 1_000_000;
const BASE = Date.parse('2026-01-10T00:00:00.000Z');
/** Calibrated budget: the streaming path grows a few MB; the old materializing path balloons >150 MB */
const HEAP_BUDGET_BYTES = 96 * 1024 * 1024;

after(async () => {
  await sharedEngine.close();
  rmSync(rootDirectory, { recursive: true, force: true });
});

/** Minimum heapUsed over a few samples (allocation decay only lowers heapUsed, so min is the stable choice) */
async function settleHeapUsed(): Promise<number> {
  let lowest = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 5; sample += 1) {
    lowest = Math.min(lowest, process.memoryUsage().heapUsed);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return lowest;
}

async function expectBoundedHeapGrowth(runQuery: () => Promise<void>): Promise<void> {
  const before = await settleHeapUsed();
  await runQuery();
  const grown = await settleHeapUsed();
  const delta = grown - before;
  assert.ok(
    delta < HEAP_BUDGET_BYTES,
    `heap grew by ${(delta / 1048576).toFixed(1)} MB, budget is ${HEAP_BUDGET_BYTES / 1048576} MB`,
  );
}

const sharedEngine = new RtdbEngine({
  dataDir: join(rootDirectory, 'bounds'),
  // Force early buffer flushes so the queries below exercise the segment path (block decode), not just
  // the in-memory buffer; min clamp for maxPendingPoints is 100_000
  maxPendingPoints: 100_000,
});

describe('Memory bounds: setup', () => {
  it('writes 1M points (1 ms spacing, sawtooth values) into segments', async () => {
    await sharedEngine.open();
    const batchSize = 10_000;
    for (let start = 0; start < POINT_COUNT; start += batchSize) {
      const points: WritePoint[] = [];
      for (let index = start; index < Math.min(start + batchSize, POINT_COUNT); index += 1) {
        points.push({ metricName: 'm.stream', timestamp: BASE + index, value: index % 7 });
      }
      await sharedEngine.writeBatch('metrics', points);
    }
  });
});

describe('Memory bounds: bounded-materialization queries over 1M points', () => {
  it('count exact over the full range stays bounded and returns the exact count', async () => {
    await expectBoundedHeapGrowth(async () => {
      const count = await sharedEngine.queryCount('metrics', 'm.stream', {
        start: BASE,
        end: BASE + POINT_COUNT - 1,
        exact: true,
      });
      assert.equal(count, POINT_COUNT);
    });
  });

  it('time-weighted avg over the full range stays bounded and matches the sawtooth mean', async () => {
    await expectBoundedHeapGrowth(async () => {
      const windows = await sharedEngine.queryAggregate('metrics', 'm.stream', {
        start: BASE,
        end: BASE + POINT_COUNT - 1,
        type: 'avg',
        windowMs: 10_000,
      });
      assert.equal(windows.length, 100);
      // Sawtooth 0..6 repeats every 7 ms; each 10 s window covers ~1428.6 periods -> mean ~3.0
      for (const window of windows) {
        assert.ok(Math.abs((window.value as number) - 3) < 0.01, `window avg ${String(window.value)}`);
      }
    });
  });

  it('descending range read stays bounded and returns the newest points in descending order', async () => {
    await expectBoundedHeapGrowth(async () => {
      const series = await sharedEngine.queryRange('metrics', 'm.stream', {
        start: BASE,
        end: BASE + POINT_COUNT - 1,
        limit: 100,
        order: 'desc',
      });
      assert.equal(series.points.length, 100);
      assert.equal(series.points[0].timestamp, BASE + POINT_COUNT - 1);
      assert.equal(series.points[99].timestamp, BASE + POINT_COUNT - 100);
      for (let index = 1; index < series.points.length; index += 1) {
        assert.ok(series.points[index].timestamp < series.points[index - 1].timestamp);
      }
    });
  });

  it('queryAt over the full range stays bounded and resolves exact/interpolated states', async () => {
    await expectBoundedHeapGrowth(async () => {
      const timestamps: number[] = [];
      for (let index = 0; index <= 100; index += 1) timestamps.push(BASE + index * 10_000);
      const results = await sharedEngine.queryAt('metrics', 'm.stream', { timestamps, mode: 'linear' });
      assert.equal(results.length, timestamps.length);
      // Exact hit on a real point (10 s spacing lands on written timestamps)
      assert.equal(results[50].state, 'exact');
      assert.equal(results[50].value, (50 * 10_000) % 7);
    });
  });
});
