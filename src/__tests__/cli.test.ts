// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `rtdbctl` 单测（对齐《详细设计 v2.2》§5）：
 * 用法 / 帮助 / 版本与退出码语义，以及端到端出口标准「SDK 写 → CLI 查 → backup → restore」。
 *
 * 说明：`runCli` 不调用 `process.exit` 且支持注入 IO / 环境，因此可在进程内直接驱动。
 * 远端命令（status / metrics / backup / retention 设置）走真实 `RtdbServer`（`port: 0` 随机端口）；
 * 离线命令（size / repair / restore / archive / retention 读取）需要数据根独占锁，故在服务停止后执行。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CLI_VERSION, USAGE_TEXT, runCli } from '../packages/cli/src/index.ts';
import type { CliIo } from '../packages/cli/src/index.ts';
import { RtdbClient } from '../packages/demo/client-node/src/index.ts';
import { RtdbEngine } from '../packages/core/src/engine.ts';
import { dateNumberFromTimestamp, formatDateFolderName } from '../packages/core/src/format.ts';
import { loadServerConfig } from '../packages/server/src/config.ts';
import { Logger } from '../packages/server/src/logger.ts';
import { RtdbServer } from '../packages/server/src/server.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-cli-'));
/** 固定基日（10:00），避免跨日边界影响时间戳构造 */
const BASE = new Date(2026, 0, 10, 10, 0, 0).getTime();
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/* ---------- 夹具 ---------- */

interface CapturedIo {
  lines: string[];
  errors: string[];
  io: CliIo;
}

function createIo(): CapturedIo {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: {
      stdout: (line: string): void => {
        lines.push(line);
      },
      stderr: (line: string): void => {
        errors.push(line);
      },
    },
  };
}

function nextDataDir(): string {
  caseCounter += 1;
  return join(rootDirectory, `case-${caseCounter}`);
}

interface TestServer {
  server: RtdbServer;
  baseUrl: string;
  dataDir: string;
}

async function startTestServer(dataDir: string): Promise<TestServer> {
  const config = loadServerConfig({
    env: {},
    overrides: {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      admin: { enabled: false },
      log: { level: 'error' },
      auth: { enabled: false, tokenFile: join(dataDir, 'rtdb.token') },
    },
  });
  const server = new RtdbServer({ config, logger: new Logger('error') });
  const address = await server.start();
  return { server, baseUrl: `http://${address.host}:${address.port}`, dataDir };
}

/* ---------- 用法 / 帮助 / 版本 ---------- */

describe('cli: 用法 / 帮助 / 版本与退出码', () => {
  it('--version 输出契约版本并返回 0', async () => {
    const sink = createIo();
    const code = await runCli(['--version'], { io: sink.io, env: {} });
    assert.equal(code, 0);
    assert.deepEqual(sink.lines, [`rtdbctl ${CLI_VERSION}`]);
  });

  it('空命令 / help / --help 输出 USAGE 并返回 0', async () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      const sink = createIo();
      const code = await runCli(argv, { io: sink.io, env: {} });
      assert.equal(code, 0, `argv=${argv.join(' ')}`);
      const output = sink.lines.join('\n');
      assert.ok(output.includes('Usage: rtdbctl'), 'usage 文本应包含 Usage 行');
      assert.ok(output.includes('serve'), 'usage 文本应列出 serve 子命令');
    }
  });

  it('未知命令返回 2 并在 stderr 给出 unknown command', async () => {
    const sink = createIo();
    const code = await runCli(['explode'], { io: sink.io, env: {} });
    assert.equal(code, 2);
    assert.match(sink.errors.join('\n'), /unknown command: explode/);
  });

  it('缺少必需位置参数返回 2（用法错误）', async () => {
    const sink = createIo();
    const code = await runCli(['metrics'], { io: sink.io, env: {} });
    assert.equal(code, 2);
    assert.match(sink.errors.join('\n'), /missing required argument: <database>/);
  });

  it('非法的 --timeout 取值返回 2', async () => {
    const sink = createIo();
    const code = await runCli(['status', '--timeout', '0'], { io: sink.io, env: {} });
    assert.equal(code, 2);
    assert.match(sink.errors.join('\n'), /timeout must be a positive integer: 0/);
  });

  it('USAGE_TEXT 覆盖全部 11 个子命令与离线命令提示', () => {
    for (const command of [
      'serve',
      'status',
      'backup',
      'restore',
      'archive',
      'retention',
      'metrics',
      'size',
      'repair',
      'user',
      'token',
    ]) {
      assert.ok(USAGE_TEXT.includes(command), `USAGE 应包含子命令 ${command}`);
    }
    assert.ok(USAGE_TEXT.includes('must not run while a server holds the data root lock'));
  });
});

