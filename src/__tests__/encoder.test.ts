// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 编码器单测矩阵（S1）：四值类型 × 典型工况 roundtrip + 压缩率断言
 *
 * 覆盖 codecId：0 raw · 1 ts delta-of-delta · 2 Gorilla XOR · 4 zlib 整块
 *              5 i64 delta · 6 bool RLE · 7 string 字典
 *
 * 运行：node --test __tests__/encoder.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ERROR_CODE, RtdbError, isRtdbError } from '../packages/core/src/errors.ts';
import { ValueType } from '../packages/core/src/types.ts';
import { CODEC_ID, decodeValues, encodeValues, encodeValuesWithCodec } from '../packages/core/src/encoder/registry.ts';
import { decodeRawValues, encodeRawValues } from '../packages/core/src/encoder/raw-codec.ts';
import { decodeTimestamps, encodeTimestamps } from '../packages/core/src/encoder/timestamp-codec.ts';
import { decodeFloat64Values, encodeFloat64Values } from '../packages/core/src/encoder/gorilla-codec.ts';
import { decodeInt64Values, encodeInt64Values } from '../packages/core/src/encoder/int64-codec.ts';
import { decodeBoolValues, encodeBoolValues } from '../packages/core/src/encoder/bool-codec.ts';
import {
  STRING_ENCODING_MODE,
  decodeStringValues,
  encodeStringValues,
} from '../packages/core/src/encoder/string-codec.ts';
import { unwrapZlib, wrapWithZlib } from '../packages/core/src/encoder/zlib-wrap.ts';
import type { EncodableValues } from '../packages/core/src/encoder/values.ts';

/** 值类型 → 专用 codecId（与 registry 的 encodeSpecialized 保持一致） */
const SPECIALIZED_CODEC_BY_TYPE: Record<number, number> = {
  [ValueType.Float64]: CODEC_ID.gorillaXor,
  [ValueType.Int64]: CODEC_ID.int64Delta,
  [ValueType.Bool]: CODEC_ID.boolRle,
  [ValueType.String]: CODEC_ID.stringDictionary,
};

/**
 * 独立复算全部候选载荷，校验 registry 的“取最小体积”择优确实成立。
 * 候选集合与 registry 一致：专用 / raw，以及二者各自的 zlib 包装（仅更小者纳入）。
 */
function assertOptimalSelection(
  valueType: ValueType,
  values: EncodableValues,
  count: number,
): number {
  const specializedCodecId = SPECIALIZED_CODEC_BY_TYPE[valueType];
  const rawPayload = encodeRawValues(valueType, values, count);
  const candidates = [
    { codecId: specializedCodecId, payload: encodeValuesWithCodec(specializedCodecId, valueType, values, count) },
    { codecId: CODEC_ID.raw, payload: rawPayload },
  ];
  for (const base of [...candidates]) {
    const wrapped = wrapWithZlib(base.codecId, base.payload);
    if (wrapped.length < base.payload.length) {
      candidates.push({ codecId: CODEC_ID.zlibWrap, payload: wrapped });
    }
  }

  const minLength = Math.min(...candidates.map((candidate) => candidate.payload.length));
  const encoded = encodeValues(valueType, values, count);
  assert.equal(encoded.payload.length, minLength, '选中载荷应为全部候选中的最小体积');
  assert.equal(encoded.uncompressedSize, rawPayload.length, 'uncompressedSize 应等于 raw 载荷长度');
  assert.ok(
    candidates.some(
      (candidate) => candidate.codecId === encoded.codecId && candidate.payload.length === minLength,
    ),
    `选中 codecId=${encoded.codecId} 应为达到最小体积的候选之一`,
  );
  return encoded.codecId;
}

/** 捕获并断言为 RtdbError */
function captureRtdbError(action: () => unknown): RtdbError {
  try {
    action();
  } catch (error) {
    if (!isRtdbError(error)) {
      throw new Error(`预期 RtdbError，实际为：${String(error)}`);
    }
    return error;
  }
  throw new Error('预期抛出异常，但未抛出');
}

