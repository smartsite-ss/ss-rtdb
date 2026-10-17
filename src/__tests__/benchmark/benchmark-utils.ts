// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 基准测试公共工具（S10 基准与验收）
 *
 * 提供六类能力：
 *   1. 规模档位：`quick`（默认，有界可跑）/ `full`（完整口径），由环境变量 `RTDB_BENCH_SCALE` 选择；
 *   2. 夹具：临时数据根 + 引擎开启封装；
 *   3. 统计：延迟样本收集（中位 / P99 / 最大）与分位函数；
 *   4. 存储测量：把库目录拆为 `段(.seg) / 索引(.idx) / WAL(.wal)` 分项，并由 `.idx` 反推块数、
 *      块头字节与载荷字节（`payloadBytes = Σ块总长 − Σ块头`），供压缩比与固定开销口径使用；
 *   5. 外推：按「每点字节」外推日增量与容量段数；
 *   6. 渲染：字节量人性化格式 + 结果表打印。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import {
  BLOCK_HEADER_FIXED_SIZE,
  INDEX_EXTENSION,
  RtdbEngine,
  SEGMENT_EXTENSION,
  WAL_EXTENSION,
  parseIndexRegion,
  utf8ByteLength,
} from '../../packages/core/src/index.ts';
import type { EngineOptions } from '../../packages/core/src/index.ts';

/* ---------- 规模档位 ---------- */

export type BenchmarkScale = 'quick' | 'full';

/** 读取规模档位（默认 `quick`，即「有界可跑」的默认口径；`full` 用于完整口径复核） */
export function readBenchmarkScale(): BenchmarkScale {
  return process.env.RTDB_BENCH_SCALE === 'full' ? 'full' : 'quick';
}

/** 按档位取值（`quick` 取降规模值，`full` 取完整值） */
export function scaleValue(scale: BenchmarkScale, quickValue: number, fullValue: number): number {
  return scale === 'full' ? fullValue : quickValue;
}

/* ---------- 夹具 ---------- */

/** 创建基准专用临时数据根（引擎开启时会再兜底建目录） */
export function createBenchmarkDataDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `ss-rtdb-bench-${tag}-`));
}

/** 清理临时数据根（尽力删除，失败仅告警） */
export function removeBenchmarkDataDir(dataDir: string): void {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[benchmark] 清理临时数据根失败: ${dataDir} (${(error as Error).message})`);
  }
}

/** 开启基准引擎（保证数据根与引擎选项均可用） */
export async function openBenchmarkEngine(options: EngineOptions): Promise<RtdbEngine> {
  const engine = new RtdbEngine(options);
  await engine.open();
  return engine;
}

/* ---------- 统计 ---------- */

/** 升序样本的分位值（`quantile` ∈ [0,1]；0 样本返回 0；实现为「最近秩」法） */
export function percentile(sortedAscending: readonly number[], quantile: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(quantile * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index];
}

/** 延迟样本收集器（毫秒；提供中位 / P99 / 最大 / 均值） */
export class SampleCollector {
  private readonly samples: number[] = [];

  record(value: number): void {
    this.samples.push(value);
  }

  get count(): number {
    return this.samples.length;
  }

  get max(): number {
    if (this.samples.length === 0) return 0;
    return Math.max(...this.samples);
  }

  get average(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
  }

  quantile(quantile: number): number {
    return percentile([...this.samples].sort((left, right) => left - right), quantile);
  }

  get median(): number {
    return this.quantile(0.5);
  }

  get p99(): number {
    return this.quantile(0.99);
  }
}

/* ---------- 存储测量 ---------- */

/** 库目录存储测量结果（字节分项 + 块级统计） */
export interface DatabaseStorageMeasurement {
  /** 目录内文件总数（含 retention.json） */
  fileCount: number;
  /** 容量段文件数（`.seg`） */
  segmentCount: number;
  /** 块总数（由 `.idx` 条目数反推） */
  blockCount: number;
  /** `.seg` 字节合计 */
  segmentBytes: number;
  /** `.idx` 字节合计（= 段内索引区镜像） */
  indexBytes: number;
  /** `.wal` 字节合计 */
  walBytes: number;
  /** 三类文件字节合计 */
  totalBytes: number;
  /** 块总长合计（块头 + 块数据，由 `.idx` 的 `length` 求和） */
  blockTotalBytes: number;
  /** 块头字节合计（`41 + metric 名 UTF-8 字节长`） */
  blockHeaderBytes: number;
  /** 载荷字节合计（`blockTotalBytes − blockHeaderBytes`，即编码后数据字节） */
  payloadBytes: number;
}

/** 递归收集目录内全部文件路径（不存在目录时返回空） */
function collectFilePaths(directoryPath: string, output: string[]): void {
  if (!existsSync(directoryPath)) return;
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) collectFilePaths(entryPath, output);
    else output.push(entryPath);
  }
}

/**
 * 测量某库的磁盘占用（按文件扩展名分项），并由 `.idx` 反推块数 / 块头 / 载荷字节
 *
 * 口径说明：`.idx` 与段内索引区**完全同构**，故其字节同时出现在 `.seg`（索引区）与 `.idx`（镜像）
 * 两处，各计一次；`payloadBytes` 只统计块数据部分，不含块头。
 */
export function measureDatabaseStorage(dataDir: string, database: string): DatabaseStorageMeasurement {
  const measurement: DatabaseStorageMeasurement = {
    fileCount: 0,
    segmentCount: 0,
    blockCount: 0,
    segmentBytes: 0,
    indexBytes: 0,
    walBytes: 0,
    totalBytes: 0,
    blockTotalBytes: 0,
    blockHeaderBytes: 0,
    payloadBytes: 0,
  };
  const filePaths: string[] = [];
  collectFilePaths(join(dataDir, database), filePaths);
  measurement.fileCount = filePaths.length;

  for (const filePath of filePaths) {
    const extension = extname(filePath);
    const fileBytes = statSync(filePath).size;
    if (extension === SEGMENT_EXTENSION) {
      measurement.segmentCount += 1;
      measurement.segmentBytes += fileBytes;
    } else if (extension === INDEX_EXTENSION) {
      measurement.indexBytes += fileBytes;
      const buffer = new Uint8Array(readFileSync(filePath));
      for (const entry of parseIndexRegion(buffer, 0, buffer.length)) {
        measurement.blockCount += 1;
        measurement.blockTotalBytes += entry.length;
        measurement.blockHeaderBytes += BLOCK_HEADER_FIXED_SIZE + utf8ByteLength(entry.metricName);
      }
    } else if (extension === WAL_EXTENSION) {
      measurement.walBytes += fileBytes;
    }
  }
  measurement.totalBytes = measurement.segmentBytes + measurement.indexBytes + measurement.walBytes;
  measurement.payloadBytes = measurement.blockTotalBytes - measurement.blockHeaderBytes;
  return measurement;
}

/* ---------- 外推 ---------- */

/** 按「每点字节」外推日增量：`sampleBytes / samplePoints * pointsPerDay` */
export function extrapolateBytesPerDay(sampleBytes: number, samplePoints: number, pointsPerDay: number): number {
  if (samplePoints <= 0) return 0;
  return (sampleBytes / samplePoints) * pointsPerDay;
}

/** 由日增量与容量段软上限推算日段数（向上取整，至少 1 段） */
export function extrapolateSegmentsPerDay(bytesPerDay: number, segmentMaxBytes: number): number {
  if (bytesPerDay <= 0) return 0;
  return Math.max(1, Math.ceil(bytesPerDay / segmentMaxBytes));
}

/* ---------- 渲染 ---------- */

/** 字节量人性化格式 */
export function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

/** 毫秒延迟格式化（保留 3 位小数） */
export function humanMillis(milliseconds: number): string {
  return `${milliseconds.toFixed(3)} ms`;
}

/** 比率格式化（保留 2 位小数，附 `×`） */
export function humanRatio(ratio: number): string {
  return `${ratio.toFixed(2)}×`;
}

/** 百分比格式化 */
export function humanPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(3)}%`;
}

