// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 引擎单测（对齐《详细设计 v1.9》§2.2 / §2.6 / §2.8）：
 * 生命周期与数据根锁、WAL 批次与安全点、启动重放、查询四原语（含六算子与时间加权 avg）、管理 API
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { RtdbEngine } from '../packages/core/src/engine.ts';
import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import { SegmentStore } from '../packages/core/src/segment-store.ts';
import { WriteAheadLog } from '../packages/core/src/wal.ts';
import { ValueType } from '../packages/core/src/types.ts';
import type { EngineOptions, WritePoint } from '../packages/core/src/types.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-engine-'));
/** 固定基日（10:00），避免跨日边界影响时间戳构造 */
const DAY_BASE = new Date(2026, 0, 10, 10, 0, 0).getTime();
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/* ---------- 夹具与工具 ---------- */

function createDataDir(): string {
  caseCounter += 1;
  return join(rootDirectory, `case-${caseCounter}`);
}

async function openEngine(dataDir: string, options: Omit<EngineOptions, 'dataDir'> = {}): Promise<RtdbEngine> {
  const engine = new RtdbEngine({ dataDir, ...options });
  await engine.open();
  return engine;
}

function expectRtdbCode(error: unknown, code: string): boolean {
  return isRtdbError(error) && error.code === code;
}

/** 等间隔点（值取自 `values`，时间戳 = base + i*stepMs） */
function pointsFrom(
  metricName: string,
  values: readonly WritePoint['value'][],
  base: number,
  stepMs = 1000,
): WritePoint[] {
  return values.map((value, index) => ({ metricName, timestamp: base + index * stepMs, value }));
}

/* ---------- 生命周期与数据根锁 ---------- */

describe('引擎: 生命周期与数据根锁', () => {
  it('open 后 isOpen 为 true；close 幂等释放锁，可再次 open', async () => {
    const dataDir = createDataDir();
    const engine = new RtdbEngine({ dataDir });
    assert.equal(engine.isOpen, false);
    await engine.open();
    assert.equal(engine.isOpen, true);

    await engine.close();
    assert.equal(engine.isOpen, false);
    await engine.close(); // 幂等

    // 锁已释放：同目录新引擎可打开
    const second = await openEngine(dataDir);
    assert.equal(second.isOpen, true);
    await second.close();
  });

  it('同一数据根被第二个引擎打开抛 E_DB_LOCKED；同一实例重复 open 抛 E_INTERNAL', async () => {
    const dataDir = createDataDir();
    const first = await openEngine(dataDir);
    try {
      await assert.rejects(
        new RtdbEngine({ dataDir }).open(),
        (error) => expectRtdbCode(error, ERROR_CODE.DatabaseLocked),
      );
      await assert.rejects(first.open(), (error) => expectRtdbCode(error, ERROR_CODE.Internal));
    } finally {
      await first.close();
    }
  });

  it('未 open 即调用写入/查询抛 E_INTERNAL', async () => {
    const engine = new RtdbEngine({ dataDir: createDataDir() });
    await assert.rejects(
      engine.writeBatch('db', pointsFrom('m', [1], DAY_BASE)),
      (error) => expectRtdbCode(error, ERROR_CODE.Internal),
    );
    await assert.rejects(
      engine.queryRange('db', 'm', { start: DAY_BASE, end: DAY_BASE }),
      (error) => expectRtdbCode(error, ERROR_CODE.Internal),
    );
  });
});

/* ---------- 写入与查询可见性 ---------- */