/** mulberry32：确定性伪随机，保证用例可复现 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertFloat64Equal(actual: Float64Array, expected: ArrayLike<number>): void {
  assert.equal(actual.length, expected.length, '长度不符');
  for (let index = 0; index < expected.length; index += 1) {
    const target = expected[index];
    const value = actual[index];
    if (Number.isNaN(target)) {
      assert.ok(Number.isNaN(value), `index=${index} 应为 NaN`);
      continue;
    }
    if (Object.is(target, -0)) {
      assert.ok(Object.is(value, -0), `index=${index} 应为 -0`);
      continue;
    }
    assert.equal(value, target, `index=${index} 值不符`);
  }
}

/** 以 8 字节小端位型逐字节比对，可捕获 NaN payload / -0 等数值比较掩盖的差异 */
function assertFloat64BitExact(actual: Float64Array, expected: Float64Array): void {
  const expectedBytes = encodeRawValues(ValueType.Float64, expected, expected.length);
  const actualBytes = encodeRawValues(ValueType.Float64, actual, actual.length);
  assert.deepEqual([...actualBytes], [...expectedBytes]);
}

function assertInt64Equal(actual: BigInt64Array, expected: readonly bigint[]): void {
  assert.equal(actual.length, expected.length, '长度不符');
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index], expected[index], `index=${index} 值不符`);
  }
}

function assertBoolEqual(actual: Uint8Array, expected: readonly number[]): void {
  assert.equal(actual.length, expected.length, '长度不符');
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index], expected[index] ? 1 : 0, `index=${index} 值不符`);
  }
}

function assertStringEqual(actual: readonly string[], expected: readonly string[]): void {
  assert.equal(actual.length, expected.length, '长度不符');
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index], expected[index], `index=${index} 值不符`);
  }
}

/* ------------------------------------------------------------------ 时间戳 */

describe('codecId 1：时间戳 delta-of-delta', () => {
  it('恒定采样周期（1s）1 万点：往返一致且 ≈1 字节/点', () => {
    const count = 10_000;
    const start = 1_700_000_000_000;
    const timestamps = new Float64Array(count);
    for (let index = 0; index < count; index += 1) timestamps[index] = start + index * 1000;

    const payload = encodeTimestamps(timestamps, count);
    assertFloat64Equal(decodeTimestamps(payload, count), timestamps);
    assert.ok(
      payload.length <= count + 32,
      `恒定周期应贴近 1 字节/点，实际 ${payload.length} 字节（${(payload.length / count).toFixed(2)} B/点）`,
    );
    const rawBytes = count * 8;
    assert.ok(rawBytes / payload.length > 4, `压缩率应 > 4×，实际 ${(rawBytes / payload.length).toFixed(1)}×`);
  });

  it('变周期与抖动周期（含回退到同值）往返一致', () => {
    const count = 5000;
    const random = createRandom(0x51ed);
    const timestamps = new Float64Array(count);
    let current = 1_600_000_000_000;
    for (let index = 0; index < count; index += 1) {
      timestamps[index] = current;
      current += Math.floor(random() * 50);
    }
    const payload = encodeTimestamps(timestamps, count);
    assertFloat64Equal(decodeTimestamps(payload, count), timestamps);
  });

  it('边界点数：0 / 1 / 2 点', () => {
    const empty = encodeTimestamps(new Float64Array(0), 0);
    assert.equal(empty.length, 0);
    assert.equal(decodeTimestamps(empty, 0).length, 0);

    const single = encodeTimestamps(new Float64Array([1_700_000_000_123]), 1);
    const singleDecoded = decodeTimestamps(single, 1);
    assert.equal(singleDecoded.length, 1);
    assert.equal(singleDecoded[0], 1_700_000_000_123);

    const double = encodeTimestamps(new Float64Array([1000, 2000]), 2);
    const doubleDecoded = decodeTimestamps(double, 2);
    assert.equal(doubleDecoded[0], 1000);
    assert.equal(doubleDecoded[1], 2000);
  });

  it('非整数时间戳抛 E_INVALID_POINT；递减时间戳抛 E_INVALID_POINT', () => {
    assert.equal(
      captureRtdbError(() => encodeTimestamps(new Float64Array([1.5]), 1)).code,
      ERROR_CODE.InvalidPoint,
    );
    assert.equal(
      captureRtdbError(() => encodeTimestamps(new Float64Array([2000, 1000]), 2)).code,
      ERROR_CODE.InvalidPoint,
    );
  });
});