/* ---------- 端到端：SDK 写 → CLI 查 → backup → restore ---------- */

describe('cli: 端到端（SDK 写 → CLI 查 → backup → restore）', () => {
  it('远端命令 + 离线运维命令打通整条链路', async () => {
    const dataDir = nextDataDir();
    const backupRoot = join(rootDirectory, `backup-${caseCounter + 1}`);
    const env: NodeJS.ProcessEnv = { RTDB_DATA_DIR: dataDir };

    // 启动真实服务
    let running: TestServer = await startTestServer(dataDir);
    try {
      // 1) status（远端，认证豁免）→ JSON 报告
      const statusSink = createIo();
      assert.equal(
        await runCli(['status', '--url', running.baseUrl, '--json'], { io: statusSink.io, env }),
        0,
      );
      const status = JSON.parse(statusSink.lines.join('\n')) as { databases: number; write: { buffered: number } };
      assert.equal(typeof status.databases, 'number');
      assert.equal(typeof status.write.buffered, 'number');

      // 2) SDK 写入 demo（f64 / i64 混写）
      const liveClient = new RtdbClient({ baseUrl: running.baseUrl });
      const written = await liveClient.writeBatch('demo', [
        { metricName: 'flow', timestamp: BASE, value: 10 },
        { metricName: 'flow', timestamp: BASE + 1000, value: 20 },
        { metricName: 'counter', timestamp: BASE, value: 5n },
      ]);
      assert.equal(written.accepted, 3);

      // 3) metrics（远端）→ 表格含 flow / counter
      const metricsSink = createIo();
      assert.equal(await runCli(['metrics', 'demo', '--url', running.baseUrl], { io: metricsSink.io, env }), 0);
      const metricsOutput = metricsSink.lines.join('\n');
      assert.ok(metricsOutput.includes('flow'));
      assert.ok(metricsOutput.includes('counter'));

      // 4) metrics --prefix + --json（远端）→ 只保留 flow
      const prefixSink = createIo();
      assert.equal(
        await runCli(['metrics', 'demo', '--prefix', 'flo', '--url', running.baseUrl, '--json'], {
          io: prefixSink.io,
          env,
        }),
        0,
      );
      const prefixed = JSON.parse(prefixSink.lines.join('\n')) as { metrics: Array<{ metricName: string }> };
      assert.deepEqual(
        prefixed.metrics.map((metric) => metric.metricName),
        ['flow'],
      );

      // 5) size --by-day（离线，不取锁，可在服务运行时执行）
      const sizeSink = createIo();
      assert.equal(await runCli(['size', 'demo', '--by-day', '--json'], { io: sizeSink.io, env }), 0);
      const sizeReport = JSON.parse(sizeSink.lines.join('\n')) as {
        database: string;
        fileCount: number;
        totalBytes: number;
        retentionDays: number | null;
        days: Array<{ dayLabel: string; totalBytes: number }>;
      };
      assert.equal(sizeReport.database, 'demo');
      assert.ok(sizeReport.fileCount >= 1);
      assert.ok(sizeReport.totalBytes > 0);
      assert.equal(sizeReport.retentionDays, null);
      assert.ok(sizeReport.days.length >= 1);
      assert.match(sizeReport.days[0].dayLabel, /^\d{8}$/);

      // 6) retention 设置（远端 PUT）→ 0
      const setRetentionSink = createIo();
      assert.equal(
        await runCli(['retention', 'demo', '30', '--url', running.baseUrl, '--json'], {
          io: setRetentionSink.io,
          env,
        }),
        0,
      );

      // 7) retention 读取（离线）→ 反映刚写入的 30 天
      const readRetentionSink = createIo();
      assert.equal(await runCli(['retention', 'demo', '--json'], { io: readRetentionSink.io, env }), 0);
      const retention = JSON.parse(readRetentionSink.lines.join('\n')) as { retentionDays: number | null };
      assert.equal(retention.retentionDays, 30);

      // 8) backup（远端）→ 生成 {backupRoot}/demo
      const backupSink = createIo();
      assert.equal(
        await runCli(['backup', 'demo', backupRoot, '--url', running.baseUrl], { io: backupSink.io, env }),
        0,
      );
      assert.ok(existsSync(join(backupRoot, 'demo')), '备份目录 {backupRoot}/demo 应存在');
      assert.ok(backupSink.lines.join('\n').includes(`database: demo`));
    } finally {
      await running.server.stop();
    }

    // 9) repair（离线，需独占锁）→ 幂等恢复成功
    const repairSink = createIo();
    assert.equal(await runCli(['repair', 'demo', '--json'], { io: repairSink.io, env }), 0);
    const repair = JSON.parse(repairSink.lines.join('\n')) as { database: string; dateNumber: number | null };
    assert.equal(repair.database, 'demo');
    assert.equal(repair.dateNumber, null);

    // 10) restore（离线，需独占锁）→ 从备份整目录替换
    const restoreSink = createIo();
    assert.equal(await runCli(['restore', 'demo', backupRoot, '--json'], { io: restoreSink.io, env }), 0);
    const restored = JSON.parse(restoreSink.lines.join('\n')) as { database: string; fileCount: number };
    assert.equal(restored.database, 'demo');
    assert.ok(restored.fileCount >= 1);

    // 11) 重启服务并校验数据仍在（f64 与 i64 口径一致）
    running = await startTestServer(dataDir);
    try {
      const verifyClient = new RtdbClient({ baseUrl: running.baseUrl });
      const flow = await verifyClient.queryRange('demo', 'flow', { start: BASE, end: BASE + 1000 });
      assert.equal(flow.points.length, 2);
      assert.deepEqual(
        flow.points.map((point) => point.value),
        [10, 20],
      );
      const counter = await verifyClient.queryRange('demo', 'counter', { start: BASE, end: BASE });
      assert.equal(counter.points[0].value, 5n);
    } finally {
      await running.server.stop();
    }

    // 12) user / token 管理（远端 admin 路由）→ 用户与令牌全流程
    running = await startTestServer(dataDir);
    try {
      const adminUrl = running.baseUrl;

      // 缺少必需 --password → 用法错误退出码 2
      const missingPasswordSink = createIo();
      assert.equal(
        await runCli(['user', 'add', 'operator', '--url', adminUrl], { io: missingPasswordSink.io, env }),
        2,
      );
      assert.match(missingPasswordSink.errors.join('\n'), /missing required option: --password/);

      // user add → 201
      const addSink = createIo();
      assert.equal(
        await runCli(
          ['user', 'add', 'operator', '--password', 'password123', '--role', 'write', '--url', adminUrl, '--json'],
          { io: addSink.io, env },
        ),
        0,
      );
      const added = JSON.parse(addSink.lines.join('\n')) as { username: string; role: string; enabled: boolean };
      assert.equal(added.username, 'operator');
      assert.equal(added.role, 'write');
      assert.equal(added.enabled, true);

      // user list → 含 operator
      const listSink = createIo();
      assert.equal(await runCli(['user', 'list', '--url', adminUrl, '--json'], { io: listSink.io, env }), 0);
      const listed = JSON.parse(listSink.lines.join('\n')) as { users: Array<{ username: string }> };
      assert.deepEqual(
        listed.users.map((user) => user.username),
        ['operator'],
      );

      // user passwd → 改口令
      const passwdSink = createIo();
      assert.equal(
        await runCli(['user', 'passwd', 'operator', '--password', 'password456', '--url', adminUrl], {
          io: passwdSink.io,
          env,
        }),
        0,
      );
      assert.ok(passwdSink.lines.join('\n').includes('user: operator'));

      // token issue → 明文令牌 + tokenRecord
      const issueSink = createIo();
      assert.equal(
        await runCli(['token', 'issue', 'operator', '--label', 'ci', '--ttl', '60000', '--url', adminUrl, '--json'], {
          io: issueSink.io,
          env,
        }),
        0,
      );
      const issued = JSON.parse(issueSink.lines.join('\n')) as {
        token: string;
        tokenRecord: { tokenId: string; user: string; role: string; label: string; expiresAt: number | null };
      };
      assert.ok(issued.token.length >= 32);
      assert.equal(issued.tokenRecord.user, 'operator');
      assert.equal(issued.tokenRecord.role, 'write');
      assert.equal(issued.tokenRecord.label, 'ci');
      assert.equal(typeof issued.tokenRecord.expiresAt, 'number');

      // token list → state 反映有效期
      const tokenListSink = createIo();
      assert.equal(await runCli(['token', 'list', '--url', adminUrl], { io: tokenListSink.io, env }), 0);
      const tokenListOutput = tokenListSink.lines.join('\n');
      assert.ok(tokenListOutput.includes(issued.tokenRecord.tokenId));
      assert.ok(tokenListOutput.includes('active'));

      // token revoke → 0
      const revokeSink = createIo();
      assert.equal(
        await runCli(['token', 'revoke', issued.tokenRecord.tokenId, '--url', adminUrl], { io: revokeSink.io, env }),
        0,
      );
      assert.ok(revokeSink.lines.join('\n').includes('ok: true'));

      // user remove → 0
      const removeSink = createIo();
      assert.equal(await runCli(['user', 'remove', 'operator', '--url', adminUrl], { io: removeSink.io, env }), 0);
      assert.ok(removeSink.lines.join('\n').includes('ok: true'));
    } finally {
      await running.server.stop();
    }
  });
});

