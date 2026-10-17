// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 写路径单测（对齐《详细设计 v1.8》§2.6 / §6.2.3）：
 * 双水位背压（字节先到 / 点数先到 / 上界可过 / 拒绝后状态不变 / 跨天前判定）、Buffer 池接线与显式生命周期
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import { dateNumberFromTimestamp } from '../packages/core/src/format.ts';
import { BufferPool } from '../packages/core/src/pool.ts';
import { SegmentReader } from '../packages/core/src/segment-reader.ts';
import { SegmentStore } from '../packages/core/src/segment-store.ts';
import type { SegmentStoreOptions } from '../packages/core/src/segment-store.ts';
import { SegmentWriter } from '../packages/core/src/segment-writer.ts';
import type { SegmentWriterOptions } from '../packages/core/src/segment-writer.ts';
import { ENGINE_CLAMPS, ValueType } from '../packages/core/src/types.ts';
import type { WritePoint } from '../packages/core/src/types.ts';

const DATABASE = 'testdb';
/** 字节水位钳位下限（= 16MB）：单测无法用更小值触发字节背压 */
const MIN_MAX_BUFFER_BYTES = ENGINE_CLAMPS.maxBufferBytes.min;
/** 点数水位钳位下限（= 10 万点） */
const MIN_MAX_PENDING_POINTS = ENGINE_CLAMPS.maxPendingPoints.min;
/** 256B UTF-8 字符串的单点内存估算（8B 时间戳槽位 + 16B 基线 + 512B UTF-16 单元） */
const STRING_POINT_COST_BYTES = 536;

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-write-path-'));
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/* ---------- 夹具与工具 ---------- */

interface Fixture {
  store: SegmentStore;
  writer: SegmentWriter;
  dataDir: string;
}

function createFixture(
  writerOverrides: Partial<SegmentWriterOptions> = {},
  storeOverrides: Partial<SegmentStoreOptions> = {},
): Fixture {
  caseCounter += 1;
  const dataDir = join(rootDirectory, `case-${caseCounter}`);
  const store = new SegmentStore({ dataDir, ...storeOverrides });
  const writer = new SegmentWriter({ store, database: DATABASE, ...writerOverrides });
  return { store, writer, dataDir };
}

/** 等间隔 f64 点 */
function floatPoints(metricName: string, startTimestamp: number, count: number, stepMs = 1000): WritePoint[] {
  const points: WritePoint[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    points[index] = { metricName, timestamp: startTimestamp + index * stepMs, value: index % 1000 };
  }
  return points;
}

/** 等间隔 string 点（值取自少量共享样本，单点估算占用固定为 `STRING_POINT_COST_BYTES`） */
function stringPoints(metricName: string, startTimestamp: number, count: number): WritePoint[] {
  const samples = new Array<string>(64);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = `${String(index).padStart(3, '0')}-${'A'.repeat(252)}`;
  }
  const points: WritePoint[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    points[index] = {
      metricName,
      timestamp: startTimestamp + index * 1000,
      value: samples[index % samples.length],
    };
  }
  return points;
}

