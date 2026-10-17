// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * string value encoding (codecId 7): low-cardinality dictionary encoding + direct storage fallback for high cardinality / very long strings
 *
 * Layout: [mode u8] followed by
 *   - mode=0 dictionary: varint dictionary size + (varint byte length + UTF-8) x size + varint index x count
 *   - mode=1 direct: (varint byte length + UTF-8) x count
 *
 * Both layouts are computed at encode time and the smaller one is used (low-cardinality status words hit the dictionary; all-unique values automatically take the direct path).
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';
import { ByteReader, ByteWriter } from './varint.ts';
import { normalizeStringValues, type EncodableValues } from './values.ts';

export const STRING_CODEC_ID = 7;

export const STRING_ENCODING_MODE = {
  dictionary: 0,
  direct: 1,
} as const;
export type StringEncodingMode = (typeof STRING_ENCODING_MODE)[keyof typeof STRING_ENCODING_MODE];

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8');

function encodeDictionaryPayload(source: readonly string[], count: number): Uint8Array {
  const indexByValue = new Map<string, number>();
  const uniqueValues: string[] = [];
  const indexes = new Uint32Array(count);

  for (let index = 0; index < count; index += 1) {
    const value = source[index];
    let dictionaryIndex = indexByValue.get(value);
    if (dictionaryIndex === undefined) {
      dictionaryIndex = uniqueValues.length;
      indexByValue.set(value, dictionaryIndex);
      uniqueValues.push(value);
    }
    indexes[index] = dictionaryIndex;
  }

  const writer = new ByteWriter(count + uniqueValues.length * 4 + 32);
  writer.writeUnsignedVarint(uniqueValues.length);
  for (const value of uniqueValues) {
    const bytes = TEXT_ENCODER.encode(value);
    writer.writeUnsignedVarint(bytes.length);
    writer.writeBytes(bytes);
  }
  for (let index = 0; index < count; index += 1) {
    writer.writeUnsignedVarint(indexes[index]);
  }
  return writer.toUint8Array();
}

function encodeDirectPayload(source: readonly string[], count: number): Uint8Array {
  const writer = new ByteWriter(count * 8 + 32);
  for (let index = 0; index < count; index += 1) {
    const bytes = TEXT_ENCODER.encode(source[index]);
    writer.writeUnsignedVarint(bytes.length);
    writer.writeBytes(bytes);
  }
  return writer.toUint8Array();
}

export function encodeStringValues(values: EncodableValues, count: number): Uint8Array {
  const source = normalizeStringValues(values, count);
  if (count <= 0) return new Uint8Array(0);

  const dictionaryPayload = encodeDictionaryPayload(source, count);
  const directPayload = encodeDirectPayload(source, count);

  if (dictionaryPayload.length <= directPayload.length) {
    const out = new Uint8Array(dictionaryPayload.length + 1);
    out[0] = STRING_ENCODING_MODE.dictionary;
    out.set(dictionaryPayload, 1);
    return out;
  }
  const out = new Uint8Array(directPayload.length + 1);
  out[0] = STRING_ENCODING_MODE.direct;
  out.set(directPayload, 1);
  return out;
}

export function decodeStringValues(buffer: Uint8Array, count: number): string[] {
  const out: string[] = new Array(Math.max(0, count));
  if (count <= 0) return out;

  const reader = new ByteReader(buffer);
  const mode = reader.readByte();

  if (mode === STRING_ENCODING_MODE.direct) {
    for (let index = 0; index < count; index += 1) {
      out[index] = TEXT_DECODER.decode(reader.readBytes(reader.readUnsignedVarint()));
    }
    return out;
  }

  if (mode === STRING_ENCODING_MODE.dictionary) {
    const dictionarySize = reader.readUnsignedVarint();
    const dictionary: string[] = new Array(dictionarySize);
    for (let index = 0; index < dictionarySize; index += 1) {
      dictionary[index] = TEXT_DECODER.decode(reader.readBytes(reader.readUnsignedVarint()));
    }
    for (let index = 0; index < count; index += 1) {
      const dictionaryIndex = reader.readUnsignedVarint();
      if (dictionaryIndex >= dictionarySize) {
        throw new RtdbError(
          ERROR_CODE.CorruptBlock,
          `string dictionary index out of bounds: dictionaryIndex=${dictionaryIndex}, dictionarySize=${dictionarySize}`,
        );
      }
      out[index] = dictionary[dictionaryIndex];
    }
    return out;
  }

  throw new RtdbError(ERROR_CODE.CorruptBlock, `string encoding mode is invalid: mode=${mode}`);
}
