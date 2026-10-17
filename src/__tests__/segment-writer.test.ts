// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 段写入器单测（对齐《详细设计 v1.6》§2.6）：
 * 成块触发器（主 / 兜底 / 跨天 / 滚动 / close）、类型锁定、整批校验、块内容逐点解码与索引一致性
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CODEC_ID, decodeTimestamps, decodeValues } from '../packages/core/src/encoder/registry.ts';
import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import {
  BLOCK_FLAG,
  BLOCK_RECEIVED_WINDOW_SIZE,
  SEGMENT_FOOTER_SIZE,
  SEGMENT_HEADER_FLAG,
  SEGMENT_HEADER_SIZE,
  blockDataCrc32,
  blockDataCrc32WithReceived,
  dateNumberFromTimestamp,
  parseIndexRegion,
  parseSegmentFooter,
  parseSegmentHeader,
  tryParseBlockHeader,
} from '../packages/core/src/format.ts';
import type { BlockHeader, SegmentBlockIndexEntry } from '../packages/core/src/format.ts';
import { SegmentStore } from '../packages/core/src/segment-store.ts';
import type { SealedSegment, SegmentStoreOptions } from '../packages/core/src/segment-store.ts';
import { SegmentWriter } from '../packages/core/src/segment-writer.ts';
import type { SegmentWriterOptions } from '../packages/core/src/segment-writer.ts';
import { ValueType } from '../packages/core/src/types.ts';
import type { Point, WritePoint } from '../packages/core/src/types.ts';

const MEGABYTE = 1024 * 1024;
const DATABASE = 'testdb';
const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-writer-'));
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

/** 等间隔 f64 点（值 = 时间戳对步长取模，便于逐点校验配对关系） */
function floatPoints(metricName: string, startTimestamp: number, count: number, stepMs = 1000): WritePoint[] {
  const points: WritePoint[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const timestamp = startTimestamp + index * stepMs;
    points[index] = { metricName, timestamp, value: index % 1000 };
  }
  return points;
}

function readBytes(filePath: string): Uint8Array {
  const buffer = readFileSync(filePath);
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/** 从段头 32B 起顺序扫描块头，`limit` 为块区终点（= Footer 起点），避免把 Footer/索引区误判为块 */
function scanBlocks(segmentBytes: Uint8Array, limit: number): BlockHeader[] {
  const headers: BlockHeader[] = [];
  let offset = SEGMENT_HEADER_SIZE;
  while (offset < limit) {
    const header = tryParseBlockHeader(segmentBytes, offset, limit);
    if (header === null) break;
    headers.push(header);
    offset += header.totalLength;
  }
  return headers;
}

interface SealedSegmentContent {
  segmentBytes: Uint8Array;
  blocks: BlockHeader[];
  indexEntries: SegmentBlockIndexEntry[];
  headerFlags: number;
}

/** 读取已封口段：校验 Footer CRC、`.idx` 镜像与段内索引区逐字节同构、索引条目与块一一对应 */
function readSealedSegment(segmentFilePath: string, indexFilePath: string): SealedSegmentContent {
  const segmentBytes = readBytes(segmentFilePath);
  const indexBytes = readBytes(indexFilePath);
  const footerStart = segmentBytes.length - indexBytes.length - SEGMENT_FOOTER_SIZE;
  const footer = parseSegmentFooter(segmentBytes, footerStart, segmentBytes.subarray(0, SEGMENT_HEADER_SIZE));
  assert.equal(footer.indexOffset, footerStart + SEGMENT_FOOTER_SIZE);

  const indexEntries = parseIndexRegion(segmentBytes, footer.indexOffset, segmentBytes.length);
  assert.deepStrictEqual(indexEntries, parseIndexRegion(indexBytes, 0, indexBytes.length), '.idx 镜像应与段内索引区一致');

  const blocks = scanBlocks(segmentBytes, footerStart);
  assert.equal(blocks.length, indexEntries.length, '块数应与索引条目数一致');
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const entry = indexEntries[index];
    assert.equal(entry.metricName, block.metricName);
    assert.equal(entry.offset, block.offset);
    assert.equal(entry.length, block.totalLength);
    assert.equal(entry.pointCount, block.pointCount);
    assert.equal(entry.timestampMin, block.timestampMin);
    assert.equal(entry.timestampMax, block.timestampMax);
  }

  return {
    segmentBytes,
    blocks,
    indexEntries,
    headerFlags: parseSegmentHeader(segmentBytes).flags,
  };
}

