// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 段存储单测（对齐《详细设计 v1.6》§2.3 / §2.5 / §2.6）
 *
 * 覆盖：目录与命名口径、单日多段字典序=时间序、滚动判据边界、块永不跨段、
 *       跨天轮转与封口、`.idx` 镜像、段句柄 LRU 与 pin 保护、封口后重新打开段可读。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { isRtdbError } from '../packages/core/src/errors.ts';
import {
  INDEX_ENTRY_FIXED_SIZE,
  MAX_SEGMENT_SEQUENCE,
  SEGMENT_EXTENSION,
  SEGMENT_FOOTER_SIZE,
  SEGMENT_HEADER_SIZE,
  encodeIndexRegion,
  formatSegmentFileName,
  parseIndexRegion,
  parseSegmentFileName,
  parseSegmentFooter,
  parseSegmentHeader,
  timestampFromDateNumber,
} from '../packages/core/src/format.ts';
import { SEGMENT_OPEN_REASON, SegmentStore } from '../packages/core/src/segment-store.ts';
import type {
  ActiveSegmentHandle,
  SealedSegment,
  SegmentStoreOptions,
} from '../packages/core/src/segment-store.ts';

const DATABASE = 'demo';
const DAY_A = 20261015;
const DAY_B = 20261016;
const TIMESTAMP_A = timestampFromDateNumber(DAY_A) + 60_000;
const TIMESTAMP_B = timestampFromDateNumber(DAY_B) + 60_000;
/** 1MB：滚动集成用例用（段软上限最小可钳位值为 16MB，故须真写满才能触发滚动） */
const MEGABYTE = 1024 * 1024;
const METRIC_NAME_BYTES = Buffer.byteLength('metric-a');

let rootDirectory = '';
let caseCounter = 0;

before(() => {
  rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-segment-store-'));
});

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/** 每个用例独立数据根，避免相互污染 */
function createStore(overrides: Partial<SegmentStoreOptions> = {}): SegmentStore {
  caseCounter += 1;
  return new SegmentStore({ dataDir: join(rootDirectory, `case-${caseCounter}`), ...overrides });
}

function expectSealed(sealed: SealedSegment | null): SealedSegment {
  if (sealed === null) throw new Error('期望返回已封口段，实际为 null');
  return sealed;
}

function appendDummyBlock(
  store: SegmentStore,
  database: string,
  metricName: string,
  bytes: number,
  timestamp: number,
): number {
  const blockBytes = new Uint8Array(bytes);
  blockBytes.fill(0x5a);
  return store.appendBlock(database, blockBytes, {
    metricName,
    pointCount: 4,
    timestampMin: timestamp,
    timestampMax: timestamp + 3,
  });
}

/** 合成句柄：仅用于滚动判据的纯函数边界测试 */
function syntheticHandle(overrides: Partial<ActiveSegmentHandle> = {}): ActiveSegmentHandle {
  return {
    database: DATABASE,
    dateNumber: DAY_A,
    sequence: 1,
    fileName: '20261015-001.seg',
    filePath: join('/nowhere', '20261015-001.seg'),
    bytesWritten: 0,
    blockCount: 0,
    headerBytes: new Uint8Array(SEGMENT_HEADER_SIZE),
    fileDescriptor: -1,
    ...overrides,
  };
}

describe('segment-store: 配置钳位', () => {
  it('未提供选项时取 ENGINE_DEFAULTS', () => {
    const store = createStore();
    assert.equal(store.segmentMaxBytes, 209_715_200);
    assert.equal(store.segmentMaxPerDay, MAX_SEGMENT_SEQUENCE);
    assert.equal(store.cacheFdGroups, 32);
  });

  it('越界值钳到边界，segmentMaxPerDay 受格式上限 999 约束', () => {
    const store = createStore({
      segmentMaxBytes: 1024,
      segmentMaxPerDay: 5_000,
      cacheFdGroups: 1,
    });
    assert.equal(store.segmentMaxBytes, 16_777_216);
    assert.equal(store.segmentMaxPerDay, MAX_SEGMENT_SEQUENCE);
    assert.equal(store.cacheFdGroups, 4);
  });
});

