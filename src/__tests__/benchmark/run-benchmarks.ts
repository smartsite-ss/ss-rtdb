// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * S10 基准与验收编排器（`npm run bench`）
 *
 * 用法：
 *   `npm run bench`                       —— quick 档（默认，有界可跑）
 *   `RTDB_BENCH_SCALE=full npm run bench` —— full 档（完整口径，含断电注入 1000 轮）
 *   `RTDB_BENCH_ONLY=POWER-LOSS RTDB_BENCH_SCALE=full npm run bench` —— 仅跑指定项（逗号分隔名称，便于单项复核）
 *
 * 编排内容（《详细设计》§7 / 《开发计划》§7）：
 *   B1 压缩率 / B2 吞吐 / B3 range 冷热延迟 / B4 跨天切换 / B5 last(before) 端点差 ×1000 /
 *   B6 满负载外推 / POWER-LOSS 断电注入（SIGKILL × N + 重启可查性校验）。
 *
 * 判定：逐项打印明细与 PASS/FAIL，最后打印汇总表；**任一项 FAIL 进程以非零码退出**（供 CI 门禁使用）。
 *
 * 说明：本编排器与各基准文件位于 `__tests__/benchmark/`，**不参与 `npm test`**
 * （其 glob 为 `__tests__/*.test.ts`，非递归），但仍在 `tsconfig.json` 的 include 范围内，故受 `npm run typecheck` 约束。
 */

import {
  allBenchmarksPassed,
  printBenchmarkResult,
  printSummaryTable,
  readBenchmarkScale,
} from './benchmark-utils.ts';
import type { BenchmarkResult, BenchmarkScale } from './benchmark-utils.ts';
import { runB1Compression } from './b1-compression.ts';
import { runB2Throughput } from './b2-throughput.ts';
import { runB3RangeLatency } from './b3-range-latency.ts';
import { runB4DayRollover } from './b4-day-rollover.ts';
import { runB5EndpointDiff } from './b5-endpoint-diff.ts';
import { runB6FullLoad } from './b6-full-load.ts';
import { runPowerLossInjection } from './power-loss.ts';

/* ---------- 编排项 ---------- */

interface BenchmarkEntry {
  /** 编号（用于执行崩溃时兜底结果） */
  name: string;
  /** 标题（用于执行崩溃时兜底结果） */
  title: string;
  run: (scale: BenchmarkScale) => Promise<BenchmarkResult>;
}

/** 编排顺序：B1 → B6 后接断电注入（重活压轴，便于先看轻量项结果） */
const BENCHMARKS: readonly BenchmarkEntry[] = [
  { name: 'B1', title: '压缩率', run: runB1Compression },
  { name: 'B2', title: '吞吐与 P99 延迟', run: runB2Throughput },
  { name: 'B3', title: 'range 冷/热延迟', run: runB3RangeLatency },
  { name: 'B4', title: '跨天目录切换', run: runB4DayRollover },
  { name: 'B5', title: 'last(before) 端点差 ×1000', run: runB5EndpointDiff },
  { name: 'B6', title: '满负载容量外推', run: runB6FullLoad },
  { name: 'POWER-LOSS', title: '断电注入', run: runPowerLossInjection },
];

/* ---------- 编排项筛选 ---------- */

/** 读取 `RTDB_BENCH_ONLY`（逗号分隔的编号，大小写不敏感；未设置或全空则不过滤） */
function readBenchmarkOnlyFilter(): string[] {
  const raw = process.env.RTDB_BENCH_ONLY ?? '';
  return raw
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item.length > 0);
}

/* ---------- 主流程 ---------- */

const scale = readBenchmarkScale();
const onlyFilter = readBenchmarkOnlyFilter();
const selected = BENCHMARKS.filter((entry) => onlyFilter.length === 0 || onlyFilter.includes(entry.name.toUpperCase()));
console.log('================ ss-rtdb S10 基准与验收 ================');
console.log(`规模档位: ${scale}（环境变量 RTDB_BENCH_SCALE=full 可切换完整口径）`);
console.log(`运行环境: node ${process.version} / ${process.platform} ${process.arch}`);
if (onlyFilter.length > 0) {
  console.log(`筛选: 仅运行 ${selected.map((entry) => entry.name).join(', ')}（环境变量 RTDB_BENCH_ONLY）`);
}

const results: BenchmarkResult[] = [];
for (const entry of selected) {
  const startedAt = Date.now();
  try {
    const result = await entry.run(scale);
    printBenchmarkResult(result, scale);
    results.push(result);
  } catch (error) {
    const failure = error as Error;
    const result: BenchmarkResult = {
      name: entry.name,
      title: entry.title,
      passed: false,
      elapsedMs: Date.now() - startedAt,
      threshold: '—（执行抛异常，未产生判定）',
      metrics: [],
      notes: [`执行失败: ${failure.stack ?? failure.message}`],
    };
    printBenchmarkResult(result, scale);
    results.push(result);
  }
}

printSummaryTable(results);
if (!allBenchmarksPassed(results)) {
  console.log('\n判定: FAIL —— 存在未达标项，进程以非零码退出。');
  process.exitCode = 1;
} else {
  console.log('\n判定: PASS —— 全部基准达标。');
}
