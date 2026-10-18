// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxDB compatibility: request body reader with `Content-Encoding: gzip` support
 *
 * Two independent caps are enforced: the wire size (compressed bytes) and the decoded size. The decoded
 * cap is what protects against compression bombs; `node:zlib` stops inflating once `maxOutputLength` is
 * exceeded (zero third-party dependencies).
 */

import type { IncomingMessage } from 'node:http';
import { gunzipSync } from 'node:zlib';

import { InfluxCompatError } from './errors.ts';

export interface CompatBody {
  buffer: Buffer;
  gzip: boolean;
}

export function readCompatBody(request: IncomingMessage, maxBytes: number): Promise<CompatBody> {
  return new Promise<CompatBody>((resolvePromise, rejectPromise) => {
    const declaredLength = Number(request.headers['content-length'] ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      rejectPromise(tooLarge(maxBytes));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;
    request.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        // Keep draining so the client receives the 413 instead of a connection reset; memory stays flat.
        exceeded = true;
        chunks.length = 0;
        return;
      }
      if (!exceeded) chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) {
        rejectPromise(tooLarge(maxBytes));
        return;
      }
      const raw = Buffer.concat(chunks);
      const encoding = String(request.headers['content-encoding'] ?? '').trim().toLowerCase();
      if (encoding.length === 0 || encoding === 'identity') {
        resolvePromise({ buffer: raw, gzip: false });
        return;
      }
      if (encoding !== 'gzip') {
        rejectPromise(
          new InfluxCompatError({
            status: 415,
            code: 'unsupported media type',
            message: `Unsupported Content-Encoding: ${encoding} (only gzip is accepted)`,
          }),
        );
        return;
      }
      try {
        const decoded = gunzipSync(raw, { maxOutputLength: maxBytes });
        resolvePromise({ buffer: decoded, gzip: true });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|buffer/i.test((error as Error).message)) {
          rejectPromise(tooLarge(maxBytes));
          return;
        }
        rejectPromise(
          new InfluxCompatError({
            status: 400,
            code: 'invalid',
            message: `Failed to decompress gzip body: ${(error as Error).message}`,
          }),
        );
      }
    });
    request.on('error', (error) => rejectPromise(error));
  });
}

function tooLarge(maxBytes: number): InfluxCompatError {
  return new InfluxCompatError({
    status: 413,
    code: 'request too large',
    message: `Request body exceeds the compatibility limit of ${maxBytes} bytes`,
  });
}
