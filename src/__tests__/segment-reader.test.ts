// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 段读取器单测（对齐《详细设计 v1.6》§2.3、§2.5）：
 * 段清单与区间裁剪、`.idx` 二分定位、块解码逐点比对、归并与去重、limit/order、
 * 重开已封口段可读、活跃段（无 Footer）可读、索引重建兜底、块缓存 LRU、跨块/跨段归并、类型不一致守门
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import { SEGMENT_HEADER_SIZE, dateNumberFromTimestamp } from '../packages/core/src/format.ts';
import { SegmentReader } from '../packages/core/src/segment-reader.ts';
import { SegmentStore } from '../packages/core/src/segment-store.ts';
import type { SegmentStoreOptions } from '../packages/core/src/segment-store.ts';
import { SegmentWriter } from '../packages/core/src/segment-writer.ts';
import type { SegmentWriterOptions } from '../packages/core/src/segment-writer.ts';
import type { Point, WritePoint } from '../packages/core/src/types.ts';

const DATABASE = 'testdb';
const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-reader-'));
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

/** 等间隔 f64 点（值 = 索引对 1000 取模，便于逐点校验配对关系） */
function floatPoints(metricName: string, startTimestamp: number, count: number, stepMs = 1000): WritePoint[] {
  const points: WritePoint[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    points[index] = { metricName, timestamp: startTimestamp + index * stepMs, value: index % 1000 };
  }
  return points;
}

/* ---------- 段清单与区间裁剪 ---------- */

describe('segment-reader: 段清单与区间裁剪', () => {
  it('段清单按日期与段序升序，且可被查询区间粗裁剪', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const day1Start = new Date(2026, 1, 5, 10, 0, 0).getTime();
    const day2Start = new Date(2026, 1, 6, 10, 0, 0).getTime();

    writer.append(floatPoints('m.day', day1Start, 4096));
    writer.append(floatPoints('m.day', day2Start, 4096));
    writer.close();

    const reader = new SegmentReader({ store });
    const all = reader.listSegments(DATABASE);
    assert.deepStrictEqual(
      all.map((descriptor) => descriptor.dateNumber),
      [dateNumberFromTimestamp(day1Start), dateNumberFromTimestamp(day2Start)],
    );
    for (const descriptor of all) {
      assert.equal(descriptor.sealed, true);
      assert.ok(descriptor.blockRegionEnd < descriptor.bytes, '封口段块区终点应早于文件末');
      assert.equal(descriptor.indexFilePath, store.indexFilePathOfSegment(DATABASE, descriptor.dateNumber, descriptor.sequence));
    }

    const day2Only = reader.listSegments(DATABASE, day2Start, day2Start + 1000);
    assert.equal(day2Only.length, 1);
    assert.equal(day2Only[0].dateNumber, dateNumberFromTimestamp(day2Start));

    const beforeAll = reader.listSegments(DATABASE, 0, new Date(2026, 1, 5, 0, 0, 0).getTime() - 1);
    assert.equal(beforeAll.length, 0, '区间完全早于日目录应返回空清单');
  });
});

/* ---------- 块定位 ---------- */

describe('segment-reader: 块定位', () => {
  it('按 timestampMin/timestampMax 二分定位并保留与区间相交的块', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 2, 5, 10, 0, 0).getTime();
    for (let round = 0; round < 4; round += 1) {
      writer.append(floatPoints('m.loc', base + round * 4096 * 1000, 4096));
    }
    writer.close();

    const reader = new SegmentReader({ store });
    const insideBlock2 = base + (2 * 4096 + 100) * 1000;
    const single = reader.locateBlocks(DATABASE, 'm.loc', insideBlock2, insideBlock2);
    assert.equal(single.length, 1, '单点区间应只命中所在块');
    assert.ok(single[0].entry.timestampMin <= insideBlock2 && single[0].entry.timestampMax >= insideBlock2);

    const spanStart = base + (1 * 4096 + 4000) * 1000;
    const spanEnd = base + (2 * 4096 + 10) * 1000;
    const spanning = reader.locateBlocks(DATABASE, 'm.loc', spanStart, spanEnd);
    assert.equal(spanning.length, 2, '跨块区间应命中两块');
    assert.ok(spanning[0].entry.timestampMin < spanning[1].entry.timestampMin, '定位结果应按时间升序');

    const otherMetric = reader.locateBlocks(DATABASE, 'm.other', base, base + 10_000_000);
    assert.equal(otherMetric.length, 0, '未写入的 metric 应无定位结果');
  });
});