/** 解码单个块（校验块头 totalLength 与 BlockData CRC——含 flags bit3 的 16B 接收时间窗口尾，逐点还原 ts/value） */
function decodeBlock(
  segmentBytes: Uint8Array,
  header: BlockHeader,
): { timestamps: number[]; values: Array<Point['value']> } {
  const blockEnd = header.offset + header.totalLength;
  const dataEnd =
    (header.flags & BLOCK_FLAG.receivedTime) !== 0 ? blockEnd - BLOCK_RECEIVED_WINDOW_SIZE : blockEnd;
  const dataOffset = dataEnd - header.timestampRawLength - header.valueRawLength;
  const timestampEncoded = segmentBytes.subarray(dataOffset, dataOffset + header.timestampRawLength);
  const valueEncoded = segmentBytes.subarray(dataOffset + header.timestampRawLength, dataEnd);
  const expectedCrc =
    dataEnd === blockEnd
      ? blockDataCrc32(timestampEncoded, valueEncoded)
      : blockDataCrc32WithReceived(
          timestampEncoded,
          valueEncoded,
          segmentBytes.subarray(dataEnd, blockEnd),
        );
  assert.equal(expectedCrc, header.crc32, '块数据 CRC 应校验通过');

  const decodedTimestamps = decodeTimestamps(timestampEncoded, header.pointCount);
  const timestamps: number[] = new Array(header.pointCount);
  for (let index = 0; index < header.pointCount; index += 1) timestamps[index] = decodedTimestamps[index];

  const decoded = decodeValues(header.valueType, header.valueCodecId, valueEncoded, header.pointCount);
  const values = new Array<Point['value']>(header.pointCount);
  for (let index = 0; index < header.pointCount; index += 1) {
    switch (header.valueType) {
      case ValueType.Float64:
        values[index] = (decoded as Float64Array)[index];
        break;
      case ValueType.Int64:
        values[index] = (decoded as BigInt64Array)[index];
        break;
      case ValueType.Bool:
        values[index] = (decoded as Uint8Array)[index] !== 0;
        break;
      case ValueType.String:
        values[index] = (decoded as string[])[index];
        break;
      default:
        throw new Error(`未知值类型：${String(header.valueType)}`);
    }
  }
  return { timestamps, values };
}

/** 伪随机 ASCII 文本（不可压缩，用于验证容量段滚动按落盘字节判定） */
const RANDOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function randomText(length: number, seed: number): string {
  let state = seed >>> 0;
  let text = '';
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    // 取高位字，避免 LCG 低位短周期导致文本高度重复（否则 zlib 会把块压到几 KB，滚动用例失去意义）
    text += RANDOM_ALPHABET[(state >>> 16) % RANDOM_ALPHABET.length];
  }
  return text;
}

/* ---------- 成块主触发 ---------- */

