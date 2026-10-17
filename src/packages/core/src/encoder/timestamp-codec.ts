// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Timestamp encoding (codecId 1): first value ZigZag varint + first-order delta + delta-of-delta varint
 *
 * A point with a constant sampling period has a delta-of-delta of always 0, stably landing at 1 byte per point;
 * timestamps within a block must be monotonically non-decreasing (strict monotonicity is guaranteed by the write path's (metric, ts) deduplication).
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';
import { ByteReader, ByteWriter } from './varint.ts';

export const TIMESTAMP_CODEC_ID = 1;

function requireMonotonic(timestamp: number, index: number, previous: number | null): number {
  if (!Number.isInteger(timestamp)) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, `timestamp must be an integer number of milliseconds: index=${index}, value=${timestamp}`);
  }
  if (previous !== null && timestamp < previous) {
    throw new RtdbError(
      ERROR_CODE.InvalidPoint,
      `timestamps within a block must be monotonically non-decreasing: index=${index}, previous=${previous}, value=${timestamp}`,
    );
  }
  return timestamp;
}

export function encodeTimestamps(timestamps: ArrayLike<number>, count: number): Uint8Array {
  const writer = new ByteWriter(count * 2 + 16);
  if (count <= 0) return writer.toUint8Array();

  let current = requireMonotonic(Number(timestamps[0]), 0, null);
  writer.writeSignedVarint(current);
  if (count === 1) return writer.toUint8Array();

  let previousDelta = requireMonotonic(Number(timestamps[1]), 1, current) - current;
  writer.writeSignedVarint(previousDelta);

  for (let index = 2; index < count; index += 1) {
    const next = requireMonotonic(Number(timestamps[index]), index, timestamps[index - 1]);
    const delta = next - timestamps[index - 1];
    writer.writeSignedVarint(delta - previousDelta);
    previousDelta = delta;
  }
  return writer.toUint8Array();
}

export function decodeTimestamps(buffer: Uint8Array, count: number): Float64Array {
  const out = new Float64Array(count);
  if (count <= 0) return out;

  const reader = new ByteReader(buffer);
  let current = reader.readSignedVarint();
  out[0] = current;
  if (count === 1) return out;

  let delta = reader.readSignedVarint();
  current += delta;
  out[1] = current;

  for (let index = 2; index < count; index += 1) {
    delta += reader.readSignedVarint();
    current += delta;
    out[index] = current;
  }
  return out;
}
