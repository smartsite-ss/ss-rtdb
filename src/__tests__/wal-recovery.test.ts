// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * WAL、数据根锁与启动恢复单测（对齐《详细设计 v1.7》§2.5、§2.6、§2.8）：
 * 锁获取/冲突/陈旧锁清理、WAL 四类型 roundtrip、跨午夜批次、group fsync、安全点截断（清空与尾部重写）、
 * 半行重放与残行截断、采纳批次推进、半块截断（块数据不足 / 末块 CRC 失败）、`.idx` 缺失与损坏重建、
 * WAL 重放报告、恢复范围限定、空数据根恢复
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import { SEGMENT_HEADER_SIZE, dateNumberFromTimestamp } from '../packages/core/src/format.ts';
import { DataRootLock, isProcessAlive } from '../packages/core/src/lock.ts';
import { recoverDataRoot } from '../packages/core/src/recovery.ts';
import { SegmentReader } from '../packages/core/src/segment-reader.ts';
import { SegmentStore } from '../packages/core/src/segment-store.ts';
import { SegmentWriter } from '../packages/core/src/segment-writer.ts';
import type { WritePoint } from '../packages/core/src/types.ts';
import {
  WAL_ADOPTED_BATCH_ID,
  WriteAheadLog,
  readWalFileEntries,
  repairWalFileTail,
} from '../packages/core/src/wal.ts';

const DATABASE = 'testdb';
const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-recovery-'));
let caseCounter = 0;

/** 2026-06-05 10:00:00 本地时区（稳定的日目录判定基准） */
const DAY_TIMESTAMP = new Date(2026, 5, 5, 10, 0, 0).getTime();
const DAY_DATE_NUMBER = dateNumberFromTimestamp(DAY_TIMESTAMP);

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/* ---------- 夹具与工具 ---------- */

function nextDirectory(label: string): string {
  caseCounter += 1;
  const directory = join(rootDirectory, `${label}-${caseCounter}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function createStore(label = 'store'): SegmentStore {
  return new SegmentStore({ dataDir: nextDirectory(label) });
}

function points(metricName: string, startTimestamp: number, count: number, stepMs = 1000): WritePoint[] {
  const out: WritePoint[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    out[index] = { metricName, timestamp: startTimestamp + index * stepMs, value: index % 1000 };
  }
  return out;
}

/** 读取文件片段（返回独立副本） */
function readSlice(filePath: string, offset: number, length: number): Uint8Array {
  const bytes = readFileSync(filePath);
  return new Uint8Array(bytes.subarray(offset, offset + length));
}

function expectRtdbError(action: () => void, code: string): void {
  try {
    action();
  } catch (error) {
    assert.ok(isRtdbError(error), `期望 RtdbError，实际抛出 ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`期望抛出 ${code}，但未抛出`);
}

/* ---------- 数据根锁 ---------- */

describe('数据根锁', () => {
  it('获取后锁文件含当前进程号，释放后可再次获取', () => {
    const dataDir = nextDirectory('lock-basic');
    const lock = new DataRootLock({ dataDir });

    const acquisition = lock.acquire();
    assert.equal(lock.isHeld, true);
    assert.equal(acquisition.owner.processId, process.pid);
    assert.equal(acquisition.reclaimedStale, false);
    assert.equal(lock.readOwner()?.processId, process.pid);

    assert.equal(lock.release(), true);
    assert.equal(lock.isHeld, false);
    assert.equal(existsSync(lock.lockFilePath), false, '释放后锁文件应被删除');
    assert.equal(lock.release(), false, '重复释放应静默返回 false');

    const second = new DataRootLock({ dataDir });
    assert.equal(second.acquire().reclaimedStale, false);
    second.release();
  });

  it('同进程内两个实例互斥（E_DB_LOCKED），先持有者释放后可被接管', () => {
    const dataDir = nextDirectory('lock-conflict');
    const first = new DataRootLock({ dataDir });
    const second = new DataRootLock({ dataDir });

    first.acquire();
    expectRtdbError(() => second.acquire(), ERROR_CODE.DatabaseLocked);
    assert.equal(second.isHeld, false);

    first.release();
    assert.equal(second.acquire().reclaimedStale, false);
    second.release();
  });

  it('陈旧锁（非法进程号 / 已消亡进程）自动清理并接管，且报告 reclaimedStale', () => {
    const dataDir = nextDirectory('lock-stale');
    const lock = new DataRootLock({ dataDir });
    writeFileSync(lock.lockFilePath, `${JSON.stringify({ processId: 0, acquiredAt: Date.now() })}\n`);

    const acquisition = lock.acquire();
    assert.equal(acquisition.reclaimedStale, true);
    assert.equal(lock.readOwner()?.processId, process.pid);
    lock.release();

    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadProcessId = child.pid;
    if (deadProcessId !== undefined && !isProcessAlive(deadProcessId)) {
      writeFileSync(
        lock.lockFilePath,
        `${JSON.stringify({ processId: deadProcessId, acquiredAt: Date.now() })}\n`,
      );
      assert.equal(lock.acquire().reclaimedStale, true, '已退出进程的锁应判定为陈旧锁');
      lock.release();
    }
  });

  it('锁文件内容不可解析视为陈旧锁', () => {
    const dataDir = nextDirectory('lock-garbage');
    const lock = new DataRootLock({ dataDir });
    writeFileSync(lock.lockFilePath, 'not-json');
    assert.equal(lock.readOwner(), null);
    assert.equal(lock.acquire().reclaimedStale, true);
    lock.release();
  });
});