/** 结果表中的单行指标 */
export interface BenchmarkMetricLine {
  label: string;
  value: string;
}

/** 单个基准结果（供编排器汇总与判定） */
export interface BenchmarkResult {
  /** 编号（B1~B6 或 `POWER-LOSS`） */
  name: string;
  /** 标题 */
  title: string;
  /** 是否达标 */
  passed: boolean;
  /** 耗时（毫秒，含造数/写入/测量） */
  elapsedMs: number;
  /** 判定阈值文字 */
  threshold: string;
  /** 关键指标 */
  metrics: BenchmarkMetricLine[];
  /** 备注（口径说明、跳过原因等） */
  notes: string[];
  /** 机器可读的量化指标（供 S15 回归门槛脚本比对；`metrics` 是展示文本，不可反向解析） */
  measurements?: Record<string, number>;
}

/** 打印单个基准结果（明细 + 判定） */
export function printBenchmarkResult(result: BenchmarkResult, scale: BenchmarkScale): void {
  console.log(`\n=== ${result.name} ${result.title} [${scale}] ${result.passed ? 'PASS' : 'FAIL'} ===`);
  for (const metric of result.metrics) console.log(`  · ${metric.label.padEnd(28)} ${metric.value}`);
  console.log(`  · 阈值: ${result.threshold}`);
  for (const note of result.notes) console.log(`  · 备注: ${note}`);
  console.log(`  · 耗时: ${humanMillis(result.elapsedMs)}`);
}

/** 打印汇总表（对齐列宽的 PASS/FAIL 一览） */
export function printSummaryTable(results: readonly BenchmarkResult[]): void {
  console.log('\n================ S10 基准与验收汇总 ================');
  console.log(`${'编号'.padEnd(12)}${'结果'.padEnd(8)}${'耗时'.padEnd(14)}标题`);
  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    console.log(`${result.name.padEnd(12)}${status.padEnd(8)}${humanMillis(result.elapsedMs).padEnd(14)}${result.title}`);
  }
  const failed = results.filter((result) => !result.passed).length;
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
}

/** 是否全部达标 */
export function allBenchmarksPassed(results: readonly BenchmarkResult[]): boolean {
  return results.every((result) => result.passed);
}
