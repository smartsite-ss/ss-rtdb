// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 基准 B7：跨时间跨度查询性能矩阵（1 / 5 / 10 / 20 / 30（按月）/ 50 / 100 天）
 *
 * 场景：1 metric × 100 天连续数据（quick 档 1 分钟采样、full 档 1 秒采样），对每个跨度测量六类查询：
 *   range asc（limit 1000）/ range desc（limit 1000）/ count exact / aggregate avg（1h 窗口）/
 *   queryAt step（101 网格点）/ queryAt linear（101 网格点）。
 *
 * 口径：
 *   - 「冷」= 该跨度在本进程内的首次查询（解码块缓存尚未覆盖该段数据）；
 *   - 「热」= 同一查询重复 3 次的中位；
 *   - 堆增量 = 查询前后 `heapUsed` 的差值（有界物化重构后应与跨度内点数解耦，
 *     标定口径见《聚合功能详细设计》§4.3 与 `__tests__/memory-bounds.test.ts`）；
 *   - 跨度按 1 → 100 天升序测量，后测跨度可复用前序跨度的解码块缓存（OS 页缓存同样不在口径内）。
 *
 * 判据：所有查询延迟 < 阈值（quick 3 s / full 15 s）、单次查询堆增量 < 256 MB，
 *       且 `count exact` 结果等于该跨度的点总数（语义正确性冒烟）。
 */

import {
  SampleCollector,
  createBenchmarkDataDir,
  humanBytes,
  humanMillis,
  measureDatabaseStorage,
  openBenchmarkEngine,
  removeBenchmarkDataDir,
  scaleValue,
} from './benchmark-utils.ts';
import type { BenchmarkMetricLine, BenchmarkResult, BenchmarkScale } from './benchmark-utils.ts';
import type { WritePoint } from '../../packages/core/src/index.ts';

