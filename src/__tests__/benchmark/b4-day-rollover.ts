// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 基准 B4：跨天切换停顿（对齐《详细设计》§7 / 《开发计划》§7）
 *
 * 目标：验证**跨天切换不产生阻塞写**（设计出口：「无阻塞写」）。
 * 判据：**跨天期间单批写入延迟的峰值 < 50ms**（不构成可感知的写入停顿）。
 *
 * 场景构造（可控地精确命中跨天点）：
 *   1. 第 1 天写入 4096 点（`blockTargetPoints` 钳位下限 4096）→ 立即成块并创建第 1 天活跃段；
 *   2. 第 2 天按 128 点/批连续提交 4096 点（32 批）：第 1 批触发 WAL 日文件切换 + 次日目录预建，
 *      第 32 批（缓冲达到 4096）成块并以第 2 天 `timestampMin` 触发**段级跨天轮转**（封第 1 天段 + 建第 2 天段）。
 *
 * 口径：
 *   - 使用默认 `fsyncPolicy='wal'`（真实持久化）；延迟样本 = 单次 `writeBatch` 的调用耗时；
 *   - 跨天开销由「峰值 vs 中位」之差体现，绝对值阈值用于判定是否构成阻塞；
 *   - 完整性校验：切换后日目录数 = 2、段数 = 2（第 1 天段已封口 + 第 2 天段已创建）。
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  SampleCollector,
  humanMillis,
  measureDatabaseStorage,
  openBenchmarkEngine,
  removeBenchmarkDataDir,
  createBenchmarkDataDir,
} from './benchmark-utils.ts';
import type { BenchmarkMetricLine, BenchmarkResult, BenchmarkScale } from './benchmark-utils.ts';
import { createValueSource } from './synthetic-data.ts';
import type { MetricDefinition } from './synthetic-data.ts';
import type { WritePoint } from '../../packages/core/src/index.ts';

/** 第 1 天零点（本机时区） */
const DAY_ONE_MIDNIGHT = new Date(2026, 2, 10, 0, 0, 0).getTime();
/** 天跨度（毫秒） */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 采样间隔 1s */
const SAMPLE_STEP_MS = 1000;
/** 成块目标点数（钳位下限 4096，使跨天点可控） */
const BLOCK_TARGET_POINTS = 4_096;
/** 第 2 天提交批大小（4 点×32 批 = 4096 点） */
const DAY_TWO_BATCH_POINTS = 128;
/** 跨天峰值延迟上限（毫秒） */
const MAXIMUM_ROLLOVER_MS = 50;

/** 统计库目录下的日目录（`yyyyMMdd`）数量 */
function countDayDirectories(dataDir: string, database: string): number {
  let count = 0;
  for (const entry of readdirSync(join(dataDir, database), { withFileTypes: true })) {
    if (entry.isDirectory() && /^\d{8}$/.test(entry.name)) count += 1;
  }
  return count;
}

/** 运行基准 B4（无规模档位差异，档位参数仅用于统一入口签名） */
export async function runB4DayRollover(_scale: BenchmarkScale): Promise<BenchmarkResult> {
  const startedAt = performance.now();
  const dataDir = createBenchmarkDataDir('b4');
  const database = 'b4';
  const metricName = 'bench.b4.i64.channel.000000';
  const metrics: BenchmarkMetricLine[] = [];
  const notes: string[] = [
    'B4 口径：场景为「跨天切换」，非吞吐/压缩指标；延迟样本 = 单次 writeBatch 调用耗时',
    '跨天点：第 2 天第 32 批（缓冲达 4096）成块并以第 2 天 timestampMin 触发段级轮转；第 1 批触发 WAL 日文件切换',
    'fsyncPolicy=wal（真实持久化）；阈值取 50ms 用于判定「是否构成阻塞停顿」',
  ];
  let passed = false;

  try {
    const definition: MetricDefinition = { metricName, valueType: 'i64', pattern: 'linear' };
    const source = createValueSource(definition);
    const engine = await openBenchmarkEngine({
      dataDir,
      blockTargetPoints: BLOCK_TARGET_POINTS,
      blockMinPoints: 64,
    });

    // 第 1 天：一批 4096 点 → 成块 + 创建第 1 天活跃段
    const dayOneTimestamps: number[] = [];
    for (let index = 0; index < BLOCK_TARGET_POINTS; index += 1) {
      dayOneTimestamps.push(DAY_ONE_MIDNIGHT + 10 * 60 * 60 * 1000 + index * SAMPLE_STEP_MS);
    }
    const dayOneBatch: WritePoint[] = dayOneTimestamps.map((timestamp, index) => ({
      metricName,
      timestamp,
      value: source.next(index),
    }));
    const dayOneStartedAt = performance.now();
    await engine.writeBatch(database, dayOneBatch);
    const dayOneLatency = performance.now() - dayOneStartedAt;

    // 第 2 天：128 点/批 × 32 批；第 32 批触发段级跨天轮转
    const latencies = new SampleCollector();
    const perBatchLatencies: number[] = [];
    const dayTwoMidnight = DAY_ONE_MIDNIGHT + DAY_MS;
    const batchCount = BLOCK_TARGET_POINTS / DAY_TWO_BATCH_POINTS;
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
      const batch = new Array<WritePoint>(DAY_TWO_BATCH_POINTS);
      for (let offset = 0; offset < DAY_TWO_BATCH_POINTS; offset += 1) {
        const sequence = batchIndex * DAY_TWO_BATCH_POINTS + offset;
        batch[offset] = {
          metricName,
          timestamp: dayTwoMidnight + sequence * SAMPLE_STEP_MS,
          value: source.next(BLOCK_TARGET_POINTS + sequence),
        };
      }
      const batchStartedAt = performance.now();
      await engine.writeBatch(database, batch);
      const latency = performance.now() - batchStartedAt;
      latencies.record(latency);
      perBatchLatencies.push(latency);
    }

    await engine.close();
    const measurement = measureDatabaseStorage(dataDir, database);

    const peakLatency = latencies.max;
    const medianLatency = latencies.median;
    const rolloverLatency = perBatchLatencies[batchCount - 1];
    const walRotateLatency = perBatchLatencies[0];
    const rolloverOverhead = peakLatency - medianLatency;
    const dayDirectoryCount = countDayDirectories(dataDir, database);
    passed = peakLatency < MAXIMUM_ROLLOVER_MS && measurement.segmentCount === 2 && dayDirectoryCount === 2;

    metrics.push(
      { label: '第 1 天成块批次延迟', value: humanMillis(dayOneLatency) },
      { label: '第 2 天批次延迟 中位', value: humanMillis(medianLatency) },
      { label: 'WAL 日切换批次延迟（第 1 批）', value: humanMillis(walRotateLatency) },
      { label: '段级跨天轮转延迟（第 32 批）', value: humanMillis(rolloverLatency) },
      { label: '峰值延迟（全批）', value: humanMillis(peakLatency) },
      { label: '跨天开销（峰值 − 中位）', value: humanMillis(rolloverOverhead) },
      { label: '日目录数 / 段数', value: `${dayDirectoryCount} / ${measurement.segmentCount}` },
    );
  } finally {
    removeBenchmarkDataDir(dataDir);
  }

  return {
    name: 'B4',
    title: '跨天切换停顿（段级轮转 + WAL 日切换）',
    passed,
    elapsedMs: performance.now() - startedAt,
    threshold: `跨天峰值延迟 < ${MAXIMUM_ROLLOVER_MS} ms 且 段数 = 2`,
    metrics,
    notes,
  };
}