describe('segment-writer: 成块主触发', () => {
  it('达到 blockTargetPoints 即连续成块，余量留在缓冲', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    assert.equal(writer.blockTargetPoints, 4096);

    const first = writer.append(floatPoints('m.a', 1_760_000_000_000, 4096));
    assert.equal(first.accepted, 4096);
    assert.equal(first.blockCount, 1);
    assert.equal(first.pointCount, 4096);
    assert.equal(first.sealedSegments.length, 0);
    assert.equal(writer.pendingPointCount, 0);
    assert.equal(writer.bufferedMetricCount, 0);

    const second = writer.append(floatPoints('m.a', 1_760_000_000_000 + 4096 * 1000, 9000));
    assert.equal(second.blockCount, 2, '9000 点应产生 2 个完整块');
    assert.equal(second.pointCount, 8192);
    assert.equal(writer.pendingPointCount, 808);

    const closed = writer.close();
    assert.equal(writer.pendingPointCount, 0);
    assert.equal(closed.sealedSegments.length, 1);

    const sealed = closed.sealedSegments[0];
    const content = readSealedSegment(sealed.segmentFilePath, sealed.indexFilePath);
    assert.equal(content.blocks.length, 4, '1 + 2 + flushAll 的 808 点应共 4 块');
    assert.equal(content.indexEntries.length, 4);

    const totalPoints = content.blocks.reduce((sum, block) => sum + block.pointCount, 0);
    assert.equal(totalPoints, 4096 + 9000);
    assert.equal(store.openDescriptorCount, 0, '封口后写侧句柄应已关闭');
  });

  it('块内时间戳升序排序且与值严格配对', () => {
    const { writer } = createFixture({ blockTargetPoints: 4096 });
    const base = 1_760_000_000_000;
    const ordered = floatPoints('m.order', base, 4096);
    const shuffled: WritePoint[] = [...ordered].reverse();

    writer.append(shuffled);
    const closed = writer.close();
    const content = readSealedSegment(closed.sealedSegments[0].segmentFilePath, closed.sealedSegments[0].indexFilePath);
    assert.equal(content.blocks.length, 1);

    const { timestamps, values } = decodeBlock(content.segmentBytes, content.blocks[0]);
    for (let index = 1; index < timestamps.length; index += 1) {
      assert.ok(timestamps[index] > timestamps[index - 1], `块内时间戳应严格递增：index=${index}`);
    }
    for (let index = 0; index < timestamps.length; index += 1) {
      assert.equal(values[index], (timestamps[index] - base) / 1000 % 1000, '值应与时间戳配对');
    }
  });
});

/* ---------- 兜底与全量落盘 ---------- */

describe('segment-writer: 兜底与全量落盘', () => {
  it('flush 仅落盘已达 blockMinPoints 的 metric', () => {
    const { writer } = createFixture({ blockTargetPoints: 4096, blockMinPoints: 64 });
    assert.equal(writer.blockMinPoints, 64);

    writer.append(floatPoints('m.low', 1_760_000_000_000, 63));
    const below = writer.flush();
    assert.equal(below.blockCount, 0, '未达下限不应成块');
    assert.equal(writer.pendingPointCount, 63);

    writer.append(floatPoints('m.reach', 1_760_000_000_000, 64));
    const reached = writer.flush();
    assert.equal(reached.blockCount, 1);
    assert.equal(reached.pointCount, 64);
    assert.equal(writer.pendingPointsOf('m.reach'), 0);
    assert.equal(writer.pendingPointsOf('m.low'), 63, '未达下限的 metric 缓冲应保持原样');

    writer.close();
  });

  it('flushAll 忽略下限（跨天与 close 走全量）', () => {
    const { writer } = createFixture({ blockTargetPoints: 4096, blockMinPoints: 1024 });
    writer.append(floatPoints('m.one', 1_760_000_000_000, 1));
    const all = writer.flushAll();
    assert.equal(all.blockCount, 1);
    assert.equal(all.pointCount, 1);
    assert.equal(writer.pendingPointCount, 0);

    writer.close();
  });
});

/* ---------- 类型锁定与整批校验 ---------- */