/* ------------------------------------------------------------------- f64 */

describe('codecId 2：f64 Gorilla XOR', () => {
  it('恒定值 1 万点：位型精确往返且 < 0.2 字节/点', () => {
    const count = 10_000;
    const values = new Float64Array(count).fill(23.5);
    const payload = encodeFloat64Values(values, count);
    const decoded = decodeFloat64Values(payload, count);
    assertFloat64BitExact(decoded, values);
    assert.ok(
      payload.length <= Math.ceil((64 + (count - 1)) / 8) + 1,
      `恒定值应为 64bit + 1bit/点，实际 ${payload.length} 字节`,
    );
    assert.ok(count * 8 / payload.length > 50, `压缩率应 > 50×，实际 ${(count * 8 / payload.length).toFixed(1)}×`);
  });

  it('线性趋势与随机游走（1 万点）位型精确往返', () => {
    const count = 10_000;
    const random = createRandom(0xbeef);

    const linear = new Float64Array(count);
    for (let index = 0; index < count; index += 1) linear[index] = 100 + index * 0.003;
    assertFloat64BitExact(decodeFloat64Values(encodeFloat64Values(linear, count), count), linear);

    const walk = new Float64Array(count);
    let current = 50;
    for (let index = 0; index < count; index += 1) {
      current += (random() - 0.5) * 0.25;
      walk[index] = current;
    }
    const walkPayload = encodeFloat64Values(walk, count);
    assertFloat64BitExact(decodeFloat64Values(walkPayload, count), walk);
    assert.ok(walkPayload.length < count * 8, '随机游走也应优于 raw');
  });

  it('极值与特殊值位型精确往返（±0 / NaN / ±Infinity / 极值 / 交替窗口）', () => {
    const samples = new Float64Array([
      0, -0, 1, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, 1e-320, -1e308, 0, 1e-320, 0,
    ]);
    const payload = encodeFloat64Values(samples, samples.length);
    assertFloat64BitExact(decodeFloat64Values(payload, samples.length), samples);
  });

  it('窗口失效与重建（前导零钳位边界：最高有效位落在低 32 位）', () => {
    const tiny = 2 ** -300;
    const samples = new Float64Array([
      tiny, tiny + 2 ** -352, tiny + 2 ** -351, 3.5, 3.5, 1e-300, 0.5, 0.25,
    ]);
    const payload = encodeFloat64Values(samples, samples.length);
    assertFloat64BitExact(decodeFloat64Values(payload, samples.length), samples);
  });

  it('随机 2000 组短序列位型精确往返', () => {
    const random = createRandom(0x1234);
    for (let round = 0; round < 2000; round += 1) {
      const count = 1 + Math.floor(random() * 12);
      const values = new Float64Array(count);
      for (let index = 0; index < count; index += 1) {
        const roll = random();
        if (roll < 0.15) values[index] = values[Math.max(0, index - 1)];
        else if (roll < 0.3) values[index] = Math.floor(random() * 1000);
        else values[index] = (random() - 0.5) * 10 ** Math.floor(random() * 20);
      }
      const payload = encodeFloat64Values(values, count);
      assertFloat64BitExact(decodeFloat64Values(payload, count), values);
    }
  });

  it('0 点返回空载荷', () => {
    assert.equal(encodeFloat64Values(new Float64Array(0), 0).length, 0);
    assert.equal(decodeFloat64Values(new Uint8Array(0), 0).length, 0);
  });
});

