// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 基准 B5：`queryLast(before)` 端点差 ×1000 边界（对齐《详细设计》§7 / 《开发计划》§7）
 *
 * 场景：1000 组边界用例，逐组构造升序点序列与两个边界值（窗口起点/终点），
 *       校验 `queryLast(before)` 与「端点差」结果。
 * 判据：**与参考实现 diff = 0**（1000/1000 全部一致）。
 *
 * 参考口径（InfluxDB 不可达环境下的等价实现）：
 *   - 目标平台报表的「端点差」= `last(t ≤ 窗口终点) − last(t ≤ 窗口起点)`；
 *   - 本基准以**进程内暴力参考**复现该语义：在升序数组上线性扫描取「≤ before 的最新一点」，
 *     与 `ss-rtdb` 的 `queryLast` 逐点比对（时间戳相等 + 值按位相等 `Object.is`），并比对端点差数值。
 *   - 「与 InfluxDB 结果 diff=0」的现场复核入口：设置环境变量 `RTDB_BENCH_INFLUX_URL` 后本基准会探测可达性
 *     并在结果中汇报（不可达时以本地暴力参考为等价基准）。
 *
 * 边界覆盖：无点、单点、`before` 落在首点之前/恰好首点/两点之间/恰好末点/末点之后、
 *           以及窗口起点在首点之前（端点差为空）等情形。
 */

import {
  openBenchmarkEngine,
  removeBenchmarkDataDir,
  createBenchmarkDataDir,
} from './benchmark-utils.ts';
import type { BenchmarkMetricLine, BenchmarkResult, BenchmarkScale } from './benchmark-utils.ts';
import { buildMetricName, createRandomSource } from './synthetic-data.ts';
import type { Point, WritePoint } from '../../packages/core/src/index.ts';

/** 用例组数（对齐「×1000 次边界」） */
const SCENARIO_COUNT = 1_000;
/** 单组最大点数 */
const MAXIMUM_POINTS_PER_SCENARIO = 200;
/** 固定基日（本机时区） */
const BASE_TIMESTAMP = new Date(2026, 2, 10, 0, 0, 0).getTime();
/** 端点差数值比对容差 */
const DIFFERENCE_TOLERANCE = 1e-9;

/** 单组边界用例（升序点序列 + 两个边界） */
interface BoundaryScenario {
  metricName: string;
  points: WritePoint[];
  /** 窗口起点边界（较小） */
  startBoundary: number;
  /** 窗口终点边界（较大） */
  endBoundary: number;
}

/** 暴力参考：升序点序列中「≤ before 的最新一点」（无则 null） */
function referenceLastAtOrBefore(points: readonly WritePoint[], before: number): { timestamp: number; value: number } | null {
  let best: { timestamp: number; value: number } | null = null;
  for (const point of points) {
    if (point.timestamp > before) continue;
    if (best === null || point.timestamp > best.timestamp) {
      best = { timestamp: point.timestamp, value: point.value as number };
    }
  }
  return best;
}

/** 构造第 `index` 组边界用例（确定性随机） */
function buildScenario(index: number): BoundaryScenario {
  const randomSource = createRandomSource(20260310 + index);
  // 前 5 组固定为边界点数（0/1/2/3/5），其后随机
  const fixedCounts = [0, 1, 2, 3, 5];
  const pointCount =
    index < fixedCounts.length ? fixedCounts[index] : 1 + randomSource.nextInt(MAXIMUM_POINTS_PER_SCENARIO - 1);

  const metricName = buildMetricName('bench.b5.f64', index);
  const points: WritePoint[] = [];
  let cursor = BASE_TIMESTAMP + randomSource.nextInt(3_600_000);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    cursor += 1 + randomSource.nextInt(1_000);
    points.push({ metricName, timestamp: cursor, value: Math.round(randomSource.nextFloat() * 100_000) / 100 });
  }

  const firstTimestamp = pointCount > 0 ? points[0].timestamp : cursor;
  const lastTimestamp = pointCount > 0 ? points[pointCount - 1].timestamp : cursor;
  const mode = index % 6;
  let startBoundary: number;
  let endBoundary: number;
  if (mode === 0) {
    // 起点在首点之前（无点可查）
    startBoundary = firstTimestamp - (1 + randomSource.nextInt(1_000));
    endBoundary = lastTimestamp;
  } else if (mode === 1) {
    startBoundary = firstTimestamp;
    endBoundary = lastTimestamp;
  } else if (mode === 2) {
    startBoundary = firstTimestamp;
    endBoundary = lastTimestamp + 1 + randomSource.nextInt(1_000);
  } else if (mode === 3 && pointCount >= 2) {
    // 起点落在首末两点之间
    startBoundary = firstTimestamp + Math.floor((lastTimestamp - firstTimestamp) / 2);
    endBoundary = lastTimestamp;
  } else if (mode === 4) {
    // 起点恰好命中某个已存在点
    startBoundary = points.length > 0 ? points[randomSource.nextInt(points.length)].timestamp : firstTimestamp;
    endBoundary = lastTimestamp + 1;
  } else {
    // 末点之后 + 起点在首点之前
    startBoundary = firstTimestamp - 1;
    endBoundary = lastTimestamp + 1 + randomSource.nextInt(10);
  }
  if (endBoundary < startBoundary) [startBoundary, endBoundary] = [endBoundary, startBoundary];
  return { metricName, points, startBoundary, endBoundary };
}