describe('segment-writer: 类型锁定', () => {
  it('首写锁定值类型，跨批与同批类型不符均抛 E_TYPE_MISMATCH', () => {
    const { writer } = createFixture();
    writer.append([{ metricName: 'm.typed', timestamp: 1_760_000_000_000, value: 1.5 }]);
    assert.equal(writer.valueTypeOf('m.typed'), ValueType.Float64);
    assert.equal(writer.valueTypeOf('m.unknown'), null);

    assert.throws(
      () => writer.append([{ metricName: 'm.typed', timestamp: 1_760_000_001_000, value: 7n }]),
      (error) => isRtdbError(error) && error.code === ERROR_CODE.TypeMismatch,
    );

    assert.throws(
      () =>
        writer.append([
          { metricName: 'm.mixed', timestamp: 1_760_000_000_000, value: 1.5 },
          { metricName: 'm.mixed', timestamp: 1_760_000_001_000, value: true },
        ]),
      (error) => isRtdbError(error) && error.code === ERROR_CODE.TypeMismatch,
    );

    writer.close();
  });

  it('四类型各自锁定并可 roundtrip（值类型由 JS 值类型推断）', () => {
    const { writer } = createFixture();
    const base = 1_760_000_000_000;
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

    assert.equal(writer.valueTypeOf('m.f64'), ValueType.Float64);
    assert.equal(writer.valueTypeOf('m.i64'), ValueType.Int64);
    assert.equal(writer.valueTypeOf('m.bool'), ValueType.Bool);
    assert.equal(writer.valueTypeOf('m.string'), ValueType.String);

    const closed = writer.close();
    const content = readSealedSegment(closed.sealedSegments[0].segmentFilePath, closed.sealedSegments[0].indexFilePath);
    assert.equal(content.blocks.length, 4);

    const pointsByMetric = new Map<string, Array<Point['value']>>();
    const timestampsByMetric = new Map<string, number[]>();
    for (const block of content.blocks) {
      const decoded = decodeBlock(content.segmentBytes, block);
      pointsByMetric.set(block.metricName, decoded.values);
      timestampsByMetric.set(block.metricName, decoded.timestamps);
    }
    assert.deepStrictEqual(timestampsByMetric.get('m.f64'), [base, base + 1000]);
    assert.deepStrictEqual(pointsByMetric.get('m.f64'), [1.25, -2.5]);
    assert.deepStrictEqual(pointsByMetric.get('m.i64'), [9_007_199_254_740_991n, -12n]);
    assert.deepStrictEqual(pointsByMetric.get('m.bool'), [true, false]);
    assert.deepStrictEqual(pointsByMetric.get('m.string'), ['运行', '停机']);
  });
});

