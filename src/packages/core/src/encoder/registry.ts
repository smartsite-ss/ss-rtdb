// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Encoder registry (detailed design §2.4)
 *
 * codecId is fixed into the format and **must not be reused or reordered**:
 *   0 = raw (fallback)        1 = delta-of-delta + varint (ts)   2 = Gorilla XOR (f64)
 *   3 = RLE (reserved)        4 = zlib whole-block wrapper                    5 = i64 delta + varint
 *   6 = bool RLE bit packing    7 = string dictionary encoding
 *
 * encodeValues automatically picks the best option: the smallest among specialized / specialized+zlib / raw / raw+zlib (ties favor specialized).
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';
import { ValueType } from '../types.ts';
import { BOOL_CODEC_ID, decodeBoolValues, encodeBoolValues } from './bool-codec.ts';
import { FLOAT64_CODEC_ID, decodeFloat64Values, encodeFloat64Values } from './gorilla-codec.ts';
import { INT64_CODEC_ID, decodeInt64Values, encodeInt64Values } from './int64-codec.ts';
import { RAW_CODEC_ID, decodeRawValues, encodeRawValues } from './raw-codec.ts';
import { STRING_CODEC_ID, decodeStringValues, encodeStringValues } from './string-codec.ts';
import {
  TIMESTAMP_CODEC_ID,
  decodeTimestamps,
  encodeTimestamps,
} from './timestamp-codec.ts';
import { ZLIB_WRAP_CODEC_ID, unwrapZlib, wrapWithZlib } from './zlib-wrap.ts';
import type { DecodedValues, EncodableValues } from './values.ts';

export const CODEC_ID = {
  raw: RAW_CODEC_ID,
  timestampDeltaOfDelta: TIMESTAMP_CODEC_ID,
  gorillaXor: FLOAT64_CODEC_ID,
  /** codecId 3 is reserved for generic RLE, currently unused (fixed format, must not be reused) */
  genericRleReserved: 3,
  zlibWrap: ZLIB_WRAP_CODEC_ID,
  int64Delta: INT64_CODEC_ID,
  boolRle: BOOL_CODEC_ID,
  stringDictionary: STRING_CODEC_ID,
} as const;

/** Encoding result: codecId goes into the block header; uncompressedSize is used for compression-ratio stats and block-level selection */
export interface EncodedValues {
  codecId: number;
  payload: Uint8Array;
  uncompressedSize: number;
}

interface CodecCandidate {
  codecId: number;
  payload: Uint8Array;
}