/* ------------------------------------------------------------------- i64 */

describe('codecId 5：i64 delta + varint', () => {
  it('恒定计数（步长 1）1 万点：往返一致且 ≈1 字节/点', () => {
    const count = 10_000;
    const values = new BigInt64Array(count);
    for (let index = 0; index < count; index += 1) values[index] = BigInt(index);
    const payload = encodeInt64Values(values, count);
    const decoded = decodeInt64Values(payload, count);
    for (let index = 0; index < count; index += 1) assert.equal(decoded[index], BigInt(index));
    assert.ok(payload.length <= count + 16, `实际 ${payload.length} 字节`);
    assert.ok((count * 8) / payload.length > 4, `压缩率应 > 4×，实际 ${((count * 8) / payload.length).toFixed(1)}×`);
  });

  it('±2^53 与 ±2^62 边界值精确往返', () => {
    const samples = [
      0n, 1n, -1n, 2n ** 53n, -(2n ** 53n), 2n ** 62n, -(2n ** 62n), 9_007_199_254_740_991n,
      -9_007_199_254_740_991n, 0n, 2n ** 62n, 1n,
    ];
    const values = BigInt64Array.from(samples);
    const decoded = decodeInt64Values(encodeInt64Values(values, values.length), values.length);
    assertInt64Equal(decoded, samples);
  });

  it('时间序列式递增计数（cm 累积量）往返一致', () => {
    const count = 5000;
    const values = new BigInt64Array(count);
    let current = 12_345_678n;
    for (let index = 0; index < count; index += 1) {
      current += BigInt(index % 7);
      values[index] = current;
    }
    assertInt64Equal(decodeInt64Values(encodeInt64Values(values, count), count), [...values]);
  });
});

/* ------------------------------------------------------------------ bool */

describe('codecId 6：bool RLE 位压缩', () => {
  it('恒定值 1 万点：整块仅 3 字节', () => {
    const count = 10_000;
    const values = new Uint8Array(count).fill(1);
    const payload = encodeBoolValues(values, count);
    assert.equal(payload.length, 3, `恒定 bool 应为 1 + varint 游程，实际 ${payload.length} 字节`);
    assertBoolEqual(decodeBoolValues(payload, count), [...values]);
  });

  it('恒定 false 与交替翻转往返一致', () => {
    const constantFalse = new Uint8Array(1000);
    assert.equal(encodeBoolValues(constantFalse, 1000).length, 3);
    assertBoolEqual(decodeBoolValues(encodeBoolValues(constantFalse, 1000), 1000), [...constantFalse]);

    const alternating = new Uint8Array(1000);
    for (let index = 0; index < 1000; index += 1) alternating[index] = index % 2;
    const alternatingPayload = encodeBoolValues(alternating, 1000);
    assertBoolEqual(decodeBoolValues(alternatingPayload, 1000), [...alternating]);
  });

  it('报警式稀疏跳变（长段稳定 + 偶发脉冲）往返一致', () => {
    const count = 4096;
    const random = createRandom(0x77);
    const values = new Uint8Array(count);
    let current = 0;
    for (let index = 0; index < count; index += 1) {
      if (random() < 0.01) current = current ? 0 : 1;
      values[index] = current;
    }
    const payload = encodeBoolValues(values, count);
    assertBoolEqual(decodeBoolValues(payload, count), [...values]);
    assert.ok(payload.length < count / 4, `稀疏跳变应显著优于 1 字节/点，实际 ${payload.length} 字节`);
  });

  it('游程非法（0 游程 / 游程越界）抛 E_CORRUPT_BLOCK', () => {
    // [首值=1][游程=0] → 游程必须为正
    assert.equal(
      captureRtdbError(() => decodeBoolValues(new Uint8Array([1, 0]), 2)).code,
      ERROR_CODE.CorruptBlock,
    );
    // [首值=1][游程=5] 但块内只有 2 点 → 游程越界
    assert.equal(
      captureRtdbError(() => decodeBoolValues(new Uint8Array([1, 5]), 2)).code,
      ERROR_CODE.CorruptBlock,
    );
  });
});

