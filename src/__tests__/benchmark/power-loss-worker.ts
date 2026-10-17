// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 断电注入的写入子进程（S10 基准与验收）
 *
 * 用法：`node power-loss-worker.ts <dataDir> <database> <ackFilePath> <metricName>`
 *
 * 职责：开启引擎 → 打印 `READY`（父进程据此确认已进入写入窗口）→ 持续按批写入，
 *       每批被 `writeBatch` 确认接受后**立即**把「批明细」追加到 ack 文件（不缓冲，存活于 OS 页缓存），
 *       直至被父进程 `kill -9`。
 *
 * ack 行格式（每批一行 JSON，父进程重启后据此重建「已确认接受」的点集合并校验可查性）：
 *   `{"metricName":"...","timestampStart":<ms>,"stepMs":1,"values":[v0,v1,...]}`
 *
 * 说明：所有点均为 f64（值可直接经 JSON 往返，避免 BigInt 序列化问题）。
 */

import { openSync, writeSync } from 'node:fs';

import { RtdbEngine } from '../../packages/core/src/index.ts';

/** 每批点数 */
const BATCH_POINTS = 200;
/** 批内时间戳步长（1ms，保证批间时间戳连续且唯一） */
const STEP_MS = 1;

const dataDir = process.argv[2];
const database = process.argv[3];
const ackFilePath = process.argv[4];
const metricName = process.argv[5];
if (!dataDir || !database || !ackFilePath || !metricName) {
  console.error('用法：node power-loss-worker.ts <dataDir> <database> <ackFilePath> <metricName>');
  process.exit(2);
}

/** 简单确定性随机源（子进程内造数，无需与父进程一致） */
let randomState = 0x9e3779b9;
function nextFloat(): number {
  randomState = (randomState * 1664525 + 1013904223) >>> 0;
  return randomState / 4294967296;
}

const engine = new RtdbEngine({ dataDir });
await engine.open();

const ackFileDescriptor = openSync(ackFilePath, 'a');
let nextTimestamp = Date.now();
let currentValue = 50;
let batchIndex = 0;

// 就绪信号：父进程收到后开始随机延迟计时
process.stdout.write('READY\n');

for (;;) {
  const values = new Array<number>(BATCH_POINTS);
  const points = new Array<{ metricName: string; timestamp: number; value: number }>(BATCH_POINTS);
  for (let offset = 0; offset < BATCH_POINTS; offset += 1) {
    currentValue += (nextFloat() - 0.5) * 0.5;
    values[offset] = currentValue;
    points[offset] = { metricName, timestamp: nextTimestamp + offset * STEP_MS, value: currentValue };
  }
  await engine.writeBatch(database, points);
  writeSync(
    ackFileDescriptor,
    `${JSON.stringify({ metricName, timestampStart: nextTimestamp, stepMs: STEP_MS, values })}\n`,
  );
  nextTimestamp += BATCH_POINTS * STEP_MS;
  batchIndex += 1;
}
