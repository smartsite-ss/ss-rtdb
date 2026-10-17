// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 保留与运维单测（对齐《详细设计 v2.0》§2.9、§6.2.1）：
 * 过期判定（纯函数）、整日 tar.gz 归档与逐字节还原、整组删除、目录替换复制、引擎备份/恢复、
 * 引擎保留扫描、库级 retention.json 覆盖
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { after, describe, it } from 'node:test';

import { RETENTION_FILE_NAME, RtdbEngine } from '../packages/core/src/engine.ts';
import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import { dateNumberFromTimestamp, formatDateFolderName, formatWalFileName } from '../packages/core/src/format.ts';
import {
  ARCHIVE_FILE_EXTENSION,
  archiveDayDirectory,
  copyDirectoryReplacing,
  deleteDayDirectory,
  extractTarGzipArchive,
  isDayDirectoryExpired,
  listArchivedDays,
  measureDirectory,
  planExpiredDayDirectories,
  readTarGzipEntries,
} from '../packages/core/src/retention.ts';
import type { EngineOptions, WritePoint } from '../packages/core/src/types.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-retention-'));
const TAR_BLOCK_SIZE = 512;
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/* ---------- 夹具与工具 ---------- */

function createWorkDir(): string {
  caseCounter += 1;
  return join(rootDirectory, `case-${caseCounter}`);
}

function makeDirectory(directoryPath: string): string {
  mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

function expectRtdbCode(error: unknown, code: string): boolean {
  return isRtdbError(error) && error.code === code;
}

async function openEngine(dataDir: string, options: Omit<EngineOptions, 'dataDir'> = {}): Promise<RtdbEngine> {
  const engine = new RtdbEngine({ dataDir, ...options });
  await engine.open();
  return engine;
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

/** 相对今天的日目录日期号（取当日 12:00 构造，规避 DST 导致的归属偏移） */
function dayNumberAtOffset(offset: number): number {
  const today = new Date();
  const shifted = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, 12, 0, 0);
  return dateNumberFromTimestamp(shifted.getTime());
}

/** 相对今天的某个时刻（默认 10:00） */
function timestampAtOffset(offset: number, hour = 10): number {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, hour, 0, 0).getTime();
}

/** 读取 USTAR 头中以 NUL 结尾的字符串域 */
function readTarString(header: Uint8Array, offset: number, maxLength: number): string {
  let end = offset;
  while (end < offset + maxLength && header[end] !== 0) end += 1;
  return Buffer.from(header.subarray(offset, end)).toString('utf8');
}

/** 解析 USTAR 归档条目（遇到全零头即视为尾标记结束） */
function parseTarEntries(tar: Uint8Array): Array<{ name: string; bytes: Uint8Array }> {
  const entries: Array<{ name: string; bytes: Uint8Array }> = [];
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    const name = readTarString(header, 0, 100);
    if (name.length === 0) break;
    const size = Number.parseInt(readTarString(header, 124, 12), 8);
    const dataStart = offset + TAR_BLOCK_SIZE;
    entries.push({ name, bytes: tar.subarray(dataStart, dataStart + size) });
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return entries;
}

