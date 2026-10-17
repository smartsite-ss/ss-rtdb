// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 内存块索引单测（对齐《详细设计 v1.6》§2.3）：
 * 全量加载、`.idx` 缺失时扫块重建、区间裁剪、增量登记、失效重载
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import { dateNumberFromTimestamp } from '../packages/core/src/format.ts';
import { MemoryIndex } from '../packages/core/src/memory-index.ts';
import { SegmentReader } from '../packages/core/src/segment-reader.ts';
import { SegmentStore } from '../packages/core/src/segment-store.ts';
import type { SegmentStoreOptions } from '../packages/core/src/segment-store.ts';
import { SegmentWriter } from '../packages/core/src/segment-writer.ts';
import type { SegmentWriterOptions } from '../packages/core/src/segment-writer.ts';
import type { WritePoint } from '../packages/core/src/types.ts';

const DATABASE = 'testdb';
const OTHER_DATABASE = 'otherdb';
const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-memindex-'));
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/* ---------- 夹具 ---------- */

interface Fixture {
  store: SegmentStore;
  writer: SegmentWriter;
  reader: SegmentReader;
  index: MemoryIndex;
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
  const reader = new SegmentReader({ store });
  return { store, writer, reader, index: new MemoryIndex({ reader }), dataDir };
}

/** 等间隔 f64 点（值 = 索引对 1000 取模） */
function floatPoints(metricName: string, startTimestamp: number, count: number, stepMs = 1000): WritePoint[] {
  const points: WritePoint[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    points[index] = { metricName, timestamp: startTimestamp + index * stepMs, value: index % 1000 };
  }
  return points;
}

/** 写入 metric 的若干整块并封口 */
function writeBlocks(fixture: Fixture, metricName: string, startTimestamp: number, blockCount: number): void {
  for (let round = 0; round < blockCount; round += 1) {
    fixture.writer.append(floatPoints(metricName, startTimestamp + round * 4096 * 1000, 4096));
  }
}

/* ---------- 全量加载 ---------- */

describe('memory-index: 全量加载', () => {
  it('多日多段全量加载，metric 列表与块条目与 reader 口径逐条一致', () => {
    const fixture = createFixture({ blockTargetPoints: 4096 });
    const day1Start = new Date(2026, 1, 5, 10, 0, 0).getTime();
    const day2Start = new Date(2026, 1, 6, 10, 0, 0).getTime();
    writeBlocks(fixture, 'm.alpha', day1Start, 2);
    fixture.writer.append(floatPoints('m.beta', day1Start, 4096));
    fixture.writer.append(floatPoints('m.alpha', day2Start, 4096));
    fixture.writer.close();

    const loaded = fixture.index.loadDatabase(DATABASE);
    assert.equal(loaded, 4, '应加载到 2 + 1 + 1 共 4 个块条目');
    assert.equal(fixture.index.isLoaded(DATABASE), true);
    assert.equal(fixture.index.blockCount(DATABASE), 4);
    assert.deepStrictEqual(fixture.index.metricNames(DATABASE), ['m.alpha', 'm.beta']);

    // 与 reader 逐段加载结果比对（顺序：按 timestampMin 升序）
    const expected = [];
    for (const descriptor of fixture.reader.listSegments(DATABASE)) {
      for (const entry of fixture.reader.loadIndexEntries(DATABASE, descriptor.dateNumber, descriptor.sequence)) {
        expected.push({ metricName: entry.metricName, timestampMin: entry.timestampMin, offset: entry.offset });
      }
    }
    expected.sort((left, right) => left.timestampMin - right.timestampMin || left.offset - right.offset);
    const actualAlpha = fixture.index
      .blocksOf(DATABASE, 'm.alpha')
      .map((location) => ({
        metricName: location.entry.metricName,
        timestampMin: location.entry.timestampMin,
        offset: location.entry.offset,
      }));
    assert.deepStrictEqual(
      actualAlpha,
      expected.filter((item) => item.metricName === 'm.alpha'),
    );
    for (const location of fixture.index.blocksOf(DATABASE, 'm.alpha')) {
      assert.equal(location.database, DATABASE);
      assert.ok(location.segmentFilePath.endsWith('.seg'));
    }
    assert.deepStrictEqual(fixture.index.blocksOf(DATABASE, 'm.absent'), []);

    // 加载幂等：重复调用结果不变
    assert.equal(fixture.index.loadDatabase(DATABASE), 4);
    assert.equal(fixture.index.blockCount(DATABASE), 4);
  });

  it('`.idx` 缺失（活跃段）时由扫块重建，索引仍可用', () => {
    const fixture = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 2, 5, 10, 0, 0).getTime();
    writeBlocks(fixture, 'm.active', base, 3);

    assert.equal(fixture.index.loadDatabase(DATABASE), 3);
    assert.deepStrictEqual(fixture.index.metricNames(DATABASE), ['m.active']);
    const locations = fixture.index.blocksOf(DATABASE, 'm.active');
    assert.deepStrictEqual(
      locations.map((location) => location.entry.timestampMin),
      [base, base + 4096 * 1000, base + 2 * 4096 * 1000],
    );

    fixture.writer.close();
  });

  it('封口段 `.idx` 被删除后加载 → 扫块重建，条目与镜像一致', () => {
    const fixture = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 2, 6, 10, 0, 0).getTime();
    writeBlocks(fixture, 'm.mirror', base, 3);
    fixture.writer.close();

    const fromMirror = fixture.index.loadDatabase(DATABASE);
    const mirrorBlocks = fixture.index.blocksOf(DATABASE, 'm.mirror').map((location) => location.entry);

    const descriptor = fixture.reader.listSegments(DATABASE)[0];
    unlinkSync(descriptor.indexFilePath);
    fixture.index.evictDatabase(DATABASE);
    assert.equal(fixture.index.loadDatabase(DATABASE), fromMirror);
    assert.deepStrictEqual(fixture.index.blocksOf(DATABASE, 'm.mirror').map((location) => location.entry), mirrorBlocks);
  });
});