function encodeSpecialized(
  valueType: ValueType,
  values: EncodableValues,
  count: number,
): CodecCandidate {
  switch (valueType) {
    case ValueType.Float64:
      return { codecId: FLOAT64_CODEC_ID, payload: encodeFloat64Values(values, count) };
    case ValueType.Int64:
      return { codecId: INT64_CODEC_ID, payload: encodeInt64Values(values, count) };
    case ValueType.Bool:
      return { codecId: BOOL_CODEC_ID, payload: encodeBoolValues(values, count) };
    case ValueType.String:
      return { codecId: STRING_CODEC_ID, payload: encodeStringValues(values, count) };
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Unknown value type: ${String(valueType)}`);
  }
}

/** Selection rank: specialized encoding first, then zlib wrapper, and raw last */
function selectionRank(codecId: number): number {
  if (codecId === RAW_CODEC_ID) return 2;
  if (codecId === ZLIB_WRAP_CODEC_ID) return 1;
  return 0;
}

/** Automatically select the best encoding (including a zlib attempt and comparison against the raw fallback) */
export function encodeValues(
  valueType: ValueType,
  values: EncodableValues,
  count: number,
): EncodedValues {
  const rawPayload = encodeRawValues(valueType, values, count);
  const specialized = encodeSpecialized(valueType, values, count);

  const candidates: CodecCandidate[] = [specialized];
  if (specialized.codecId !== RAW_CODEC_ID) {
    candidates.push({ codecId: RAW_CODEC_ID, payload: rawPayload });
  }

  const baseCandidates = [...candidates];
  for (const candidate of baseCandidates) {
    const wrappedPayload = wrapWithZlib(candidate.codecId, candidate.payload);
    if (wrappedPayload.length < candidate.payload.length) {
      candidates.push({ codecId: ZLIB_WRAP_CODEC_ID, payload: wrappedPayload });
    }
  }

  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.payload.length < best.payload.length) {
      best = candidate;
    } else if (
      candidate.payload.length === best.payload.length &&
      selectionRank(candidate.codecId) < selectionRank(best.codecId)
    ) {
      best = candidate;
    }
  }

  return {
    codecId: best.codecId,
    payload: best.payload,
    uncompressedSize: rawPayload.length,
  };
}

/** Encode with an explicit codecId (used for benchmark comparison and unit tests) */
export function encodeValuesWithCodec(
  codecId: number,
  valueType: ValueType,
  values: EncodableValues,
  count: number,
): Uint8Array {
  if (codecId === ZLIB_WRAP_CODEC_ID) {
    const inner = encodeSpecialized(valueType, values, count);
    return wrapWithZlib(inner.codecId, inner.payload);
  }
  if (codecId === RAW_CODEC_ID) return encodeRawValues(valueType, values, count);
  const specialized = encodeSpecialized(valueType, values, count);
  if (specialized.codecId !== codecId) {
    throw new RtdbError(
      ERROR_CODE.Internal,
      `explicit codecId=${codecId} does not match the specialized encoding ${specialized.codecId} for value type ${String(valueType)}`,
    );
  }
  return specialized.payload;
}

/** Decode by codecId (automatically unwraps zlib) */
export function decodeValues(
  valueType: ValueType,
  codecId: number,
  payload: Uint8Array,
  count: number,
): DecodedValues {
  if (codecId === ZLIB_WRAP_CODEC_ID) {
    const unwrapped = unwrapZlib(payload);
    return decodeValues(valueType, unwrapped.innerCodecId, unwrapped.payload, count);
  }
  switch (valueType) {
    case ValueType.Float64:
      if (codecId !== FLOAT64_CODEC_ID && codecId !== RAW_CODEC_ID) {
        throw new RtdbError(ERROR_CODE.CorruptBlock, `f64 block has invalid codecId: ${codecId}`);
      }
      return codecId === RAW_CODEC_ID
        ? decodeRawValues(valueType, payload, count)
        : decodeFloat64Values(payload, count);
    case ValueType.Int64:
      if (codecId !== INT64_CODEC_ID && codecId !== RAW_CODEC_ID) {
        throw new RtdbError(ERROR_CODE.CorruptBlock, `i64 block has invalid codecId: ${codecId}`);
      }
      return codecId === RAW_CODEC_ID
        ? (decodeRawValues(valueType, payload, count) as BigInt64Array)
        : decodeInt64Values(payload, count);
    case ValueType.Bool:
      if (codecId !== BOOL_CODEC_ID && codecId !== RAW_CODEC_ID) {
        throw new RtdbError(ERROR_CODE.CorruptBlock, `bool block has invalid codecId: ${codecId}`);
      }
      return codecId === RAW_CODEC_ID
        ? (decodeRawValues(valueType, payload, count) as Uint8Array)
        : decodeBoolValues(payload, count);
    case ValueType.String:
      if (codecId !== STRING_CODEC_ID && codecId !== RAW_CODEC_ID) {
        throw new RtdbError(ERROR_CODE.CorruptBlock, `string block has invalid codecId: ${codecId}`);
      }
      return codecId === RAW_CODEC_ID
        ? (decodeRawValues(valueType, payload, count) as string[])
        : decodeStringValues(payload, count);
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Unknown value type: ${String(valueType)}`);
  }
}

/** Timestamp encoding/decoding (codecId 1, shared within a block) */
export { decodeTimestamps, encodeTimestamps, TIMESTAMP_CODEC_ID };

export type { DecodedValues, EncodableValues };
