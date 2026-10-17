// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Per-token usage statistics: last use / last database and the rolling-window write rates shown by the
 * admin console's token table.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TokenUsageTracker } from '../packages/server/src/token-usage.ts';

describe('server: 令牌使用统计', () => {
  it('记录最后访问时间与数据库；无库请求保留原数据库', () => {
    const tracker = new TokenUsageTracker();
    tracker.touch('t1', 'alpha', 1_000);
    assert.deepEqual(tracker.snapshot('t1', 1_000), {
      lastUsedAt: 1_000,
      lastDatabase: 'alpha',
      pointsPerSec: 0,
      bytesPerSec: 0,
    });

    tracker.touch('t1', null, 2_000);
    const snapshot = tracker.snapshot('t1', 2_000);
    assert.equal(snapshot.lastUsedAt, 2_000);
    assert.equal(snapshot.lastDatabase, 'alpha');
  });

  it('按滚动窗口计算点/字节速率，超出窗口后归零', () => {
    const tracker = new TokenUsageTracker();
    tracker.recordWrite('t1', 100, 1_000, 'alpha', 10_000);

    // 单个已覆盖秒：速率等于该秒计数
    assert.equal(tracker.snapshot('t1', 10_000).pointsPerSec, 100);
    assert.equal(tracker.snapshot('t1', 10_000).bytesPerSec, 1_000);

    // 同一秒内累加
    tracker.recordWrite('t1', 50, 500, 'alpha', 10_500);
    assert.equal(tracker.snapshot('t1', 10_500).pointsPerSec, 150);

    // 5 秒后再看：仍在 10 s 窗口内，但除数变成 6 秒
    const later = tracker.snapshot('t1', 15_000);
    assert.equal(later.pointsPerSec, 25);
    assert.equal(later.bytesPerSec, 250);

    // 超出窗口：全部归零，最后访问时间仍保留
    const stale = tracker.snapshot('t1', 21_000);
    assert.equal(stale.pointsPerSec, 0);
    assert.equal(stale.bytesPerSec, 0);
    assert.equal(stale.lastUsedAt, 10_500);
  });

  it('连续多秒写入按实际覆盖秒数取平均，窗口滑出后速率下降', () => {
    const tracker = new TokenUsageTracker();
    // Ten writes per second for 10 seconds: seconds 0..9
    for (let second = 0; second < 10; second += 1) {
      tracker.recordWrite('t1', 10, 100, 'alpha', second * 1_000);
    }

    assert.equal(tracker.snapshot('t1', 9_000).pointsPerSec, 10);
    assert.equal(tracker.snapshot('t1', 9_000).bytesPerSec, 100);

    // At 10.5 s the bucket of second 0 has left the 10 s window: 90 points over 10 covered seconds
    const slid = tracker.snapshot('t1', 10_500);
    assert.equal(slid.pointsPerSec, 9);
    assert.equal(slid.bytesPerSec, 90);

    // Long after the last write everything decays to zero
    assert.equal(tracker.snapshot('t1', 30_000).pointsPerSec, 0);
  });

  it('不同令牌的统计互相独立', () => {
    const tracker = new TokenUsageTracker();
    tracker.recordWrite('fast', 600, 6_000, 'alpha', 5_000);
    tracker.recordWrite('slow', 30, 300, 'beta', 5_000);

    assert.equal(tracker.snapshot('fast', 5_000).pointsPerSec, 600);
    assert.equal(tracker.snapshot('fast', 5_000).lastDatabase, 'alpha');
    assert.equal(tracker.snapshot('slow', 5_000).pointsPerSec, 30);
    assert.equal(tracker.snapshot('slow', 5_000).lastDatabase, 'beta');
  });

  it('查询类请求只刷新最后访问信息，不影响写入速率', () => {
    const tracker = new TokenUsageTracker();
    tracker.recordWrite('t1', 100, 1_000, 'alpha', 8_000);
    tracker.touch('t1', 'beta', 8_500);

    const snapshot = tracker.snapshot('t1', 8_500);
    assert.equal(snapshot.pointsPerSec, 100);
    assert.equal(snapshot.bytesPerSec, 1_000);
    assert.equal(snapshot.lastDatabase, 'beta');
    assert.equal(snapshot.lastUsedAt, 8_500);
  });

  it('未知令牌与空 tokenId 不产生记录', () => {
    const tracker = new TokenUsageTracker();
    assert.deepEqual(tracker.snapshot('missing', 1_000), {
      lastUsedAt: null,
      lastDatabase: null,
      pointsPerSec: 0,
      bytesPerSec: 0,
    });

    tracker.touch(undefined, 'alpha', 1_000);
    tracker.recordWrite('', 1, 1, 'alpha', 1_000);
    assert.equal(tracker.snapshot('', 1_000).lastUsedAt, null);
  });
});
