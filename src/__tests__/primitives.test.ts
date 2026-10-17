// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * 编码基础原语单测（S1）：ZigZag、变长整数、字节流游标、位流
 *
 * 运行：node --test __tests__/primitives.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ERROR_CODE, RtdbError, isRtdbError } from '../packages/core/src/errors.ts';
import { BitReader, BitWriter } from '../packages/core/src/encoder/bit-stream.ts';
import {
  ByteReader,
  ByteWriter,
  decodeZigZagBigint,
  decodeZigZagNumber,
  encodeZigZagBigint,
  encodeZigZagNumber,
} from '../packages/core/src/encoder/varint.ts';

/** 捕获并断言为 RtdbError，便于进一步校验 code */
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

describe('ZigZag 映射', () => {
  const numberSamples = [
    0, 1, -1, 2, -2, 127, -128, 1024, -1024, 2 ** 31, -(2 ** 31), 2 ** 52, -(2 ** 52),
  ];

  it('number 路径往返一致且结果非负', () => {
    for (const value of numberSamples) {
      const encoded = encodeZigZagNumber(value);
      assert.ok(encoded >= 0, `ZigZag 结果应为非负：value=${value}`);
      assert.equal(decodeZigZagNumber(encoded), value, `往返失败：value=${value}`);
    }
  });

  it('number 路径经典映射（0→0、-1→1、1→2、-2→3）', () => {
    assert.equal(encodeZigZagNumber(0), 0);
    assert.equal(encodeZigZagNumber(-1), 1);
    assert.equal(encodeZigZagNumber(1), 2);
    assert.equal(encodeZigZagNumber(-2), 3);
  });

  it('BigInt 路径往返一致并覆盖 ±2^53 与 ±2^62', () => {
    const bigintSamples = [
      0n, 1n, -1n, 127n, -128n, 2n ** 52n, -(2n ** 52n), 2n ** 53n, -(2n ** 53n),
      2n ** 62n, -(2n ** 62n),
    ];
    for (const value of bigintSamples) {
      const encoded = encodeZigZagBigint(value);
      assert.ok(encoded >= 0n, `ZigZag(BigInt) 结果应为非负：value=${value}`);
      assert.equal(decodeZigZagBigint(encoded), value, `往返失败：value=${value}`);
    }
  });
});

describe('ByteWriter / ByteReader 变长整数', () => {
  const unsignedSamples = [
    0, 1, 127, 128, 129, 16_383, 16_384, 2 ** 21, 2 ** 31, 2 ** 42, Number.MAX_SAFE_INTEGER,
  ];

  it('无符号变长整数往返一致', () => {
    for (const value of unsignedSamples) {
      const writer = new ByteWriter();
      writer.writeUnsignedVarint(value);
      const reader = new ByteReader(writer.toUint8Array());
      assert.equal(reader.readUnsignedVarint(), value, `往返失败：value=${value}`);
      assert.equal(reader.remainingBytes, 0, `应恰好读完：value=${value}`);
    }
  });

  it('无符号变长整数字节数与 LEB128 定义一致', () => {
    const expectations: Array<[number, number]> = [
      [0, 1],
      [127, 1],
      [128, 2],
      [16_383, 2],
      [16_384, 3],
      [Number.MAX_SAFE_INTEGER, 8],
    ];
    for (const [value, expectedBytes] of expectations) {
      const writer = new ByteWriter();
      writer.writeUnsignedVarint(value);
      assert.equal(writer.size, expectedBytes, `字节数不符：value=${value}`);
    }
  });

  it('有符号变长整数往返一致（含负数与 ±(2^52-1) 边界）', () => {
    const maxSigned = 2 ** 52 - 1;
    const samples = [0, 1, -1, 63, -64, 65, -4096, 2 ** 31, -(2 ** 31), maxSigned, -maxSigned];
    for (const value of samples) {
      const writer = new ByteWriter();
      writer.writeSignedVarint(value);
      const reader = new ByteReader(writer.toUint8Array());
      assert.equal(reader.readSignedVarint(), value, `往返失败：value=${value}`);
    }
  });

  it('BigInt 变长整数往返一致（覆盖 ±2^53 / ±2^62）', () => {
    const samples = [
      0n, 1n, -1n, 127n, -128n, 2n ** 40n, -(2n ** 40n), 2n ** 53n, -(2n ** 53n),
      2n ** 62n, -(2n ** 62n),
    ];
    for (const value of samples) {
      const writer = new ByteWriter();
      writer.writeSignedVarintBigint(value);
      const reader = new ByteReader(writer.toUint8Array());
      assert.equal(reader.readSignedVarintBigint(), value, `往返失败：value=${value}`);
    }
  });

  it('writeUnsignedVarint 拒绝负数、小数与超安全整数', () => {
    const writer = new ByteWriter();
    assert.throws(() => writer.writeUnsignedVarint(-1), isRtdbError);
    assert.throws(() => writer.writeUnsignedVarint(1.5), isRtdbError);
    assert.throws(() => writer.writeUnsignedVarint(Number.MAX_SAFE_INTEGER + 1), isRtdbError);
  });

  it('writeUnsignedVarintBigint 拒绝负数', () => {
    const writer = new ByteWriter();
    assert.throws(() => writer.writeUnsignedVarintBigint(-1n), isRtdbError);
  });
});