/* ---------- 块解码逐点比对 ---------- */

describe('segment-reader: 块解码', () => {
  it('四值类型经写入 → 读取 roundtrip 逐点一致', () => {
    const { store, writer } = createFixture();
    const base = new Date(2026, 3, 5, 10, 0, 0).getTime();
    const expectations = new Map<string, number[]>([
      ['m.f64', [base, base + 1000]],
      ['m.i64', [base, base + 1000]],
      ['m.bool', [base, base + 1000]],
      ['m.string', [base, base + 1000]],
    ]);
    writer.append([
      { metricName: 'm.f64', timestamp: base, value: 1.25 },
      { metricName: 'm.f64', timestamp: base + 1000, value: -2.5 },
      { metricName: 'm.i64', timestamp: base, value: 9_007_199_254_740_991n },
      { metricName: 'm.i64', timestamp: base + 1000, value: -12n },
      { metricName: 'm.bool', timestamp: base, value: true },
      { metricName: 'm.bool', timestamp: base + 1000, value: false },
      { metricName: 'm.string', timestamp: base, value: '运行' },
      { metricName: 'm.string', timestamp: base + 1000, value: '停机' },
    ]);
    writer.close();

    const reader = new SegmentReader({ store });
    const readAll = (metricName: string): Point[] =>
      reader.readMetricPoints(DATABASE, metricName, { start: base, end: base + 1000 });
    const valuesOf = (metricName: string): Array<Point['value']> => readAll(metricName).map((point) => point.value);

    assert.deepStrictEqual(readAll('m.f64').map((point) => point.timestamp), expectations.get('m.f64'));
    assert.deepStrictEqual(valuesOf('m.f64'), [1.25, -2.5]);
    assert.deepStrictEqual(valuesOf('m.i64'), [9_007_199_254_740_991n, -12n]);
    assert.deepStrictEqual(valuesOf('m.bool'), [true, false]);
    assert.deepStrictEqual(valuesOf('m.string'), ['运行', '停机']);
    assert.deepStrictEqual(readAll('m.missing'), [], '不存在的 metric 返回空序列');
  });
});

/* ---------- 归并与去重 ---------- */

describe('segment-reader: 归并、去重与 limit/order', () => {
  it('多块归并为时间升序，重复时间戳保留先出现者；limit 截断与 desc 反转生效', () => {
    const { store, writer } = createFixture();
    const base = new Date(2026, 4, 5, 0, 0, 0).getTime();

    writer.append([{ metricName: 'm.dedup', timestamp: base, value: 1 }]);
    writer.flushAll();
    writer.append([
      { metricName: 'm.dedup', timestamp: base, value: 2 },
      { metricName: 'm.dedup', timestamp: base + 1000, value: 3 },
    ]);
    writer.close();

    const reader = new SegmentReader({ store });
    const full = reader.readMetricPoints(DATABASE, 'm.dedup', { start: base, end: base + 1000 });
    assert.deepStrictEqual(full, [
      { timestamp: base, value: 1 },
      { timestamp: base + 1000, value: 3 },
    ]);

    const limited = reader.readMetricPoints(DATABASE, 'm.dedup', { start: base, end: base + 1000, limit: 1 });
    assert.deepStrictEqual(limited, [{ timestamp: base, value: 1 }]);

    const descending = reader.readMetricPoints(DATABASE, 'm.dedup', {
      start: base,
      end: base + 1000,
      order: 'desc',
    });
    assert.deepStrictEqual(descending, [
      { timestamp: base + 1000, value: 3 },
      { timestamp: base, value: 1 },
    ]);

    assert.throws(
      () => reader.readMetricPoints(DATABASE, 'm.dedup', { start: base + 1000, end: base }),
      (error) => isRtdbError(error) && error.code === ERROR_CODE.InvalidRange,
    );
  });

  it('跨天两段（不同日目录）归并后仍严格升序', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const day1Start = new Date(2026, 5, 5, 23, 0, 0).getTime();
    const day2Start = new Date(2026, 5, 6, 1, 0, 0).getTime();
    writer.append(floatPoints('m.merge', day1Start, 4096));
    writer.append(floatPoints('m.merge', day2Start, 4096));
    writer.close();

    const reader = new SegmentReader({ store });
    const points = reader.readMetricPoints(DATABASE, 'm.merge', { start: day1Start, end: day2Start + 4096 * 1000 });
    assert.equal(points.length, 8192);
    assert.equal(points[0].timestamp, day1Start);
    assert.equal(points[8191].timestamp, day2Start + 4095 * 1000);
    for (let index = 1; index < points.length; index += 1) {
      assert.ok(points[index].timestamp > points[index - 1].timestamp, `跨段归并应严格递增：index=${index}`);
    }
  });
});