/* ---------- WAL 追加与重放 ---------- */

describe('WAL 追加与重放', () => {
  it('四值类型经 WAL roundtrip 逐点一致，区间偏移与文件大小吻合', () => {
    const store = createStore('wal-roundtrip');
    const wal = new WriteAheadLog({ store, database: DATABASE });
    const batch: WritePoint[] = [
      { metricName: 'm.f64', timestamp: DAY_TIMESTAMP, value: 1.5 },
      { metricName: 'm.i64', timestamp: DAY_TIMESTAMP + 1, value: 9_007_199_254_740_991n },
      { metricName: 'm.bool', timestamp: DAY_TIMESTAMP + 2, value: true },
      { metricName: 'm.string', timestamp: DAY_TIMESTAMP + 3, value: '运行/停止' },
    ];

    const receipt = wal.append(batch);
    assert.equal(receipt.pointCount, 4);
    assert.equal(receipt.synced, true, "fsyncPolicy='wal' 时批次应已落盘");
    assert.equal(receipt.fileRanges.length, 1);

    const walFilePath = store.walFilePath(DATABASE, DAY_DATE_NUMBER);
    assert.equal(receipt.fileRanges[0].dateNumber, DAY_DATE_NUMBER);
    assert.equal(receipt.fileRanges[0].startOffset, 0);
    assert.equal(receipt.fileRanges[0].endOffset, statSync(walFilePath).size);
    assert.equal(wal.pendingBytes, statSync(walFilePath).size);

    const report = readWalFileEntries(walFilePath, DAY_DATE_NUMBER);
    assert.equal(report.discardedTailBytes, 0);
    assert.deepStrictEqual(
      report.entries.map((entry) => [entry.metricName, entry.timestamp, entry.value, entry.quality]),
      batch.map((point) => [point.metricName, point.timestamp, point.value, 0]),
    );
    assert.equal(typeof report.entries[1].value, 'bigint', 'i64 值应以 bigint 还原（而非字符串）');
    wal.close();
  });

  it('跨午夜批次分别落入两个日文件', () => {
    const store = createStore('wal-crossday');
    const wal = new WriteAheadLog({ store, database: DATABASE });
    const beforeMidnight = new Date(2026, 5, 5, 23, 59, 59).getTime();
    const batch: WritePoint[] = [
      { metricName: 'm.cross', timestamp: beforeMidnight, value: 1 },
      { metricName: 'm.cross', timestamp: beforeMidnight + 1000, value: 2 },
    ];

    const receipt = wal.append(batch);
    assert.equal(receipt.fileRanges.length, 2);
    assert.equal(receipt.synced, true);
    assert.equal(wal.openFileCount, 2);

    const expectedByDate = new Map<number, number[]>([
      [dateNumberFromTimestamp(batch[0].timestamp), [batch[0].timestamp]],
      [dateNumberFromTimestamp(batch[1].timestamp), [batch[1].timestamp]],
    ]);
    for (const range of receipt.fileRanges) {
      const report = readWalFileEntries(store.walFilePath(DATABASE, range.dateNumber), range.dateNumber);
      assert.deepStrictEqual(
        report.entries.map((entry) => entry.timestamp),
        expectedByDate.get(range.dateNumber),
      );
      assert.equal(range.endOffset, statSync(store.walFilePath(DATABASE, range.dateNumber)).size);
    }
    wal.close();
  });

  it('禁用 WAL 时不落任何文件，安全点推进为空操作', () => {
    const store = createStore('wal-disabled');
    const wal = new WriteAheadLog({ store, database: DATABASE, enabled: false });
    const receipt = wal.append(points('m.off', DAY_TIMESTAMP, 3));

    assert.equal(receipt.fileRanges.length, 0);
    assert.equal(receipt.synced, false);
    assert.equal(wal.pendingBytes, 0);
    assert.equal(store.listDayDirectories(DATABASE).length, 0, '禁用 WAL 不应创建日目录');
    assert.deepStrictEqual(wal.commitSafePoint(), { releasedBytes: 0, remainingBytes: 0, filesTruncated: 0 });
    wal.close();
  });

  it("fsyncPolicy='none' 时批次标记为未 fsync", () => {
    const store = createStore('wal-nofsync');
    const wal = new WriteAheadLog({ store, database: DATABASE, fsyncPolicy: 'none' });
    assert.equal(wal.append(points('m.nofsync', DAY_TIMESTAMP, 2)).synced, false);
    wal.close();
  });
});

