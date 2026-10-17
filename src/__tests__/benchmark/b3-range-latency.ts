// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 基准 B3：7 天 range 查询冷热延迟（对齐《详细设计》§7 / 《开发计划》§7）
 *
 * 场景：1 metric × 7 天 × 1s 采样，跨 7 个日目录；查询整个 7 天区间。
 * 判据：**冷查询 < 200ms**、**热查询 < 50ms**。
 *
 * 口径：
 *   - 「冷」= 重新 `open()` 后的**首次**区间查询（解码块缓存为空）；
 *   - 「热」= 同一区间**重复查询**的中位耗时（解码块缓存命中）；
 *   - 查询返回全部点（显式传 `limit = 点数 + 1`，避免默认 10 万上限截断）；
 *   - OS 页缓存不在此口径内（进程内无法清空），冷热差异定位在「解码块缓存」这一层。
 */

import {
  SampleCollector,
  humanBytes,
  humanMillis,
  measureDatabaseStorage,
  openBenchmarkEngine,
  removeBenchmarkDataDir,
  scaleValue,
  createBenchmarkDataDir,
} from './benchmark-utils.ts';
import type { BenchmarkMetricLine, BenchmarkResult, BenchmarkScale } from './benchmark-utils.ts';
import { buildTypedMetricDefinitions, createValueSource, timestampSequence } from './synthetic-data.ts';
import type { WritePoint } from '../../packages/core/src/index.ts';

/** 固定基日 00:00（本机时区，即第 1 天零点） */
const BASE_TIMESTAMP = new Date(2026, 2, 10, 0, 0, 0).getTime();
/** 天跨度（毫秒） */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 采样间隔 1s */
const SAMPLE_STEP_MS = 1000;
/** 冷查询上限（毫秒） */
const MAXIMUM_COLD_MS = 200;
/** 热查询上限（毫秒） */
const MAXIMUM_HOT_MS = 50;

/** 运行基准 B3 */
export async function runB3RangeLatency(scale: BenchmarkScale): Promise<BenchmarkResult> {
  const startedAt = performance.now();
  const dayCount = 7;
  const pointsPerDay = scaleValue(scale, 21_600, 86_400);
  const dataDir = createBenchmarkDataDir('b3');
  const database = 'b3';
  const metricName = 'bench.b3.f64.channel.000000';
  const metrics: BenchmarkMetricLine[] = [];
  const notes: string[] = [
    `B3 口径：1 metric × ${dayCount} 天 × ${pointsPerDay} 点/天（1s 采样；quick 档降为 6h/天）`,
    '冷 = 重新 open 后首查（解码块缓存空）；热 = 重复查询中位（解码块缓存命中）；OS 页缓存不在口径内',
  ];
  let passed = false;

  try {
    // 写入阶段：逐日一批，跨日自动轮转 7 个日目录
    const definitions = buildTypedMetricDefinitions('bench.b3.f64', 1, 'f64');
    definitions[0] = { metricName, valueType: 'f64', pattern: 'random-walk' };
    const source = createValueSource(definitions[0]);
    const engine = await openBenchmarkEngine({ dataDir });
    for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
      const timestamps = timestampSequence(BASE_TIMESTAMP + dayIndex * DAY_MS, SAMPLE_STEP_MS, pointsPerDay);
      const batch = new Array<WritePoint>(pointsPerDay);
      for (let index = 0; index < pointsPerDay; index += 1) {
        batch[index] = { metricName, timestamp: timestamps[index], value: source.next(index) };
      }
      await engine.writeBatch(database, batch);
    }
    await engine.close();

    const measurement = measureDatabaseStorage(dataDir, database);
    const totalPointCount = dayCount * pointsPerDay;
    const rangeStart = BASE_TIMESTAMP;
    const rangeEnd = BASE_TIMESTAMP + dayCount * DAY_MS - 1;
    const queryLimit = totalPointCount + 1;

    // 冷测量：新引擎（空解码块缓存）首查
    const coldEngine = await openBenchmarkEngine({ dataDir });
    const coldStartedAt = performance.now();
    const coldSeries = await coldEngine.queryRange(database, metricName, {
      start: rangeStart,
      end: rangeEnd,
      limit: queryLimit,
    });
    const coldLatency = performance.now() - coldStartedAt;

    // 热测量：同区间重复查询（解码块缓存命中）
    const hotLatencies = new SampleCollector();
    for (let repeat = 0; repeat < 5; repeat += 1) {
      const repeatStartedAt = performance.now();
      await coldEngine.queryRange(database, metricName, { start: rangeStart, end: rangeEnd, limit: queryLimit });
      hotLatencies.record(performance.now() - repeatStartedAt);
    }
    await coldEngine.close();

    const hotLatency = hotLatencies.median;
    passed = coldLatency < MAXIMUM_COLD_MS && hotLatency < MAXIMUM_HOT_MS;

    // 根因拆分：冷 − 热 的差额即「块解码（Gorilla/ts 位解码）」增量；段文件打开 + 索引读按文档预算约 20~60ms
    const decodeDeltaMs = coldLatency - hotLatency;
    notes.push(
      `冷 − 热 = ${humanMillis(decodeDeltaMs)}，即块解码增量 ≈ ${((decodeDeltaMs * 1000) / Math.max(totalPointCount, 1)).toFixed(3)} µs/点（设计《TS 弱点分析》W2 已预警 JS 位级解码吞吐弱）`,
      `段文件打开 + 索引读按架构评估《评估-按天分文件性能影响》§6 预算为 20~60ms（7 段/日），占比 <30% 的 200ms 预算；本基准超出部分来自解码而非文件层`,
    );

    metrics.push(
      { label: '日目录数 / 段数', value: `${dayCount} / ${measurement.segmentCount}` },
      { label: '总点数 / 返回点数', value: `${totalPointCount} / ${coldSeries.points.length}` },
      { label: '磁盘占用（段 / 总）', value: `${humanBytes(measurement.segmentBytes)} / ${humanBytes(measurement.totalBytes)}` },
      { label: '冷查询延迟', value: humanMillis(coldLatency) },
      { label: '热查询延迟（中位/5 次）', value: humanMillis(hotLatency) },
      { label: '热查询最大延迟', value: humanMillis(hotLatencies.max) },
    );
  } finally {
    removeBenchmarkDataDir(dataDir);
  }

  return {
    name: 'B3',
    title: '7 天 range 查询冷热延迟',
    passed,
    elapsedMs: performance.now() - startedAt,
    threshold: `冷 < ${MAXIMUM_COLD_MS} ms 且 热 < ${MAXIMUM_HOT_MS} ms`,
    metrics,
    notes,
  };
}