describe('segment-writer: 整批校验', () => {
  it('批内任一非法点整批拒绝，且不修改缓冲状态', () => {
    const { writer } = createFixture();
    writer.append(floatPoints('m.keep', 1_760_000_000_000, 10));
    assert.equal(writer.pendingPointCount, 10);

    assert.throws(
      () =>
        writer.append([
          { metricName: 'm.new', timestamp: 1_760_000_000_000, value: 1 },
          { metricName: 'm.new', timestamp: 1_760_000_001_000, value: Number.NaN },
        ]),
      (error) => {
        assert.ok(isRtdbError(error));
        assert.equal(error.code, ERROR_CODE.InvalidPoint);
        assert.match(error.message, /index=1/);
        return true;
      },
    );

    assert.equal(writer.pendingPointCount, 10, '失败批次不得进入缓冲');
    assert.equal(writer.bufferedMetricCount, 1);
    assert.equal(writer.valueTypeOf('m.new'), null, '失败批次不得锁定类型');

    writer.close();
  });

  it('校验矩阵：时间戳 / metric 名 / i64 范围 / string 长度 / 质量位 / 非法值类型', () => {
    const { writer } = createFixture();
    const base = 1_760_000_000_000;
    const expect = (points: WritePoint[], code: string, pattern: RegExp) => {
      assert.throws(
        () => writer.append(points),
        (error) => {
          assert.ok(isRtdbError(error), `期望 RtdbError，实际 ${String(error)}`);
          assert.equal(error.code, code);
          assert.match(error.message, pattern);
          return true;
        },
      );
    };

    expect([{ metricName: 'm', timestamp: 1.5, value: 1 }], ERROR_CODE.InvalidPoint, /timestamp must be an integer number of milliseconds/);
    expect([{ metricName: '', timestamp: base, value: 1 }], ERROR_CODE.BadMetricName, /metric name cannot be empty/);
    expect([{ metricName: 'm\nx', timestamp: base, value: 1 }], ERROR_CODE.BadMetricName, /must not contain newlines/);
    expect(
      [{ metricName: 'm'.repeat(513), timestamp: base, value: 1 }],
      ERROR_CODE.BadMetricName,
      /exceeds the 512B UTF-8 limit/,
    );
    expect([{ metricName: 'm', timestamp: base, value: 2n ** 53n + 2n }], ERROR_CODE.InvalidPoint, /exceeds ±2\^53/);
    expect(
      [{ metricName: 'm', timestamp: base, value: 'x'.repeat(257) }],
      ERROR_CODE.InvalidPoint,
      /exceeds the 256B UTF-8 limit/,
    );
    expect(
      [{ metricName: 'm', timestamp: base, value: 1, quality: 1 }],
      ERROR_CODE.InvalidPoint,
      /supports quality 0/,
    );
    expect(
      [{ metricName: 'm', timestamp: base, value: null as unknown as number }],
      ERROR_CODE.InvalidPoint,
      /Unsupported value type/,
    );
    expect([{ metricName: 'm', timestamp: base, value: Number.POSITIVE_INFINITY }], ERROR_CODE.InvalidPoint, /must be finite numbers/);

    assert.equal(writer.pendingPointCount, 0);
    writer.close();
  });

  it('空批返回 accepted=0 且不落盘', () => {
    const { writer } = createFixture();
    const result = writer.append([]);
    assert.equal(result.accepted, 0);
    assert.equal(result.blockCount, 0);
    assert.equal(result.sealedSegments.length, 0);
  });
});

/* ---------- 跨天与滚动 ---------- */

