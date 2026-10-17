// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Variable-length integers (LEB128) + byte-stream read/write cursor
 *
 * - unsigned uses LEB128 (7 significant bits per byte, the highest bit is the continuation flag)
 * - signed uses ZigZag mapping then unsigned encoding (the number path is exact when |value| <= 2^52-1, otherwise it uses BigInt)
 * - i64 uses the BigInt path to avoid precision loss for intermediate values above 2^53
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';

/** ZigZag: signed -> unsigned (number path, valid within +/-2^52) */
export function encodeZigZagNumber(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

export function decodeZigZagNumber(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

export function encodeZigZagBigint(value: bigint): bigint {
  return value >= 0n ? value * 2n : -value * 2n - 1n;
}

export function decodeZigZagBigint(value: bigint): bigint {
  return value % 2n === 0n ? value / 2n : -(value + 1n) / 2n;
}

const MIN_CAPACITY_BYTES = 32;
const GROWTH_FACTOR = 2;

export class ByteWriter {
  private buffer: Uint8Array;
  private used = 0;

  constructor(initialCapacityBytes = 64) {
    this.buffer = new Uint8Array(Math.max(MIN_CAPACITY_BYTES, initialCapacityBytes));
  }

  /** Number of bytes written */
  get size(): number {
    return this.used;
  }

  writeByte(value: number): void {
    this.ensureCapacity(1);
    this.buffer[this.used] = value;
    this.used += 1;
  }

  writeBytes(source: Uint8Array): void {
    this.ensureCapacity(source.length);
    this.buffer.set(source, this.used);
    this.used += source.length;
  }

  /** LEB128 unsigned (0 ~ 2^53-1) */
  writeUnsignedVarint(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new RtdbError(
        ERROR_CODE.Internal,
        `writeUnsignedVarint value is outside the safe integer range: ${value}`,
      );
    }
    let remainder = value;
    while (remainder >= 0x80) {
      this.writeByte((remainder % 0x80) | 0x80);
      remainder = Math.floor(remainder / 0x80);
    }
    this.writeByte(remainder);
  }

  /** LEB128 signed (ZigZag mapping, |value| <= 2^52-1) */
  writeSignedVarint(value: number): void {
    this.writeUnsignedVarint(encodeZigZagNumber(value));
  }

  writeUnsignedVarintBigint(value: bigint): void {
    if (value < 0n) {
      throw new RtdbError(ERROR_CODE.Internal, `writeUnsignedVarintBigint does not accept negative values: ${value}`);
    }
    let remainder = value;
    while (remainder >= 0x80n) {
      this.writeByte(Number(remainder & 0x7fn) | 0x80);
      remainder >>= 7n;
    }
    this.writeByte(Number(remainder));
  }

  writeSignedVarintBigint(value: bigint): void {
    this.writeUnsignedVarintBigint(encodeZigZagBigint(value));
  }

  /** IEEE754 double precision, little-endian 8 bytes */
  writeFloat64LittleEndian(value: number): void {
    this.ensureCapacity(8);
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.used, 8);
    view.setFloat64(0, value, true);
    this.used += 8;
  }

  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.used);
  }

  private ensureCapacity(extraBytes: number): void {
    const required = this.used + extraBytes;
    if (required <= this.buffer.length) return;
    let nextCapacity = this.buffer.length * GROWTH_FACTOR;
    while (nextCapacity < required) nextCapacity *= GROWTH_FACTOR;
    const next = new Uint8Array(nextCapacity);
    next.set(this.buffer.subarray(0, this.used));
    this.buffer = next;
  }
}

export class ByteReader {
  readonly buffer: Uint8Array;
  private cursor = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  get offset(): number {
    return this.cursor;
  }

  get remainingBytes(): number {
    return this.buffer.length - this.cursor;
  }

  readByte(): number {
    if (this.cursor >= this.buffer.length) {
      throw new RtdbError(
        ERROR_CODE.CorruptSegment,
        `read out of bounds: offset=${this.cursor}, length=${this.buffer.length}`,
      );
    }
    const value = this.buffer[this.cursor];
    this.cursor += 1;
    return value;
  }

  readBytes(length: number): Uint8Array {
    if (length < 0 || this.cursor + length > this.buffer.length) {
      throw new RtdbError(
        ERROR_CODE.CorruptSegment,
        `read out of bounds: need ${length} bytes, offset=${this.cursor}, length=${this.buffer.length}`,
      );
    }
    const slice = this.buffer.subarray(this.cursor, this.cursor + length);
    this.cursor += length;
    return slice;
  }

  readUnsignedVarint(): number {
    let result = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.readByte();
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return result;
      multiplier *= 0x80;
    }
    throw new RtdbError(ERROR_CODE.CorruptSegment, 'unsigned variable-length integer exceeds 8 bytes');
  }

  readSignedVarint(): number {
    return decodeZigZagNumber(this.readUnsignedVarint());
  }

  readUnsignedVarintBigint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.readByte();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new RtdbError(ERROR_CODE.CorruptSegment, 'unsigned variable-length integer (BigInt) exceeds 10 bytes');
  }

  readSignedVarintBigint(): bigint {
    return decodeZigZagBigint(this.readUnsignedVarintBigint());
  }

  readFloat64LittleEndian(): number {
    if (this.cursor + 8 > this.buffer.length) {
      throw new RtdbError(ERROR_CODE.CorruptSegment, 'read float64 out of bounds');
    }
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.cursor, 8);
    const value = view.getFloat64(0, true);
    this.cursor += 8;
    return value;
  }
}
