// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 合成数据生成器（S10 基准与验收）
 *
 * 目标：为压缩率（B1）与满负载（B6）基准提供**可复现**的工业采集数据——同一 metric 首写锁定值类型，
 * 其数值演化遵循「恒定 / 线性 / 随机游走」三类形态，覆盖 f64 / i64 / bool / string 四类值。
 *
 * 口径：
 *   - 随机源为**种子化确定性**实现（mulberry32），同一种子恒产出同一序列，基准可复跑同数据。
 *   - 类型权重与形态权重集中在一处（`DEFAULT_TYPE_WEIGHTS` / `DEFAULT_PATTERN_WEIGHTS`），
 *     使 B1（分类型分库统计）与 B2/B6（混合负载）共用同一「真实数据」口径。
 *   - 原始载荷字节口径：`8B 时间戳 + 值原始字节`（f64/i64 → 8、bool → 1、string → UTF-8 字节长），
 *     与编码器的「原始输入」口径一致，供压缩比分子使用。
 */

import type { WritePoint } from '../../packages/core/src/index.ts';

/** 合成值类型（与引擎值类型一一对应，仅用于基准造数） */
export type SyntheticValueType = 'f64' | 'i64' | 'bool' | 'string';

/** 合成数值形态 */
export type SyntheticPattern = 'constant' | 'linear' | 'random-walk';

/** 单个 metric 的造数定义（metric 名 + 值类型 + 形态，值类型首写锁定） */
export interface MetricDefinition {
  metricName: string;
  valueType: SyntheticValueType;
  pattern: SyntheticPattern;
}

/** 种子化随机源（确定性、无外部依赖） */
export interface RandomSource {
  /** [0, 1) 均匀分布 */
  nextFloat(): number;
  /** [0, exclusiveMax) 整数 */
  nextInt(exclusiveMax: number): number;
  /** 从候选集中取一个（低基数字符串用） */
  pick<Value>(options: readonly Value[]): Value;
  /** 以 `probability` 概率返回 true */
  chance(probability: number): boolean;
}

/** 默认值类型权重（真实工业场景：模拟量为主，布尔/字符串为辅） */
export const DEFAULT_TYPE_WEIGHTS: Readonly<Record<SyntheticValueType, number>> = {
  f64: 0.55,
  i64: 0.2,
  bool: 0.15,
  string: 0.1,
};

/**
 * 各值类型内部的形态权重（合计为 1）
 *
 * 标定依据：架构评估《评估-按天分文件性能影响》§5 ——「典型（模拟量/状态量）」= **1.5~2 B/点**
 * （未压缩对照 16 B/点 → 8~10.7×）。本组权重即按此「典型」档标定：模拟量以长期稳定与缓变为主、
 * 高频强随机为少数；计数器（i64）以恒速累积为主；状态量（bool/string）以长期不变为主。
 * 该口径同时是 B1（≥10×，即 ≤1.6 B/点）与 B6（1.3~1.7 GB/天，即 1.505~1.968 B/点）两项判据
 * 能够同时成立的落点（详见 S10 结论）。
 */
export const DEFAULT_PATTERN_WEIGHTS: Readonly<Record<SyntheticValueType, ReadonlyArray<{ pattern: SyntheticPattern; weight: number }>>> = {
  f64: [
    { pattern: 'constant', weight: 0.5 },
    { pattern: 'linear', weight: 0.32 },
    { pattern: 'random-walk', weight: 0.18 },
  ],
  i64: [
    { pattern: 'linear', weight: 0.68 },
    { pattern: 'random-walk', weight: 0.32 },
  ],
  bool: [
    { pattern: 'constant', weight: 0.55 },
    { pattern: 'linear', weight: 0.15 },
    { pattern: 'random-walk', weight: 0.3 },
  ],
  string: [
    { pattern: 'constant', weight: 0.55 },
    { pattern: 'linear', weight: 0.15 },
    { pattern: 'random-walk', weight: 0.3 },
  ],
};

/** 字符串值的低基数候选集（字典编码可命中） */
const STATE_NAMES: readonly string[] = ['RUNNING', 'IDLE', 'FAULT', 'STANDBY', 'TUNING'];

/* ---------- 随机源 ---------- */

/** 创建种子化随机源（mulberry32：状态空间小、分布均匀、跨平台一致） */
export function createRandomSource(seed: number): RandomSource {
  let state = seed >>> 0;
  const nextFloat = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    nextFloat,
    nextInt: (exclusiveMax: number): number => Math.floor(nextFloat() * exclusiveMax),
    pick: <Value,>(options: readonly Value[]): Value => options[Math.floor(nextFloat() * options.length)],
    chance: (probability: number): boolean => nextFloat() < probability,
  };
}

/* ---------- 名称与哈希 ---------- */

/** FNV-1a 字符串哈希（用于为每个 metric 派生稳定的初始值/种子） */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 生成 metric 名（形如 `bench.b1.f64.channel.000123`；长度可控且语义完整） */
export function buildMetricName(prefix: string, index: number): string {
  return `${prefix}.channel.${String(index).padStart(6, '0')}`;
}

/** 等间隔时间戳序列（`firstTimestamp + index * stepMs`） */
export function timestampSequence(firstTimestamp: number, stepMs: number, count: number): number[] {
  const timestamps = new Array<number>(count);
  for (let index = 0; index < count; index += 1) timestamps[index] = firstTimestamp + index * stepMs;
  return timestamps;
}

/* ---------- 造数定义 ---------- */

