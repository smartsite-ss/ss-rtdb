// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 段文件格式单测（对齐《详细设计 v1.6》§2.5）：逐字段偏移 + 结构 roundtrip + 命名口径
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOCK_FLAG,
  BLOCK_HEADER_FIXED_SIZE,
  FORMAT_VERSION,
  INDEX_ENTRY_FIXED_SIZE,
  MAX_SEGMENT_SEQUENCE,
  SEGMENT_FOOTER_SIZE,
  SEGMENT_HEADER_FLAG,
  SEGMENT_HEADER_SIZE,
  SEGMENT_MAGIC,
  blockDataCrc32,
  crc32,
  createSegmentHeader,
  dateNumberFromTimestamp,
  encodeBlockHeader,
  encodeIndexEntry,
  encodeIndexRegion,
  encodeSegmentFooter,
  encodeSegmentHeader,
  formatBackfillSegmentFileName,
  formatDateFolderName,
  formatSegmentFileName,
  formatWalFileName,
  footerCrc32,
  indexEntryLength,
  indexFileNameOfSegmentFileName,
  isSegmentFileName,
  nextDayTimestampFromDateNumber,
  parseDateFolderName,
  parseIndexRegion,
  parseSegmentFileName,
  parseSegmentFooter,
  parseSegmentHeader,
  timestampFromDateNumber,
  tryParseBlockHeader,
} from '../packages/core/src/format.ts';

import { isRtdbError } from '../packages/core/src/errors.ts';
import { ValueType } from '../packages/core/src/types.ts';

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('format: CRC32', () => {
  it('对齐标准向量（"123456789" → 0xCBF43926）', () => {
    assert.equal(crc32(utf8.encode('123456789')), 0xcbf43926);
  });

  it('支持链式累加（分段校验 = 拼接后校验）', () => {
    const first = utf8.encode('12345');
    const second = utf8.encode('6789');
    assert.equal(crc32(second, crc32(first)), crc32(utf8.encode('123456789')));
  });

  it('块数据 CRC 覆盖 ts 与 val 两段拼接', () => {
    const tsBytes = utf8.encode('ts-part');
    const valBytes = utf8.encode('val-part');
    assert.equal(blockDataCrc32(tsBytes, valBytes), crc32(utf8.encode('ts-partval-part')));
  });
});

describe('format: 段头（Header 32B）', () => {
  const header = createSegmentHeader(20261015, 1_760_000_000_000);
  header.flags = SEGMENT_HEADER_FLAG.zlibBlock | SEGMENT_HEADER_FLAG.hasBackfillBlock;
  const bytes = encodeSegmentHeader(header);

  it('字节数 = 32，且 magic 位于 0x00', () => {
    assert.equal(bytes.length, SEGMENT_HEADER_SIZE);
    assert.equal(utf8Decoder.decode(bytes.subarray(0, 8)), SEGMENT_MAGIC);
  });

  it('逐字段偏移：version 0x08 / flags 0x0A / date 0x0C / createdAt 0x10 / reserved 0x18', () => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint16(0x08, true), FORMAT_VERSION);
    assert.equal(view.getUint16(0x0a, true), 3);
    assert.equal(view.getUint32(0x0c, true), 20261015);
    assert.equal(Number(view.getBigInt64(0x10, true)), 1_760_000_000_000);
    assert.equal(hex(bytes.subarray(0x18, 0x20)), '0000000000000000');
  });

  it('解析 roundtrip 一致', () => {
    const parsed = parseSegmentHeader(bytes);
    assert.deepStrictEqual(parsed, {
      version: FORMAT_VERSION,
      flags: 3,
      date: 20261015,
      createdAt: 1_760_000_000_000,
    });
  });

  it('魔数不符 / 版本不符 / 越界均抛错', () => {
    const wrongMagic = bytes.slice();
    wrongMagic[0] = 'X'.charCodeAt(0);
    assert.throws(() => parseSegmentHeader(wrongMagic), (error) => isRtdbError(error));

    const wrongVersion = bytes.slice();
    new DataView(wrongVersion.buffer, wrongVersion.byteOffset).setUint16(0x08, 2, true);
    assert.throws(() => parseSegmentHeader(wrongVersion), (error) => isRtdbError(error));

    assert.throws(() => parseSegmentHeader(bytes.subarray(0, 16)), (error) => isRtdbError(error));
  });
});