/** 目录内的常规文件（名称 + 绝对路径，按名称升序；不含子目录） */
function listFilesFlat(directoryPath: string): Array<{ name: string; path: string }> {
  return readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, path: join(directoryPath, entry.name) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** 逐字节比对两个目录：文件名集合、每个文件的长度与字节都必须一致 */
function assertDirectoriesByteIdentical(actualDirectory: string, expectedDirectory: string): void {
  const actual = listFilesFlat(actualDirectory);
  const expected = listFilesFlat(expectedDirectory);
  assert.deepStrictEqual(
    actual.map((file) => file.name),
    expected.map((file) => file.name),
    '还原目录的文件名集合应与原目录一致',
  );
  for (let index = 0; index < actual.length; index += 1) {
    const actualBytes = readFileSync(actual[index].path);
    const expectedBytes = readFileSync(expected[index].path);
    assert.equal(actualBytes.length, expectedBytes.length, `文件 ${actual[index].name} 长度应一致`);
    assert.deepStrictEqual(actualBytes, expectedBytes, `文件 ${actual[index].name} 应逐字节一致`);
  }
}

/** 手工构造单条目 USTAR（用于构造越界 / 逃逸条目名的畸形归档） */
function buildSingleEntryArchive(entryName: string, declaredSize: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(entryName, 0, 100, 'utf8');
  header.write(`${declaredSize.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  header.write('0', 156, 1, 'latin1');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return Buffer.concat([header, Buffer.from(payload)]);
}

/* ---------- 过期判定（纯函数） ---------- */

describe('保留: 过期判定（纯函数）', () => {
  /** 固定「今天」为 2026-06-20 08:00（本机时区），避免依赖当前时间 */
  const nowMs = new Date(2026, 5, 20, 8, 0, 0).getTime();
  const dayNumber = (daysAgo: number): number =>
    dateNumberFromTimestamp(new Date(2026, 5, 20 - daysAgo, 12, 0, 0).getTime());

  it('retentionDays<=0 表示永久保留，恒不过期', () => {
    assert.equal(isDayDirectoryExpired(dayNumber(0), 0, nowMs), false);
    assert.equal(isDayDirectoryExpired(dayNumber(30), 0, nowMs), false);
    assert.equal(isDayDirectoryExpired(dayNumber(3650), -1, nowMs), false);
  });

  it('保留 N 天 = 今天与之前 N 天，第 N+1 天前才过期（当日天然排除）', () => {
    for (const days of [1, 7, 30]) {
      assert.equal(isDayDirectoryExpired(dayNumber(0), days, nowMs), false, `今天（days=${days}）`);
      assert.equal(isDayDirectoryExpired(dayNumber(days), days, nowMs), false, `边界第 ${days} 天`);
      assert.equal(isDayDirectoryExpired(dayNumber(days + 1), days, nowMs), true, `第 ${days + 1} 天`);
    }
  });

  it('planExpiredDayDirectories 升序输出过期日目录并尊重排除集', () => {
    const directories = [dayNumber(30), dayNumber(0), dayNumber(9), dayNumber(8), dayNumber(1)];
    assert.deepStrictEqual(
      planExpiredDayDirectories(directories, 7, nowMs),
      [dayNumber(30), dayNumber(9), dayNumber(8)],
    );
    assert.deepStrictEqual(
      planExpiredDayDirectories(directories, 7, nowMs, [dayNumber(8)]),
      [dayNumber(30), dayNumber(9)],
    );
    assert.deepStrictEqual(planExpiredDayDirectories(directories, 7, nowMs, directories), []);
  });
});

/* ---------- 整日归档 ---------- */

describe('保留: 整日归档 tar.gz', () => {
  it('archiveDayDirectory 生成 {archiveDir}/{db}/yyyyMMdd.tar.gz 且内容可完整还原', () => {
    const workDir = createWorkDir();
    const dateNumber = 20260620;
    const prefix = formatDateFolderName(dateNumber);
    const segEntryName = `${prefix}/${prefix}-001.seg`;
    const walEntryName = `${prefix}/${formatWalFileName(dateNumber)}`;

    const dayDirectory = makeDirectory(join(workDir, 'source', 'db', prefix));
    const segmentBytes = Buffer.from('segment-payload-0123456789', 'utf8');
    const walBytes = Buffer.from('{"m":"m.temp","t":1,"v":1}\n', 'utf8');
    writeFileSync(join(dayDirectory, `${prefix}-001.seg`), segmentBytes);
    writeFileSync(join(dayDirectory, formatWalFileName(dateNumber)), walBytes);

    const archiveDirectory = join(workDir, 'archive');
    const result = archiveDayDirectory({
      database: 'db',
      dateNumber,
      sourceDayDirectory: dayDirectory,
      archiveDirectory,
    });

    assert.equal(result.archiveFilePath, join(archiveDirectory, 'db', `${prefix}${ARCHIVE_FILE_EXTENSION}`));
    assert.equal(result.entryCount, 2);
    assert.equal(result.totalBytes, statSync(result.archiveFilePath).size);

    const tar = new Uint8Array(gunzipSync(readFileSync(result.archiveFilePath)));
    assert.equal(tar.length % TAR_BLOCK_SIZE, 0);
    for (let index = tar.length - 1024; index < tar.length; index += 1) {
      assert.equal(tar[index], 0, `尾标记字节偏移 ${index} 应为 0`);
    }

    const entries = parseTarEntries(tar);
    assert.deepStrictEqual(entries.map((entry) => entry.name).sort(), [walEntryName, segEntryName].sort());

    const segmentEntry = entries.find((entry) => entry.name === segEntryName);
    if (segmentEntry === undefined) throw new Error('归档缺少段文件条目');
    assert.deepStrictEqual(Buffer.from(segmentEntry.bytes), segmentBytes);

    const walEntry = entries.find((entry) => entry.name === walEntryName);
    if (walEntry === undefined) throw new Error('归档缺少 WAL 条目');
    assert.deepStrictEqual(Buffer.from(walEntry.bytes), walBytes);
  });
});

/* ---------- 归档可还原性（逐字节） ---------- */

describe('保留: 归档可还原性（逐字节）', () => {
  it('整日归档可逐字节还原：文件集合、长度与字节与原日目录完全一致', () => {
    const workDir = createWorkDir();
    const dateNumber = 20260620;
    const prefix = formatDateFolderName(dateNumber);
    const dayDirectory = makeDirectory(join(workDir, 'data', 'db', prefix));

    // 覆盖边界：512 整数倍 / 非整数倍 / 空文件（USTAR size=0）/ 回填边车
    const files: Array<[string, Uint8Array]> = [
      [`${prefix}-001.seg`, new Uint8Array(1024).map((_, index) => index % 251)],
      [`${prefix}-002.seg`, new Uint8Array(300).map((_, index) => (index * 7) % 256)],
      [`${prefix}-001.idx`, new Uint8Array(128).fill(0x5a)],
      [formatWalFileName(dateNumber), new Uint8Array(0)],
      [`${prefix}.bfill.seg`, new Uint8Array(37).fill(0x11)],
    ];
    let sourceBytes = 0;
    for (const [name, bytes] of files) {
      writeFileSync(join(dayDirectory, name), bytes);
      sourceBytes += bytes.length;
    }

    const archive = archiveDayDirectory({
      database: 'db',
      dateNumber,
      sourceDayDirectory: dayDirectory,
      archiveDirectory: join(workDir, 'archive'),
    });
    assert.equal(archive.entryCount, files.length);
    assert.deepStrictEqual(
      readTarGzipEntries(archive.archiveFilePath).map((entry) => entry.name),
      files.map(([name]) => `${prefix}/${name}`).sort(),
      '归档条目名应为 yyyyMMdd/文件名（按名升序）',
    );

    // 目标目录预置陈旧文件，验证「整日替换」语义
    const restoredDirectory = join(workDir, 'restored', prefix);
    makeDirectory(restoredDirectory);
    writeFileSync(join(restoredDirectory, 'stale.bin'), new Uint8Array(512).fill(0xee));

    const extracted = extractTarGzipArchive({
      archiveFilePath: archive.archiveFilePath,
      targetDayDirectory: restoredDirectory,
    });
    assert.equal(extracted.fileCount, files.length);
    assert.equal(extracted.totalBytes, sourceBytes);
    assert.equal(measureDirectory(restoredDirectory).totalBytes, sourceBytes);
    assert.equal(existsSync(join(restoredDirectory, 'stale.bin')), false, '陈旧文件应被整目录替换清除');
    assertDirectoriesByteIdentical(restoredDirectory, dayDirectory);
  });

  it('listArchivedDays 按日期升序列出，临时文件与非 yyyyMMdd 命名被跳过', () => {
    const workDir = createWorkDir();
    const archiveDirectory = join(workDir, 'archive');
    for (const dateNumber of [20260620, 20260618]) {
      const dayDirectory = makeDirectory(join(workDir, 'db', formatDateFolderName(dateNumber)));
      writeFileSync(join(dayDirectory, `${formatDateFolderName(dateNumber)}-001.seg`), new Uint8Array(64).fill(3));
      archiveDayDirectory({ database: 'db', dateNumber, sourceDayDirectory: dayDirectory, archiveDirectory });
    }
    const databaseArchiveDirectory = join(archiveDirectory, 'db');
    writeFileSync(join(databaseArchiveDirectory, `20260619${ARCHIVE_FILE_EXTENSION}.tmp`), new Uint8Array(4));
    writeFileSync(join(databaseArchiveDirectory, 'readme.txt'), new Uint8Array(4));

    const archives = listArchivedDays(archiveDirectory, 'db');
    assert.deepStrictEqual(archives.map((archive) => archive.dateNumber), [20260618, 20260620]);
    for (const archive of archives) {
      assert.equal(archive.totalBytes, statSync(archive.archiveFilePath).size);
    }
    assert.deepStrictEqual(listArchivedDays(join(workDir, 'no-such-archive'), 'db'), []);
  });

  it('归档损坏（非 gzip / 截断 gzip / 越界条目 / 逃逸条目名）读取抛 E_IO', () => {
    const workDir = makeDirectory(createWorkDir());

    const notGzip = join(workDir, 'not-gzip.tar.gz');
    writeFileSync(notGzip, Buffer.from('not a gzip payload', 'utf8'));
    assert.throws(
      () => readTarGzipEntries(notGzip),
      (error) => expectRtdbCode(error, ERROR_CODE.Io),
      '非 gzip 载荷应抛 E_IO',
    );

    const truncated = join(workDir, 'truncated.tar.gz');
    writeFileSync(truncated, gzipSync(new Uint8Array(TAR_BLOCK_SIZE * 3)).subarray(0, 12));
    assert.throws(
      () => readTarGzipEntries(truncated),
      (error) => expectRtdbCode(error, ERROR_CODE.Io),
      '截断的 gzip 应抛 E_IO',
    );

    const oversized = join(workDir, 'oversized.tar.gz');
    writeFileSync(
      oversized,
      gzipSync(buildSingleEntryArchive('20260620/x.seg', 4096, new Uint8Array(16))),
    );
    assert.throws(
      () => readTarGzipEntries(oversized),
      (error) => expectRtdbCode(error, ERROR_CODE.Io),
      '声明长度超出归档长度的条目应抛 E_IO',
    );

    const traversal = join(workDir, 'traversal.tar.gz');
    writeFileSync(
      traversal,
      gzipSync(buildSingleEntryArchive('20260620/..', 16, new Uint8Array(16))),
    );
    assert.throws(
      () => extractTarGzipArchive({ archiveFilePath: traversal, targetDayDirectory: join(workDir, 'target') }),
      (error) => expectRtdbCode(error, ERROR_CODE.Io),
      '逃逸目标目录的条目名应抛 E_IO',
    );
  });
});

/* ---------- 整组删除 ---------- */

describe('保留: 整组删除', () => {
  it('deleteDayDirectory 返回释放字节数并移除整日目录（目录已不存在返回 0）', () => {
    const workDir = createWorkDir();
    const dayDirectory = makeDirectory(join(workDir, 'day'));
    writeFileSync(join(dayDirectory, 'a.seg'), Buffer.alloc(64, 1));
    writeFileSync(join(dayDirectory, 'a.wal'), Buffer.alloc(50, 2));

    assert.equal(deleteDayDirectory(dayDirectory), 114);
    assert.equal(existsSync(dayDirectory), false);
    assert.equal(deleteDayDirectory(dayDirectory), 0);
  });
});

/* ---------- 目录替换复制 ---------- */

describe('保留: 目录替换复制', () => {
  it('copyDirectoryReplacing 清空目标陈旧文件并返回文件数与字节数', () => {
    const workDir = createWorkDir();
    const sourceDirectory = makeDirectory(join(workDir, 'source'));
    writeFileSync(join(sourceDirectory, '1.seg'), Buffer.alloc(30, 1));
    writeFileSync(join(sourceDirectory, '2.idx'), Buffer.alloc(20, 2));

    const targetDirectory = join(workDir, 'nested', 'target');
    makeDirectory(targetDirectory);
    writeFileSync(join(targetDirectory, 'stale.bin'), Buffer.alloc(999, 3));

    const result = copyDirectoryReplacing(sourceDirectory, targetDirectory);
    assert.equal(result.fileCount, 2);
    assert.equal(result.totalBytes, 50);
    assert.deepStrictEqual(measureDirectory(targetDirectory), { fileCount: 2, totalBytes: 50 });
    assert.equal(existsSync(join(targetDirectory, 'stale.bin')), false);
    assert.equal(existsSync(join(targetDirectory, '1.seg')), true);
  });

  it('源目录缺失抛 E_DB_NOT_FOUND', () => {
    const workDir = createWorkDir();
    assert.throws(
      () => copyDirectoryReplacing(join(workDir, 'missing'), join(workDir, 'target')),
      (error) => expectRtdbCode(error, ERROR_CODE.DatabaseNotFound),
    );
  });
});

/* ---------- 备份与恢复（引擎） ---------- */

describe('保留: 备份与恢复（引擎）', () => {
  it('backup 复制整库一致快照（含活跃段与 WAL），restore 后可查且 WAL 已重放', async () => {
    const base = new Date(2026, 0, 10, 10, 0, 0).getTime();
    const dayPrefix = formatDateFolderName(dateNumberFromTimestamp(base));
    const backupRoot = join(createWorkDir(), 'backups');
    const blockOptions = { blockTargetPoints: 4096, blockMinPoints: 64 };
    const bigValues = Array.from({ length: 4096 }, (_, index) => index);

    const source = await openEngine(join(createWorkDir(), 'source-data'), blockOptions);
    try {
      await source.writeBatch('db', pointsFrom('m.temp', bigValues, base));
      const pressResult = await source.writeBatch('db', pointsFrom('m.press', [1.5, 2.5, 3.5], base + 4096 * 1000));
      assert.equal(pressResult.accepted, 3);

      const backup = await source.backup('db', backupRoot);
      assert.equal(backup.database, 'db');
      assert.equal(backup.targetDirectory, join(backupRoot, 'db'));
      assert.ok(backup.fileCount > 0);
      assert.ok(backup.totalBytes > 0);
      // 一致性快照含当日活跃段（未封口）与未清空 WAL
      assert.equal(existsSync(join(backupRoot, 'db', dayPrefix, `${dayPrefix}-001.seg`)), true);
      assert.ok(statSync(join(backupRoot, 'db', dayPrefix, formatWalFileName(dateNumberFromTimestamp(base)))).size > 0);
    } finally {
      await source.close();
    }

    const restored = await openEngine(join(createWorkDir(), 'restored-data'));
    try {
      const result = await restored.restore(backupRoot, 'db');
      assert.equal(result.database, 'db');
      assert.equal(result.sourceDirectory, join(backupRoot, 'db'));
      assert.ok(result.fileCount > 0);

      const series = await restored.queryRange('db', 'm.temp', { start: base, end: base + 4095 * 1000 });
      assert.equal(series.points.length, 4096);
      assert.deepStrictEqual(series.points[0], { timestamp: base, value: 0 });
      assert.deepStrictEqual(series.points[4095], { timestamp: base + 4095 * 1000, value: 4095 });

      const press = await restored.queryRange('db', 'm.press', { start: base + 4096 * 1000, end: base + 4098 * 1000 });
      assert.deepStrictEqual(press.points, [
        { timestamp: base + 4096 * 1000, value: 1.5 },
        { timestamp: base + 4097 * 1000, value: 2.5 },
        { timestamp: base + 4098 * 1000, value: 3.5 },
      ]);
    } finally {
      await restored.close();
    }
  });

  it('backup 未知库与 restore 缺备份均抛 E_DB_NOT_FOUND', async () => {
    const engine = await openEngine(createWorkDir());
    try {
      await assert.rejects(
        engine.backup('missing', createWorkDir()),
        (error) => expectRtdbCode(error, ERROR_CODE.DatabaseNotFound),
      );
      await assert.rejects(
        engine.restore(createWorkDir(), 'db'),
        (error) => expectRtdbCode(error, ERROR_CODE.DatabaseNotFound),
      );
    } finally {
      await engine.close();
    }
  });
});

/* ---------- 引擎保留扫描 ---------- */

describe('保留: 引擎 runRetention 扫描', () => {
  it('只删过期日目录；今日、保留边界日与 WAL 非空的过期日不删', async () => {
    const dataDir = join(createWorkDir(), 'data');
    const engine = await openEngine(dataDir, { retentionDays: 7 });
    try {
      const database = 'db';
      const todayNumber = dayNumberAtOffset(0);
      const boundaryNumber = dayNumberAtOffset(7);
      const expiredNumber = dayNumberAtOffset(8);
      const dirtyNumber = dayNumberAtOffset(10);
      const dayDirectoryOf = (dateNumber: number): string =>
        join(dataDir, database, formatDateFolderName(dateNumber));
      const createDay = (dateNumber: number, byteLength: number): void => {
        const directory = makeDirectory(dayDirectoryOf(dateNumber));
        writeFileSync(join(directory, `${formatDateFolderName(dateNumber)}-001.seg`), Buffer.alloc(byteLength, 7));
      };

      createDay(todayNumber, 32);
      createDay(boundaryNumber, 32);
      createDay(expiredNumber, 32);
      createDay(dirtyNumber, 32);
      // 脏日目录：WAL 非空（模拟存在未落段数据）
      writeFileSync(join(dayDirectoryOf(dirtyNumber), formatWalFileName(dirtyNumber)), Buffer.from('{"m":"m.temp","t":1,"v":1}\n'));

      const results = await engine.runRetention();
      assert.equal(results.length, 1);
      const result = results[0];
      assert.equal(result.database, database);
      assert.equal(result.retentionDays, 7);
      assert.deepStrictEqual(result.deletedDateNumbers, [expiredNumber]);
      assert.deepStrictEqual(result.skippedDateNumbers, [dirtyNumber]);
      assert.deepStrictEqual(result.archived, []);
      assert.equal(result.deletedBytes, 32);

      assert.equal(existsSync(dayDirectoryOf(expiredNumber)), false);
      assert.equal(existsSync(dayDirectoryOf(dirtyNumber)), true);
      assert.equal(existsSync(dayDirectoryOf(boundaryNumber)), true);
      assert.equal(existsSync(dayDirectoryOf(todayNumber)), true);
    } finally {
      await engine.close();
    }
  });

  it('retentionDays=0（永久保留）时不删任何日目录', async () => {
    const dataDir = join(createWorkDir(), 'data');
    const engine = await openEngine(dataDir, { retentionDays: 0 });
    try {
      const expiredNumber = dayNumberAtOffset(30);
      const dayDirectory = makeDirectory(join(dataDir, 'db', formatDateFolderName(expiredNumber)));
      writeFileSync(join(dayDirectory, `${formatDateFolderName(expiredNumber)}-001.seg`), Buffer.alloc(16, 1));

      const results = await engine.runRetention();
      assert.equal(results.length, 1);
      assert.equal(results[0].retentionDays, 0);
      assert.deepStrictEqual(results[0].deletedDateNumbers, []);
      assert.equal(existsSync(dayDirectory), true);
    } finally {
      await engine.close();
    }
  });

  it('archiveBeforeDelete 归档后删除，落点 {dataDir}/archive/{db}/yyyyMMdd.tar.gz', async () => {
    const dataDir = join(createWorkDir(), 'data');
    const engine = await openEngine(dataDir, { retentionDays: 7, archiveBeforeDelete: true });
    try {
      const expiredNumber = dayNumberAtOffset(8);
      const dayDirectory = makeDirectory(join(dataDir, 'db', formatDateFolderName(expiredNumber)));
      writeFileSync(join(dayDirectory, `${formatDateFolderName(expiredNumber)}-001.seg`), Buffer.alloc(40, 9));

      const results = await engine.runRetention();
      assert.equal(results.length, 1);
      const result = results[0];
      assert.deepStrictEqual(result.deletedDateNumbers, [expiredNumber]);
      assert.equal(result.archived.length, 1);
      assert.equal(result.archived[0].dateNumber, expiredNumber);
      assert.equal(
        result.archived[0].archiveFilePath,
        join(engine.archiveDir, 'db', `${formatDateFolderName(expiredNumber)}${ARCHIVE_FILE_EXTENSION}`),
      );
      assert.equal(result.archived[0].totalBytes, statSync(result.archived[0].archiveFilePath).size);
      assert.equal(existsSync(dayDirectory), false);
    } finally {
      await engine.close();
    }
  });

  it('过期日存在已写段句柄时仍可删除（覆盖段/WAL/解码块缓存句柄释放）', async () => {
    const dataDir = join(createWorkDir(), 'data');
    const engine = await openEngine(dataDir, { retentionDays: 7, blockTargetPoints: 4096, blockMinPoints: 64 });
    try {
      const expiredTimestamp = timestampAtOffset(30, 10);
      const expiredNumber = dateNumberFromTimestamp(expiredTimestamp);
      const todayTimestamp = timestampAtOffset(0, 10);
      const values = Array.from({ length: 4096 }, (_, index) => index);

      // 旧日写满一个块（形成活跃段），再用今日写入触发跨天轮转与旧段封口
      await engine.writeBatch('db', pointsFrom('m.temp', values, expiredTimestamp));
      await engine.writeBatch('db', pointsFrom('m.temp', values, todayTimestamp));

      const before = await engine.queryCount('db', 'm.temp', {
        start: expiredTimestamp,
        end: expiredTimestamp + 4095 * 1000,
      });
      assert.equal(before, 4096);

      const results = await engine.runRetention();
      assert.equal(results.length, 1);
      assert.deepStrictEqual(results[0].deletedDateNumbers, [expiredNumber]);
      assert.ok(results[0].deletedBytes > 0);
      assert.equal(existsSync(join(dataDir, 'db', formatDateFolderName(expiredNumber))), false);

      const after = await engine.queryCount('db', 'm.temp', {
        start: expiredTimestamp,
        end: expiredTimestamp + 4095 * 1000,
      });
      assert.equal(after, 0);
    } finally {
      await engine.close();
    }
  });
});

/* ---------- 库级 retention.json 覆盖 ---------- */

describe('保留: 库级 retention.json 覆盖', () => {
  it('库级覆盖优先于全局默认（含重启后重新加载）', async () => {
    const dataDir = join(createWorkDir(), 'data');
    const globalDays = 1;
    const databaseDays = 30;
    // 判别日：全局 1 天口径下已过期，库级 30 天口径下仍在保留范围
    const withinDatabaseRange = dayNumberAtOffset(20);
    const beyondDatabaseRange = dayNumberAtOffset(35);

    const engine = await openEngine(dataDir, { retentionDays: globalDays });
    try {
      await engine.setRetention('db', databaseDays);
      const policy = JSON.parse(
        readFileSync(join(dataDir, 'db', RETENTION_FILE_NAME), 'utf8'),
      ) as { retentionDays: number };
      assert.equal(policy.retentionDays, databaseDays, '策略文件应落盘为库级天数');

      for (const [dateNumber, byteLength] of [
        [withinDatabaseRange, 16],
        [beyondDatabaseRange, 24],
      ] as const) {
        // 用 `.idx` 造日目录：本用例会在重开引擎时触发启动恢复，而恢复只按 `.seg` 枚举段
        const directory = makeDirectory(join(dataDir, 'db', formatDateFolderName(dateNumber)));
        writeFileSync(
          join(directory, `${formatDateFolderName(dateNumber)}-001.idx`),
          Buffer.alloc(byteLength, 5),
        );
      }

      const results = await engine.runRetention();
      assert.equal(results.length, 1);
      assert.equal(results[0].retentionDays, databaseDays, '库级 30 天应覆盖全局 1 天');
      assert.deepStrictEqual(
        results[0].deletedDateNumbers,
        [beyondDatabaseRange],
        '仅在库级保留范围之外的日目录被删',
      );
      assert.equal(
        existsSync(join(dataDir, 'db', formatDateFolderName(withinDatabaseRange))),
        true,
        '库级保留范围内的日目录（全局口径下已过期）不应被删',
      );
    } finally {
      await engine.close();
    }

    // 重启（重开引擎）后按 retention.json 重新加载覆盖，过期判定沿用库级天数
    const reopened = await openEngine(dataDir, { retentionDays: globalDays });
    try {
      const results = await reopened.runRetention();
      assert.equal(results.length, 1);
      assert.equal(results[0].retentionDays, databaseDays, '重开引擎后仍应重载库级覆盖');
      assert.deepStrictEqual(results[0].deletedDateNumbers, []);
      assert.equal(existsSync(join(dataDir, 'db', formatDateFolderName(withinDatabaseRange))), true);
    } finally {
      await reopened.close();
    }
  });
});