/* ---------- WAL 残行与安全点截断 ---------- */

describe('WAL 残行与安全点', () => {
  it('尾部断电半行被识别并丢弃，完整行不受影响', () => {
    const store = createStore('wal-halfline');
    const wal = new WriteAheadLog({ store, database: DATABASE });
    wal.append(points('m.half', DAY_TIMESTAMP, 3));
    wal.close();

    const walFilePath = store.walFilePath(DATABASE, DAY_DATE_NUMBER);
    const completeBytes = statSync(walFilePath).size;
    const tornLine = '{"m":"m.half","t":123,"v":4';
    appendFileSync(walFilePath, tornLine);

    const dirty = readWalFileEntries(walFilePath, DAY_DATE_NUMBER);
    assert.equal(dirty.entries.length, 3, '无换行结尾的残行不应计入条目');
    assert.equal(dirty.validBytes, completeBytes);
    assert.equal(dirty.discardedTailBytes, tornLine.length);

    assert.equal(repairWalFileTail(walFilePath, dirty.validBytes), tornLine.length);
    assert.equal(statSync(walFilePath).size, completeBytes);
    assert.equal(readWalFileEntries(walFilePath, DAY_DATE_NUMBER).discardedTailBytes, 0);
    assert.equal(repairWalFileTail(walFilePath, completeBytes), 0, '无需截断时返回 0');
  });

  it('完成最早批次后安全点截断文件前缀，未完成批次保留且偏移重算', () => {
    const store = createStore('wal-safepoint');
    const wal = new WriteAheadLog({ store, database: DATABASE });
    const walFilePath = store.walFilePath(DATABASE, DAY_DATE_NUMBER);

    const batchOne = wal.append(points('m.sp', DAY_TIMESTAMP, 2));
    const batchTwo = wal.append(points('m.sp', DAY_TIMESTAMP + 10_000, 3));
    assert.deepStrictEqual(wal.outstandingBatchIds, [batchOne.batchId, batchTwo.batchId]);

    assert.equal(wal.completeBatch(batchOne.batchId), 1);
    assert.equal(wal.completeBatch(-1), 0, '未知批次号应静默返回 0');
    assert.deepStrictEqual(wal.outstandingBatchIds, [batchTwo.batchId]);

    const truncation = wal.commitSafePoint();
    assert.equal(truncation.filesTruncated, 1);
    assert.equal(truncation.releasedBytes, batchTwo.fileRanges[0].startOffset);
    assert.equal(truncation.remainingBytes, statSync(walFilePath).size);
    assert.equal(readWalFileEntries(walFilePath, DAY_DATE_NUMBER).entries.length, 3, '未完成批次的行应完整保留');

    const batchThree = wal.append(points('m.sp', DAY_TIMESTAMP + 20_000, 1));
    assert.equal(batchThree.fileRanges[0].startOffset, truncation.remainingBytes, '截断后偏移应重新对齐');
    assert.equal(readWalFileEntries(walFilePath, DAY_DATE_NUMBER).entries.length, 4);

    assert.equal(wal.completeBatch(batchTwo.batchId), 1);
    assert.equal(wal.completeBatch(batchThree.batchId), 1);
    const cleared = wal.commitSafePoint();
    assert.equal(cleared.remainingBytes, 0);
    assert.equal(statSync(walFilePath).size, 0, '全部批次完成后应清空文件');
    assert.deepStrictEqual(wal.outstandingBatchIds, []);
    wal.close();
  });

  it('打开时把已有 WAL 内容登记为采纳批次，完成后可被释放', () => {
    const store = createStore('wal-adopt');
    const first = new WriteAheadLog({ store, database: DATABASE });
    first.append(points('m.adopt', DAY_TIMESTAMP, 4));
    first.close();

    const walFilePath = store.walFilePath(DATABASE, DAY_DATE_NUMBER);
    const fileBytes = statSync(walFilePath).size;

    const resumed = new WriteAheadLog({ store, database: DATABASE });
    assert.deepStrictEqual(resumed.outstandingBatchIds, [WAL_ADOPTED_BATCH_ID]);
    assert.equal(resumed.pendingBytes, fileBytes);
    assert.equal(resumed.completeBatch(WAL_ADOPTED_BATCH_ID), 1);
    assert.equal(resumed.commitSafePoint().releasedBytes, fileBytes);
    assert.equal(statSync(walFilePath).size, 0);
    resumed.close();

    const withoutAdopt = new WriteAheadLog({ store, database: DATABASE, adoptExistingLines: false });
    assert.deepStrictEqual(withoutAdopt.outstandingBatchIds, []);
    withoutAdopt.close();
  });
});