describe('segment-store: 目录与命名口径', () => {
  it('库/日目录/段/索引路径命名符合格式版本 1', () => {
    const store = createStore();
    assert.equal(store.databaseDirectoryPath(DATABASE), join(store.dataDir, DATABASE));
    assert.equal(store.dayDirectoryPath(DATABASE, DAY_A), join(store.dataDir, DATABASE, '20261015'));
    assert.equal(
      store.segmentFilePath(DATABASE, DAY_A, 7),
      join(store.dataDir, DATABASE, '20261015', '20261015-007.seg'),
    );
    assert.equal(
      store.indexFilePathOfSegment(DATABASE, DAY_A, 7),
      join(store.dataDir, DATABASE, '20261015', '20261015-007.idx'),
    );
  });

  it('库目录与日目录不存在时列表为空（不抛错）', () => {
    const store = createStore();
    assert.deepEqual(store.listDayDirectories(DATABASE), []);
    assert.deepEqual(store.listSegmentSequences(DATABASE, DAY_A), []);
    assert.equal(store.getActiveSegment(DATABASE), null);
    assert.equal(store.segmentFileBytes(store.segmentFilePath(DATABASE, DAY_A, 1)), null);
  });

  it('目录扫描只认日目录与容量段命名（忽略 .idx/.wal/临时文件/子目录）', () => {
    const store = createStore();
    const dayDirectory = store.dayDirectoryPath(DATABASE, DAY_A);
    mkdirSync(dayDirectory, { recursive: true });
    writeFileSync(join(dayDirectory, '20261015-001.seg'), Buffer.alloc(8));
    writeFileSync(join(dayDirectory, '20261015-001.idx'), Buffer.alloc(8));
    writeFileSync(join(dayDirectory, '20261015.wal'), Buffer.alloc(8));
    writeFileSync(join(dayDirectory, '20261015-002.idx.tmp'), Buffer.alloc(8));
    writeFileSync(join(dayDirectory, 'not-a-day'), Buffer.alloc(8));
    mkdirSync(join(dayDirectory, '20261016'));

    assert.deepEqual(store.listSegmentSequences(DATABASE, DAY_A), [1]);
    assert.deepEqual(store.listDayDirectories(DATABASE), [DAY_A]);
    // 已有 1 段 → 下一段序号为 2（重开库后沿用既有序号，不覆盖既有数据）
    assert.equal(store.nextSegmentSequence(DATABASE, DAY_A), 2);
  });
});

describe('segment-store: 活跃段创建与滚动判据', () => {
  it('首次获取创建段：写 32B 段头（magic/版本/日期），字节数与块数为初始值', () => {
    const store = createStore();
    const opened = store.openActiveSegment(DATABASE, TIMESTAMP_A);
    assert.equal(opened.reason, SEGMENT_OPEN_REASON.created);
    assert.equal(opened.sealed, null);

    const handle = opened.handle;
    assert.equal(handle.dateNumber, DAY_A);
    assert.equal(handle.sequence, 1);
    assert.equal(handle.fileName, '20261015-001.seg');
    assert.equal(handle.bytesWritten, SEGMENT_HEADER_SIZE);
    assert.equal(handle.blockCount, 0);

    const header = parseSegmentHeader(store.readSegmentSlice(handle.filePath, 0, SEGMENT_HEADER_SIZE));
    assert.equal(header.version, 1);
    assert.equal(header.date, DAY_A);
    store.close();
  });

  it('同日再次获取复用同一活跃段（不重复创建）', () => {
    const store = createStore();
    const first = store.openActiveSegment(DATABASE, TIMESTAMP_A);
    const second = store.openActiveSegment(DATABASE, TIMESTAMP_A + 1_000);
    assert.equal(second.reason, SEGMENT_OPEN_REASON.appended);
    assert.equal(second.handle, first.handle);
    assert.deepEqual(store.listSegmentSequences(DATABASE, DAY_A), [1]);
    store.close();
  });

  it('滚动判据：空段不滚动、恰好等于软上限不滚动、超出 1 字节即滚动、达单日上限不滚动', () => {
    const store = createStore();
    const max = store.segmentMaxBytes;
    // 空段（尚无块）永不滚动：块不跨段分裂，超大单块仅使软上限被超出
    assert.equal(store.shouldRoll(syntheticHandle({ bytesWritten: max, blockCount: 0 }), 1), false);
    // 边界：bytesWritten + estimated === max → 不滚动（软上限为「>」判定）
    assert.equal(
      store.shouldRoll(syntheticHandle({ bytesWritten: max - 100, blockCount: 1 }), 100),
      false,
    );
    assert.equal(
      store.shouldRoll(syntheticHandle({ bytesWritten: max - 100, blockCount: 1 }), 101),
      true,
    );
    // 单日段数达格式上限 → 停止滚动（宁可超出软上限也不丢数据）
    assert.equal(
      store.shouldRoll(
        syntheticHandle({ sequence: store.segmentMaxPerDay, bytesWritten: max, blockCount: 1 }),
        1,
      ),
      false,
    );
    store.close();
  });

  it('段序号越格式上限（1000）时拒绝创建', () => {
    const store = createStore();
    assert.throws(
      () => store.createSegment(DATABASE, DAY_A, MAX_SEGMENT_SEQUENCE + 1),
      (error: unknown) => isRtdbError(error) && error.code === 'E_INTERNAL',
    );
    store.close();
  });

  it('无活跃段时追加块抛 E_INTERNAL；无活跃段时封口返回 null', () => {
    const store = createStore();
    assert.throws(
      () => appendDummyBlock(store, DATABASE, 'metric-a', 16, TIMESTAMP_A),
      (error: unknown) => isRtdbError(error) && error.code === 'E_INTERNAL',
    );
    assert.equal(store.sealActiveSegment(DATABASE), null);
    assert.deepEqual(store.close(), []);
  });
});

