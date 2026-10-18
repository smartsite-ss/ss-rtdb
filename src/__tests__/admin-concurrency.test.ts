// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * The metric inventory refreshes live values with one `query/last` per metric through `mapWithLimit`
 * (`packages/admin/src/concurrency.ts`). These tests pin the two properties the panel relies on: every item is
 * visited, and the number of in-flight calls never exceeds the limit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapWithLimit } from '../packages/admin/src/concurrency.ts';

describe('admin: 限制并发的批处理', () => {
  it('处理全部条目且同时在飞的任务不超过上限', async () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const seen: number[] = [];
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(item);
      inFlight -= 1;
    });
    assert.equal(seen.length, items.length);
    assert.deepEqual([...seen].sort((left, right) => left - right), items);
    assert.ok(peak <= 4, `peak concurrency ${peak} exceeded the limit`);
    assert.ok(peak >= 2, 'the pool should actually run items in parallel');
  });

  it('上限大于条目数时按条目数并发', async () => {
    const items = ['a', 'b', 'c'];
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit(items, 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    assert.equal(peak, 3);
  });

  it('空列表立即返回；非法上限至少按 1 并发', async () => {
    let calls = 0;
    await mapWithLimit([], 4, async () => {
      calls += 1;
    });
    assert.equal(calls, 0);
    await mapWithLimit([1, 2], 0, async () => {
      calls += 1;
    });
    assert.equal(calls, 2);
  });

  it('worker 抛错时整体失败（由调用方决定是否吞掉单条错误）', async () => {
    await assert.rejects(
      mapWithLimit([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
      }),
      /boom/,
    );
  });
});