/* ---------- 区间裁剪 ---------- */

describe('memory-index: 区间裁剪', () => {
  it('queryBlocks 只返回与区间相交的块且按时间升序，不产生额外加载', () => {
    const fixture = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 3, 5, 10, 0, 0).getTime();
    writeBlocks(fixture, 'm.loc', base, 4);
    fixture.writer.close();
    fixture.index.loadDatabase(DATABASE);

    const insideBlock2 = base + (2 * 4096 + 100) * 1000;
    const single = fixture.index.queryBlocks(DATABASE, 'm.loc', insideBlock2, insideBlock2);
    assert.equal(single.length, 1);
    assert.ok(single[0].entry.timestampMin <= insideBlock2 && single[0].entry.timestampMax >= insideBlock2);

    const spanning = fixture.index.queryBlocks(
      DATABASE,
      'm.loc',
      base + (1 * 4096 + 4000) * 1000,
      base + (2 * 4096 + 10) * 1000,
    );
    assert.equal(spanning.length, 2);
    assert.ok(spanning[0].entry.timestampMin < spanning[1].entry.timestampMin);

    assert.deepStrictEqual(fixture.index.queryBlocks(DATABASE, 'm.loc', base - 1_000_000, base - 1), []);
    assert.deepStrictEqual(fixture.index.queryBlocks(DATABASE, 'm.absent', base, base + 1_000_000), []);
  });

  it('未加载的库在查询时自动加载；otherdb 与 testdb 索引互不串扰', () => {
    const fixture = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 4, 5, 10, 0, 0).getTime();
    writeBlocks(fixture, 'm.auto', base, 2);
    fixture.writer.close();

    assert.equal(fixture.index.isLoaded(DATABASE), false);
    const locations = fixture.index.queryBlocks(DATABASE, 'm.auto', base, base + 4095 * 1000);
    assert.equal(locations.length, 1);
    assert.equal(fixture.index.isLoaded(DATABASE), true);

    assert.equal(fixture.index.isLoaded(OTHER_DATABASE), false);
    assert.deepStrictEqual(fixture.index.queryBlocks(OTHER_DATABASE, 'm.auto', base, base + 1000), []);
    assert.equal(fixture.index.metricNames(OTHER_DATABASE).length, 0);
  });
});

/* ---------- 增量登记与失效 ---------- */

describe('memory-index: 增量登记与失效', () => {
  it('loadSegment 增量登记新段后立刻可按区间命中', () => {
    const fixture = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 5, 5, 10, 0, 0).getTime();
    writeBlocks(fixture, 'm.inc', base, 1);
    fixture.writer.close();

    const loaded = fixture.index.loadDatabase(DATABASE);
    assert.equal(loaded, 1);

    const secondStart = base + 10_000_000;
    fixture.writer.append(floatPoints('m.inc', secondStart, 4096));
    const sealed = fixture.writer.close().sealedSegments;
    assert.equal(sealed.length, 1);

    const added = fixture.index.loadSegment(DATABASE, sealed[0].dateNumber, sealed[0].sequence);
    assert.equal(added, 1);
    assert.equal(fixture.index.blockCount(DATABASE), 2);

    const locations = fixture.index.queryBlocks(DATABASE, 'm.inc', secondStart, secondStart + 4096 * 1000);
    assert.equal(locations.length, 1);
    assert.equal(locations[0].entry.timestampMin, secondStart);

    // 幂等：重复登记同段不产生重复条目
    assert.equal(fixture.index.loadSegment(DATABASE, sealed[0].dateNumber, sealed[0].sequence), 1);
    assert.equal(fixture.index.blockCount(DATABASE), 2);
  });

  it('loadSegment 指向不存在的段抛 E_DATABASE_NOT_FOUND；evictDatabase 后重载可用', () => {
    const fixture = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 6, 5, 10, 0, 0).getTime();
    writeBlocks(fixture, 'm.evict', base, 2);
    fixture.writer.close();
    const dateNumber = dateNumberFromTimestamp(base);

    assert.equal(fixture.index.loadDatabase(DATABASE), 2);
    assert.throws(
      () => fixture.index.loadSegment(DATABASE, dateNumber, 9),
      (error) => isRtdbError(error) && error.code === ERROR_CODE.DatabaseNotFound,
    );

    fixture.index.evictDatabase(DATABASE);
    assert.equal(fixture.index.isLoaded(DATABASE), false);
    assert.equal(fixture.index.loadDatabase(DATABASE), 2);
    assert.equal(fixture.index.isLoaded(DATABASE), true);
  });
});