/* ---------- 离线运维：archive / restore --archive / repair 幂等 ---------- */

describe('cli: 离线运维（archive → restore --archive → repair 幂等）', () => {
  it('归档落盘 → 列表 → 整日还原 → 还原后数据可查 → repair 幂等', async () => {
    const dataDir = nextDataDir();
    const env: NodeJS.ProcessEnv = { RTDB_DATA_DIR: dataDir };
    const dateNumber = dateNumberFromTimestamp(BASE);
    const dayLabel = formatDateFolderName(dateNumber);
    const dayDirectory = join(dataDir, 'demo', dayLabel);
    const blockOptions = { blockTargetPoints: 4096, blockMinPoints: 64 };

    // 1) 先由引擎写入一个完整块（形成封口段与 .idx 镜像），关闭引擎释放数据根锁
    const writer = new RtdbEngine({ dataDir, ...blockOptions });
    await writer.open();
    try {
      const written = await writer.writeBatch(
        'demo',
        Array.from({ length: 4096 }, (_, index) => ({
          metricName: 'flow',
          timestamp: BASE + index * 1000,
          value: index,
        })),
      );
      assert.equal(written.accepted, 4096);
    } finally {
      await writer.close();
    }
    assert.equal(existsSync(dayDirectory), true, '引擎写入后应生成日目录');

    // 2) archive（离线，指定日期）→ 落盘 {dataDir}/archive/demo/yyyyMMdd.tar.gz
    const archiveSink = createIo();
    assert.equal(await runCli(['archive', 'demo', dayLabel, '--json'], { io: archiveSink.io, env }), 0);
    const archived = JSON.parse(archiveSink.lines.join('\n')) as {
      dateNumber: number;
      dayLabel: string;
      archiveFilePath: string;
      entryCount: number;
    };
    assert.equal(archived.dateNumber, dateNumber);
    assert.equal(archived.dayLabel, dayLabel);
    assert.ok(archived.entryCount >= 1);
    assert.equal(existsSync(archived.archiveFilePath), true);
    assert.equal(archived.archiveFilePath, join(dataDir, 'archive', 'demo', `${dayLabel}.tar.gz`));

    // 3) archive（离线，省略日期）→ 列出已落盘归档
    const listSink = createIo();
    assert.equal(await runCli(['archive', 'demo', '--json'], { io: listSink.io, env }), 0);
    const listed = JSON.parse(listSink.lines.join('\n')) as {
      archiveDirectory: string;
      archives: Array<{ dayLabel: string; totalBytes: number }>;
    };
    assert.equal(listed.archiveDirectory, join(dataDir, 'archive'));
    assert.deepEqual(
      listed.archives.map((item) => item.dayLabel),
      [dayLabel],
    );
    assert.ok(listed.archives[0].totalBytes > 0);

    // 4) 模拟保留策略过期删除：整日目录消失
    rmSync(dayDirectory, { recursive: true, force: true });

    // 5) restore --archive（离线）→ 整日还原
    const restoreSink = createIo();
    assert.equal(await runCli(['restore', 'demo', '--archive', dayLabel, '--json'], { io: restoreSink.io, env }), 0);
    const restoredDay = JSON.parse(restoreSink.lines.join('\n')) as {
      dayLabel: string;
      targetDayDirectory: string;
      fileCount: number;
    };
    assert.equal(restoredDay.dayLabel, dayLabel);
    assert.equal(restoredDay.targetDayDirectory, dayDirectory);
    assert.ok(restoredDay.fileCount >= 1);
    assert.equal(existsSync(dayDirectory), true);

    // 6) 还原后数据可查（4096 个点逐点对齐）
    const verify = new RtdbEngine({ dataDir, ...blockOptions });
    await verify.open();
    try {
      const series = await verify.queryRange('demo', 'flow', { start: BASE, end: BASE + 4095 * 1000 });
      assert.equal(series.points.length, 4096);
      assert.deepStrictEqual(series.points[0], { timestamp: BASE, value: 0 });
      assert.deepStrictEqual(series.points[4095], { timestamp: BASE + 4095 * 1000, value: 4095 });
    } finally {
      await verify.close();
    }

    // 7) repair 幂等：删掉 .idx 镜像后首次重建、二次不再重建也不截断
    let removedIndexCount = 0;
    for (const name of readdirSync(dayDirectory)) {
      if (!name.endsWith('.idx')) continue;
      unlinkSync(join(dayDirectory, name));
      removedIndexCount += 1;
    }
    assert.ok(removedIndexCount >= 1, '应存在可删除的 .idx 镜像');

    const firstSink = createIo();
    assert.equal(await runCli(['repair', 'demo', '--json'], { io: firstSink.io, env }), 0);
    const firstRepair = JSON.parse(firstSink.lines.join('\n')) as { rebuiltIndexCount: number };
    assert.equal(firstRepair.rebuiltIndexCount, removedIndexCount, '首次 repair 应重建缺失的镜像');

    const secondSink = createIo();
    assert.equal(await runCli(['repair', 'demo', '--json'], { io: secondSink.io, env }), 0);
    const secondRepair = JSON.parse(secondSink.lines.join('\n')) as {
      rebuiltIndexCount: number;
      truncatedSegmentCount: number;
      truncatedBytes: number;
    };
    assert.equal(secondRepair.rebuiltIndexCount, 0, '二次 repair 不应重复重建镜像');
    assert.equal(secondRepair.truncatedSegmentCount, 0, '二次 repair 不应再截断段');
    assert.equal(secondRepair.truncatedBytes, 0);

    // 8) 归档不存在时 restore --archive 返回 1 并给出错误码
    const missingSink = createIo();
    assert.equal(await runCli(['restore', 'demo', '--archive', '20000101'], { io: missingSink.io, env }), 1);
    assert.match(missingSink.errors.join('\n'), /Day archive does not exist/);

    // 9) 非法日期形态返回 2（用法错误）
    const usageSink = createIo();
    assert.equal(await runCli(['archive', 'demo', '2026-01-10'], { io: usageSink.io, env }), 2);
    assert.match(usageSink.errors.join('\n'), /date must use the yyyyMMdd form: 2026-01-10/);
  });
});
