// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Bit-level read/write (MSB-first: higher bits within a byte are written/read first)
 *
 * Used by Gorilla XOR float encoding: the bit stream length is not byte-aligned, and trailing bits of an incomplete byte are zero-padded.
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';

const BITS_PER_BYTE = 8;

export class BitWriter {
  private buffer: Uint8Array;
  private bitLength = 0;

  constructor(initialCapacityBytes = 64) {
    this.buffer = new Uint8Array(Math.max(BITS_PER_BYTE, initialCapacityBytes));
  }

  get lengthInBits(): number {
    return this.bitLength;
  }

  get lengthInBytes(): number {
    return Math.ceil(this.bitLength / BITS_PER_BYTE);
  }

  writeBit(bit: number): void {
    const byteIndex = this.bitLength >> 3;
    const bitInByte = this.bitLength & 7;
    if (byteIndex >= this.buffer.length) this.grow(byteIndex + 1);
    if (bit !== 0) {
      this.buffer[byteIndex] |= 1 << (7 - bitInByte);
    }
    this.bitLength += 1;
  }

  /** Write bitCount bits (MSB-first); value must be non-negative and < 2^bitCount */
  writeBits(value: number, bitCount: number): void {
    for (let index = bitCount - 1; index >= 0; index -= 1) {
      this.writeBit(Math.floor(value / 2 ** index) % 2);
    }
  }

  /** Write bitCount bits (BigInt variant, up to 64 bits) */
  writeBitsBigint(value: bigint, bitCount: number): void {
    if (value < 0n) {
      throw new RtdbError(ERROR_CODE.Internal, `writeBitsBigint does not accept negative values: ${value}`);
    }
    for (let index = bitCount - 1; index >= 0; index -= 1) {
      this.writeBit(Number((value >> BigInt(index)) & 1n));
    }
  }

  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.lengthInBytes);
  }

  private grow(minCapacityBytes: number): void {
    let nextCapacity = this.buffer.length * 2;
    while (nextCapacity < minCapacityBytes) nextCapacity *= 2;
    const next = new Uint8Array(nextCapacity);
    next.set(this.buffer.subarray(0, this.lengthInBytes));
    this.buffer = next;
  }
}

export class BitReader {
  readonly buffer: Uint8Array;
  private bitPosition = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  get positionInBits(): number {
    return this.bitPosition;
  }

  readBit(): number {
    const byteIndex = this.bitPosition >> 3;
    if (byteIndex >= this.buffer.length) {
      throw new RtdbError(ERROR_CODE.CorruptBlock, 'Bit stream read out of bounds (insufficient bit stream length)');
    }
    const bitInByte = this.bitPosition & 7;
    this.bitPosition += 1;
    return (this.buffer[byteIndex] >> (7 - bitInByte)) & 1;
  }

  readBits(bitCount: number): number {
    let value = 0;
    for (let index = 0; index < bitCount; index += 1) {
      value = value * 2 + this.readBit();
    }
    return value;
  }

  readBitsBigint(bitCount: number): bigint {
    let value = 0n;
    for (let index = 0; index < bitCount; index += 1) {
      value = (value << 1n) | BigInt(this.readBit());
    }
    return value;
  }
}
