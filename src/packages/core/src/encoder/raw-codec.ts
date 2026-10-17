// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Raw fallback encoding (codecId 0): store the four value types directly, no compression
 *
 * Purpose: the last-resort fallback when compression is unavailable or not worthwhile, and the generic fallback path for the decoder.
 *   f64 -> 8-byte little-endian; i64 -> 8-byte little-endian; bool -> 1 byte; string -> reuses the dictionary encoding layout (including the mode byte)
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';
import { ValueType } from '../types.ts';
import { ByteReader, ByteWriter } from './varint.ts';
import {
  normalizeBoolValues,
  normalizeFloat64Values,
  normalizeInt64Values,
  type DecodedValues,
  type EncodableValues,
} from './values.ts';
import { decodeStringValues, encodeStringValues } from './string-codec.ts';

export const RAW_CODEC_ID = 0;

export function encodeRawValues(
  valueType: ValueType,
  values: EncodableValues,
  count: number,
): Uint8Array {
  if (count <= 0) return new Uint8Array(0);

  switch (valueType) {
    case ValueType.Float64: {
      const source = normalizeFloat64Values(values, count);
      const writer = new ByteWriter(count * 8 + 8);
      for (let index = 0; index < count; index += 1) {
        writer.writeFloat64LittleEndian(source[index]);
      }
      return writer.toUint8Array();
    }
    case ValueType.Int64: {
      const source = normalizeInt64Values(values, count);
      const writer = new ByteWriter(count * 8 + 8);
      const view = new DataView(new ArrayBuffer(8));
      for (let index = 0; index < count; index += 1) {
        view.setBigInt64(0, source[index], true);
        for (let offset = 0; offset < 8; offset += 1) {
          writer.writeByte(view.getUint8(offset));
        }
      }
      return writer.toUint8Array();
    }
    case ValueType.Bool: {
      const source = normalizeBoolValues(values, count);
      const out = new Uint8Array(count);
      for (let index = 0; index < count; index += 1) out[index] = source[index] ? 1 : 0;
      return out;
    }
    case ValueType.String:
      return encodeStringValues(values, count);
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Raw encoding encountered an unknown value type: ${String(valueType)}`);
  }
}

export function decodeRawValues(
  valueType: ValueType,
  buffer: Uint8Array,
  count: number,
): DecodedValues {
  switch (valueType) {
    case ValueType.Float64: {
      const out = new Float64Array(count);
      const reader = new ByteReader(buffer);
      for (let index = 0; index < count; index += 1) {
        out[index] = reader.readFloat64LittleEndian();
      }
      return out;
    }
    case ValueType.Int64: {
      const out = new BigInt64Array(count);
      const reader = new ByteReader(buffer);
      for (let index = 0; index < count; index += 1) {
        let bits = 0n;
        for (let offset = 0; offset < 8; offset += 1) {
          bits |= BigInt(reader.readByte()) << BigInt(offset * 8);
        }
        const view = new DataView(new ArrayBuffer(8));
        view.setBigUint64(0, bits, true);
        out[index] = view.getBigInt64(0, true);
      }
      return out;
    }
    case ValueType.Bool: {
      const out = new Uint8Array(count);
      for (let index = 0; index < count; index += 1) out[index] = buffer[index] ? 1 : 0;
      return out;
    }
    case ValueType.String:
      return decodeStringValues(buffer, count);
    default:
      throw new RtdbError(ERROR_CODE.Internal, `Raw decoding encountered an unknown value type: ${String(valueType)}`);
  }
}
