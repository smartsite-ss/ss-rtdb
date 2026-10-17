// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 基准 B6：满负载容量核算（10k metric × 1s × 24h）（对齐《详细设计》§7 / 《开发计划》§7）
 *
 * 判据：**日增量 1.3~1.7 GB/天**、**容量段数 7~9 段/天（200MB 段）**、**固定开销 < 2%**。
 *
 * 采样与外推口径（真实写满 864M 点不可行）：
 *   - 按目标负载的**每点字节**取样外推：写入 `metricCount × pointsPerMetric` 点（每 metric 恰好一个满块
 *     16384 点），测得每点字节后按 `10 000 metric × 86 400 点/天` 外推日增量；
 *   - 日段数 = `ceil(日增量 / segmentMaxBytes=200MB)`；
 *   - 固定开销 = `(实测总占用 − 载荷字节) / 实测总占用`，其中载荷字节由 `.idx` 条目的块总长减去块头得到，
 *     结构性字节 = 段头/段尾（32+16）/段 + 块头（41+metric）/块 + 索引区（35~38+metric，`.seg` 内与 `.idx` 镜像各一份）+ WAL。
 */

import {
  humanBytes,
  humanPercent,
  measureDatabaseStorage,
  openBenchmarkEngine,
  removeBenchmarkDataDir,
  scaleValue,
  createBenchmarkDataDir,
} from './benchmark-utils.ts';
import type { BenchmarkMetricLine, BenchmarkResult, BenchmarkScale } from './benchmark-utils.ts';
import { buildMixedMetricDefinitions, createValueSource } from './synthetic-data.ts';
import type { WritePoint } from '../../packages/core/src/index.ts';

/** 目标负载：10 000 metric */
const TARGET_METRIC_COUNT = 10_000;
/** 目标负载：1s 采样 */
const SAMPLE_STEP_MS = 1000;
/** 目标负载：一天 86 400 点/metric */
const POINTS_PER_METRIC_PER_DAY = 86_400;
/** 每 metric 取样点数（恰好一个满块，`blockTargetPoints` 默认 16384） */
const POINTS_PER_METRIC_SAMPLE = 16_384;
/** 容量段软上限（默认 200MB） */
const SEGMENT_MAX_BYTES = 209_715_200;
/** 固定开销上限 */
const MAXIMUM_OVERHEAD_RATIO = 0.02;
/**
 * GB 口径（字节）：**10⁹**，非 2³⁰
 *
 * 依据：架构评估《评估-按天分文件性能影响》§5 的「1.3~1.7 GB/天」按 GB = 10⁹ B 计
 * （同文档对照行「864M 点 × 16 B = 13.8 GB」即可反证），故此处不得用 2³⁰ 字节的 GiB。
 */
const GIGABYTE_BYTES = 1_000_000_000;
/** 日增量下界 / 上界（字节） */
const MINIMUM_BYTES_PER_DAY = 1.3 * GIGABYTE_BYTES;
const MAXIMUM_BYTES_PER_DAY = 1.7 * GIGABYTE_BYTES;
/** 固定基日 00:00（本机时区） */
const BASE_TIMESTAMP = new Date(2026, 2, 10, 0, 0, 0).getTime();

/** 运行基准 B6 */
export async function runB6FullLoad(scale: BenchmarkScale): Promise<BenchmarkResult> {
  const startedAt = performance.now();
  const metricCount = scaleValue(scale, 100, 200);
  const dataDir = createBenchmarkDataDir('b6');
  const database = 'b6';
  const metrics: BenchmarkMetricLine[] = [];
  const notes: string[] = [
    `B6 口径：目标负载 ${TARGET_METRIC_COUNT} metric × 1s × ${POINTS_PER_METRIC_PER_DAY} 点/天（864M 点）`,
    `实测不可行，改按「每点字节」取样外推：写 ${metricCount} metric × ${POINTS_PER_METRIC_SAMPLE} 点（每 metric 恰一个满块）`,
    '固定开销 = (实测总占用 − 载荷字节)/实测总占用；载荷字节 = Σ(块总长 − 块头)，结构性字节含段头尾/块头/索引(双份)/WAL',
  ];
  let passed = false;

  try {
    const definitions = buildMixedMetricDefinitions('bench.b6', metricCount, 20260310);
    const sources = definitions.map((definition) => createValueSource(definition));
    const engine = await openBenchmarkEngine({ dataDir });

    for (let metricIndex = 0; metricIndex < definitions.length; metricIndex += 1) {
      const batch = new Array<WritePoint>(POINTS_PER_METRIC_SAMPLE);
      for (let pointIndex = 0; pointIndex < POINTS_PER_METRIC_SAMPLE; pointIndex += 1) {
        batch[pointIndex] = {
          metricName: definitions[metricIndex].metricName,
          timestamp: BASE_TIMESTAMP + pointIndex * SAMPLE_STEP_MS,
          value: sources[metricIndex].next(pointIndex),
        };
      }
      await engine.writeBatch(database, batch);
    }
    await engine.close();

    const measurement = measureDatabaseStorage(dataDir, database);
    const samplePointCount = definitions.length * POINTS_PER_METRIC_SAMPLE;
    const pointsPerDay = TARGET_METRIC_COUNT * POINTS_PER_METRIC_PER_DAY;
    const bytesPerDay = (measurement.totalBytes / samplePointCount) * pointsPerDay;
    const segmentsPerDay = Math.max(1, Math.ceil(bytesPerDay / SEGMENT_MAX_BYTES));
    const overheadBytes = measurement.totalBytes - measurement.payloadBytes;
    const overheadRatio = measurement.totalBytes > 0 ? overheadBytes / measurement.totalBytes : 0;
    const bytesPerPoint = measurement.totalBytes / samplePointCount;

    passed =
      bytesPerDay >= MINIMUM_BYTES_PER_DAY &&
      bytesPerDay <= MAXIMUM_BYTES_PER_DAY &&
      segmentsPerDay >= 7 &&
      segmentsPerDay <= 9 &&
      overheadRatio < MAXIMUM_OVERHEAD_RATIO;

    metrics.push(
      { label: '取样点数 / 块数 / 段数', value: `${samplePointCount} / ${measurement.blockCount} / ${measurement.segmentCount}` },
      { label: '每点字节（含开销）', value: `${bytesPerPoint.toFixed(3)} B` },
      { label: '外推日增量', value: `${(bytesPerDay / GIGABYTE_BYTES).toFixed(3)} GB/天（10⁹ 口径，即 ${humanBytes(bytesPerDay)}）` },
      { label: '外推日段数（200MB 段）', value: `${segmentsPerDay} 段/天` },
      { label: '实测总占用', value: humanBytes(measurement.totalBytes) },
      { label: '其中载荷字节', value: humanBytes(measurement.payloadBytes) },
      { label: '其中固定开销字节', value: humanBytes(overheadBytes) },
      { label: '固定开销占比', value: humanPercent(overheadRatio) },
      { label: 'WAL 残留字节', value: `${measurement.walBytes} B` },
    );
  } finally {
    removeBenchmarkDataDir(dataDir);
  }

  return {
    name: 'B6',
    title: '满负载容量核算（10k metric × 1s × 24h 外推）',
    passed,
    elapsedMs: performance.now() - startedAt,
    threshold: '日增量 1.3~1.7 GB/天 且 7~9 段/天 且 固定开销 < 2%',
    metrics,
    notes,
  };
}