describe('format: 块头（BlockHeader）', () => {
  const crc = 0xdeadbeef;
  const encoded = encodeBlockHeader({
    metricName: '泵站#1.出口压力',
    pointCount: 16_384,
    valueType: ValueType.Float64,
    timestampCodecId: 1,
    valueCodecId: 2,
    timestampRawLength: 4_096,
    valueRawLength: 8_192,
    timestampMin: 1_700_000_000_000,
    timestampMax: 1_700_000_060_000,
    flags: BLOCK_FLAG.backfill,
    crc32: crc,
  });
  const metricBytes = utf8.encode('泵站#1.出口压力');

  it('总长 = 41 + metric 字节数', () => {
    assert.equal(encoded.length, BLOCK_HEADER_FIXED_SIZE + metricBytes.length);
  });

  it('逐字段偏移：metricLen 0 / metric 2 / pointCount 2+M / valueType +4 / tsCodec +5 / valCodec +6', () => {
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const fields = 2 + metricBytes.length;
    assert.equal(view.getUint16(0, true), metricBytes.length);
    assert.equal(hex(encoded.subarray(2, fields)), hex(metricBytes));
    assert.equal(view.getUint32(fields, true), 16_384);
    assert.equal(view.getUint8(fields + 4), ValueType.Float64);
    assert.equal(view.getUint8(fields + 5), 1);
    assert.equal(view.getUint8(fields + 6), 2);
    assert.equal(view.getUint32(fields + 7, true), 4_096);
    assert.equal(view.getUint32(fields + 11, true), 8_192);
    assert.equal(Number(view.getBigInt64(fields + 15, true)), 1_700_000_000_000);
    assert.equal(Number(view.getBigInt64(fields + 23, true)), 1_700_000_060_000);
    assert.equal(view.getUint16(fields + 31, true), BLOCK_FLAG.backfill);
    assert.equal(view.getUint16(fields + 33, true), 0);
    assert.equal(view.getUint32(fields + 35, true), crc);
  });

  it('解析 roundtrip 一致（含 totalLength）', () => {
    const blockBytes = new Uint8Array(encoded.length + 4_096 + 8_192);
    blockBytes.set(encoded, 0);
    const parsed = tryParseBlockHeader(blockBytes, 0);
    assert.notEqual(parsed, null);
    assert.equal(parsed?.metricName, '泵站#1.出口压力');
    assert.equal(parsed?.metricLength, metricBytes.length);
    assert.equal(parsed?.pointCount, 16_384);
    assert.equal(parsed?.valueType, ValueType.Float64);
    assert.equal(parsed?.timestampCodecId, 1);
    assert.equal(parsed?.valueCodecId, 2);
    assert.equal(parsed?.timestampRawLength, 4_096);
    assert.equal(parsed?.valueRawLength, 8_192);
    assert.equal(parsed?.timestampMin, 1_700_000_000_000);
    assert.equal(parsed?.timestampMax, 1_700_000_060_000);
    assert.equal(parsed?.flags, BLOCK_FLAG.backfill);
    assert.equal(parsed?.crc32, crc);
    assert.equal(
      parsed?.totalLength,
      BLOCK_HEADER_FIXED_SIZE + metricBytes.length + 4_096 + 8_192,
    );
  });

  it('非块边界返回 null（供段扫描探测 Footer 起点）', () => {
    const blockBytes = new Uint8Array(encoded.length + 4_096 + 8_192);
    blockBytes.set(encoded, 0);

    const onFooter = new Uint8Array(SEGMENT_FOOTER_SIZE);
    assert.equal(tryParseBlockHeader(onFooter, 0), null);
    assert.equal(tryParseBlockHeader(blockBytes, 0, 10), null);
    assert.equal(tryParseBlockHeader(blockBytes, blockBytes.length - 4), null);

    const truncating = encodeBlockHeader({
      metricName: 'x',
      pointCount: 10,
      valueType: ValueType.Float64,
      timestampCodecId: 1,
      valueCodecId: 2,
      timestampRawLength: 1_000,
      valueRawLength: 1_000,
      timestampMin: 0,
      timestampMax: 1,
      flags: 0,
      crc32: 0,
    });
    assert.equal(tryParseBlockHeader(truncating, 0), null);

    const badCodec = blockBytes.slice();
    new DataView(badCodec.buffer, badCodec.byteOffset).setUint8(2 + metricBytes.length + 6, 99);
    assert.equal(tryParseBlockHeader(badCodec, 0), null);

    const badValueType = blockBytes.slice();
    new DataView(badValueType.buffer, badValueType.byteOffset).setUint8(
      2 + metricBytes.length + 4,
      9,
    );
    assert.equal(tryParseBlockHeader(badValueType, 0), null);
  });
});

