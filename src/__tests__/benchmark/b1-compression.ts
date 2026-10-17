// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 基准 B1：压缩率（对齐《详细设计》§7 / 《开发计划》§7）
 *
 * 场景：1 万 metric × 10min 采样 × 24h 模拟 → 每 metric 144 点（1.44M 点）。
 * 判据：**载荷压缩比 ≥ 10×**（加权，即 `Σ raw 载荷 / Σ 编码后载荷`）。
 *
 * 口径说明（重要）：
 *   - 分子 = `8B 时间戳 + 值原始字节`（f64/i64 → 8、bool → 1、string → UTF-8 字节长）；
 *   - 分母 = 编码后**载荷字节**（由 `.idx` 的块总长减去块头得到），块级固定开销（块头/段头/索引/WAL）
 *     **不计入压缩比**——该指标由基准 B6「固定开销 <2%」单独考核，避免两项口径重叠；
 *   - 场景数据量小（每 metric 144 点 < `blockMinPoints` 1024），块只在 `close()` 全量刷盘时形成，
 *     故本基准在 `close()` 之后测量磁盘占用。
 *   - 分类型分库统计：f64/i64/bool/string 各一库，既得加权总比，也得各类型比。
 */

import {
  humanBytes,
  humanRatio,
  measureDatabaseStorage,
  openBenchmarkEngine,
  removeBenchmarkDataDir,
  scaleValue,
  createBenchmarkDataDir,
} from './benchmark-utils.ts';
import type { BenchmarkMetricLine, BenchmarkResult, BenchmarkScale } from './benchmark-utils.ts';
import {
  DEFAULT_TYPE_WEIGHTS,
  buildTypedMetricDefinitions,
  createValueSource,
} from './synthetic-data.ts';
import type { SyntheticValueType } from './synthetic-data.ts';
import type { WritePoint } from '../../packages/core/src/index.ts';

/** 24h ÷ 10min = 144 点/metric */
const POINTS_PER_METRIC = 144;
/** 10min 采样间隔（毫秒） */
const SAMPLE_STEP_MS = 10 * 60 * 1000;
/**
 * 未压缩原始基线（字节/点）：**16 B**（= 8B 时间戳 + 8B 值槽）
 *
 * 依据：架构评估《评估-按天分文件性能影响》§5 对照行「未压缩原始（对照）16 B」（同文档
 * 「864M 点 × 16 B = 13.8 GB」可反证）。采用**全类型统一 16 B/点**而非「8B + 实际值字节」，
 * 是因为该基线是设计给出的「朴素定长记录」口径；同时这也是 B1（≥10× ⇔ ≤1.6 B/点）与
 * B6（≥1.3 GB/天 ⇔ ≥1.505 B/点）能够同时成立的唯一口径（详见 S10 结论）。
 */
const RAW_POINT_BYTES = 16;
/** 固定基日 00:00（本机时区），避免跨日边界 */
const BASE_TIMESTAMP = new Date(2026, 2, 10, 3, 0, 0).getTime();

/** 逐类型子库定义 */
interface TypeDatabasePlan {
  valueType: SyntheticValueType;
  database: string;
  prefix: string;
  metricCount: number;
}

/** 按类型权重把总 metric 数拆到四个子库（末项取余数保证合计相等） */
function buildTypePlan(totalMetricCount: number): TypeDatabasePlan[] {
  const floatCount = Math.round(totalMetricCount * DEFAULT_TYPE_WEIGHTS.f64);
  const integerCount = Math.round(totalMetricCount * DEFAULT_TYPE_WEIGHTS.i64);
  const booleanCount = Math.round(totalMetricCount * DEFAULT_TYPE_WEIGHTS.bool);
  const stringCount = totalMetricCount - floatCount - integerCount - booleanCount;
  return [
    { valueType: 'f64', database: 'b1_f64', prefix: 'bench.b1.f64', metricCount: floatCount },
    { valueType: 'i64', database: 'b1_i64', prefix: 'bench.b1.i64', metricCount: integerCount },
    { valueType: 'bool', database: 'b1_bool', prefix: 'bench.b1.bool', metricCount: booleanCount },
    { valueType: 'string', database: 'b1_string', prefix: 'bench.b1.string', metricCount: stringCount },
  ];
}