/** 固定基日 00:00（本机时区） */
const BASE_TIMESTAMP = new Date(2026, 2, 10, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
/** 数据集总跨度（天） */
const TOTAL_DAYS = 100;
/** 评估跨度（天）；30 天近似「按月」 */
const SPAN_DAYS = [1, 5, 10, 20, 30, 50, 100] as const;
/** range 查询返回条数上限 */
const RANGE_LIMIT = 1000;
/** aggregate 窗口（1 小时） */
const AGGREGATE_WINDOW_MS = 3_600_000;
/** queryAt 网格点数量（均匀覆盖跨度） */
const AT_SAMPLE_COUNT = 101;
/** 热查询重复次数 */
const WARM_REPEAT = 3;

interface SpanMeasurement {
  days: number;
  /** 每类查询的冷查询延迟与热中位延迟（毫秒） */
  rangeAsc: { cold: number; warm: number };
  rangeDesc: { cold: number; warm: number };
  countExact: { cold: number; warm: number };
  aggregateAvg: { cold: number; warm: number };
  atStep: { cold: number; warm: number };
  atLinear: { cold: number; warm: number };
  /** 单次查询观测到的最大堆增量（MB） */
  maxHeapDeltaMb: number;
}

/** 查询一次后的堆增量（MB；采样为查询前后 heapUsed 差值，无 GC 干预，仅作量级判断） */
async function heapDeltaMb(run: () => Promise<void>): Promise<number> {
  const before = process.memoryUsage().heapUsed;
  await run();
  const after = process.memoryUsage().heapUsed;
  return Math.max(0, (after - before) / 1048576);
}

/** 测量单类查询：首次为冷、其后 3 次取中位为热 */
async function measureQuery(run: () => Promise<void>): Promise<{ cold: number; warm: number; heapMb: number }> {
  const coldStartedAt = performance.now();
  const coldHeap = await heapDeltaMb(run);
  const cold = performance.now() - coldStartedAt;
  const warm = new SampleCollector();
  for (let repeat = 0; repeat < WARM_REPEAT; repeat += 1) {
    const startedAt = performance.now();
    await run();
    warm.record(performance.now() - startedAt);
  }
  return { cold, warm: warm.median, heapMb: coldHeap };
}

/** 运行基准 B7 */
export async function runB7SpanScaling(scale: BenchmarkScale): Promise<BenchmarkResult> {
  const startedAt = performance.now();
  // quick: 1 分钟采样（100 天 = 14.4 万点）；full: 1 秒采样（100 天 = 864 万点）
  const pointsPerDay = scaleValue(scale, 1440, 86_400);
  const stepMs = DAY_MS / pointsPerDay;
  const maximumLatencyMs = scale === 'full' ? 15_000 : 3_000;
  const maximumHeapDeltaMb = 256;
  const dataDir = createBenchmarkDataDir('b7');
  const database = 'b7';
  const metricName = 'bench.b7.f64.channel';
  const measurements: Record<string, number> = {};
  const metricLines: BenchmarkMetricLine[] = [];
  const notes: string[] = [
    `B7 口径：1 metric × ${TOTAL_DAYS} 天 × ${pointsPerDay} 点/天（quick=1min 采样 / full=1s 采样），跨度 ${SPAN_DAYS.join('/')} 天（30 天≈按月）`,
    '冷 = 该跨度首次查询；热 = 重复 3 次中位；跨度升序测量，后续跨度可复用前序跨度的解码块缓存',
    'range 取 limit 1000（分页口径）；count 为 exact；aggregate 为时间加权 avg、窗口 1h；queryAt 为 101 点均匀网格',
  ];
  let passed = false;
  let maxHeapDeltaMb = 0;
  let maxLatencyMs = 0;

  try {
    // 写入 100 天数据（逐日一批，天然跨 100 个日目录）
    const engine = await openBenchmarkEngine({ dataDir });
    const totalPoints = TOTAL_DAYS * pointsPerDay;
    for (let dayIndex = 0; dayIndex < TOTAL_DAYS; dayIndex += 1) {
      const batch = new Array<WritePoint>(pointsPerDay);
      for (let index = 0; index < pointsPerDay; index += 1) {
        const pointIndex = dayIndex * pointsPerDay + index;
        batch[index] = {
          metricName,
          timestamp: BASE_TIMESTAMP + dayIndex * DAY_MS + index * stepMs,
          // Deterministic sawtooth-ish signal (mean ≈ 50), no RNG so every run is comparable
          value: (pointIndex * 37) % 100,
        };
      }
      await engine.writeBatch(database, batch);
    }
    await engine.close();

    const storage = measureDatabaseStorage(dataDir, database);
    const reader = await openBenchmarkEngine({ dataDir });
    const spanMeasurements: SpanMeasurement[] = [];

    for (const days of SPAN_DAYS) {
      const rangeStart = BASE_TIMESTAMP;
      const rangeEnd = BASE_TIMESTAMP + days * DAY_MS - 1;
      const spanMs = days * DAY_MS;
      const gridTimestamps = Array.from({ length: AT_SAMPLE_COUNT }, (_, index) =>
        Math.round(rangeStart + ((spanMs - 1) * index) / (AT_SAMPLE_COUNT - 1)),
      );

      const rangeAsc = await measureQuery(async () => {
        const series = await reader.queryRange(database, metricName, {
          start: rangeStart,
          end: rangeEnd,
          limit: RANGE_LIMIT,
        });
        if (series.points.length !== RANGE_LIMIT) {
          throw new Error(`range asc returned ${series.points.length} points (expected ${RANGE_LIMIT})`);
        }
      });
      const rangeDesc = await measureQuery(async () => {
        const series = await reader.queryRange(database, metricName, {
          start: rangeStart,
          end: rangeEnd,
          limit: RANGE_LIMIT,
          order: 'desc',
        });
        if (series.points.length !== RANGE_LIMIT) {
          throw new Error(`range desc returned ${series.points.length} points (expected ${RANGE_LIMIT})`);
        }
        // The newest point of the span sits at the last sample of the last day
        const expectedNewest = rangeStart + (days * pointsPerDay - 1) * stepMs;
        if (series.points[0].timestamp !== expectedNewest) {
          throw new Error(`range desc newest ${series.points[0].timestamp} (expected ${expectedNewest})`);
        }
      });
      const countExact = await measureQuery(async () => {
        const count = await reader.queryCount(database, metricName, {
          start: rangeStart,
          end: rangeEnd,
          exact: true,
        });
        const expected = days * pointsPerDay;
        if (count !== expected) {
          throw new Error(`count exact returned ${count} (expected ${expected})`);
        }
      });
      const aggregateAvg = await measureQuery(async () => {
        const windows = await reader.queryAggregate(database, metricName, {
          start: rangeStart,
          end: rangeEnd,
          type: 'avg',
          windowMs: AGGREGATE_WINDOW_MS,
        });
        if (windows.length !== days * 24) {
          throw new Error(`aggregate returned ${windows.length} windows (expected ${days * 24})`);
        }
      });
      const atStep = await measureQuery(async () => {
        const points = await reader.queryAt(database, metricName, { timestamps: gridTimestamps });
        if (points.length !== AT_SAMPLE_COUNT) {
          throw new Error(`queryAt step returned ${points.length} points`);
        }
      });
      const atLinear = await measureQuery(async () => {
        const points = await reader.queryAt(database, metricName, {
          timestamps: gridTimestamps,
          mode: 'linear',
        });
        if (points.length !== AT_SAMPLE_COUNT) {
          throw new Error(`queryAt linear returned ${points.length} points`);
        }
      });

      const spanMaxHeap = Math.max(
        rangeAsc.heapMb,
        rangeDesc.heapMb,
        countExact.heapMb,
        aggregateAvg.heapMb,
        atStep.heapMb,
        atLinear.heapMb,
      );
      const spanMaxLatency = Math.max(
        rangeAsc.cold,
        rangeAsc.warm,
        rangeDesc.cold,
        rangeDesc.warm,
        countExact.cold,
        countExact.warm,
        aggregateAvg.cold,
        aggregateAvg.warm,
        atStep.cold,
        atStep.warm,
        atLinear.cold,
        atLinear.warm,
      );
      maxHeapDeltaMb = Math.max(maxHeapDeltaMb, spanMaxHeap);
      maxLatencyMs = Math.max(maxLatencyMs, spanMaxLatency);

      spanMeasurements.push({
        days,
        rangeAsc: { cold: rangeAsc.cold, warm: rangeAsc.warm },
        rangeDesc: { cold: rangeDesc.cold, warm: rangeDesc.warm },
        countExact: { cold: countExact.cold, warm: countExact.warm },
        aggregateAvg: { cold: aggregateAvg.cold, warm: aggregateAvg.warm },
        atStep: { cold: atStep.cold, warm: atStep.warm },
        atLinear: { cold: atLinear.cold, warm: atLinear.warm },
        maxHeapDeltaMb: spanMaxHeap,
      });

      const prefix = `${days}d`;
      measurements[`${prefix}.rangeAscWarm`] = rangeAsc.warm;
      measurements[`${prefix}.rangeDescWarm`] = rangeDesc.warm;
      measurements[`${prefix}.countExactWarm`] = countExact.warm;
      measurements[`${prefix}.aggregateAvgWarm`] = aggregateAvg.warm;
      measurements[`${prefix}.atStepWarm`] = atStep.warm;
      measurements[`${prefix}.atLinearWarm`] = atLinear.warm;
      measurements[`${prefix}.countExactCold`] = countExact.cold;

      // One compact table row per span: hot medians in ms, plus the worst heap growth of that span
      metricLines.push({
        label: `${days} 天（${days * pointsPerDay} 点）`,
        value:
          `range ${rangeAsc.warm.toFixed(1)}/${rangeDesc.warm.toFixed(1)} · ` +
          `count ${countExact.warm.toFixed(1)}（冷 ${countExact.cold.toFixed(1)}） · ` +
          `avg ${aggregateAvg.warm.toFixed(1)} · ` +
          `at ${atStep.warm.toFixed(1)}/${atLinear.warm.toFixed(1)} ms · ` +
          `堆 +${spanMaxHeap.toFixed(1)} MB`,
      });
    }
    await reader.close();

    passed = maxLatencyMs < maximumLatencyMs && maxHeapDeltaMb < maximumHeapDeltaMb;

    // Scaling insight: count-exact is proportional to the points scanned, others are bounded by pages/grid
    const oneDay = spanMeasurements[0];
    const hundredDays = spanMeasurements[spanMeasurements.length - 1];
    notes.push(
      `模型：count exact 时间 ∝ 跨度内点数（1→100 天放大 ${(hundredDays.countExact.warm / Math.max(oneDay.countExact.warm, 0.001)).toFixed(1)}×，点数为 100×）`,
      `模型：range 受 limit 约束（仅解码命中块），avg 受窗口数约束（100 天 = 2400 窗），queryAt 受网格点数约束——三者不随跨度线性放大`,
      `数据量：${totalPoints} 点 / ${humanBytes(storage.totalBytes)}（${storage.segmentCount} 段）`,
      `判定上限：单查询 < ${humanMillis(maximumLatencyMs)}、堆增量 < ${maximumHeapDeltaMb} MB`,
    );
    measurements.maxLatencyMs = maxLatencyMs;
    measurements.maxHeapDeltaMb = maxHeapDeltaMb;
    measurements.totalPoints = totalPoints;

    metricLines.push(
      { label: '数据规模（100 天）', value: `${totalPoints} 点 / ${humanBytes(storage.totalBytes)} / ${storage.segmentCount} 段` },
      { label: '最大单查询延迟', value: humanMillis(maxLatencyMs) },
      { label: '最大堆增量', value: `${maxHeapDeltaMb.toFixed(1)} MB` },
    );
  } finally {
    removeBenchmarkDataDir(dataDir);
  }

  return {
    name: 'B7',
    title: '跨时间跨度查询性能（1/5/10/20/30/50/100 天）',
    passed,
    elapsedMs: performance.now() - startedAt,
    threshold: `所有查询 < ${maximumLatencyMs} ms 且堆增量 < ${maximumHeapDeltaMb} MB（quick=1min 采样 / full=1s 采样）`,
    metrics: metricLines,
    notes,
    measurements,
  };
}