describe('引擎: 写入与查询可见性', () => {
  it('writeBatch 后立即可查（未成块缓冲点参与归并）', async () => {
    const engine = await openEngine(createDataDir());
    try {
      const result = await engine.writeBatch('db', pointsFrom('m.temp', [1, 2, 3], DAY_BASE));
      assert.equal(result.accepted, 3);

      const series = await engine.queryRange('db', 'm.temp', { start: DAY_BASE, end: DAY_BASE + 2000 });
      assert.deepStrictEqual(series.points, [
        { timestamp: DAY_BASE, value: 1 },
        { timestamp: DAY_BASE + 1000, value: 2 },
        { timestamp: DAY_BASE + 2000, value: 3 },
      ]);

      const stats = await engine.stats();
      assert.equal(stats.write.acceptedPoints, 3);
      assert.equal(stats.write.bufferedPoints, 3);
    } finally {
      await engine.close();
    }
  });

  it('被拒批次不落 WAL、不计 accepted：非法点抛 E_INVALID_POINT', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await assert.rejects(
        engine.writeBatch('db', [{ metricName: 'm.bad', timestamp: DAY_BASE, value: Number.NaN }]),
        (error) => expectRtdbCode(error, ERROR_CODE.InvalidPoint),
      );
      const stats = await engine.stats();
      assert.equal(stats.write.acceptedPoints, 0);
      assert.equal(stats.wal.pendingBytes, 0, '被拒批次不得进 WAL');
    } finally {
      await engine.close();
    }
  });

  it('批内 (metric, ts) 去重：保留首个并计数', async () => {
    const engine = await openEngine(createDataDir());
    try {
      const result = await engine.writeBatch('db', [
        { metricName: 'm.dup', timestamp: DAY_BASE, value: 1 },
        { metricName: 'm.dup', timestamp: DAY_BASE, value: 999 },
        { metricName: 'm.dup', timestamp: DAY_BASE + 1000, value: 2 },
      ]);
      assert.equal(result.accepted, 2, '重复点静默丢弃');
      const stats = await engine.stats();
      assert.equal(stats.write.duplicatePoints, 1);
      const series = await engine.queryRange('db', 'm.dup', { start: DAY_BASE, end: DAY_BASE + 1000 });
      assert.deepStrictEqual(series.points.map((point) => point.value), [1, 2]);
    } finally {
      await engine.close();
    }
  });

  it('查询支持 order=desc 与 limit（降序取最新 N 条）', async () => {
    const engine = await openEngine(createDataDir());
    try {
      const values = Array.from({ length: 20 }, (_, index) => index);
      await engine.writeBatch('db', pointsFrom('m.rank', values, DAY_BASE));

      const ascending = await engine.queryRange('db', 'm.rank', {
        start: DAY_BASE,
        end: DAY_BASE + 19_000,
        limit: 5,
      });
      assert.deepStrictEqual(ascending.points.map((point) => point.value), [0, 1, 2, 3, 4]);

      const descending = await engine.queryRange('db', 'm.rank', {
        start: DAY_BASE,
        end: DAY_BASE + 19_000,
        order: 'desc',
        limit: 5,
      });
      assert.deepStrictEqual(descending.points.map((point) => point.value), [19, 18, 17, 16, 15]);
    } finally {
      await engine.close();
    }
  });

  it('服务器接收时间窗口：缓冲点即查即有 received；成块落段后随块持久化', async () => {
    // 缓冲路径：未成块点由写入时的到达窗口提供 received
    const bufferedEngine = await openEngine(createDataDir());
    try {
      await bufferedEngine.writeBatch('db', pointsFrom('m.buf', [1, 2, 3], DAY_BASE));
      const buffered = await bufferedEngine.queryRange('db', 'm.buf', {
        start: DAY_BASE,
        end: DAY_BASE + 2000,
      });
      assert.ok(buffered.received !== undefined, '缓冲可见性查询应携带 received');
      assert.ok(buffered.received.min > 0);
      assert.ok(buffered.received.min <= buffered.received.max);
    } finally {
      await bufferedEngine.close();
    }

    // 成块路径：4096 点达成目标块 → 立即落段
    const dataDir = createDataDir();
    const blockEngine = await openEngine(dataDir, { blockTargetPoints: 4096 });
    try {
      const values = Array.from({ length: 4096 }, (_, index) => index);
      await blockEngine.writeBatch('db', pointsFrom('m.blk', values, DAY_BASE));
      const flushed = await blockEngine.queryRange('db', 'm.blk', {
        start: DAY_BASE,
        end: DAY_BASE + 4095_000,
      });
      assert.ok(flushed.received !== undefined, '落段查询应携带 received');
      assert.ok(flushed.received.min <= flushed.received.max);
      // 数据时间戳（DAY_BASE 固定值）与接收时间（真实 wall clock）相互独立
      assert.ok(flushed.received.max > DAY_BASE, '接收时间应晚于写入的数据时间戳');
    } finally {
      await blockEngine.close();
    }

    // 重开：窗口从块尾 16B 读出（格式往返验证）
    const reopened = await openEngine(dataDir);
    try {
      const persisted = await reopened.queryRange('db', 'm.blk', {
        start: DAY_BASE,
        end: DAY_BASE + 4095_000,
      });
      assert.ok(persisted.received !== undefined, 'received 应随块持久化并在重开后可读');
      assert.ok(persisted.received.min <= persisted.received.max);
    } finally {
      await reopened.close();
    }
  });
});