/* ---------- 启动恢复：半块截断 ---------- */

describe('启动恢复：半块截断', () => {
  it('尾部残块（块数据不足）被截断至最后完整块，完整块数据不受影响', () => {
    const store = createStore('recover-partial-block');
    const writer = new SegmentWriter({ store, database: DATABASE, blockTargetPoints: 4096 });
    writer.append(points('m.partial', DAY_TIMESTAMP, 8192));
    const segmentFilePath = store.segmentFilePath(DATABASE, DAY_DATE_NUMBER, 1);

    const reader = new SegmentReader({ store });
    const before = reader.inspectSegment(DATABASE, DAY_DATE_NUMBER, 1);
    assert.notEqual(before, null);
    assert.equal(before?.entries.length, 2);
    assert.equal(before?.sealed, false, '未 close 的段没有 Footer');
    assert.equal(before?.truncatedBytes, 0);
    assert.equal(before?.indexMirrorRebuildNeeded, false, '未封口段不做镜像校验');

    // 断电残留：完整块之后追加「块头合法但数据被截断」的残块（取自末块的一半字节）
    const sourceEntry = before === null ? null : before.entries[1];
    assert.notEqual(sourceEntry, null);
    const sourceBytes = readSlice(
      segmentFilePath,
      sourceEntry?.offset ?? 0,
      sourceEntry?.length ?? 0,
    );
    const partialBytes = sourceBytes.subarray(0, Math.floor(sourceBytes.length / 2));
    appendFileSync(segmentFilePath, partialBytes);

    const report = recoverDataRoot({ store, reader });
    const segmentReport = report.databases[0].segments[0];
    assert.equal(segmentReport.truncatedBytes, partialBytes.length);
    assert.equal(segmentReport.scannedBlockCount, 2);
    assert.equal(segmentReport.indexRebuilt, false);
    assert.equal(report.truncatedSegmentCount, 1);
    assert.equal(statSync(segmentFilePath).size, before?.fileBytes, '应截断回追加残块前的长度');
    assert.equal(recoverDataRoot({ store }).truncatedBytes, 0, '二次恢复应无截断（幂等）');

    const reloaded = new SegmentReader({ store });
    assert.equal(reloaded.listSegments(DATABASE).length, 1);
    const read = reloaded.readMetricPoints(DATABASE, 'm.partial', {
      start: DAY_TIMESTAMP,
      end: DAY_TIMESTAMP + 8192 * 1000,
    });
    assert.equal(read.length, 8192, '完整块的点应全部可读');
    writer.close();
  });

  it('尾部末块 BlockData CRC 失败时剔除该末块并截断', () => {
    const store = createStore('recover-crc-block');
    const writer = new SegmentWriter({ store, database: DATABASE, blockTargetPoints: 4096 });
    writer.append(points('m.crc', DAY_TIMESTAMP, 4096));
    const segmentFilePath = store.segmentFilePath(DATABASE, DAY_DATE_NUMBER, 1);

    const reader = new SegmentReader({ store });
    const before = reader.inspectSegment(DATABASE, DAY_DATE_NUMBER, 1);
    assert.equal(before?.entries.length, 1);
    const entry = before?.entries[0];
    assert.notEqual(entry, undefined);

    // 结构合法、数据 CRC 不符（模拟断电写坏残块）
    const corrupted = readSlice(segmentFilePath, entry?.offset ?? 0, entry?.length ?? 0);
    corrupted[corrupted.length - 1] ^= 0xff;
    appendFileSync(segmentFilePath, corrupted);
    const cleanBytes = before?.fileBytes ?? 0;

    const report = recoverDataRoot({ store, reader });
    assert.equal(report.databases[0].segments[0].truncatedBytes, corrupted.length);
    assert.equal(report.databases[0].segments[0].scannedBlockCount, 1);
    assert.equal(statSync(segmentFilePath).size, cleanBytes, '应截断回追加坏末块前的长度');

    const reloaded = new SegmentReader({ store });
    assert.equal(reloaded.listSegments(DATABASE).length, 1);
    assert.equal(
      reloaded.readMetricPoints(DATABASE, 'm.crc', {
        start: DAY_TIMESTAMP,
        end: DAY_TIMESTAMP + 4096 * 1000,
      }).length,
      4096,
      '完整块的点应全部可读',
    );
    writer.close();
  });
});

