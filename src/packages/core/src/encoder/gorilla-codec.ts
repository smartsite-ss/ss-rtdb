// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * f64 value encoding (codecId 2): Gorilla XOR
 *
 * Bit layout (MSB-first):
 *   first value: 64-bit raw bit pattern
 *   each subsequent point: 1 flag bit (xor==0 -> 0, repeated value uses only 1 bit) + control bit:
 *     0 -> reuse the previous window (prevLeading/prevTrailing unchanged), write prevBlockSize bits of the xor significand
 *     1 -> new window: 5 bits leading zeros (clamped to a maximum of 31) + 6 bits (significand length - 1) + significand
 *
 * Clamping leading zeros to 31 is safe: clamping only happens when the highest significant bit falls within the low 32 bits,
 * where trailing <= 31 and significand length = 64-31-trailing >= 2, so the window still fully covers the xor significand.
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';
import { BitReader, BitWriter } from './bit-stream.ts';
import { normalizeFloat64Values, type EncodableValues } from './values.ts';

export const FLOAT64_CODEC_ID = 2;

const BITS_PER_VALUE = 64;
const LEADING_ZERO_BITS = 5;
const SIGNIFICAND_LENGTH_BITS = 6;
const LEADING_ZERO_UP_LIMIT = 31;
const NO_WINDOW = 0xffffffff;

const BIT_VIEW = new DataView(new ArrayBuffer(8));

function toBits(value: number): bigint {
  BIT_VIEW.setFloat64(0, value, false);
  return BIT_VIEW.getBigUint64(0, false);
}

function fromBits(bits: bigint): number {
  BIT_VIEW.setBigUint64(0, bits, false);
  return BIT_VIEW.getFloat64(0, false);
}

/** Count leading zeros (64-bit) */
function countLeadingZeros(bits: bigint): number {
  const high = Number(bits >> 32n) >>> 0;
  if (high !== 0) return Math.clz32(high);
  const low = Number(bits & 0xffffffffn) >>> 0;
  return low === 0 ? BITS_PER_VALUE : 32 + Math.clz32(low);
}

/** Count trailing zeros (64-bit) */
function countTrailingZeros(bits: bigint): number {
  const low = Number(bits & 0xffffffffn) >>> 0;
  if (low !== 0) return 31 - Math.clz32(low & -low);
  const high = Number(bits >> 32n) >>> 0;
  return high === 0 ? BITS_PER_VALUE : 32 + (31 - Math.clz32(high & -high));
}

function maskBits(bitCount: number): bigint {
  return (1n << BigInt(bitCount)) - 1n;
}

export function encodeFloat64Values(values: EncodableValues, count: number): Uint8Array {
  const source = normalizeFloat64Values(values, count);
  if (count <= 0) return new Uint8Array(0);
  if (source.length < count) {
    throw new RtdbError(ERROR_CODE.Internal, `Gorilla encode has insufficient point data: count=${count}`);
  }

  const writer = new BitWriter(count * 2 + 16);
  let previous = toBits(source[0]);
  writer.writeBitsBigint(previous, BITS_PER_VALUE);

  let windowLeading = NO_WINDOW;
  let windowTrailing = 0;

  for (let index = 1; index < count; index += 1) {
    const current = toBits(source[index]);
    const xor = previous ^ current;
    previous = current;

    if (xor === 0n) {
      writer.writeBit(0);
      continue;
    }
    writer.writeBit(1);

    let leading = countLeadingZeros(xor);
    const trailing = countTrailingZeros(xor);
    if (leading > LEADING_ZERO_UP_LIMIT) leading = LEADING_ZERO_UP_LIMIT;

    if (windowLeading !== NO_WINDOW && leading >= windowLeading && trailing >= windowTrailing) {
      writer.writeBit(0);
      const blockSize = BITS_PER_VALUE - windowLeading - windowTrailing;
      writer.writeBitsBigint((xor >> BigInt(windowTrailing)) & maskBits(blockSize), blockSize);
      continue;
    }

    writer.writeBit(1);
    const blockSize = BITS_PER_VALUE - leading - trailing;
    if (blockSize < 1 || blockSize > BITS_PER_VALUE) {
      throw new RtdbError(ERROR_CODE.Internal, `Gorilla significand length is invalid: ${blockSize}`);
    }
    writer.writeBits(leading, LEADING_ZERO_BITS);
    writer.writeBits(blockSize - 1, SIGNIFICAND_LENGTH_BITS);
    writer.writeBitsBigint((xor >> BigInt(trailing)) & maskBits(blockSize), blockSize);
    windowLeading = leading;
    windowTrailing = trailing;
  }
  return writer.toUint8Array();
}

export function decodeFloat64Values(buffer: Uint8Array, count: number): Float64Array {
  const out = new Float64Array(count);
  if (count <= 0) return out;

  const reader = new BitReader(buffer);
  let previous = reader.readBitsBigint(BITS_PER_VALUE);
  out[0] = fromBits(previous);

  let windowLeading = NO_WINDOW;
  let windowTrailing = 0;

  for (let index = 1; index < count; index += 1) {
    if (reader.readBit() === 0) {
      out[index] = fromBits(previous);
      continue;
    }
    let xor: bigint;
    if (reader.readBit() === 0) {
      if (windowLeading === NO_WINDOW) {
        throw new RtdbError(ERROR_CODE.CorruptBlock, 'Gorilla bit stream references a previous window that has not been established');
      }
      const blockSize = BITS_PER_VALUE - windowLeading - windowTrailing;
      xor = reader.readBitsBigint(blockSize) << BigInt(windowTrailing);
    } else {
      windowLeading = reader.readBits(LEADING_ZERO_BITS);
      const blockSize = reader.readBits(SIGNIFICAND_LENGTH_BITS) + 1;
      windowTrailing = BITS_PER_VALUE - windowLeading - blockSize;
      xor = reader.readBitsBigint(blockSize) << BigInt(windowTrailing);
    }
    previous ^= xor;
    out[index] = fromBits(previous);
  }
  return out;
}
