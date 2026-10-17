// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * i64 value encoding (codecId 5): first value ZigZag varint + first-order delta ZigZag varint
 *
 * All arithmetic uses BigInt to preserve precision at the +/-2^53 boundary and for intermediate deltas (the write path separately validates |v| <= 2^53).
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';
import { ByteReader, ByteWriter } from './varint.ts';
import { normalizeInt64Values, type EncodableValues } from './values.ts';

export const INT64_CODEC_ID = 5;

export function encodeInt64Values(values: EncodableValues, count: number): Uint8Array {
  const source = normalizeInt64Values(values, count);
  if (count <= 0) return new Uint8Array(0);
  if (source.length < count) {
    throw new RtdbError(ERROR_CODE.Internal, `i64 encode has insufficient point data: count=${count}`);
  }

  const writer = new ByteWriter(count * 2 + 16);
  let previous = source[0];
  writer.writeSignedVarintBigint(previous);

  for (let index = 1; index < count; index += 1) {
    const current = source[index];
    writer.writeSignedVarintBigint(current - previous);
    previous = current;
  }
  return writer.toUint8Array();
}

export function decodeInt64Values(buffer: Uint8Array, count: number): BigInt64Array {
  const out = new BigInt64Array(count);
  if (count <= 0) return out;

  const reader = new ByteReader(buffer);
  let current = reader.readSignedVarintBigint();
  out[0] = current;

  for (let index = 1; index < count; index += 1) {
    current += reader.readSignedVarintBigint();
    out[index] = current;
  }
  return out;
}