/* ---------- 重开与活跃段 ---------- */

describe('segment-reader: 重开与活跃段', () => {
  it('已封口段用新 store/reader 重新打开仍可读', () => {
    const { writer, dataDir } = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 6, 5, 10, 0, 0).getTime();
    writer.append(floatPoints('m.reopen', base, 4096));
    writer.close();

    const reopenedStore = new SegmentStore({ dataDir });
    const reader = new SegmentReader({ store: reopenedStore });
    const descriptors = reader.listSegments(DATABASE);
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].sealed, true);

    const points = reader.readMetricPoints(DATABASE, 'm.reopen', { start: base, end: base + 4096 * 1000 });
    assert.equal(points.length, 4096);
    assert.equal(points[0].value, 0);
    assert.equal(points[4095].value, 4095 % 1000);
  });

  it('活跃段（尚无 Footer）的块区终点延伸至文件末，仍可被定位与解码', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 7, 5, 10, 0, 0).getTime();
    writer.append(floatPoints('m.active', base, 4096));

    const reader = new SegmentReader({ store });
    const descriptors = reader.listSegments(DATABASE);
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].sealed, false);
    assert.equal(descriptors[0].blockRegionEnd, descriptors[0].bytes, '活跃段块区终点应等于文件末');

    const points = reader.readMetricPoints(DATABASE, 'm.active', { start: base, end: base + 4096 * 1000 });
    assert.equal(points.length, 4096);
    assert.equal(points[0].timestamp, base);
    assert.equal(points[4095].timestamp, base + 4095 * 1000);

    writer.close();
  });
});

/* ---------- 索引重建兜底 ---------- */