/* ---------- 启动恢复：空段（断电于段头写入之前） ---------- */

describe('启动恢复：空段（断电于段头写入之前）', () => {
  it('0 字节 .seg 视为空段：恢复不抛 E_CORRUPT_SEGMENT，不截断、不删文件，其余段照常可读', () => {
    const store = createStore('recover-empty-segment');
    const writer = new SegmentWriter({ store, database: DATABASE, blockTargetPoints: 4096 });
    writer.append(points('m.empty', DAY_TIMESTAMP, 4096));
    writer.close();
    const sealedFilePath = store.segmentFilePath(DATABASE, DAY_DATE_NUMBER, 1);
    const sealedBytes = statSync(sealedFilePath).size;

    // 断电落在「独占创建 wx+ 成功、段头 32B 尚未写入」的窗口：留下 0 字节 .seg
    const emptySequence = store.nextSegmentSequence(DATABASE, DAY_DATE_NUMBER);
    const emptyFilePath = store.segmentFilePath(DATABASE, DAY_DATE_NUMBER, emptySequence);
    writeFileSync(emptyFilePath, new Uint8Array(0));

    const reader = new SegmentReader({ store });
    const inspection = reader.inspectSegment(DATABASE, DAY_DATE_NUMBER, emptySequence);
    assert.notEqual(inspection, null);
    assert.equal(inspection?.sealed, false);
    assert.equal(inspection?.entries.length, 0);
    assert.equal(inspection?.truncatedBytes, 0);
    assert.equal(inspection?.blockRegionEnd, 0);
    assert.equal(inspection?.indexMirrorRebuildNeeded, false);

    const report = recoverDataRoot({ store, reader }); // 关键：不得抛 E_CORRUPT_SEGMENT
    const emptyReport = report.databases[0].segments.find((segment) => segment.sequence === emptySequence);
    assert.notEqual(emptyReport, undefined);
    assert.equal(emptyReport?.scannedBlockCount, 0);
    assert.equal(emptyReport?.truncatedBytes, 0);
    assert.equal(emptyReport?.indexRebuilt, false);
    assert.equal(report.truncatedSegmentCount, 0);
    assert.equal(statSync(emptyFilePath).size, 0, '空段既不截断也不删除，保持原样');
    assert.equal(statSync(sealedFilePath).size, sealedBytes, '同目录其余段不受影响');

    // 读路径同样容忍：可列出 2 段（空段贡献 0 个块），已封口段的点仍全部可读
    const reloaded = new SegmentReader({ store });
    assert.equal(reloaded.listSegments(DATABASE).length, 2);
    assert.equal(
      reloaded.readMetricPoints(DATABASE, 'm.empty', {
        start: DAY_TIMESTAMP,
        end: DAY_TIMESTAMP + 4096 * 1000,
      }).length,
      4096,
    );
  });

  it('段头写入中途断电（部分段头，< 32B）同样按空段处理而非损坏', () => {
    const store = createStore('recover-partial-header');
    const emptySequence = 1;
    const emptyFilePath = store.segmentFilePath(DATABASE, DAY_DATE_NUMBER, emptySequence);
    mkdirSync(store.dayDirectoryPath(DATABASE, DAY_DATE_NUMBER), { recursive: true });
    writeFileSync(emptyFilePath, new Uint8Array(12)); // 段头只写了一部分

    const reader = new SegmentReader({ store });
    assert.equal(reader.inspectSegment(DATABASE, DAY_DATE_NUMBER, emptySequence)?.entries.length, 0);
    const report = recoverDataRoot({ store, reader });
    assert.equal(report.truncatedSegmentCount, 0);
    assert.equal(report.databases[0].segments[0].truncatedBytes, 0);
    assert.equal(statSync(emptyFilePath).size, 12, '未满 32B 的残段头不做截断');
    assert.equal(
      reader.readMetricPoints(DATABASE, 'any.metric', {
        start: DAY_TIMESTAMP,
        end: DAY_TIMESTAMP + 1000,
      }).length,
      0,
    );
  });
});

