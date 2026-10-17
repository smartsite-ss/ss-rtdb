// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Encodable value containers and normalization (detailed design §2.4 `EncodableValues`)
 *
 * The four types f64 / i64 / bool / string correspond respectively to
 * Float64Array / BigInt64Array / Uint8Array(0|1) / string[]
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';

/** Encoding input container (loose union, narrowed by the normalization functions) */
export type EncodableValues =
  | Float64Array
  | BigInt64Array
  | readonly number[]
  | Uint8Array
  | readonly string[];

/** Decoding output container */
export type DecodedValues = Float64Array | BigInt64Array | Uint8Array | string[];

export function normalizeFloat64Values(
  values: EncodableValues,
  count: number,
): Float64Array {
  if (values instanceof Float64Array) {
    return values.length === count ? values : values.subarray(0, count);
  }
  if (Array.isArray(values) || values instanceof Uint8Array) {
    const out = new Float64Array(count);
    for (let index = 0; index < count; index += 1) out[index] = Number(values[index]);
    return out;
  }
  throw new RtdbError(ERROR_CODE.Internal, 'normalizeFloat64Values: container type mismatch');
}

export function normalizeInt64Values(values: EncodableValues, count: number): BigInt64Array {
  if (values instanceof BigInt64Array) {
    return values.length === count ? values : values.subarray(0, count);
  }
  const out = new BigInt64Array(count);
  if (Array.isArray(values) || values instanceof Uint8Array || values instanceof Float64Array) {
    for (let index = 0; index < count; index += 1) {
      out[index] = BigInt(Math.trunc(Number(values[index])));
    }
    return out;
  }
  throw new RtdbError(ERROR_CODE.Internal, 'normalizeInt64Values: container type mismatch');
}

export function normalizeBoolValues(values: EncodableValues, count: number): Uint8Array {
  if (values instanceof Uint8Array) {
    return values.length === count ? values : values.subarray(0, count);
  }
  const out = new Uint8Array(count);
  if (Array.isArray(values) || values instanceof Float64Array) {
    for (let index = 0; index < count; index += 1) out[index] = Number(values[index]) ? 1 : 0;
    return out;
  }
  if (values instanceof BigInt64Array) {
    for (let index = 0; index < count; index += 1) out[index] = values[index] ? 1 : 0;
    return out;
  }
  throw new RtdbError(ERROR_CODE.Internal, 'normalizeBoolValues: container type mismatch');
}

export function normalizeStringValues(values: EncodableValues, count: number): string[] {
  if (Array.isArray(values)) {
    if (values.length >= count && typeof values[0] === 'string') {
      return values as string[];
    }
    const out: string[] = new Array(count);
    for (let index = 0; index < count; index += 1) out[index] = String(values[index]);
    return out;
  }
  throw new RtdbError(ERROR_CODE.Internal, 'normalizeStringValues: container type mismatch');
}