describe('segment-writer: 跨天与容量段滚动', () => {
  it('跨天先把旧日缓冲落盘，日目录边界完整且各自可读', () => {
    const { store, writer } = createFixture({ blockTargetPoints: 4096 });
    const day1Start = new Date(2026, 0, 5, 10, 0, 0).getTime();
    const day2Start = new Date(2026, 0, 6, 10, 0, 0).getTime();
    const day1DateNumber = dateNumberFromTimestamp(day1Start);
    const day2DateNumber = dateNumberFromTimestamp(day2Start);

    const day1Result = writer.append(floatPoints('m.day', day1Start, 100));
    assert.equal(day1Result.blockCount, 0, '100 点未达目标块，应留在缓冲');
    assert.equal(writer.pendingPointCount, 100);

    const day2Result = writer.append([{ metricName: 'm.day', timestamp: day2Start, value: 42 }]);
    assert.equal(day2Result.blockCount, 1, '跨天应先落旧日缓冲');
    assert.equal(writer.pendingPointCount, 1, '新日点仍在缓冲');
    assert.deepStrictEqual(store.listDayDirectories(DATABASE), [day1DateNumber], '新日目录应在写入新日数据时才创建');

    const closed = writer.close();
    assert.equal(closed.sealedSegments.length, 2, '跨天轮转封旧日段 + close 封新日段');
    assert.deepStrictEqual(store.listDayDirectories(DATABASE), [day1DateNumber, day2DateNumber]);

    const day1Segments = store.listSegmentSequences(DATABASE, day1DateNumber);
    const day2Segments = store.listSegmentSequences(DATABASE, day2DateNumber);
    assert.deepStrictEqual(day1Segments, [1]);
    assert.deepStrictEqual(day2Segments, [1]);

    const day1Content = readSealedSegment(
      store.segmentFilePath(DATABASE, day1DateNumber, 1),
      store.indexFilePathOfSegment(DATABASE, day1DateNumber, 1),
    );
    assert.equal(day1Content.blocks.length, 1);
    assert.equal(day1Content.blocks[0].pointCount, 100);
    const day1Decoded = decodeBlock(day1Content.segmentBytes, day1Content.blocks[0]);
    assert.equal(day1Decoded.timestamps[0], day1Start);
    assert.equal(day1Decoded.timestamps[99], day1Start + 99 * 1000);
    assert.equal(dateNumberFromTimestamp(day1Decoded.timestamps[99]), day1DateNumber);

    const day2Content = readSealedSegment(
      store.segmentFilePath(DATABASE, day2DateNumber, 1),
      store.indexFilePathOfSegment(DATABASE, day2DateNumber, 1),
    );
    assert.equal(day2Content.blocks.length, 1);
    const day2Decoded = decodeBlock(day2Content.segmentBytes, day2Content.blocks[0]);
    assert.deepStrictEqual(day2Decoded.timestamps, [day2Start]);
    assert.deepStrictEqual(day2Decoded.values, [42]);
  });

  it('落盘字节超 segmentMaxBytes 时封口当前段并新建下一段（块不跨段）', () => {
    const { store, writer } = createFixture(
      { blockTargetPoints: 4096 },
      { segmentMaxBytes: 16 * MEGABYTE },
    );
    const base = new Date(2026, 0, 5, 0, 0, 0).getTime();
    const dateNumber = dateNumberFromTimestamp(base);
    const pool = new Array<string>(4096);
    for (let index = 0; index < pool.length; index += 1) pool[index] = randomText(256, index + 1);

    const sealedSegments: SealedSegment[] = [];
    const blockCount = 24;
    for (let round = 0; round < blockCount; round += 1) {
      const points: WritePoint[] = new Array(4096);
      for (let index = 0; index < points.length; index += 1) {
        points[index] = {
          metricName: 'm.bulk',
          timestamp: base + (round * 4096 + index) * 500,
          value: pool[index],
        };
      }
      sealedSegments.push(...writer.append(points).sealedSegments);
    }
    assert.equal(writer.pendingPointCount, 0, '每批 4096 点应恰好成块');

    const sequences = store.listSegmentSequences(DATABASE, dateNumber);
    const totalBytes = sequences.reduce(
      (sum, sequence) => sum + (store.segmentFileBytes(store.segmentFilePath(DATABASE, dateNumber, sequence)) ?? 0),
      0,
    );
    assert.ok(
      totalBytes > 16 * MEGABYTE,
      `累计落盘 ${totalBytes}B 应超过软上限 16MB（否则滚动用例未覆盖）`,
    );
    assert.deepStrictEqual(sequences, [1, 2], `24 块（约 ${Math.round(totalBytes / MEGABYTE)}MB）应恰为两段`);
    assert.equal(sealedSegments.length, 1, 'append 期间应自动封口第一段');
    assert.equal(sealedSegments[0].sequence, 1);
    assert.ok(sealedSegments[0].bytes > 16 * MEGABYTE - 2 * MEGABYTE, '封口段应已接近软上限');

    writer.close();
    let countedBlocks = 0;
    let countedPoints = 0;
    for (const sequence of store.listSegmentSequences(DATABASE, dateNumber)) {
      const content = readSealedSegment(
        store.segmentFilePath(DATABASE, dateNumber, sequence),
        store.indexFilePathOfSegment(DATABASE, dateNumber, sequence),
      );
      countedBlocks += content.blocks.length;
      countedPoints += content.blocks.reduce((sum, block) => sum + block.pointCount, 0);
      assert.ok(
        content.segmentBytes.length <= 16 * MEGABYTE + MEGABYTE,
        `段 ${sequence} 仅允许超出单块大小的软上限余量`,
      );
      for (const block of content.blocks) assert.ok(block.timestampMax >= block.timestampMin);
    }
    assert.equal(countedBlocks, blockCount, '块数应与写入批次数一致（块永不跨段）');
    assert.equal(countedPoints, blockCount * 4096);
  });

  it('含 zlib 整块包装时置位段头 zlibBlock 标记，且与块 codecId 口径一致', () => {
    const { writer } = createFixture({ blockTargetPoints: 4096 });
    const base = new Date(2026, 0, 5, 12, 0, 0).getTime();
    // 低基数长字符串：专用字典编码体积小，zlib 包装后更小 → 触发整块包装路径
    const values = new Array<string>(4096);
    for (let index = 0; index < values.length; index += 1) {
      values[index] = `${String(index % 64).padStart(3, '0')}-${'STATE'.repeat(48)}`;
    }
    const points: WritePoint[] = values.map((value, index) => ({
      metricName: 'm.zlib',
      timestamp: base + index * 1000,
      value,
    }));
    writer.append(points);

    const closed = writer.close();
    const content = readSealedSegment(closed.sealedSegments[0].segmentFilePath, closed.sealedSegments[0].indexFilePath);
    const block = content.blocks[0];
    assert.equal(block.valueCodecId, CODEC_ID.zlibWrap, '低基数长字符串应命中 zlib 整块包装');
    assert.equal(
      (content.headerFlags & SEGMENT_HEADER_FLAG.zlibBlock) !== 0,
      true,
      '段头 zlibBlock 标记应与块 codecId 一致',
    );

    const decoded = decodeBlock(content.segmentBytes, block);
    assert.deepStrictEqual(decoded.values, values);
  });
});