describe('format: Footer（16B）', () => {
  const headerBytes = encodeSegmentHeader(createSegmentHeader(20261015, 1_760_000_000_000));
  const indexOffset = 32 + 128 + SEGMENT_FOOTER_SIZE;
  const footerOffset = indexOffset - SEGMENT_FOOTER_SIZE;
  const bytes = encodeSegmentFooter(headerBytes, indexOffset);
  /** 按真实布局放置 Footer（Header + 块区 128B + Footer + 索引区），并使 indexOffset 校验成立 */
  function intoContainer(): Uint8Array {
    const container = new Uint8Array(indexOffset + 8);
    container.set(bytes, footerOffset);
    return container;
  }

  it('字节数 = 16，indexOffset 于 0x00、crc32 于 0x08、reserved 于 0x0C', () => {
    assert.equal(bytes.length, SEGMENT_FOOTER_SIZE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(Number(view.getBigUint64(0, true)), indexOffset);
    assert.equal(view.getUint32(8, true), footerCrc32(headerBytes, indexOffset));
    assert.equal(hex(bytes.subarray(12, 16)), '00000000');
  });

  it('解析 roundtrip 一致', () => {
    const container = intoContainer();
    const parsed = parseSegmentFooter(container, footerOffset, headerBytes);
    assert.equal(parsed.indexOffset, indexOffset);
    assert.equal(parsed.crc32, new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true));
  });

  it('CRC 覆盖 Header 32B + indexOffset，篡改任一方即失败', () => {
    const tamperedHeader = headerBytes.slice();
    tamperedHeader[0x0c] = 0xff;
    assert.throws(
      () => parseSegmentFooter(intoContainer(), footerOffset, tamperedHeader),
      (error) => isRtdbError(error),
    );

    const tamperedCrc = intoContainer();
    tamperedCrc[footerOffset + 8] ^= 0x01;
    assert.throws(
      () => parseSegmentFooter(tamperedCrc, footerOffset, headerBytes),
      (error) => isRtdbError(error),
    );
  });

  it('indexOffset 与布局不符即报错', () => {
    const misplaced = intoContainer();
    new DataView(misplaced.buffer, misplaced.byteOffset).setBigUint64(
      footerOffset,
      BigInt(indexOffset + 1),
      true,
    );
    assert.throws(
      () => parseSegmentFooter(misplaced, footerOffset, headerBytes),
      (error) => isRtdbError(error),
    );
  });
});