/* ---------- status 指标（§3.4） ---------- */

describe('引擎: status 指标补全', () => {
  it('wal.pendingPoints / lastFsyncMs / segments.bytesToday / cache / gc / query 分位均有值且口径自洽', async () => {
    const engine = await openEngine(createDataDir());
    try {
      const initial = await engine.stats();
      assert.equal(initial.write.pointsPerSec, 0, '无写入时会话均值速率为 0');
      assert.equal(initial.wal.pendingPoints, 0);
      assert.equal(initial.wal.lastFsyncMs, 0, '无写入时无 fsync 记录');
      assert.equal(initial.cache.blockHitRate, 0, '无查询时块缓存命中率为 0');
      assert.equal(initial.query.count, 0);
      assert.equal(typeof initial.cache.heapUsedMb, 'number');
      assert.equal(typeof initial.cache.externalMb, 'number');
      assert.ok(initial.gc.count >= 0 && initial.gc.maxMs >= 0);

      // 今日时间戳：日目录即「今天」，故 bytesToday 可被统计（固定 DAY_BASE 为过去日期，不适用）
      const now = Date.now();
      await engine.writeBatch('db', pointsFrom('m.today', [1, 2, 3], now - 2000));
      const afterWrite = await engine.stats();
      assert.equal(afterWrite.wal.pendingPoints, 3, '未成块批次的点数计入 wal.pendingPoints');
      assert.ok(afterWrite.wal.lastFsyncMs > 0, '默认 fsyncPolicy=wal 下写入触发 fsync');
      assert.ok(afterWrite.segments.bytesToday > 0, '今日日目录（WAL 文件）占用应被统计');
      assert.ok(afterWrite.write.pointsPerSec >= 0, '会话均值速率非负');

      // 回归：批次台账里的 cumulative 是「进程内累计」而非「本批点数」，最老未完成批次若直接用
      // 绝对累计计算，会把已落段的历史点数算进 wal.pendingPoints（曾出现 buffered=8 万而
      // pendingPoints=549 万）。未落段点数恒等于缓冲区点数。
      const bulkValues = Array.from({ length: 20_000 }, (_unused, index) => index * 0.5);
      await engine.writeBatch('db', pointsFrom('m.bulk', bulkValues, now - 120_000));
      const afterBulk = await engine.stats();
      assert.equal(
        afterBulk.wal.pendingPoints,
        afterBulk.write.bufferedPoints,
        'wal.pendingPoints 必须等于尚未落段的缓冲点数，而不是历史累计',
      );
      assert.ok(afterBulk.wal.pendingPoints < 20_000, '已落段部分不得计入 wal.pendingPoints');

      await engine.queryRange('db', 'm.today', { start: now - 2000, end: now });
      await engine.queryRange('db', 'm.today', { start: now - 2000, end: now });
      const afterQuery = await engine.stats();
      assert.equal(afterQuery.query.count, 2, '仅统计成功查询');
      assert.ok(afterQuery.query.p99Ms >= afterQuery.query.p50Ms, '分位值单调');
      assert.ok(afterQuery.cache.blockHitRate >= 0 && afterQuery.cache.blockHitRate <= 1, '命中率落在 [0,1]');
    } finally {
      await engine.close();
    }
  });
});

/* ---------- WAL 批次与安全点 ---------- */