/* ---------- 段文件 fsync 与 WAL 安全点顺序 ---------- */

describe('段写入器: 段文件 fsync 与 WAL 安全点顺序', () => {
  const DAY_TIMESTAMP = new Date(2026, 5, 5, 10, 0, 0).getTime();

  /** 用实例级包装统计 `store.fsyncActiveSegment` 调用次数（真实 fsync 仍会执行） */
  function spyFsync(store: SegmentStore): { calls: () => number } {
    let count = 0;
    const injectable = store as unknown as { fsyncActiveSegment: (database: string) => boolean };
    const original = injectable.fsyncActiveSegment.bind(store);
    injectable.fsyncActiveSegment = (database: string): boolean => {
      count += 1;
      return original(database);
    };
    return { calls: () => count };
  }

  it('落块的 append/flush 各 fsync 一次；没有新块就不 fsync', () => {
    const fixture = createFixture({ blockMinPoints: 64, blockTargetPoints: 1024 });
    const spy = spyFsync(fixture.store);
    try {
      fixture.writer.append(floatPoints('m.fsync.a', DAY_TIMESTAMP, 100));
      assert.equal(spy.calls(), 0, '缓冲未成块时不应 fsync');

      fixture.writer.flush();
      assert.equal(spy.calls(), 1, 'flush 落块后应恰好 fsync 一次');

      fixture.writer.append(floatPoints('m.fsync.b', DAY_TIMESTAMP, 4_096));
      assert.equal(spy.calls(), 2, 'append 内成块同样要在返回前 fsync');

      fixture.writer.flush();
      assert.equal(spy.calls(), 2, '没有新块时不再 fsync');
    } finally {
      fixture.writer.close();
    }
  });

  it('fsyncSegments=false 时不调用段 fsync（仅限可重灌场景）', () => {
    const fixture = createFixture({ blockMinPoints: 64, blockTargetPoints: 1024, fsyncSegments: false });
    const spy = spyFsync(fixture.store);
    try {
      fixture.writer.append(floatPoints('m.fsync.c', DAY_TIMESTAMP, 100));
      fixture.writer.flush();
      assert.equal(spy.calls(), 0, '关闭 fsyncSegments 后不应调用段 fsync');
    } finally {
      fixture.writer.close();
    }
  });
});