/* ---------- 启动恢复：`.idx` 镜像 ---------- */

describe('启动恢复：索引镜像', () => {
  it('封口段 `.idx` 缺失时由扫块重建，二次恢复不再重建', () => {
    const store = createStore('recover-idx-missing');
    const writer = new SegmentWriter({ store, database: DATABASE, blockTargetPoints: 4096 });
    writer.append(points('m.idx', DAY_TIMESTAMP, 4096));
    writer.close();

    const indexFilePath = store.indexFilePathOfSegment(DATABASE, DAY_DATE_NUMBER, 1);
    const mirroredBytes = statSync(indexFilePath).size;
    unlinkSync(indexFilePath);

    const report = recoverDataRoot({ store });
    const segmentReport = report.databases[0].segments[0];
    assert.equal(segmentReport.sealed, true);
    assert.equal(segmentReport.indexRebuilt, true);
    assert.equal(report.rebuiltIndexCount, 1);
    assert.equal(statSync(indexFilePath).size, mirroredBytes, '重建镜像长度应与原镜像一致');
    assert.equal(recoverDataRoot({ store }).rebuiltIndexCount, 0, '二次恢复不应重复重建');

    const reader = new SegmentReader({ store });
    assert.equal(
      reader.readMetricPoints(DATABASE, 'm.idx', { start: DAY_TIMESTAMP, end: DAY_TIMESTAMP + 4096 * 1000 })
        .length,
      4096,
    );
  });

  it('`.idx` 内容损坏（同长度垃圾）时按扫块结果重建', () => {
    const store = createStore('recover-idx-corrupt');
    const writer = new SegmentWriter({ store, database: DATABASE, blockTargetPoints: 4096 });
    writer.append(points('m.idx', DAY_TIMESTAMP, 4096));
    writer.close();

    const indexFilePath = store.indexFilePathOfSegment(DATABASE, DAY_DATE_NUMBER, 1);
    writeFileSync(indexFilePath, new Uint8Array(statSync(indexFilePath).size).fill(0xff));

    const reader = new SegmentReader({ store });
    assert.equal(reader.inspectSegment(DATABASE, DAY_DATE_NUMBER, 1)?.indexMirrorRebuildNeeded, true);

    const report = recoverDataRoot({ store, reader });
    assert.equal(report.rebuiltIndexCount, 1);
    assert.equal(reader.inspectSegment(DATABASE, DAY_DATE_NUMBER, 1)?.indexMirrorRebuildNeeded, false);
    assert.equal(
      reader.readMetricPoints(DATABASE, 'm.idx', { start: DAY_TIMESTAMP, end: DAY_TIMESTAMP + 4096 * 1000 })
        .length,
      4096,
    );
  });
});