describe('引擎: WAL 批次与安全点', () => {
  it('未成块批次保留在 WAL；成块落段后安全点推进并清空', async () => {
    const engine = await openEngine(createDataDir(), { blockTargetPoints: 4096 });
    try {
      await engine.writeBatch('db', pointsFrom('m.wal', [1, 2, 3], DAY_BASE));
      const buffered = await engine.stats();
      assert.ok(buffered.wal.pendingBytes > 0, '未落点应保留在 WAL');
      assert.equal(buffered.wal.outstandingBatches, 1);

      // 再补满一个目标块（3 + 4093 = 4096）→ 触发成块 → 两批均落段 → 安全点截断
      const bulk = Array.from({ length: 4093 }, (_, index) => index);
      await engine.writeBatch('db', pointsFrom('m.wal', bulk, DAY_BASE + 10_000));
      const flushed = await engine.stats();
      assert.equal(flushed.wal.outstandingBatches, 0, '批次落段后应完成');
      assert.equal(flushed.wal.pendingBytes, 0, '安全点应截断 WAL');
    } finally {
      await engine.close();
    }
  });

  it('启动重放 WAL 残留（模拟崩溃）：未落盘点入缓冲可查，关闭刷段后落段可查', async () => {
    const dataDir = createDataDir();
    const database = 'crashdb';
    // 直接以底层 WAL 追加（不刷段、不取数据根锁），模拟上次崩溃遗留的未落段数据
    const store = new SegmentStore({ dataDir });
    const wal = new WriteAheadLog({ store, database });
    wal.append(pointsFrom('crash.metric', [1.5, 2.5], DAY_BASE));
    wal.close();

    const engine = await openEngine(dataDir);
    try {
      const series = await engine.queryRange(database, 'crash.metric', {
        start: DAY_BASE,
        end: DAY_BASE + 1000,
      });
      assert.deepStrictEqual(series.points.map((point) => point.value), [1.5, 2.5], '重放点应立即可查');
      const stats = await engine.stats();
      assert.ok(stats.wal.pendingBytes > 0, '采纳批次未完成前 WAL 保留');
    } finally {
      await engine.close();
    }

    // 关闭刷段 + 推进安全点后重开：数据来自容量段
    const reopened = await openEngine(dataDir);
    try {
      const series = await reopened.queryRange(database, 'crash.metric', {
        start: DAY_BASE,
        end: DAY_BASE + 1000,
      });
      assert.deepStrictEqual(series.points.map((point) => point.value), [1.5, 2.5]);
      const metrics = await reopened.listMetrics(database);
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].metricName, 'crash.metric');
    } finally {
      await reopened.close();
    }
  });
});

/* ---------- 查询四原语：last ---------- */

describe('查询: queryLast', () => {
  it('before 语义（≤before 最新一点）与缺省全量最新、无命中返回 null', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', pointsFrom('m.last', [10, 20, 30], DAY_BASE));
      const latest = await engine.queryLast('db', 'm.last');
      assert.deepStrictEqual(latest, { timestamp: DAY_BASE + 2000, value: 30 });

      const before = await engine.queryLast('db', 'm.last', { before: DAY_BASE + 1500 });
      assert.deepStrictEqual(before, { timestamp: DAY_BASE + 1000, value: 20 });

      const none = await engine.queryLast('db', 'm.last', { before: DAY_BASE - 1 });
      assert.equal(none, null);

      const empty = await engine.queryLast('db', 'm.missing');
      assert.equal(empty, null);
    } finally {
      await engine.close();
    }
  });
});

/* ---------- 查询四原语：count ---------- */

describe('查询: queryCount', () => {
  it('exact 逐点精确；estimate 为块交集累加（可粗于精确）', async () => {
    const engine = await openEngine(createDataDir(), { blockTargetPoints: 4096 });
    try {
      const values = Array.from({ length: 8192 }, (_, index) => index);
      await engine.writeBatch('db', pointsFrom('m.count', values, DAY_BASE));

      const fullRange = { start: DAY_BASE, end: DAY_BASE + 8191 * 1000 };
      assert.equal(await engine.queryCount('db', 'm.count', { ...fullRange, exact: true }), 8192);
      assert.equal(await engine.queryCount('db', 'm.count', fullRange), 8192, '整块估算应与精确一致');

      const narrow = { start: DAY_BASE, end: DAY_BASE + 9 * 1000 };
      assert.equal(await engine.queryCount('db', 'm.count', { ...narrow, exact: true }), 10);
      assert.equal(
        await engine.queryCount('db', 'm.count', narrow),
        4096,
        '估算按命中整块累加：narrow 仅与第 1 个 4096 点块相交，故计整块 4096 而非精确 10',
      );
    } finally {
      await engine.close();
    }
  });
});