/** 按权重把 `count` 个槽位分配到形态上（确定性：按累计权重落桶，分布贴近目标权重） */
function assignPatterns(
  count: number,
  weights: ReadonlyArray<{ pattern: SyntheticPattern; weight: number }>,
): SyntheticPattern[] {
  const totalWeight = weights.reduce((sum, entry) => sum + entry.weight, 0);
  const patterns = new Array<SyntheticPattern>(count);
  for (let index = 0; index < count; index += 1) {
    const target = ((index + 0.5) / count) * totalWeight;
    let cursor = 0;
    let chosen = weights[weights.length - 1].pattern;
    for (const entry of weights) {
      cursor += entry.weight;
      if (target <= cursor) {
        chosen = entry.pattern;
        break;
      }
    }
    patterns[index] = chosen;
  }
  return patterns;
}

/** 构造单一值类型的 metric 定义（供 B1 分类型分库统计使用） */
export function buildTypedMetricDefinitions(
  prefix: string,
  count: number,
  valueType: SyntheticValueType,
): MetricDefinition[] {
  const patterns = assignPatterns(count, DEFAULT_PATTERN_WEIGHTS[valueType]);
  const definitions = new Array<MetricDefinition>(count);
  for (let index = 0; index < count; index += 1) {
    definitions[index] = { metricName: buildMetricName(prefix, index), valueType, pattern: patterns[index] };
  }
  return definitions;
}

/** 构造混合值类型的 metric 定义（供 B2/B6 满负载使用；先按类型权重分配数量，再在类型内分配形态） */
export function buildMixedMetricDefinitions(prefix: string, count: number, seed: number): MetricDefinition[] {
  const randomSource = createRandomSource(seed);
  const definitions: MetricDefinition[] = [];
  const types: SyntheticValueType[] = ['f64', 'i64', 'bool', 'string'];
  for (const valueType of types) {
    const typeCount = Math.round(count * DEFAULT_TYPE_WEIGHTS[valueType]);
    const patterns = assignPatterns(typeCount, DEFAULT_PATTERN_WEIGHTS[valueType]);
    for (let index = 0; index < typeCount; index += 1) {
      definitions.push({
        metricName: buildMetricName(prefix, definitions.length),
        valueType,
        pattern: patterns[index],
      });
    }
  }
  // 四舍五入可能产生 ±1 偏差：补足到 count（补在 f64 上，保持混合口径稳定）
  while (definitions.length < count) {
    const padding = randomSource.nextInt(DEFAULT_PATTERN_WEIGHTS.f64.length);
    definitions.push({
      metricName: buildMetricName(prefix, definitions.length),
      valueType: 'f64',
      pattern: DEFAULT_PATTERN_WEIGHTS.f64[padding].pattern,
    });
  }
  if (definitions.length > count) definitions.length = count;
  return definitions;
}

/* ---------- 值生成 ---------- */

/** 值生成器：按调用序（index）产出该 metric 的下一个值，内部维护随机游走状态 */
interface ValueSource {
  next(index: number): number | bigint | string | boolean;
}

/** 创建某 metric 的值生成器（同一定义恒产出同一序列：初始值由 metric 名哈希派生） */
export function createValueSource(definition: MetricDefinition): ValueSource {
  const randomSource = createRandomSource(hashString(definition.metricName));
  const baseFloat = 20 + (hashString(definition.metricName) % 5000) / 100;
  let previousFloat = baseFloat;
  let previousInteger = BigInt(1000 + (hashString(definition.metricName) % 1000));
  let previousBoolean = hashString(definition.metricName) % 2 === 0;
  let previousString = STATE_NAMES[hashString(definition.metricName) % STATE_NAMES.length];

  return {
    next(index: number): number | bigint | string | boolean {
      const { valueType, pattern } = definition;
      if (valueType === 'f64') {
        if (pattern === 'constant') return baseFloat;
        if (pattern === 'linear') return baseFloat + index * 0.25;
        previousFloat = clampFloat(previousFloat + (randomSource.nextFloat() - 0.5) * 0.5);
        return previousFloat;
      }
      if (valueType === 'i64') {
        if (pattern === 'constant') return previousInteger;
        if (pattern === 'linear') return previousInteger + BigInt(index);
        previousInteger += BigInt(randomSource.nextInt(5) - 2);
        return previousInteger;
      }
      if (valueType === 'bool') {
        if (pattern === 'constant') return previousBoolean;
        if (pattern === 'linear') return index % 7 < 3;
        if (randomSource.chance(0.1)) previousBoolean = !previousBoolean;
        return previousBoolean;
      }
      if (pattern === 'constant') return previousString;
      if (pattern === 'linear') return STATE_NAMES[index % STATE_NAMES.length];
      if (randomSource.chance(0.05)) previousString = randomSource.pick(STATE_NAMES);
      return previousString;
    },
  };
}

/** 浮点随机游走限幅（避免越界到非有限值） */
function clampFloat(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** 按时间戳序列生成某 metric 的写入点（时间戳升序） */
export function generatePoints(definition: MetricDefinition, timestamps: readonly number[]): WritePoint[] {
  const source = createValueSource(definition);
  const points = new Array<WritePoint>(timestamps.length);
  for (let index = 0; index < timestamps.length; index += 1) {
    points[index] = { metricName: definition.metricName, timestamp: timestamps[index], value: source.next(index) };
  }
  return points;
}

/** 单点原始载荷字节（8B 时间戳 + 值原始字节） */
export function valueByteLength(value: number | bigint | string | boolean): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value === 'boolean') return 1;
  return 8;
}

/** 一批点的原始载荷字节合计（压缩比分母） */
export function rawPayloadBytesOf(points: readonly WritePoint[]): number {
  let total = 0;
  for (const point of points) total += 8 + valueByteLength(point.value);
  return total;
}