/* ---------------------------------------------------------------- string */

describe('codecId 7：string 字典编码', () => {
  it('低基数状态字（3 种取值 × 1000 点）：字典模式且压缩 > 5×', () => {
    const count = 1000;
    const states = ['running', 'stopped', 'faulted'];
    const values: string[] = [];
    let byteBaseline = 0;
    for (let index = 0; index < count; index += 1) {
      const value = states[index % states.length];
      values.push(value);
      byteBaseline += Buffer.byteLength(value, 'utf8');
    }
    const payload = encodeStringValues(values, count);
    assert.equal(payload[0], STRING_ENCODING_MODE.dictionary, '低基数应命中字典模式');
    assertStringEqual(decodeStringValues(payload, count), values);
    assert.ok(
      byteBaseline / payload.length > 5,
      `压缩率应 > 5×，实际 ${(byteBaseline / payload.length).toFixed(1)}×`,
    );
  });

  it('全唯一长字符串（哈希/序列号）退化为直存模式且往返一致', () => {
    const count = 500;
    const values: string[] = [];
    for (let index = 0; index < count; index += 1) {
      values.push(`sn-${index.toString(36)}-${(index * 2654435761).toString(16).padStart(8, '0')}`);
    }
    const payload = encodeStringValues(values, count);
    assert.equal(payload[0], STRING_ENCODING_MODE.direct, '全唯一值应退化为直存模式');
    assertStringEqual(decodeStringValues(payload, count), values);
  });

  it('中文与 emoji 多字节 UTF-8 往返一致', () => {
    const values = ['运行', '停止', '故障', '⚠️告警', '', '运行'];
    const payload = encodeStringValues(values, values.length);
    assertStringEqual(decodeStringValues(payload, values.length), values);
  });

  it('空串与超长值（256 字节上限）往返一致', () => {
    const longValue = 'x'.repeat(256);
    const values = ['', longValue, 'a', '', longValue];
    const payload = encodeStringValues(values, values.length);
    assertStringEqual(decodeStringValues(payload, values.length), values);
  });

  it('字典索引越界与非法模式抛 E_CORRUPT_BLOCK', () => {
    // 手工构造：字典只有 1 项，索引写入 5 → 越界
    const badIndexPayload = new Uint8Array([STRING_ENCODING_MODE.dictionary, 0x01, 0x01, 0x61, 0x05]);
    assert.equal(
      captureRtdbError(() => decodeStringValues(badIndexPayload, 1)).code,
      ERROR_CODE.CorruptBlock,
    );

    const badMode = new Uint8Array([9, 1, 2, 3]);
    assert.equal(captureRtdbError(() => decodeStringValues(badMode, 1)).code, ERROR_CODE.CorruptBlock);
  });
});

/* ------------------------------------------------------- raw 与 zlib 包装 */