describe('segment-store: 块追加与封口（索引一致性）', () => {
  it('追加两块 → 封口：Footer 校验通过、段内索引区与 .idx 镜像逐字节一致', () => {
    const store = createStore();
    const handle = store.openActiveSegment(DATABASE, TIMESTAMP_A).handle;
    const firstOffset = appendDummyBlock(store, DATABASE, 'metric-a', 64, TIMESTAMP_A);
    const secondOffset = appendDummyBlock(store, DATABASE, 'metric-b', 128, TIMESTAMP_A + 100);
    assert.equal(firstOffset, SEGMENT_HEADER_SIZE);
    assert.equal(secondOffset, SEGMENT_HEADER_SIZE + 64);
    assert.equal(handle.blockCount, 2);
    assert.equal(handle.bytesWritten, SEGMENT_HEADER_SIZE + 64 + 128);

    const sealed = expectSealed(store.sealActiveSegment(DATABASE));
    assert.equal(sealed.blockCount, 2);
    // Footer 紧邻块区之后，索引区在其后：indexOffset = Footer 起点 + SEGMENT_FOOTER_SIZE
    assert.equal(
      sealed.indexOffset,
      SEGMENT_HEADER_SIZE + 64 + 128 + SEGMENT_FOOTER_SIZE,
    );
    assert.equal(
      sealed.bytes,
      sealed.indexOffset + 2 * (INDEX_ENTRY_FIXED_SIZE + METRIC_NAME_BYTES),
    );
    assert.equal(store.getActiveSegment(DATABASE), null);

    // 段内布局校验：Header → 块区 → Footer → 索引区（Footer 起点 = indexOffset - 16）
    const bytes = store.readSegmentSlice(sealed.segmentFilePath, 0, sealed.bytes);
    const headerBytes = bytes.subarray(0, SEGMENT_HEADER_SIZE);
    const footer = parseSegmentFooter(bytes, sealed.indexOffset - SEGMENT_FOOTER_SIZE, headerBytes);
    assert.equal(footer.indexOffset, sealed.indexOffset);
    const inSegmentEntries = parseIndexRegion(bytes, footer.indexOffset);
    assert.deepEqual(inSegmentEntries, [
      {
        metricName: 'metric-a',
        offset: SEGMENT_HEADER_SIZE,
        length: 64,
        pointCount: 4,
        timestampMin: TIMESTAMP_A,
        timestampMax: TIMESTAMP_A + 3,
      },
      {
        metricName: 'metric-b',
        offset: SEGMENT_HEADER_SIZE + 64,
        length: 128,
        pointCount: 4,
        timestampMin: TIMESTAMP_A + 100,
        timestampMax: TIMESTAMP_A + 103,
      },
    ]);

    // .idx 镜像 = 段内索引区同布局（原子重写后逐字节一致）
    const indexBytes = new Uint8Array(readFileSync(sealed.indexFilePath));
    assert.deepEqual(indexBytes, encodeIndexRegion(inSegmentEntries));

    // 封口后重新打开段仍可读（段不可变，满足「拷走即备份」语义）
    assert.equal(store.segmentFileBytes(sealed.segmentFilePath), sealed.bytes);
    store.close();
  });

  it('封口后在同日续写新段，序号递增且字典序 = 时间序', () => {
    const store = createStore();
    store.openActiveSegment(DATABASE, TIMESTAMP_A);
    appendDummyBlock(store, DATABASE, 'metric-a', 32, TIMESTAMP_A);
    store.sealActiveSegment(DATABASE);

    const reopened = store.openActiveSegment(DATABASE, TIMESTAMP_A + 10_000);
    assert.equal(reopened.reason, SEGMENT_OPEN_REASON.created);
    assert.equal(reopened.handle.sequence, 2);
    assert.deepEqual(store.listSegmentSequences(DATABASE, DAY_A), [1, 2]);

    // 字典序（文件名直接排序）= 时间序（序号升序）
    const segmentNames = readdirSync(store.dayDirectoryPath(DATABASE, DAY_A))
      .filter((name) => name.endsWith(SEGMENT_EXTENSION))
      .sort();
    assert.deepEqual(
      segmentNames,
      [1, 2].map((sequence) => formatSegmentFileName(DAY_A, sequence)),
    );
    assert.deepEqual(
      segmentNames.map((name) => parseSegmentFileName(name)?.sequence),
      [1, 2],
    );
    store.close();
  });
});