/* ---------- 查询四原语：aggregate ---------- */

describe('查询: queryAggregate', () => {
  it('等周期 f64：六算子逐窗正确，末窗按窗口宽度回补（平坦外延）', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', pointsFrom('m.agg', [10, 20, 30, 40], DAY_BASE));
      const windows = await engine.queryAggregate('db', 'm.agg', {
        start: DAY_BASE,
        end: DAY_BASE + 3000,
        type: 'avg',
        windowMs: 1000,
      });
      assert.equal(windows.length, 4);
      assert.deepStrictEqual(windows.map((window) => window.start), [
        DAY_BASE,
        DAY_BASE + 1000,
        DAY_BASE + 2000,
        DAY_BASE + 3000,
      ]);
      assert.deepStrictEqual(windows.map((window) => window.value), [15, 25, 35, 40]);
      assert.deepStrictEqual(windows.map((window) => window.count), [1, 1, 1, 1]);

      const sum = await engine.queryAggregate('db', 'm.agg', {
        start: DAY_BASE,
        end: DAY_BASE + 3000,
        type: 'sum',
        windowMs: 1000,
      });
      assert.deepStrictEqual(sum.map((window) => window.value), [10, 20, 30, 40]);

      const last = await engine.queryAggregate('db', 'm.agg', {
        start: DAY_BASE,
        end: DAY_BASE + 3000,
        type: 'last',
        windowMs: 1000,
      });
      assert.deepStrictEqual(last.map((window) => window.value), [10, 20, 30, 40]);

      const min = await engine.queryAggregate('db', 'm.agg', {
        start: DAY_BASE,
        end: DAY_BASE + 3000,
        type: 'min',
        windowMs: 1000,
      });
      assert.deepStrictEqual(min.map((window) => window.value), [10, 20, 30, 40]);

      const count = await engine.queryAggregate('db', 'm.agg', {
        start: DAY_BASE,
        end: DAY_BASE + 3000,
        type: 'count',
        windowMs: 1000,
      });
      assert.deepStrictEqual(count.map((window) => window.value), [1, 1, 1, 1]);
    } finally {
      await engine.close();
    }
  });

  it('avg 为时间加权（变周期）：与点等权均值显著不同', async () => {
    const engine = await openEngine(createDataDir());
    try {
      // 窗口 [0,1000)：内点 t=0→0、t=200→100；后邻 t=1000→100
      await engine.writeBatch('db', [
        { metricName: 'm.weighted', timestamp: DAY_BASE, value: 0 },
        { metricName: 'm.weighted', timestamp: DAY_BASE + 200, value: 100 },
        { metricName: 'm.weighted', timestamp: DAY_BASE + 1000, value: 100 },
      ]);
      const windows = await engine.queryAggregate('db', 'm.weighted', {
        start: DAY_BASE,
        end: DAY_BASE + 999,
        type: 'avg',
        windowMs: 1000,
      });
      assert.equal(windows.length, 1);
      assert.equal(windows[0].value, 90, '时间加权 = 90（点等权均值仅 50）');
      assert.equal(windows[0].count, 2);
    } finally {
      await engine.close();
    }
  });

  it('缺数窗（窗外无覆盖）avg 为 NaN，count 为 0', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', pointsFrom('m.gap', [5, 6], DAY_BASE));
      const windows = await engine.queryAggregate('db', 'm.gap', {
        start: DAY_BASE + 10_000,
        end: DAY_BASE + 13_999,
        type: 'avg',
        windowMs: 1000,
      });
      assert.equal(windows.length, 4);
      for (const window of windows) {
        assert.ok(Number.isNaN(window.value as number), '窗外无覆盖应为 NaN');
        assert.equal(window.count, 0);
      }
    } finally {
      await engine.close();
    }
  });

  it('跨块聚合：多容量块合入单窗，sum/min/max/last/count 正确', async () => {
    const engine = await openEngine(createDataDir(), { blockTargetPoints: 4096 });
    try {
      const values = Array.from({ length: 8192 }, (_, index) => index);
      await engine.writeBatch('db', pointsFrom('m.block', values, DAY_BASE));
      const range = {
        start: DAY_BASE,
        end: DAY_BASE + 8191 * 1000,
        windowMs: 8192 * 1000,
      };
      const sum = await engine.queryAggregate('db', 'm.block', { ...range, type: 'sum' });
      assert.equal(sum.length, 1);
      assert.equal(sum[0].value, (8191 * 8192) / 2);
      assert.equal(sum[0].count, 8192);

      const min = await engine.queryAggregate('db', 'm.block', { ...range, type: 'min' });
      assert.equal(min[0].value, 0);
      const max = await engine.queryAggregate('db', 'm.block', { ...range, type: 'max' });
      assert.equal(max[0].value, 8191);
      const last = await engine.queryAggregate('db', 'm.block', { ...range, type: 'last' });
      assert.equal(last[0].value, 8191);
    } finally {
      await engine.close();
    }
  });

  it('i64：sum 为 number，min/max/last 为 bigint', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', [
        { metricName: 'm.i64', timestamp: DAY_BASE, value: 10n },
        { metricName: 'm.i64', timestamp: DAY_BASE + 1000, value: -5n },
        { metricName: 'm.i64', timestamp: DAY_BASE + 2000, value: 100n },
      ]);
      const range = { start: DAY_BASE, end: DAY_BASE + 2000, windowMs: 3000 };
      assert.equal((await engine.queryAggregate('db', 'm.i64', { ...range, type: 'sum' }))[0].value, 105);
      assert.equal((await engine.queryAggregate('db', 'm.i64', { ...range, type: 'min' }))[0].value, -5n);
      assert.equal((await engine.queryAggregate('db', 'm.i64', { ...range, type: 'max' }))[0].value, 100n);
      assert.equal((await engine.queryAggregate('db', 'm.i64', { ...range, type: 'last' }))[0].value, 100n);

      const lastPoint = await engine.queryLast('db', 'm.i64');
      assert.equal(lastPoint?.value, 100n);
    } finally {
      await engine.close();
    }
  });

  it('bool：min/max/last 为 boolean；string：仅 count/last 可用，数值算子抛 E_TYPE_MISMATCH', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', [
        { metricName: 'm.bool', timestamp: DAY_BASE, value: true },
        { metricName: 'm.bool', timestamp: DAY_BASE + 1000, value: false },
        { metricName: 'm.bool', timestamp: DAY_BASE + 2000, value: true },
      ]);
      const range = { start: DAY_BASE, end: DAY_BASE + 2000, windowMs: 3000 };
      assert.equal((await engine.queryAggregate('db', 'm.bool', { ...range, type: 'min' }))[0].value, false);
      assert.equal((await engine.queryAggregate('db', 'm.bool', { ...range, type: 'max' }))[0].value, true);
      assert.equal((await engine.queryAggregate('db', 'm.bool', { ...range, type: 'last' }))[0].value, true);

      await engine.writeBatch('db', pointsFrom('m.str', ['a', 'b', 'c'], DAY_BASE));
      assert.equal((await engine.queryAggregate('db', 'm.str', { ...range, type: 'last' }))[0].value, 'c');
      assert.equal((await engine.queryAggregate('db', 'm.str', { ...range, type: 'count' }))[0].value, 3);
      await assert.rejects(
        engine.queryAggregate('db', 'm.str', { ...range, type: 'avg' }),
        (error) => expectRtdbCode(error, ERROR_CODE.TypeMismatch),
      );
      await assert.rejects(
        engine.queryAggregate('db', 'm.str', { ...range, type: 'min' }),
        (error) => expectRtdbCode(error, ERROR_CODE.TypeMismatch),
      );
    } finally {
      await engine.close();
    }
  });

  it('窗口宽度非法 / 窗口数超上限抛 E_INVALID_RANGE', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', pointsFrom('m.guard', [1], DAY_BASE));
      await assert.rejects(
        engine.queryAggregate('db', 'm.guard', { start: DAY_BASE, end: DAY_BASE, type: 'avg', windowMs: 0 }),
        (error) => expectRtdbCode(error, ERROR_CODE.InvalidRange),
      );
      await assert.rejects(
        engine.queryAggregate('db', 'm.guard', {
          start: DAY_BASE,
          end: DAY_BASE + 1_000_000,
          type: 'avg',
          windowMs: 1,
        }),
        (error) => expectRtdbCode(error, ERROR_CODE.InvalidRange),
      );
    } finally {
      await engine.close();
    }
  });
});