describe('ByteWriter / ByteReader 字节与浮点', () => {
  it('writeByte / writeBytes / toUint8Array 保序', () => {
    const writer = new ByteWriter(8);
    writer.writeByte(0xab);
    writer.writeBytes(new Uint8Array([1, 2, 3]));
    assert.deepEqual([...writer.toUint8Array()], [0xab, 1, 2, 3]);
    assert.equal(writer.size, 4);
  });

  it('writeFloat64LittleEndian 往返一致（含 ±0 / NaN / ±Infinity / 极值）', () => {
    const samples = [
      0, -0, 1, -1, 3.141592653589793, 1e-300, 1e300, Number.MAX_VALUE, Number.MIN_VALUE,
      Number.EPSILON, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    ];
    for (const value of samples) {
      const writer = new ByteWriter();
      writer.writeFloat64LittleEndian(value);
      const reader = new ByteReader(writer.toUint8Array());
      const decoded = reader.readFloat64LittleEndian();
      if (Number.isNaN(value)) {
        assert.ok(Number.isNaN(decoded), 'NaN 应保持 NaN');
        continue;
      }
      if (Object.is(value, -0)) {
        assert.ok(Object.is(decoded, -0), '-0 应保持符号位');
        continue;
      }
      assert.equal(decoded, value, `往返失败：value=${value}`);
    }
  });

  it('float64 小端字节序正确（1.0 → 00 00 00 00 00 00 F0 3F）', () => {
    const writer = new ByteWriter();
    writer.writeFloat64LittleEndian(1);
    assert.deepEqual([...writer.toUint8Array()], [0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
  });

  it('容量增长后数据仍完整（跨越 2 倍扩容边界）', () => {
    const writer = new ByteWriter(8);
    for (let index = 0; index < 4096; index += 1) writer.writeUnsignedVarint(index);
    const reader = new ByteReader(writer.toUint8Array());
    for (let index = 0; index < 4096; index += 1) {
      assert.equal(reader.readUnsignedVarint(), index);
    }
    assert.equal(reader.remainingBytes, 0);
  });
});

describe('ByteReader 越界防护', () => {
  it('readByte / readBytes / readFloat64LittleEndian 越界抛 E_CORRUPT_SEGMENT', () => {
    const reader = new ByteReader(new Uint8Array([1, 2]));
    reader.readByte();
    reader.readByte();
    assert.equal(captureRtdbError(() => reader.readByte()).code, ERROR_CODE.CorruptSegment);

    const shortReader = new ByteReader(new Uint8Array([1, 2]));
    assert.equal(captureRtdbError(() => shortReader.readBytes(3)).code, ERROR_CODE.CorruptSegment);

    const tinyReader = new ByteReader(new Uint8Array([1]));
    assert.equal(
      captureRtdbError(() => tinyReader.readFloat64LittleEndian()).code,
      ERROR_CODE.CorruptSegment,
    );
  });

  it('变长整数超长（续写位一直为 1）抛错', () => {
    const reader = new ByteReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]));
    assert.equal(captureRtdbError(() => reader.readUnsignedVarint()).code, ERROR_CODE.CorruptSegment);
  });

  it('offset / remainingBytes 正确推进', () => {
    const reader = new ByteReader(new Uint8Array([1, 2, 3, 4]));
    assert.equal(reader.remainingBytes, 4);
    reader.readBytes(3);
    assert.equal(reader.offset, 3);
    assert.equal(reader.remainingBytes, 1);
  });
});

