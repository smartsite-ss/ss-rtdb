// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 基准「断电注入」（S10 基准与验收）
 *
 * 场景：写子进程持续按批写入（每批 200 点，1ms 步长），父进程在**随机延迟**后 `kill -9`（模拟断电），
 *       随后用新引擎重启该数据根，校验「已被确认接受（ack 台账记录）的点 100% 可查」。
 *
 * 判据（《详细设计》§7 / 《开发计划》§7）：
 *   1. **100% 启动成功**：每轮重启均能 `open()` 成功（SIGKILL 遗留的陈旧锁可被回收、WAL 可重放）；
 *   2. **acked 点 100% 可查**：ack 台账点集与重启后 `queryRange` 实际点集完全一致 —— 无缺失、无值不一致。
 *
 * 口径说明（重要）：
 *   - ack 文件由子进程在每次 `writeBatch` 返回（= WAL 一致性点之后）后**立即** `writeSync` 落盘，
 *     数据存活于 OS 页缓存，`SIGKILL` 不会丢失，故它是「一致性边界之后」的精确点台账；
 *   - 唯一可能丢失的是**正在写入的尾行**，父进程按最后一个 `\n` 截断，天然忽略可能撕裂的半行；
 *   - ack 目录独立于数据根（置于另一临时目录），避免被数据根启动 recovery 扫描到；
 *   - 随机延迟取种子化随机源（可复现）：quick 档 0~800ms / full 档 0~5000ms，
 *     覆盖「首个块尚未成块」「WAL 已刷但块未成块」「块已落盘」等多种崩溃点。
 *
 * 说明：全部点位 f64，值可直接经 JSON 往返（避免 BigInt 序列化问题），故用严格相等比对即可。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RtdbEngine } from '../../packages/core/src/index.ts';
import {
  createBenchmarkDataDir,
  humanMillis,
  removeBenchmarkDataDir,
  scaleValue,
} from './benchmark-utils.ts';
import type { BenchmarkResult, BenchmarkScale } from './benchmark-utils.ts';
import { createRandomSource } from './synthetic-data.ts';

/* ---------- 常量 ---------- */

/** 断电注入使用的库名 */
const DATABASE_NAME = 'powerloss';
/** 断电注入使用的 metric 名 */
const METRIC_NAME = 'bench.powerloss.f64.channel.000000';
/** 写子进程文件名（与 `power-loss.ts` 同目录） */
const WORKER_FILE_NAME = 'power-loss-worker.ts';
/** 等待子进程打印 `READY` 的超时（毫秒） */
const READY_TIMEOUT_MS = 30_000;
/** 等待子进程彻底退出的超时（毫秒；确保数据根锁与文件句柄已释放） */
const EXIT_WAIT_TIMEOUT_MS = 10_000;
/** 随机延迟使用的固定种子（保证跨次运行可复现） */
const RANDOM_SEED = 0x5eed1234;
/** 备注最多保留的失败样本条数（避免 full 档刷屏） */
const MAX_NOTE_COUNT = 5;
/** 子进程 stderr 摘要保留的最大字节数（用于失败定位，避免无界增长） */
const MAX_WORKER_STDERR_LENGTH = 2048;
/** 失败备注中回显的 stderr 摘要最大字符数 */
const MAX_STDERR_IN_NOTE = 400;

/* ---------- 内部类型 ---------- */

/** ack 文件单行（每批一行；仅声明本文件用到的字段） */
interface AckLine {
  timestampStart: number;
  stepMs: number;
  values: number[];
}

/* ---------- 工具 ---------- */

/** 睡眠（毫秒；保持事件循环存活以便父进程在延迟后 kill 子进程） */
function sleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * 等待子进程打印 `READY\n`（含超时与「READY 之前早退」两条拒绝路径）
 *
 * 监听器在结算时统一摘除，避免泄漏；`exit` 监听用 `once`，且与父进程另注册的退出等待互不影响。
 */
function awaitWorkerReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onData = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf8');
      if (stdoutBuffer.includes('READY\n')) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`子进程在 READY 之前退出：code=${String(code)} signal=${String(signal)}`));
    };
    const onError = (error: Error): void => {
      finish(error);
    };
    const timer = setTimeout(() => finish(new Error(`等待子进程 READY 超时（${timeoutMs}ms）`)), timeoutMs);
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/**
 * 读取 ack 台账并重建「已确认接受的 (timestamp → value)」点集合
 *
 * 截断口径：取最后一个 `\n` 之前的内容为完整行（最后一行可能是 `SIGKILL` 打断的半行，丢弃）；
 * 单行 JSON 解析失败同样丢弃（不因一行异常影响整轮判定）。
 */
function readAckedPoints(ackFilePath: string): Map<number, number> {
  const points = new Map<number, number>();
  if (!existsSync(ackFilePath)) return points;
  const content = readFileSync(ackFilePath, 'utf8');
  const lastNewlineIndex = content.lastIndexOf('\n');
  if (lastNewlineIndex < 0) return points;
  for (const line of content.slice(0, lastNewlineIndex).split('\n')) {
    if (line.length === 0) continue;
    let parsed: AckLine;
    try {
      parsed = JSON.parse(line) as AckLine;
    } catch {
      continue;
    }
    const values = parsed.values;
    if (!Array.isArray(values)) continue;
    for (let offset = 0; offset < values.length; offset += 1) {
      points.set(parsed.timestampStart + offset * parsed.stepMs, values[offset]);
    }
  }
  return points;
}

/* ---------- 基准 ---------- */