describe('format: 段内索引区', () => {
  const entries = [
    {
      metricName: 'alpha',
      offset: 32,
      length: 1_000,
      pointCount: 100,
      timestampMin: 1_700_000_000_000,
      timestampMax: 1_700_000_001_000,
    },
    {
      metricName: '中文.测点',
      offset: 1_032,
      length: 2_000,
      pointCount: 200,
      timestampMin: 1_700_000_002_000,
      timestampMax: 1_700_000_003_000,
    },
  ];

  it('单条字节数 = 38 + metric 字节数', () => {
    assert.equal(indexEntryLength('alpha'), INDEX_ENTRY_FIXED_SIZE + 5);
    assert.equal(indexEntryLength('中文.测点'), INDEX_ENTRY_FIXED_SIZE + utf8.encode('中文.测点').length);
    assert.equal(encodeIndexEntry(entries[0]).length, indexEntryLength('alpha'));
  });

  it('逐字段偏移：metricLen 0 / metric 2 / offset 2+M / len +8 / pointCount +16 / tsMin +20 / tsMax +28', () => {
    const bytes = encodeIndexEntry(entries[0]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fields = 2 + 5;
    assert.equal(view.getUint16(0, true), 5);
    assert.equal(utf8Decoder.decode(bytes.subarray(2, fields)), 'alpha');
    assert.equal(Number(view.getBigUint64(fields, true)), 32);
    assert.equal(Number(view.getBigUint64(fields + 8, true)), 1_000);
    assert.equal(view.getUint32(fields + 16, true), 100);
    assert.equal(Number(view.getBigInt64(fields + 20, true)), 1_700_000_000_000);
    assert.equal(Number(view.getBigInt64(fields + 28, true)), 1_700_000_001_000);
  });

  it('整段索引区 roundtrip 一致', () => {
    const region = encodeIndexRegion(entries);
    assert.equal(region.length, indexEntryLength('alpha') + indexEntryLength('中文.测点'));
    assert.deepStrictEqual(parseIndexRegion(region, 0), entries);
    assert.deepStrictEqual(parseIndexRegion(region, indexEntryLength('alpha')), [entries[1]]);
  });

  it('残条 / 越界抛错', () => {
    const region = encodeIndexRegion(entries);
    assert.throws(() => parseIndexRegion(region, 0, region.length - 1), (error) => isRtdbError(error));
    assert.throws(() => parseIndexRegion(region, region.length + 1), (error) => isRtdbError(error));
  });
});

describe('format: 日目录与段命名', () => {
  it('段名 = yyyyMMdd-NNN.seg，序号 3 位零填充', () => {
    assert.equal(formatSegmentFileName(20261015, 1), '20261015-001.seg');
    assert.equal(formatSegmentFileName(20261015, 42), '20261015-042.seg');
    assert.equal(formatSegmentFileName(20261015, MAX_SEGMENT_SEQUENCE), '20261015-999.seg');
    assert.deepStrictEqual(parseSegmentFileName('20261015-007.seg'), {
      dateNumber: 20261015,
      sequence: 7,
    });
    assert.throws(() => formatSegmentFileName(20261015, 0));
    assert.throws(() => formatSegmentFileName(20261015, MAX_SEGMENT_SEQUENCE + 1));
  });

  it('单日多段字典序 = 时间序', () => {
    const names = [
      formatSegmentFileName(20261015, 10),
      formatSegmentFileName(20261015, 2),
      formatSegmentFileName(20261015, 1),
      formatSegmentFileName(20261015, 100),
    ].sort();
    assert.deepStrictEqual(names, [
      '20261015-001.seg',
      '20261015-002.seg',
      '20261015-010.seg',
      '20261015-100.seg',
    ]);
  });

  it('非段名一律拒绝', () => {
    assert.equal(isSegmentFileName('20261015-001.seg'), true);
    assert.equal(isSegmentFileName('20261015.bfill.seg'), false);
    assert.equal(isSegmentFileName('20261015-001.idx'), false);
    assert.equal(isSegmentFileName('20261015-000.seg'), false);
    assert.equal(parseSegmentFileName('20261315-001.seg'), null);
    assert.equal(parseSegmentFileName('20260230-001.seg'), null);
  });

  it('.idx / .bfill.seg / .wal 命名派生正确', () => {
    assert.equal(indexFileNameOfSegmentFileName('20261015-001.seg'), '20261015-001.idx');
    assert.equal(indexFileNameOfSegmentFileName('20261015.bfill.seg'), '20261015.bfill.idx');
    assert.throws(() => indexFileNameOfSegmentFileName('20261015-001.idx'));
    assert.equal(formatBackfillSegmentFileName(20261015), '20261015.bfill.seg');
    assert.equal(formatWalFileName(20261015), '20261015.wal');
  });

  it('日目录名解析与生成 strict 一致', () => {
    assert.equal(formatDateFolderName(20261015), '20261015');
    assert.equal(parseDateFolderName('20261015'), 20261015);
    assert.equal(parseDateFolderName('20260230'), null);
    assert.equal(parseDateFolderName('2026101'), null);
    assert.equal(parseDateFolderName('20261015.wal'), null);
  });

  it('时间戳 ↔ 日期号 ↔ 日边界（本机时区口径）', () => {
    const dateNumber = 20261015;
    const start = timestampFromDateNumber(dateNumber);
    const nextDay = nextDayTimestampFromDateNumber(dateNumber);
    assert.equal(dateNumberFromTimestamp(start), dateNumber);
    assert.equal(dateNumberFromTimestamp(start - 1), 20261014);
    assert.equal(dateNumberFromTimestamp(nextDay - 1), dateNumber);
    assert.equal(dateNumberFromTimestamp(nextDay), 20261016);
    assert.ok(nextDay > start);
  });
});