/* ---------- 管理 API ---------- */

describe('引擎: 管理 API', () => {
  it('listDatabases / listMetrics / stats 汇报写入面', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('alpha', pointsFrom('m.a', [1, 2], DAY_BASE));
      await engine.writeBatch('beta', pointsFrom('m.b', [3], DAY_BASE));

      assert.deepStrictEqual(await engine.listDatabases(), ['alpha', 'beta']);
      const metrics = await engine.listMetrics('alpha');
      assert.deepStrictEqual(metrics, [
        { metricName: 'm.a', firstTs: DAY_BASE, lastTs: DAY_BASE + 1000, valueType: ValueType.Float64 },
      ]);

      const stats = await engine.stats();
      assert.equal(stats.databases, 2);
      assert.equal(stats.metrics, 2);
      assert.equal(stats.write.acceptedPoints, 3);
      assert.equal(stats.write.bufferedPoints, 3);
      assert.ok(stats.segments.openFiles >= 0);
    } finally {
      await engine.close();
    }
  });

  it('listMetrics 汇报块头来源的指标值类型（i64 落段后）', async () => {
    const engine = await openEngine(createDataDir());
    try {
      // 4096 点 = blockTargetPoints 下限，落段后走块头读取路径（而非写缓冲）
      const values = Array.from({ length: 4_096 }, (_, index) => BigInt(index));
      await engine.writeBatch('alpha', pointsFrom('m.i', values, DAY_BASE));
      const metrics = await engine.listMetrics('alpha');
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].valueType, ValueType.Int64);
    } finally {
      await engine.close();
    }
  });

  it('setRetention 钳位 0~3650 并原子写入 retention.json', async () => {
    const dataDir = createDataDir();
    const engine = await openEngine(dataDir);
    try {
      await engine.setRetention('db', 30);
      assert.equal(readRetentionDays(dataDir, 'db'), 30);

      await engine.setRetention('db', 99_999);
      assert.equal(readRetentionDays(dataDir, 'db'), 3650, '超上限钳位');

      await engine.setRetention('db', -3);
      assert.equal(readRetentionDays(dataDir, 'db'), 0, '负数钳位为 0（永久）');
    } finally {
      await engine.close();
    }
  });
});