describe('BitWriter / BitReader（MSB-first）', () => {
  it('writeBit 单 bit 布局（高位先写）', () => {
    const writer = new BitWriter(1);
    writer.writeBit(1);
    for (let index = 0; index < 6; index += 1) writer.writeBit(0);
    writer.writeBit(1);
    assert.deepEqual([...writer.toUint8Array()], [0b10000001]);
    assert.equal(writer.lengthInBits, 8);
    assert.equal(writer.lengthInBytes, 1);
  });

  it('writeBits 跨字节往返一致（含非 8 倍数位长）', () => {
    const writer = new BitWriter(4);
    const samples: Array<[number, number]> = [
      [0b101, 3],
      [0b1, 1],
      [0b1111111, 7],
      [0, 5],
      [0b111111111111, 12],
      [0x7fffffff, 31],
    ];
    for (const [value, bitCount] of samples) writer.writeBits(value, bitCount);

    const reader = new BitReader(writer.toUint8Array());
    for (const [value, bitCount] of samples) {
      assert.equal(reader.readBits(bitCount), value, `往返失败：value=${value}, bits=${bitCount}`);
    }
    assert.equal(reader.positionInBits, writer.lengthInBits);
  });

  it('writeBitsBigint 64 位往返一致（含全 1 与最高位）', () => {
    const writer = new BitWriter(16);
    const samples: Array<[bigint, number]> = [
      [0xffffffffffffffffn, 64],
      [0x8000000000000000n, 64],
      [0n, 64],
      [0x123456789abcdefn, 60],
      [1n, 1],
    ];
    for (const [value, bitCount] of samples) writer.writeBitsBigint(value, bitCount);

    const reader = new BitReader(writer.toUint8Array());
    for (const [value, bitCount] of samples) {
      assert.equal(
        reader.readBitsBigint(bitCount),
        value,
        `往返失败：value=${value.toString(16)}, bits=${bitCount}`,
      );
    }
  });

  it('BitWriter 自动扩容后位流仍连续', () => {
    const writer = new BitWriter(1);
    const totalBits = 1000;
    for (let index = 0; index < totalBits; index += 1) writer.writeBit(index % 3 === 0 ? 1 : 0);
    const reader = new BitReader(writer.toUint8Array());
    for (let index = 0; index < totalBits; index += 1) {
      assert.equal(reader.readBit(), index % 3 === 0 ? 1 : 0, `位 ${index} 不符`);
    }
  });

  it('writeBitsBigint 拒绝负数；位流读取越界抛 E_CORRUPT_BLOCK', () => {
    assert.throws(() => new BitWriter().writeBitsBigint(-1n, 8), isRtdbError);
    const overflow = captureRtdbError(() => new BitReader(new Uint8Array([0])).readBits(9));
    assert.equal(overflow.code, ERROR_CODE.CorruptBlock);
  });
});
