// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * zlib whole-block wrapper (codecId 4)
 *
 * Layout: [inner codecId u8][zlib compressed stream]
 * On decode, unwrap first then dispatch by the inner codecId; it is only used when compression makes the payload smaller (selected by the registry).
 */

import { deflateSync, inflateSync } from 'node:zlib';

import { ERROR_CODE, RtdbError } from '../errors.ts';

export const ZLIB_WRAP_CODEC_ID = 4;

export interface UnwrappedPayload {
  innerCodecId: number;
  payload: Uint8Array;
}

export function wrapWithZlib(innerCodecId: number, payload: Uint8Array): Uint8Array {
  const compressed = deflateSync(payload);
  const out = new Uint8Array(compressed.length + 1);
  out[0] = innerCodecId;
  out.set(compressed, 1);
  return out;
}

export function unwrapZlib(buffer: Uint8Array): UnwrappedPayload {
  if (buffer.length < 2) {
    throw new RtdbError(ERROR_CODE.CorruptBlock, 'zlib wrapper block is shorter than 2 bytes');
  }
  const innerCodecId = buffer[0];
  try {
    return { innerCodecId, payload: new Uint8Array(inflateSync(buffer.subarray(1))) };
  } catch (error) {
    throw new RtdbError(
      ERROR_CODE.CorruptBlock,
      `zlib unwrap failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