describe('codecId 0：raw 兜底', () => {
  it('四值类型直存往返一致且长度符合定义', () => {
    const floatValues = new Float64Array([1.5, -2.25, 0]);
    const floatPayload = encodeRawValues(ValueType.Float64, floatValues, 3);
    assert.equal(floatPayload.length, 24);
    assertFloat64BitExact(decodeRawValues(ValueType.Float64, floatPayload, 3) as Float64Array, floatValues);

    const intValues = BigInt64Array.from([1n, -1n, 9_007_199_254_740_991n]);
    const intPayload = encodeRawValues(ValueType.Int64, intValues, 3);
    assert.equal(intPayload.length, 24);
    assertInt64Equal(decodeRawValues(ValueType.Int64, intPayload, 3) as BigInt64Array, [...intValues]);

    const boolValues = new Uint8Array([1, 0, 1]);
    const boolPayload = encodeRawValues(ValueType.Bool, boolValues, 3);
    assert.equal(boolPayload.length, 3);
    assertBoolEqual(decodeRawValues(ValueType.Bool, boolPayload, 3) as Uint8Array, [...boolValues]);

    const stringValues = ['a', 'bb', 'ccc'];
    const stringPayload = encodeRawValues(ValueType.String, stringValues, 3);
    assertStringEqual(
      decodeRawValues(ValueType.String, stringPayload, 3) as string[],
      stringValues,
    );
  });

  it('空载荷与 0 点往返一致', () => {
    assert.equal(encodeRawValues(ValueType.Float64, new Float64Array(0), 0).length, 0);
    assert.equal((decodeRawValues(ValueType.String, new Uint8Array(0), 0) as string[]).length, 0);
  });
});

describe('codecId 4：zlib 整块包装', () => {
  it('包装/解包往返一致并保留内层 codecId', () => {
    const inner = encodeFloat64Values(new Float64Array([1, 2, 3, 4]), 4);
    const wrapped = wrapWithZlib(CODEC_ID.gorillaXor, inner);
    const unwrapped = unwrapZlib(wrapped);
    assert.equal(unwrapped.innerCodecId, CODEC_ID.gorillaXor);
    assert.deepEqual([...unwrapped.payload], [...inner]);
  });

  it('包装块可经 decodeValues 直接解码', () => {
    const values = new Float64Array([10.5, 10.5, 20.25, 20.25, 0, -0]);
    const payload = encodeValuesWithCodec(CODEC_ID.zlibWrap, ValueType.Float64, values, values.length);
    assert.equal(payload[0], CODEC_ID.gorillaXor, '内层应记录为 Gorilla');
    assertFloat64BitExact(
      decodeValues(ValueType.Float64, CODEC_ID.zlibWrap, payload, values.length) as Float64Array,
      values,
    );
  });

  it('损坏载荷与过短载荷抛 E_CORRUPT_BLOCK', () => {
    assert.equal(captureRtdbError(() => unwrapZlib(new Uint8Array([1]))).code, ERROR_CODE.CorruptBlock);
    assert.equal(
      captureRtdbError(() => unwrapZlib(new Uint8Array([1, 2, 3, 4, 5]))).code,
      ERROR_CODE.CorruptBlock,
    );
  });
});

/* -------------------------------------------------------------- 注册表择优 */

