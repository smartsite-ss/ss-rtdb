// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 基准 B2：写入吞吐与延迟分位（对齐《详细设计》§7 / 《开发计划》§7）
 *
 * 场景：1000 metric × 1s 持续写入 1h（3.6M 点，3600 批）。
 * 判据：**吞吐 ≥ 5 万点/秒** 且 **单批写入延迟 P99 < 500ms**。
 *
 * 口径：
 *   - 每 tick（1s）提交一批「全部 metric 各 1 点」，批内无重复 (metric, ts)；
 *   - 吞吐分母 = 写入循环的墙钟时长（不含引擎 `open()` 与最终 `close()`）；
 *   - 延迟样本 = 每次 `writeBatch` 的调用耗时（含整批校验、WAL 追加 + group fsync、成块编码与段追加）；
 *   - 使用**默认** `fsyncPolicy='wal'`（真实持久化口径，不做降级）。
 */

import {
  SampleCollector,
  humanBytes,
  humanMillis,
  openBenchmarkEngine,
  removeBenchmarkDataDir,
  scaleValue,
  createBenchmarkDataDir,
} from './benchmark-utils.ts';
import type { BenchmarkMetricLine, BenchmarkResult, BenchmarkScale } from './benchmark-utils.ts';
import { buildMixedMetricDefinitions, createValueSource } from './synthetic-data.ts';
import type { WritePoint } from '../../packages/core/src/index.ts';

/** 固定基日 00:00（本机时区） */
const BASE_TIMESTAMP = new Date(2026, 2, 10, 0, 0, 0).getTime();
/** 采样间隔 1s */
const TICK_STEP_MS = 1000;
/** 吞吐下限（点/秒） */
const MINIMUM_THROUGHPUT = 50_000;
/** P99 延迟上限（毫秒） */
const MAXIMUM_P99_MS = 500;

/** 运行基准 B2 */
export async function runB2Throughput(scale: BenchmarkScale): Promise<BenchmarkResult> {
  const startedAt = performance.now();
  const metricCount = scaleValue(scale, 500, 1_000);
  const tickCount = scaleValue(scale, 600, 3_600);
  const dataDir = createBenchmarkDataDir('b2');
  const database = 'b2';
  const metrics: BenchmarkMetricLine[] = [];
  const notes: string[] = [
    `B2 口径：${metricCount} metric × 1s × ${tickCount}s → 每 tick 一批（批内全部 metric 各 1 点）`,
    '吞吐分母 = 写入循环墙钟时长；延迟样本 = 单次 writeBatch 调用耗时；fsyncPolicy=wal（真实持久化）',
  ];
  let passed = false;
  let measurements: Record<string, number> = {};

  try {
    const definitions = buildMixedMetricDefinitions('bench.b2', metricCount, 20260310);
    const sources = definitions.map((definition) => createValueSource(definition));
    const engine = await openBenchmarkEngine({ dataDir });

    const latencies = new SampleCollector();
    let acceptedPointCount = 0;
    const writeStartedAt = performance.now();
    for (let tick = 0; tick < tickCount; tick += 1) {
      const timestamp = BASE_TIMESTAMP + tick * TICK_STEP_MS;
      const batch = new Array<WritePoint>(definitions.length);
      for (let index = 0; index < definitions.length; index += 1) {
        batch[index] = { metricName: definitions[index].metricName, timestamp, value: sources[index].next(tick) };
      }
      const callStartedAt = performance.now();
      const result = await engine.writeBatch(database, batch);
      latencies.record(performance.now() - callStartedAt);
      acceptedPointCount += result.accepted;
    }
    const writeElapsedMs = performance.now() - writeStartedAt;
    const throughput = writeElapsedMs > 0 ? acceptedPointCount / (writeElapsedMs / 1000) : 0;

    const stats = await engine.stats();
    await engine.close();

    const p99 = latencies.p99;
    passed = throughput >= MINIMUM_THROUGHPUT && p99 < MAXIMUM_P99_MS;
    measurements = {
      pointCount: acceptedPointCount,
      batchCount: latencies.count,
      writeElapsedMs,
      throughput,
      p50Ms: latencies.median,
      p99Ms: p99,
      maxMs: latencies.max,
    };

    metrics.push(
      { label: '总点数 / 批次数', value: `${acceptedPointCount} / ${latencies.count}` },
      { label: '写入墙钟时长', value: humanMillis(writeElapsedMs) },
      { label: '吞吐（点/秒）', value: throughput.toFixed(0) },
      { label: '延迟 P50', value: humanMillis(latencies.median) },
      { label: '延迟 P99', value: humanMillis(p99) },
      { label: '延迟 最大', value: humanMillis(latencies.max) },
      { label: '未成块缓冲点（stats）', value: `${stats.write.bufferedPoints}` },
      { label: 'WAL 未释放字节（stats）', value: humanBytes(stats.wal.pendingBytes) },
    );
  } finally {
    removeBenchmarkDataDir(dataDir);
  }

  return {
    name: 'B2',
    title: '写入吞吐与 P99 延迟（1000 metric × 1s × 1h）',
    passed,
    elapsedMs: performance.now() - startedAt,
    threshold: `吞吐 ≥ ${MINIMUM_THROUGHPUT} 点/秒 且 P99 < ${MAXIMUM_P99_MS} ms`,
    metrics,
    notes,
    measurements,
  };
}