describe('segment-store: 容量段滚动（16MB 软上限集成）', () => {
  it('写满软上限即封口并滚动；各段块数合计守恒；单日多段序号升序', () => {
    const store = createStore({ segmentMaxBytes: 16 * MEGABYTE });
    const totalBlocks = 20;
    const sealedSegments: SealedSegment[] = [];

    for (let index = 1; index <= totalBlocks; index += 1) {
      const opened = store.openActiveSegment(DATABASE, TIMESTAMP_A + index * 1_000, MEGABYTE);
      if (opened.reason === SEGMENT_OPEN_REASON.sizeRolled) {
        sealedSegments.push(expectSealed(opened.sealed));
      }
      appendDummyBlock(store, DATABASE, `metric-${index}`, MEGABYTE, TIMESTAMP_A + index * 1_000);
    }

    assert.ok(sealedSegments.length >= 1, '至少应发生一次容量段滚动');
    for (const sealed of sealedSegments) {
      // 软上限口径：封口时块区 ≤ 软上限，仅多出 Footer + 索引区的固定开销
      assert.ok(sealed.bytes <= store.segmentMaxBytes + 65_536);
    }

    const activeBlocks = store.getActiveSegment(DATABASE)?.blockCount ?? 0;
    const sealedBlocks = sealedSegments.reduce((sum, sealed) => sum + sealed.blockCount, 0);
    assert.equal(activeBlocks + sealedBlocks, totalBlocks);

    const sequences = store.listSegmentSequences(DATABASE, DAY_A);
    assert.ok(sequences.length >= 2);
    assert.deepEqual(
      sequences,
      Array.from({ length: sequences.length }, (_, index) => index + 1),
    );
    store.close();
  });

  it('触发滚动的块整体落入新段（块永不跨段分裂）', () => {
    const store = createStore({ segmentMaxBytes: 16 * MEGABYTE });
    const halfSegmentBytes = 8 * MEGABYTE;
    // 首块 8MB：已使「32B 段头 + 8MB」占过半段容量
    store.openActiveSegment(DATABASE, TIMESTAMP_A, halfSegmentBytes);
    appendDummyBlock(store, DATABASE, 'metric-a', halfSegmentBytes, TIMESTAMP_A);

    // 第二块 8MB：32 + 8MB + 8MB > 16MB → 在追加前滚动
    const opened = store.openActiveSegment(DATABASE, TIMESTAMP_A + 1, halfSegmentBytes);
    assert.equal(opened.reason, SEGMENT_OPEN_REASON.sizeRolled);
    const sealed = expectSealed(opened.sealed);
    assert.equal(sealed.blockCount, 1);
    assert.equal(opened.handle.sequence, 2);
    assert.equal(opened.handle.blockCount, 0);

    // 整块写入新段（不回填旧段、不切分）
    appendDummyBlock(store, DATABASE, 'metric-b', halfSegmentBytes, TIMESTAMP_A + 1);
    assert.equal(opened.handle.blockCount, 1);
    assert.equal(opened.handle.bytesWritten, SEGMENT_HEADER_SIZE + halfSegmentBytes);
    store.close();
  });
});