/* ---------- 启动恢复：WAL 重放与范围 ---------- */

describe('启动恢复：WAL 重放与范围', () => {
  it('返回完整行条目并截断尾部残行', () => {
    const store = createStore('recover-wal');
    const wal = new WriteAheadLog({ store, database: DATABASE });
    wal.append(points('m.replay', DAY_TIMESTAMP, 5));
    wal.close();

    const walFilePath = store.walFilePath(DATABASE, DAY_DATE_NUMBER);
    const completeBytes = statSync(walFilePath).size;
    const tornLine = '{"m":"m.replay","t":1';
    appendFileSync(walFilePath, tornLine);

    const report = recoverDataRoot({ store });
    const databaseReport = report.databases[0];
    assert.equal(databaseReport.replayedEntries.length, 5);
    assert.equal(report.replayedEntryCount, 5);
    assert.equal(databaseReport.walFiles.length, 1);
    assert.equal(databaseReport.walFiles[0].discardedTailBytes, tornLine.length);
    assert.equal(report.discardedWalTailBytes, tornLine.length);
    assert.equal(statSync(walFilePath).size, completeBytes, '残行应已被截断');

    const replayed = databaseReport.replayedEntries[0];
    assert.equal(replayed.metricName, 'm.replay');
    assert.equal(replayed.timestamp, DAY_TIMESTAMP);
    assert.equal(replayed.value, 0);
    assert.equal(replayed.quality, 0);
  });

  it('超大 WAL（15 万行）重放不再触发 push 参数展开上限崩溃', () => {
    // 20k pts/s + 5 s 兜底成块 ⇒ 崩溃时 WAL 里常驻 10^5 条；旧实现用
    // `replayedEntries.push(...entries)` 直接展开，会抛 RangeError: Maximum call stack size exceeded，
    // 导致崩溃后无法启动。
    const store = createStore('recover-wal-large');
    const wal = new WriteAheadLog({ store, database: DATABASE });
    const total = 150_000;
    for (let written = 0; written < total; written += 50_000) {
      wal.append(points('m.replay.large', DAY_TIMESTAMP + written * 10, 50_000, 10));
    }
    wal.close();

    const report = recoverDataRoot({ store });
    assert.equal(report.replayedEntryCount, total);
    assert.equal(report.databases[0]?.replayedEntries.length, total);
  });

  it('空数据根返回空报告且不抛错', () => {
    const store = createStore('recover-empty');
    const report = recoverDataRoot({ store });
    assert.deepStrictEqual(report.databases, []);
    assert.equal(report.segmentCount, 0);
    assert.equal(report.replayedEntryCount, 0);
  });

  it('可限定恢复的库，未列出的库不被扫描', () => {
    const store = createStore('recover-scope');
    for (const database of ['db.a', 'db.b']) {
      const writer = new SegmentWriter({ store, database, blockTargetPoints: 4096 });
      writer.append(points('m.scope', DAY_TIMESTAMP, 4096));
      writer.close();
    }

    assert.deepStrictEqual(store.listDatabases(), ['db.a', 'db.b']);
    const scoped = recoverDataRoot({ store, databases: ['db.a'] });
    assert.deepStrictEqual(
      scoped.databases.map((entry) => entry.database),
      ['db.a'],
    );
    assert.equal(scoped.segmentCount, 1);

    const all = recoverDataRoot({ store });
    assert.equal(all.databases.length, 2);
    assert.equal(all.segmentCount, 2);
  });
});

/* ---------- 格式常量口径 ---------- */

describe('启动恢复：格式常量口径', () => {
  it('段头固定 32B（半块扫描起点依赖该常量）', () => {
    assert.equal(SEGMENT_HEADER_SIZE, 32);
  });
});