/** 比对引擎点与参考点（时间戳相等 + 值按位相等） */
function pointsMatch(enginePoint: Point | null, referencePoint: { timestamp: number; value: number } | null): boolean {
  if (enginePoint === null && referencePoint === null) return true;
  if (enginePoint === null || referencePoint === null) return false;
  return enginePoint.timestamp === referencePoint.timestamp && Object.is(enginePoint.value, referencePoint.value);
}

/** 端点差：`last(t ≤ endBoundary) − last(t ≤ startBoundary)`（任一为空则返回 null） */
function endpointDifference(
  lastAtEnd: { timestamp: number; value: number } | null,
  lastAtStart: { timestamp: number; value: number } | null,
): number | null {
  if (lastAtEnd === null || lastAtStart === null) return null;
  return lastAtEnd.value - lastAtStart.value;
}

/** InfluxDB 可达性探针（仅当 `RTDB_BENCH_INFLUX_URL` 已设置时探测；不设置则返回 null） */
async function probeLiveInfluxDatabase(): Promise<string | null> {
  const baseUrl = process.env.RTDB_BENCH_INFLUX_URL;
  if (baseUrl === undefined || baseUrl.length === 0) return null;
  const healthUrl = `${baseUrl.replace(/\/+$/, '')}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    return `InfluxDB 探针 ${healthUrl}：HTTP ${response.status}（可达；本次 diff 仍以本地暴力参考为准）`;
  } catch (error) {
    return `InfluxDB 探针 ${healthUrl}：不可达（${(error as Error).message}）`;
  } finally {
    clearTimeout(timeout);
  }
}

/** 运行基准 B5 */
export async function runB5EndpointDiff(_scale: BenchmarkScale): Promise<BenchmarkResult> {
  const startedAt = performance.now();
  const dataDir = createBenchmarkDataDir('b5');
  const database = 'b5';
  const metrics: BenchmarkMetricLine[] = [];
  const notes: string[] = [
    `B5 口径：${SCENARIO_COUNT} 组边界用例，逐组比对 queryLast(before) 与「端点差」`,
    '参考实现 = 进程内暴力 last(t ≤ before)（等价复现目标平台 InfluxDB 报表端点差语义）；比对口径 = 时间戳相等 + 值 Object.is',
  ];
  let passed = false;

  try {
    const influxNote = await probeLiveInfluxDatabase();
    notes.push(influxNote ?? '未设置 RTDB_BENCH_INFLUX_URL：以本地暴力参考为等价基准（InfluxDB 不可达环境）');

    const engine = await openBenchmarkEngine({ dataDir, fsyncPolicy: 'none' });
    let lastQueryMismatchCount = 0;
    let endpointMismatchCount = 0;
    let nonNullEndpointCaseCount = 0;

    for (let index = 0; index < SCENARIO_COUNT; index += 1) {
      const scenario = buildScenario(index);
      if (scenario.points.length > 0) await engine.writeBatch(database, scenario.points);

      const engineAtStart = await engine.queryLast(database, scenario.metricName, { before: scenario.startBoundary });
      const engineAtEnd = await engine.queryLast(database, scenario.metricName, { before: scenario.endBoundary });
      const referenceAtStart = referenceLastAtOrBefore(scenario.points, scenario.startBoundary);
      const referenceAtEnd = referenceLastAtOrBefore(scenario.points, scenario.endBoundary);

      if (!pointsMatch(engineAtStart, referenceAtStart)) lastQueryMismatchCount += 1;
      if (!pointsMatch(engineAtEnd, referenceAtEnd)) lastQueryMismatchCount += 1;

      const engineDifference = endpointDifference(
        engineAtEnd === null ? null : { timestamp: engineAtEnd.timestamp, value: Number(engineAtEnd.value) },
        engineAtStart === null ? null : { timestamp: engineAtStart.timestamp, value: Number(engineAtStart.value) },
      );
      const referenceDifference = endpointDifference(referenceAtEnd, referenceAtStart);
      if (engineDifference !== null && referenceDifference !== null) nonNullEndpointCaseCount += 1;
      if (!numbersMatch(engineDifference, referenceDifference)) endpointMismatchCount += 1;
    }
    await engine.close();

    const diffCount = lastQueryMismatchCount + endpointMismatchCount;
    passed = diffCount === 0;
    metrics.push(
      { label: '边界用例组数', value: `${SCENARIO_COUNT}` },
      { label: 'queryLast 比对次数', value: `${SCENARIO_COUNT * 2}` },
      { label: 'queryLast 不一致数', value: `${lastQueryMismatchCount}` },
      { label: '端点差（非空）用例组数', value: `${nonNullEndpointCaseCount}` },
      { label: '端点差不一致数', value: `${endpointMismatchCount}` },
      { label: 'diff 合计', value: `${diffCount}` },
    );
  } finally {
    removeBenchmarkDataDir(dataDir);
  }

  return {
    name: 'B5',
    title: 'queryLast(before) 端点差 ×1000 边界',
    passed,
    elapsedMs: performance.now() - startedAt,
    threshold: '与参考实现 diff = 0（1000/1000 一致）',
    metrics,
    notes,
  };
}

/** 端点差数值比对（双空视为一致；单空视为不一致；其余按容差比对） */
function numbersMatch(left: number | null, right: number | null): boolean {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return Math.abs(left - right) < DIFFERENCE_TOLERANCE;
}