describe('segment-reader: 索引重建兜底', () => {
  it('活跃段无 `.idx` 时从 `.seg` 顺序扫块重建，条目与块区布局一致', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 8, 5, 10, 0, 0).getTime();
    for (let round = 0; round < 3; round += 1) {
      writer.append(floatPoints('m.rebuild', base + round * 4096 * 1000, 4096));
    }

    const reader = new SegmentReader({ store });
    const descriptor = reader.listSegments(DATABASE)[0];
    const entries = reader.loadIndexEntries(DATABASE, descriptor.dateNumber, descriptor.sequence);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].offset, SEGMENT_HEADER_SIZE, '首块应紧跟 32B 段头');
    for (let index = 0; index < entries.length; index += 1) {
      assert.equal(entries[index].metricName, 'm.rebuild');
      assert.equal(entries[index].pointCount, 4096);
      assert.equal(entries[index].timestampMin, base + index * 4096 * 1000);
      assert.equal(entries[index].timestampMax, base + (index * 4096 + 4095) * 1000);
      if (index > 0) {
        assert.equal(entries[index].offset, entries[index - 1].offset + entries[index - 1].length, '块区应连续无空洞');
      }
    }

    const points = reader.readMetricPoints(DATABASE, 'm.rebuild', { start: base, end: base + 3 * 4096 * 1000 });
    assert.equal(points.length, 3 * 4096);

    writer.close();
  });

  it('封口段 `.idx` 缺失时从 `.seg` 重建，条目与 `.idx` 镜像逐字段一致', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 8, 6, 10, 0, 0).getTime();
    for (let round = 0; round < 3; round += 1) {
      writer.append(floatPoints('m.mirror', base + round * 4096 * 1000, 4096));
    }
    writer.close();

    const reader = new SegmentReader({ store });
    const descriptor = reader.listSegments(DATABASE)[0];
    assert.equal(descriptor.sealed, true);
    const fromMirror = reader.loadIndexEntries(DATABASE, descriptor.dateNumber, descriptor.sequence);
    assert.equal(fromMirror.length, 3);

    unlinkSync(descriptor.indexFilePath);
    const rebuilt = reader.loadIndexEntries(DATABASE, descriptor.dateNumber, descriptor.sequence);
    assert.deepStrictEqual(rebuilt, fromMirror, '重建条目应与 `.idx` 镜像逐字段一致（Footer 探测须避免误判块头）');

    const points = reader.readMetricPoints(DATABASE, 'm.mirror', { start: base, end: base + 3 * 4096 * 1000 });
    assert.equal(points.length, 3 * 4096);
  });
});

/* ---------- 块缓存 LRU ---------- */

describe('segment-reader: 块缓存', () => {
  it('解码块缓存条数受 cacheBlocks 约束，越界后淘汰最久未用项', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 9, 5, 0, 0, 0).getTime();
    const blockCount = 20;
    for (let round = 0; round < blockCount; round += 1) {
      writer.append(floatPoints('m.cache', base + round * 4096 * 1000, 4096));
    }
    writer.close();

    const reader = new SegmentReader({ store, cacheBlocks: 16 });
    assert.equal(reader.cacheBlocks, 16);
    const range = { start: base, end: base + blockCount * 4096 * 1000 };
    const first = reader.readMetricPoints(DATABASE, 'm.cache', range);
    assert.equal(first.length, blockCount * 4096);
    assert.ok(reader.cachedBlockCount <= 16, `块缓存应受 16 条上限约束，实际 ${reader.cachedBlockCount}`);

    const second = reader.readMetricPoints(DATABASE, 'm.cache', range);
    assert.deepStrictEqual(second, first, '重读结果应与首次一致（含缓存命中路径）');
    assert.ok(reader.cachedBlockCount <= 16);

    reader.clearBlockCache();
    assert.equal(reader.cachedBlockCount, 0);
  });
});

/* ---------- 读侧类型守门 ---------- */

describe('segment-reader: 值类型守门', () => {
  it('同一 metric 跨段值类型不一致时抛 E_TYPE_MISMATCH', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 10, 5, 10, 0, 0).getTime();
    writer.append(floatPoints('m.mixed', base, 4096));
    writer.close();

    // 新写侧实例无前一段的首写锁定记忆，故意以 string 追加同 metric → 跨段类型冲突
    const secondWriter = new SegmentWriter({ store, database: DATABASE, blockTargetPoints: 4096 });
    const laterBase = base + 4096 * 1000;
    const stringPoints: WritePoint[] = new Array(4096);
    for (let index = 0; index < stringPoints.length; index += 1) {
      stringPoints[index] = { metricName: 'm.mixed', timestamp: laterBase + index * 1000, value: `s${index}` };
    }
    secondWriter.append(stringPoints);
    secondWriter.close();

    const reader = new SegmentReader({ store });
    assert.throws(
      () => reader.readMetricPoints(DATABASE, 'm.mixed', { start: base, end: laterBase + 4096 * 1000 }),
      (error) => {
        assert.ok(isRtdbError(error));
        assert.equal(error.code, ERROR_CODE.TypeMismatch);
        assert.match(error.message, /m\.mixed/);
        return true;
      },
    );
  });
});