describe('registry：编码择优与解码分派', () => {
  it('典型工况择优结果均为候选最小体积，且低熵块由专用编码或 zlib 包装胜出', () => {
    const count = 1024;

    const floatConstant = new Float64Array(count).fill(1.25);
    assertOptimalSelection(ValueType.Float64, floatConstant, count);

    const intConstant = new BigInt64Array(count);
    for (let index = 0; index < count; index += 1) intConstant[index] = BigInt(index);
    assertOptimalSelection(ValueType.Int64, intConstant, count);

    // bool 恒定：专用编码整块仅 3 字节，zlib 包装无法更小，故必然选中 6
    const boolConstant = new Uint8Array(count).fill(1);
    assert.equal(
      assertOptimalSelection(ValueType.Bool, boolConstant, count),
      CODEC_ID.boolRle,
      '恒定量测点应命中 bool RLE 专用编码',
    );

    const stringLowCardinality = new Array<string>(count).fill('running');
    assertOptimalSelection(ValueType.String, stringLowCardinality, count);
  });

  it('高熵数据回退：随机 f64 仍优于 raw，且不劣于任何候选', () => {
    const count = 4096;
    const random = createRandom(0xc0ffee);
    const values = new Float64Array(count);
    for (let index = 0; index < count; index += 1) values[index] = random() * 100;
    assertOptimalSelection(ValueType.Float64, values, count);
  });

  it('四值类型经 encodeValues → decodeValues 往返一致', () => {
    const count = 2000;
    const random = createRandom(0x9e37);

    const floatValues = new Float64Array(count);
    for (let index = 0; index < count; index += 1) floatValues[index] = (random() - 0.5) * 1000;
    const floatEncoded = encodeValues(ValueType.Float64, floatValues, count);
    assertFloat64BitExact(
      decodeValues(ValueType.Float64, floatEncoded.codecId, floatEncoded.payload, count) as Float64Array,
      floatValues,
    );

    const intValues = new BigInt64Array(count);
    let intCursor = 1n;
    for (let index = 0; index < count; index += 1) {
      intCursor += BigInt(Math.floor(random() * 100));
      intValues[index] = intCursor;
    }
    const intEncoded = encodeValues(ValueType.Int64, intValues, count);
    assertInt64Equal(
      decodeValues(ValueType.Int64, intEncoded.codecId, intEncoded.payload, count) as BigInt64Array,
      [...intValues],
    );

    const boolValues = new Uint8Array(count);
    let boolCursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (random() < 0.5) boolCursor = boolCursor ? 0 : 1;
      boolValues[index] = boolCursor;
    }
    const boolEncoded = encodeValues(ValueType.Bool, boolValues, count);
    assertBoolEqual(
      decodeValues(ValueType.Bool, boolEncoded.codecId, boolEncoded.payload, count) as Uint8Array,
      [...boolValues],
    );

    const states = ['idle', 'heating', 'holding', 'cooling', 'fault'];
    const stringValues: string[] = [];
    for (let index = 0; index < count; index += 1) {
      stringValues.push(states[Math.floor(random() * 4)]);
    }
    const stringEncoded = encodeValues(ValueType.String, stringValues, count);
    assertStringEqual(
      decodeValues(ValueType.String, stringEncoded.codecId, stringEncoded.payload, count) as string[],
      stringValues,
    );
  });

  it('0 点编码不产生非空载荷且可解码', () => {
    const encoded = encodeValues(ValueType.Float64, new Float64Array(0), 0);
    assert.equal(encoded.payload.length, 0);
    assert.equal(encoded.uncompressedSize, 0);
    assert.equal(
      (decodeValues(ValueType.Float64, encoded.codecId, encoded.payload, 0) as Float64Array).length,
      0,
    );
  });

  it('codecId 与值类型不匹配时抛 E_CORRUPT_BLOCK（格式自描述校验）', () => {
    const floatValues = new Float64Array([1, 2, 3]);
    const floatPayload = encodeFloat64Values(floatValues, 3);
    assert.equal(
      captureRtdbError(() => decodeValues(ValueType.Float64, CODEC_ID.int64Delta, floatPayload, 3)).code,
      ERROR_CODE.CorruptBlock,
    );
    assert.equal(
      captureRtdbError(() => decodeValues(ValueType.Bool, CODEC_ID.gorillaXor, floatPayload, 3)).code,
      ERROR_CODE.CorruptBlock,
    );
    assert.equal(
      captureRtdbError(() => decodeValues(ValueType.String, CODEC_ID.boolRle, floatPayload, 3)).code,
      ERROR_CODE.CorruptBlock,
    );
  });

  it('encodeValuesWithCodec 显式 codecId 与类型不符时抛 E_INTERNAL', () => {
    const intValues = BigInt64Array.from([1n, 2n, 3n]);
    assert.equal(
      captureRtdbError(() =>
        encodeValuesWithCodec(CODEC_ID.gorillaXor, ValueType.Int64, intValues, 3),
      ).code,
      ERROR_CODE.Internal,
    );
  });

  it('未知值类型抛 E_INTERNAL', () => {
    const bogusType = 99 as ValueType;
    assert.equal(
      captureRtdbError(() => encodeValues(bogusType, new Float64Array([1]), 1)).code,
      ERROR_CODE.Internal,
    );
  });
});