/** 断言同步抛出 E_RATE_LIMITED（消息匹配 `pattern`） */
function expectRateLimited(action: () => unknown, pattern: RegExp): void {
  assert.throws(
    action,
    (error) => {
      assert.ok(isRtdbError(error), `期望 RtdbError，实际 ${String(error)}`);
      assert.equal(error.code, ERROR_CODE.RateLimited);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

/* ---------- 双水位背压 ---------- */

describe('写路径: 点数水位', () => {
  it('已缓冲点数 + 本批点数超 maxPendingPoints 即整批拒绝（含投影口径与上界可过）', () => {
    const blockTargetPoints = 4096;
    const { store, writer } = createFixture({
      blockTargetPoints,
      maxPendingPoints: MIN_MAX_PENDING_POINTS,
    });
    assert.equal(writer.maxPendingPoints, MIN_MAX_PENDING_POINTS);
    const base = new Date(2026, 0, 5, 10, 0, 0).getTime();

    writer.append(floatPoints('m.keep', base, 1));
    assert.equal(writer.pendingPointCount, 1);

    // 投影判据：已缓冲 1 点 + 本批 10 万 = 100_001 > 100_000
    expectRateLimited(() => writer.append(floatPoints('m.many', base, MIN_MAX_PENDING_POINTS)), /maxPendingPoints/);
    assert.equal(writer.pendingPointCount, 1, '被拒批次不得进入缓冲');
    assert.equal(writer.bufferedMetricCount, 1);
    assert.equal(writer.valueTypeOf('m.many'), null, '被拒批次不得锁定值类型');
    assert.equal(store.listDayDirectories(DATABASE).length, 0, '被拒批次不得产生任何落盘');

    // 上界可过：1 + 99_999 = 100_000（不超即放行）
    const exactly = writer.append(floatPoints('m.many', base, MIN_MAX_PENDING_POINTS - 1));
    assert.equal(exactly.accepted, MIN_MAX_PENDING_POINTS - 1);
    const expectedBlocks = Math.floor((MIN_MAX_PENDING_POINTS - 1) / blockTargetPoints);
    assert.equal(exactly.blockCount, expectedBlocks, '剩余点数应按目标块 4096 连续成块');
    assert.equal(
      writer.pendingPointCount,
      1 + ((MIN_MAX_PENDING_POINTS - 1) % blockTargetPoints),
      '未整除目标块的余量应与 m.keep 的 1 点一并留在缓冲',
    );

    writer.close();
  });
});

describe('写路径: 字节水位', () => {
  it('已缓冲内存 + 本批估算字节超 maxBufferBytes 即整批拒绝且状态不变', () => {
    const { store, writer } = createFixture({ maxBufferBytes: MIN_MAX_BUFFER_BYTES });
    assert.equal(writer.maxBufferBytes, MIN_MAX_BUFFER_BYTES);
    const base = new Date(2026, 0, 5, 10, 0, 0).getTime();

    // 30_000 点 × 536B = 16_080_000B < 16_777_216B（水位内）
    const withinWater = 30_000;
    const accepted = writer.append(stringPoints('m.bulk', base, withinWater));
    assert.equal(accepted.accepted, withinWater);
    assert.equal(writer.valueTypeOf('m.bulk'), ValueType.String);
    const pendingBytesAfterAccepted = writer.pendingBytes;
    const pendingPointsAfterAccepted = writer.pendingPointCount;
    const dayDirectoriesAfterAccepted = store.listDayDirectories(DATABASE).length;
    assert.ok(pendingBytesAfterAccepted > 0, '应有未成块残留（30_000 点未整除目标块）');

    // 32_000 点 × 536B = 17_152_000B → 与残留叠加后越过字节水位
    expectRateLimited(
      () => writer.append(stringPoints('m.bulk', base + withinWater * 1000, 32_000)),
      /maxBufferBytes/,
    );
    assert.equal(writer.pendingBytes, pendingBytesAfterAccepted, '被拒批次不得改变已缓冲字节数');
    assert.equal(writer.pendingPointCount, pendingPointsAfterAccepted);
    assert.equal(store.listDayDirectories(DATABASE).length, dayDirectoriesAfterAccepted, '被拒批次不得落盘');

    writer.close();
  });

  it('单批估算字节本身超水位即拒绝（无需已缓冲残留）', () => {
    const { writer } = createFixture({ maxBufferBytes: MIN_MAX_BUFFER_BYTES });
    const base = new Date(2026, 0, 5, 10, 0, 0).getTime();
    const batchPointCount = 32_000;
    // 32_000 点 × 536B = 17_152_000B > 16_777_216B
    assert.ok(
      batchPointCount * STRING_POINT_COST_BYTES > MIN_MAX_BUFFER_BYTES,
      '用例前提：单批估算字节必须越过字节水位',
    );
    expectRateLimited(
      () => writer.append(stringPoints('m.huge', base, batchPointCount)),
      /maxBufferBytes/,
    );
    assert.equal(writer.pendingPointCount, 0);
    assert.equal(writer.bufferedMetricCount, 0);
    assert.equal(writer.valueTypeOf('m.huge'), null);
  });
});

describe('写路径: 背压与跨天顺序', () => {
  it('水位判定先于跨天刷盘：被拒的新日批次不得落旧日数据、旧日缓冲原样保留', () => {
    const { store, writer } = createFixture({
      blockTargetPoints: 4096,
      maxPendingPoints: MIN_MAX_PENDING_POINTS,
    });
    const day1Start = new Date(2026, 0, 5, 23, 0, 0).getTime();
    const day2Start = new Date(2026, 0, 6, 1, 0, 0).getTime();
    assert.notEqual(dateNumberFromTimestamp(day1Start), dateNumberFromTimestamp(day2Start));

    writer.append(floatPoints('m.day', day1Start, 10));
    assert.equal(writer.pendingPointCount, 10);

    expectRateLimited(() => writer.append(floatPoints('m.day', day2Start, MIN_MAX_PENDING_POINTS)), /maxPendingPoints/);
    assert.deepStrictEqual(store.listDayDirectories(DATABASE), [], '被拒批次不得创建日目录');
    assert.equal(writer.pendingPointCount, 10, '旧日缓冲应在拒绝后原样保留');

    const flushed = writer.flushAll();
    assert.equal(flushed.blockCount, 1);
    assert.equal(flushed.pointCount, 10);
    writer.close();
  });
});

/* ---------- Buffer 池接线 ---------- */

describe('写路径: Buffer 池接线', () => {
  it('块字节借出后立即归还；相同块复用同档缓冲且数据可读回', () => {
    const { store, writer } = createFixture(
      { blockTargetPoints: 4096, bufferPool: new BufferPool({ minClassBytes: 256, maxClassBytes: 65536 }) },
    );
    const base = new Date(2026, 0, 5, 10, 0, 0).getTime();

    const firstBatch = floatPoints('m.pool', base, 4096);
    writer.append(firstBatch);
    assert.equal(writer.bufferPool.stats().allocatedBuffers, 1, '首块应分配一条缓冲');
    assert.equal(writer.bufferPool.stats().outstandingBuffers, 0, 'appendBlock 之后必须已归还');
    assert.equal(writer.bufferPool.stats().pooledBuffers, 1);

    const secondBatch = floatPoints('m.pool', base + 4096 * 1000, 4096);
    writer.append(secondBatch);
    assert.equal(writer.bufferPool.stats().reusedBuffers, 1, '同档同长块应复用池中缓冲');
    assert.equal(writer.bufferPool.stats().allocatedBuffers, 1, '复用不应再分配');
    assert.equal(writer.bufferPool.stats().outstandingBuffers, 0);

    const closed = writer.close();
    assert.equal(writer.bufferPool.stats().disposed, false, '注入池的生命周期归调用方，写入器不得代为释放');

    const reader = new SegmentReader({ store });
    const readBack = reader.readMetricPoints(DATABASE, 'm.pool', {
      start: base,
      end: base + 8192 * 1000,
    });
    assert.equal(readBack.length, 8192, '池化缓冲写出的块必须可完整解码');
    assert.deepStrictEqual(readBack[0], { timestamp: base, value: 0 });
    // 第二块独立编码（值序列从 index 0 重新开始），故全局 8191 点 = 第二块 index 4095
    assert.deepStrictEqual(readBack[8191], {
      timestamp: base + 8191 * 1000,
      value: 4095 % 1000,
    });
    assert.equal(closed.sealedSegments.length, 1);
    writer.bufferPool.dispose();
  });

  it('未注入池时写入器自建，close() 只收尾数据、dispose() 释放池（两者均幂等）', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 0, 5, 10, 0, 0).getTime();

    writer.append(floatPoints('m.own', base, 4096));
    assert.equal(writer.bufferPool.stats().pooledBuffers, 1);
    assert.equal(writer.bufferPool.stats().disposed, false);

    writer.close();
    assert.equal(writer.bufferPool.stats().disposed, false, 'close() 不得释放池（close 后可续写新段）');
    writer.close();
    assert.equal(writer.bufferPool.stats().disposed, false, '重复 close 幂等');

    assert.equal(writer.dispose(), true);
    assert.equal(writer.dispose(), false, '重复 dispose 幂等');
    assert.equal(writer.bufferPool.stats().disposed, true);
    assert.equal(writer.bufferPool.stats().pooledBuffers, 0);

    assert.throws(
      () => writer.bufferPool.acquire(16),
      (error) => isRtdbError(error) && error.code === ERROR_CODE.Internal,
    );
    assert.equal(store.openDescriptorCount, 0);
  });

  it('注入池时写入器不代为释放，dispose() 返回 false', () => {
    const injectedPool = new BufferPool();
    const { writer } = createFixture({ blockTargetPoints: 4096, bufferPool: injectedPool });
    assert.equal(writer.dispose(), false);
    assert.equal(injectedPool.stats().disposed, false);
    assert.equal(injectedPool.acquire(64).length, 64);
  });
});