describe('segment-store: 跨天轮转', () => {
  it('触及新日期 → 同步新建次日段并自动封口旧段；日目录升序 = 时间序', () => {
    const store = createStore();
    const dayAHandle = store.openActiveSegment(DATABASE, TIMESTAMP_A).handle;
    appendDummyBlock(store, DATABASE, 'metric-a', 96, TIMESTAMP_A);

    const opened = store.openActiveSegment(DATABASE, TIMESTAMP_B);
    assert.equal(opened.reason, SEGMENT_OPEN_REASON.dayRotated);
    const sealed = expectSealed(opened.sealed);
    assert.equal(sealed.dateNumber, DAY_A);
    assert.equal(sealed.sequence, 1);
    assert.equal(sealed.blockCount, 1);
    assert.equal(opened.handle.dateNumber, DAY_B);
    assert.equal(opened.handle.sequence, 1);
    assert.notEqual(opened.handle.filePath, dayAHandle.filePath);

    assert.deepEqual(store.listDayDirectories(DATABASE), [DAY_A, DAY_B]);
    assert.deepEqual(store.listSegmentSequences(DATABASE, DAY_A), [1]);
    assert.deepEqual(store.listSegmentSequences(DATABASE, DAY_B), [1]);

    // 旧段已封口可读：段头日期 = 前一日，Footer 与索引区自洽
    const bytes = store.readSegmentSlice(sealed.segmentFilePath, 0, sealed.bytes);
    const headerBytes = bytes.subarray(0, SEGMENT_HEADER_SIZE);
    assert.equal(parseSegmentHeader(headerBytes).date, DAY_A);
    const footer = parseSegmentFooter(bytes, sealed.indexOffset - SEGMENT_FOOTER_SIZE, headerBytes);
    assert.equal(parseIndexRegion(bytes, footer.indexOffset).length, 1);

    // 新日期写入落入次日目录（跨天不混段）
    const active = store.getActiveSegment(DATABASE);
    assert.equal(active?.dateNumber, DAY_B);
    assert.equal(active?.filePath.startsWith(store.dayDirectoryPath(DATABASE, DAY_B)), true);
    store.close();
  });
});

describe('segment-store: 段句柄 LRU', () => {
  it('读侧句柄数受 cacheFdGroups 约束，且活跃段写侧句柄被 pin 保护', () => {
    const store = createStore({ cacheFdGroups: 4 });
    const active = store.openActiveSegment(DATABASE, TIMESTAMP_A).handle;
    assert.equal(store.openDescriptorCount, 1);

    const scratchDirectory = join(store.dataDir, 'scratch');
    mkdirSync(scratchDirectory, { recursive: true });
    const scratchPaths = Array.from({ length: 8 }, (_, index) => {
      const filePath = join(scratchDirectory, `file-${index}.bin`);
      writeFileSync(filePath, Buffer.alloc(16, index));
      return filePath;
    });
    for (const filePath of scratchPaths) {
      assert.equal(store.readSegmentSlice(filePath, 0, 4).length, 4);
    }

    // 活跃段句柄常 pin 不被淘汰；未 pin 的读侧句柄压到上限内
    assert.equal(store.openDescriptorCount, store.cacheFdGroups);

    // 被 pin 的写侧句柄仍可用（未被 LRU 关闭）：追加块不抛错
    assert.equal(appendDummyBlock(store, DATABASE, 'metric-a', 32, TIMESTAMP_A), SEGMENT_HEADER_SIZE);
    assert.equal(active.blockCount, 1);

    store.close();
    assert.equal(store.openDescriptorCount, 0);
  });

  it('close() 幂等：重复调用不抛错', () => {
    const store = createStore();
    store.openActiveSegment(DATABASE, TIMESTAMP_A);
    appendDummyBlock(store, DATABASE, 'metric-a', 32, TIMESTAMP_A);
    assert.equal(store.close().length, 1);
    assert.deepEqual(store.close(), []);
  });
});