/* ---------- 插值取值 queryAt（插值功能详细设计 M2.1） ---------- */

describe('引擎: queryAt 插值取值', () => {
  it('step：命中点 exact；两点之间与边缘前值保持 exact；早于首点且无历史 → no-data', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', pointsFrom('m.step', [10, 20], DAY_BASE));
      const results = await engine.queryAt('db', 'm.step', {
        timestamps: [DAY_BASE, DAY_BASE + 500, DAY_BASE + 1000, DAY_BASE + 5000, DAY_BASE - 1000],
      });
      assert.deepStrictEqual(results, [
        { timestamp: DAY_BASE, value: 10, state: 'exact' },
        { timestamp: DAY_BASE + 500, value: 10, state: 'exact' },
        { timestamp: DAY_BASE + 1000, value: 20, state: 'exact' },
        { timestamp: DAY_BASE + 5000, value: 20, state: 'exact' },
        { timestamp: DAY_BASE - 1000, value: null, state: 'no-data' },
      ]);

      const missing = await engine.queryAt('db', 'ghost.metric', { timestamps: [DAY_BASE] });
      assert.deepStrictEqual(missing, [{ timestamp: DAY_BASE, value: null, state: 'no-data' }]);
    } finally {
      await engine.close();
    }
  });

  it('linear：两点之间线性插值 interpolated；数据范围外平推 extrapolated', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', pointsFrom('m.lin', [0, 10, 40], DAY_BASE));
      const results = await engine.queryAt('db', 'm.lin', {
        timestamps: [DAY_BASE + 500, DAY_BASE + 1500, DAY_BASE - 1000, DAY_BASE + 9000],
        mode: 'linear',
      });
      assert.equal(results[0].state, 'interpolated');
      assert.equal(results[0].value, 5, '0→10 中点');
      assert.equal(results[1].state, 'interpolated');
      assert.equal(results[1].value, 25, '10→40 中点');
      assert.equal(results[2].state, 'extrapolated');
      assert.equal(results[2].value, 0, '早于首点 → 首点平推');
      assert.equal(results[3].state, 'extrapolated');
      assert.equal(results[3].value, 40, '晚于末点 → 末点平推');
    } finally {
      await engine.close();
    }
  });

  it('linear：i64 四舍五入保持 bigint；exact 命中返回原值不取整', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', pointsFrom('m.i64', [10n, 13n], DAY_BASE));
      const results = await engine.queryAt('db', 'm.i64', {
        timestamps: [DAY_BASE, DAY_BASE + 500],
        mode: 'linear',
      });
      assert.equal(results[0].state, 'exact');
      assert.equal(results[0].value, 10n);
      assert.equal(typeof results[0].value, 'bigint');
      assert.equal(results[1].state, 'interpolated');
      assert.equal(results[1].value, 12n, '10 + 3×0.5 = 11.5 → 四舍五入 12');
      assert.equal(typeof results[1].value, 'bigint');
    } finally {
      await engine.close();
    }
  });

  it('linear：bool/string 整批拒绝 E_TYPE_MISMATCH；非法 mode/timestamps 拒绝 E_INVALID_POINT', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', pointsFrom('m.bool', [true, false], DAY_BASE));
      await engine.writeBatch('db', pointsFrom('m.str', ['a', 'b'], DAY_BASE));
      await assert.rejects(
        () => engine.queryAt('db', 'm.bool', { timestamps: [DAY_BASE], mode: 'linear' }),
        (error) => expectRtdbCode(error, ERROR_CODE.TypeMismatch),
      );
      await assert.rejects(
        () => engine.queryAt('db', 'm.str', { timestamps: [DAY_BASE], mode: 'linear' }),
        (error) => expectRtdbCode(error, ERROR_CODE.TypeMismatch),
      );
      await assert.rejects(
        () => engine.queryAt('db', 'm.bool', { timestamps: [DAY_BASE], mode: 'nearest' as 'linear' }),
        (error) => expectRtdbCode(error, ERROR_CODE.InvalidPoint),
      );
      await assert.rejects(
        () => engine.queryAt('db', 'm.bool', { timestamps: [] }),
        (error) => expectRtdbCode(error, ERROR_CODE.InvalidPoint),
      );
      await assert.rejects(
        () => engine.queryAt('db', 'm.bool', { timestamps: [DAY_BASE + 0.5] }),
        (error) => expectRtdbCode(error, ERROR_CODE.InvalidPoint),
      );
    } finally {
      await engine.close();
    }
  });

  it('未成块缓冲点参与插值（写后立查）；结果按请求顺序回显且无序输入可处理', async () => {
    const engine = await openEngine(createDataDir());
    try {
      await engine.writeBatch('db', pointsFrom('m.buf', [1, 5], DAY_BASE));
      const results = await engine.queryAt('db', 'm.buf', {
        timestamps: [DAY_BASE + 500, DAY_BASE],
        mode: 'linear',
      });
      assert.equal(results[0].timestamp, DAY_BASE + 500, '结果按请求顺序回显');
      assert.equal(results[0].value, 3, '1→5 中点');
      assert.equal(results[0].state, 'interpolated');
      assert.equal(results[1].state, 'exact');
      assert.equal(results[1].value, 1);
    } finally {
      await engine.close();
    }
  });

  it('timestamps 超过 10_000 整批拒绝', async () => {
    const engine = await openEngine(createDataDir());
    try {
      const tooMany = Array.from({ length: 10_001 }, (_, index) => DAY_BASE + index);
      await assert.rejects(
        () => engine.queryAt('db', 'm.x', { timestamps: tooMany }),
        (error) => expectRtdbCode(error, ERROR_CODE.InvalidPoint),
      );
    } finally {
      await engine.close();
    }
  });
});

/* ---------- 工具 ---------- */

function readRetentionDays(dataDir: string, database: string): number {
  const text = readFileSync(join(dataDir, database, 'retention.json'), 'utf8');
  const parsed = JSON.parse(text) as { retentionDays?: unknown };
  return parsed.retentionDays as number;
}