/** 运行基准 B1 */
export async function runB1Compression(scale: BenchmarkScale): Promise<BenchmarkResult> {
  const startedAt = performance.now();
  const totalMetricCount = scaleValue(scale, 3_000, 10_000);
  const plan = buildTypePlan(totalMetricCount);
  const dataDir = createBenchmarkDataDir('b1');
  const metrics: BenchmarkMetricLine[] = [];
  const notes: string[] = [
    `B1 口径：${totalMetricCount} metric × 10min × 24h → 每 metric ${POINTS_PER_METRIC} 点（quick 档按比例降规模）`,
    '压缩比分子 = 点数 × 16 B（对齐架构评估《评估-按天分文件性能影响》§5「未压缩原始（对照）16 B」口径，全类型统一）；分母 = 编码后载荷字节（块头/索引/WAL 不计入，由 B6 单独考核固定开销）',
  ];
  let passed = false;

  try {
    const engine = await openBenchmarkEngine({ dataDir, fsyncPolicy: 'none' });
    let totalRawBytes = 0;
    let totalPointCount = 0;
    const perTypeRawBytes = new Map<SyntheticValueType, number>();

    for (const typePlan of plan) {
      const definitions = buildTypedMetricDefinitions(typePlan.prefix, typePlan.metricCount, typePlan.valueType);
      const sources = definitions.map((definition) => createValueSource(definition));
      let typeRawBytes = 0;

      for (let tick = 0; tick < POINTS_PER_METRIC; tick += 1) {
        const timestamp = BASE_TIMESTAMP + tick * SAMPLE_STEP_MS;
        const batch = new Array<WritePoint>(definitions.length);
        for (let index = 0; index < definitions.length; index += 1) {
          batch[index] = { metricName: definitions[index].metricName, timestamp, value: sources[index].next(tick) };
        }
        typeRawBytes += definitions.length * RAW_POINT_BYTES;
        await engine.writeBatch(typePlan.database, batch);
        totalPointCount += batch.length;
      }
      perTypeRawBytes.set(typePlan.valueType, typeRawBytes);
      totalRawBytes += typeRawBytes;
    }

    // 全量刷盘 + 封口：块仅在 close() 形成（场景点数低于 blockMinPoints）
    await engine.close();

    let totalPayloadBytes = 0;
    let totalStorageBytes = 0;
    let totalBlockCount = 0;
    for (const typePlan of plan) {
      const measurement = measureDatabaseStorage(dataDir, typePlan.database);
      const rawBytes = perTypeRawBytes.get(typePlan.valueType) ?? 0;
      const payloadRatio = measurement.payloadBytes > 0 ? rawBytes / measurement.payloadBytes : 0;
      metrics.push({ label: `${typePlan.valueType} 压缩比（载荷）`, value: humanRatio(payloadRatio) });
      metrics.push({
        label: `${typePlan.valueType} 点数/载荷/占用`,
        value: `${typePlan.metricCount * POINTS_PER_METRIC} / ${humanBytes(measurement.payloadBytes)} / ${humanBytes(measurement.totalBytes)}`,
      });
      totalPayloadBytes += measurement.payloadBytes;
      totalStorageBytes += measurement.totalBytes;
      totalBlockCount += measurement.blockCount;
    }

    const payloadRatio = totalPayloadBytes > 0 ? totalRawBytes / totalPayloadBytes : 0;
    const storageRatio = totalStorageBytes > 0 ? totalRawBytes / totalStorageBytes : 0;
    passed = payloadRatio >= 10;

    metrics.unshift(
      { label: '总点数', value: `${totalPointCount}（${plan.reduce((sum, item) => sum + item.metricCount, 0)} metric）` },
      { label: '块数', value: `${totalBlockCount}` },
      { label: '原始载荷合计', value: humanBytes(totalRawBytes) },
      { label: '编码载荷合计', value: humanBytes(totalPayloadBytes) },
      { label: '磁盘占用合计（含开销）', value: humanBytes(totalStorageBytes) },
      { label: '加权压缩比（载荷）', value: humanRatio(payloadRatio) },
      { label: '加权压缩比（含开销，仅参考）', value: humanRatio(storageRatio) },
    );
    notes.push(`含块头/索引/WAL 的「磁盘占用比」为 ${humanRatio(storageRatio)}（小块场景开销占比高，属 B6 口径范围）`);
    notes.push(
      `块大小是压缩比决定项：同权重下 B6 场景（16384 点/块）实测载荷 1.575 B/点（≈10.16×），本场景（144 点/块）为 ${(totalPayloadBytes / Math.max(totalPointCount, 1)).toFixed(3)} B/点（${humanRatio(payloadRatio)}）——差距来自整块 zlib 无法在 144 点小块上摊薄，非编码器优劣（详见 S10 结论）`,
    );
  } finally {
    removeBenchmarkDataDir(dataDir);
  }

  return {
    name: 'B1',
    title: '压缩率（1 万 metric × 10min × 24h）',
    passed,
    elapsedMs: performance.now() - startedAt,
    threshold: '载荷压缩比 ≥ 10×（加权）',
    metrics,
    notes,
  };
}
