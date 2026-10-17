// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * bool value encoding (codecId 6): 0/1 run-length (RLE bit packing)
 *
 * Layout: 1 first-value byte (0/1) + alternating run-length varints (the first run belongs to the first value).
 * A constant-value block is only 3 bytes; frequently toggling booleans (e.g. alarm bits) degrade to 1 byte per run.
 */

import { ERROR_CODE, RtdbError } from '../errors.ts';
import { ByteReader, ByteWriter } from './varint.ts';
import { normalizeBoolValues, type EncodableValues } from './values.ts';

export const BOOL_CODEC_ID = 6;

export function encodeBoolValues(values: EncodableValues, count: number): Uint8Array {
  const source = normalizeBoolValues(values, count);
  if (count <= 0) return new Uint8Array(0);
  if (source.length < count) {
    throw new RtdbError(ERROR_CODE.Internal, `bool encode has insufficient point data: count=${count}`);
  }

  const writer = new ByteWriter(Math.ceil(count / 4) + 16);
  const firstValue = source[0] ? 1 : 0;
  writer.writeByte(firstValue);

  let runValue = firstValue;
  let runLength = 0;
  for (let index = 0; index < count; index += 1) {
    const bit = source[index] ? 1 : 0;
    if (bit === runValue) {
      runLength += 1;
      continue;
    }
    writer.writeUnsignedVarint(runLength);
    runValue = bit;
    runLength = 1;
  }
  writer.writeUnsignedVarint(runLength);
  return writer.toUint8Array();
}

export function decodeBoolValues(buffer: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(count);
  if (count <= 0) return out;

  const reader = new ByteReader(buffer);
  let runValue = reader.readByte() ? 1 : 0;
  let cursor = 0;

  while (cursor < count) {
    const runLength = reader.readUnsignedVarint();
    if (runLength <= 0 || cursor + runLength > count) {
      throw new RtdbError(
        ERROR_CODE.CorruptBlock,
        `bool run is invalid: runLength=${runLength}, cursor=${cursor}, count=${count}`,
      );
    }
    out.fill(runValue, cursor, cursor + runLength);
    cursor += runLength;
    runValue = runValue === 1 ? 0 : 1;
  }
  return out;
}