/**
 * 组装失败备注：`第 N 轮<kind>：<错误信息>`，并在有子进程 stderr 摘要时附带其后（空白折叠、截断）
 *
 * 说明：子进程 stderr 是「READY 之前早退」唯一可用的根因线索（如 ENOSPC / EMFILE / 引擎 `open()` 异常），
 *       故失败备注必须回显其摘要，避免只留下「code=1」这类无从定位的信息。
 */
function formatFailureNote(iteration: number, kind: string, error: unknown, workerStderr: string): string {
  const base = `第 ${iteration} 轮${kind}：${(error as Error).message}`;
  const stderrSummary = workerStderr.trim().replace(/\s+/g, ' ').slice(0, MAX_STDERR_IN_NOTE);
  return stderrSummary.length > 0 ? `${base}；子进程 stderr: ${stderrSummary}` : base;
}

export async function runPowerLossInjection(scale: BenchmarkScale): Promise<BenchmarkResult> {
  const startedAt = Date.now();
  const iterations = scaleValue(scale, 20, 1000);
  const maxDelayMs = scaleValue(scale, 800, 5000);
  const randomSource = createRandomSource(RANDOM_SEED);
  const workerPath = join(import.meta.dirname, WORKER_FILE_NAME);

  let startupFailureCount = 0;
  let missingPointCount = 0;
  let mismatchedValueCount = 0;
  let ackedPointCount = 0;
  let totalDelayMs = 0;
  const notes: string[] = [];
  const recordNote = (message: string): void => {
    if (notes.length < MAX_NOTE_COUNT) notes.push(message);
    else if (notes.length === MAX_NOTE_COUNT) notes.push('（更多失败样本已省略）');
  };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const dataDir = createBenchmarkDataDir('powerloss');
    const ackDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-bench-ack-'));
    const ackFilePath = join(ackDirectory, `ack-${iteration}.jsonl`);
    let child: ChildProcess | null = null;
    // 子进程 stderr 摘要（用于失败定位；必须持续排空，避免管道缓冲区写满阻塞子进程）
    let workerStderr = '';
    try {
      // 1. 启动写子进程（stdout 用于 READY 握手，stderr 仅保留前若干字节用于失败诊断）
      child = spawn(process.execPath, [workerPath, dataDir, DATABASE_NAME, ackFilePath, METRIC_NAME], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (workerStderr.length < MAX_WORKER_STDERR_LENGTH) workerStderr += chunk.toString('utf8');
      });
      const exited = new Promise<void>((resolve) => {
        child?.once('exit', () => resolve());
      });
      await awaitWorkerReady(child, READY_TIMEOUT_MS);

      // 2. 随机延迟后 kill -9（模拟断电）；等待彻底退出以确保锁与文件句柄释放
      const delayMs = Math.floor(randomSource.nextFloat() * (maxDelayMs + 1));
      totalDelayMs += delayMs;
      await sleep(delayMs);
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(EXIT_WAIT_TIMEOUT_MS)]);

      // 3. 读 ack 台账（一致性边界之后已确认接受的点集）
      const expectedPoints = readAckedPoints(ackFilePath);
      ackedPointCount += expectedPoints.size;

      // 4. 重启引擎校验：启动成功 + acked 点全部可查
      const engine = new RtdbEngine({ dataDir });
      try {
        await engine.open();
      } catch (error) {
        startupFailureCount += 1;
        recordNote(`第 ${iteration} 轮重启失败：${(error as Error).message}`);
        continue;
      }
      try {
        const series = await engine.queryRange(DATABASE_NAME, METRIC_NAME, {
          start: 0,
          end: Date.now() + 3_600_000,
          limit: Number.MAX_SAFE_INTEGER,
        });
        const actualPoints = new Map<number, number>();
        for (const point of series.points) {
          if (typeof point.value === 'number') actualPoints.set(point.timestamp, point.value);
        }
        for (const [timestamp, expectedValue] of expectedPoints) {
          const actualValue = actualPoints.get(timestamp);
          if (actualValue === undefined) missingPointCount += 1;
          else if (!Object.is(actualValue, expectedValue)) mismatchedValueCount += 1;
        }
      } finally {
        await engine.close();
      }
    } catch (error) {
      startupFailureCount += 1;
      recordNote(formatFailureNote(iteration, '异常', error, workerStderr));
      if (child !== null) child.kill('SIGKILL');
    } finally {
      removeBenchmarkDataDir(dataDir);
      removeBenchmarkDataDir(ackDirectory);
    }
  }

  const passed = startupFailureCount === 0 && missingPointCount === 0 && mismatchedValueCount === 0;
  return {
    name: 'POWER-LOSS',
    title: '断电注入（SIGKILL × N + 重启可查性校验）',
    passed,
    elapsedMs: Date.now() - startedAt,
    threshold: '启动成功 100% 且 acked 点 100% 可查（缺失 = 0、值不一致 = 0）',
    metrics: [
      { label: '迭代轮数', value: `${iterations}` },
      { label: '随机延迟上限', value: `${maxDelayMs} ms` },
      { label: '平均延迟', value: humanMillis(totalDelayMs / Math.max(iterations, 1)) },
      { label: '启动失败轮数', value: `${startupFailureCount}` },
      { label: 'ack 确认点数', value: `${ackedPointCount}` },
      { label: '缺失点数', value: `${missingPointCount}` },
      { label: '值不一致点数', value: `${mismatchedValueCount}` },
    ],
    notes: [
      `每轮独立数据根 + 独立 ack 目录（ack 由子进程 writeSync 落盘，SIGKILL 不丢；尾行按最后一个换行截断）`,
      `随机延迟取种子化随机源（seed=${RANDOM_SEED}），覆盖「块未成块/WAL 已刷/块已落盘」多种崩溃点`,
      ...notes,
    ],
  };
}
