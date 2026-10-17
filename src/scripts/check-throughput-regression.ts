// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * S15 cross-regression gate (`npm run bench:regression`).
 *
 * Runs benchmark B2 (write throughput + P99 latency) and compares the measured
 * throughput against the recorded baseline in `scripts/throughput-baseline.json`.
 * Degradation beyond `MAXIMUM_DEGRADATION_RATIO` (15%) blocks the gate
 * (non-zero exit code), so a performance regression cannot land unnoticed.
 *
 * Usage:
 *   node scripts/check-throughput-regression.ts
 *   node scripts/check-throughput-regression.ts --update-baseline
 *   RTDB_BENCH_SCALE=full node scripts/check-throughput-regression.ts
 *
 * Notes:
 *   - a baseline is machine/platform specific. Before using this gate on a new
 *     target platform (e.g. Kylin / UnionTech), record a fresh baseline there
 *     with `--update-baseline`;
 *   - an environment mismatch is reported as a warning (the comparison then
 *     stays indicative) and does not by itself block;
 *   - scale mismatch (quick baseline vs full run) blocks, because the two
 *     scales are not comparable.
 *
 * Exit code: 0 = within budget, 1 = degradation beyond budget, scale mismatch,
 * missing baseline, or B2 absolute threshold unmet.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runB2Throughput } from '../__tests__/benchmark/b2-throughput.ts';
import { humanMillis, printBenchmarkResult, readBenchmarkScale } from '../__tests__/benchmark/benchmark-utils.ts';
import type { BenchmarkScale } from '../__tests__/benchmark/benchmark-utils.ts';

/* ---------- 常量 ---------- */

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE_PATH = join(SCRIPT_DIRECTORY, 'throughput-baseline.json');
/** 允许的吞吐劣化上限（对齐《开发计划》§8「吞吐劣化 >15% 阻断」） */
const MAXIMUM_DEGRADATION_RATIO = 0.15;

/* ---------- 基线结构 ---------- */

/** 基线录制时的运行环境（跨平台比对时仅作提示） */
interface BaselineEnvironment {
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
}

/** B2 吞吐基线（由 `--update-baseline` 写入） */
interface ThroughputBaseline {
  recordedAt: string;
  scale: BenchmarkScale;
  throughput: number;
  p99Ms: number;
  environment: BaselineEnvironment;
}

/** 读取当前运行环境 */
function currentEnvironment(): BaselineEnvironment {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    // CPU 型号串在不同平台带不同尾随空白，统一 trim 以免环境比对误报
    cpuModel: (cpus()[0]?.model ?? 'unknown').trim(),
    cpuCount: cpus().length,
  };
}

/** 读取基线文件（不存在或字段非法时返回 null） */
function readBaseline(): ThroughputBaseline | null {
  if (!existsSync(BASELINE_FILE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_FILE_PATH, 'utf8')) as Partial<ThroughputBaseline>;
    if (typeof parsed.throughput !== 'number' || typeof parsed.p99Ms !== 'number') return null;
    if (parsed.scale !== 'quick' && parsed.scale !== 'full') return null;
    return parsed as ThroughputBaseline;
  } catch {
    return null;
  }
}

/** 写入基线文件（保留 2 空格缩进，末尾换行） */
function writeBaseline(baseline: ThroughputBaseline): void {
  writeFileSync(BASELINE_FILE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

/** 列出基线与当前环境的差异项（空数组表示环境一致） */
function environmentMismatches(baseline: BaselineEnvironment, current: BaselineEnvironment): string[] {
  const mismatches: string[] = [];
  const keys: readonly (keyof BaselineEnvironment)[] = ['nodeVersion', 'platform', 'arch', 'cpuModel', 'cpuCount'];
  for (const key of keys) {
    if (baseline[key] !== current[key]) {
      mismatches.push(`${key}: 基线 ${String(baseline[key])} → 当前 ${String(current[key])}`);
    }
  }
  return mismatches;
}

/* ---------- 主流程 ---------- */

const scale = readBenchmarkScale();
const updateBaseline = process.argv.includes('--update-baseline');

console.log('================ ss-rtdb S15 吞吐回归门槛（B2） ================');
console.log(`规模档位: ${scale}（RTDB_BENCH_SCALE=full 切换完整口径）`);
console.log(`运行环境: node ${process.version} / ${process.platform} ${process.arch}`);

const result = await runB2Throughput(scale);
printBenchmarkResult(result, scale);

const measurements = result.measurements;
const throughput = measurements?.throughput;
const p99Ms = measurements?.p99Ms;
const environment = currentEnvironment();
const violations: string[] = [];

if (throughput === undefined || p99Ms === undefined) {
  violations.push('B2 未返回机器可读的吞吐指标（measurements 缺失），无法比对');
} else if (updateBaseline) {
  const baseline: ThroughputBaseline = {
    recordedAt: new Date().toISOString(),
    scale,
    throughput: Number(throughput.toFixed(0)),
    p99Ms: Number(p99Ms.toFixed(3)),
    environment,
  };
  writeBaseline(baseline);
  console.log(`\n基线与已写入: ${BASELINE_FILE_PATH}`);
  console.log(`  · 吞吐 ${baseline.throughput} 点/秒 / P99 ${baseline.p99Ms} ms / 档位 ${baseline.scale}`);
} else {
  const baseline = readBaseline();
  if (!baseline) {
    violations.push(`基线文件缺失或非法: ${BASELINE_FILE_PATH}（先用 --update-baseline 录制）`);
  } else if (baseline.scale !== scale) {
    violations.push(`档位不可比: 基线 ${baseline.scale} vs 本次 ${scale}（先用 --update-baseline 重录同档位基线）`);
  } else {
    const mismatches = environmentMismatches(baseline.environment, environment);
    const degradationRatio = baseline.throughput > 0 ? (baseline.throughput - throughput) / baseline.throughput : 0;
    console.log('\n================ 回归比对 ================');
    console.log(`基线录制: ${baseline.recordedAt} / node ${baseline.environment.nodeVersion} / ${baseline.environment.cpuModel} ×${baseline.environment.cpuCount}`);
    console.log(`基线吞吐: ${baseline.throughput} 点/秒（P99 ${baseline.p99Ms} ms）`);
    console.log(`本次吞吐: ${throughput.toFixed(0)} 点/秒（P99 ${humanMillis(p99Ms)}）`);
    console.log(`劣化比例: ${(degradationRatio * 100).toFixed(2)}%（上限 ${(MAXIMUM_DEGRADATION_RATIO * 100).toFixed(0)}%）`);
    if (mismatches.length > 0) {
      console.log('环境差异（比对仅供参考，不作为阻断依据）:');
      for (const mismatch of mismatches) console.log(`  · ${mismatch}`);
    }
    if (!result.passed) {
      violations.push(`B2 绝对阈值未达标（${result.threshold}）`);
    }
    if (degradationRatio > MAXIMUM_DEGRADATION_RATIO) {
      violations.push(
        `吞吐劣化 ${(degradationRatio * 100).toFixed(2)}% > 上限 ${(MAXIMUM_DEGRADATION_RATIO * 100).toFixed(0)}%`,
      );
    }
  }
}

if (violations.length > 0) {
  console.log('\n判定: FAIL —— 存在回归门槛违规，进程以非零码退出。');
  for (const violation of violations) console.log(`  - ${violation}`);
} else if (updateBaseline) {
  console.log('\n判定: BASELINE —— 基线已录制，本次未做回归比对。');
} else {
  console.log('\n判定: PASS —— 吞吐在回归预算内。');
}

process.exitCode = violations.length > 0 ? 1 : 0;
