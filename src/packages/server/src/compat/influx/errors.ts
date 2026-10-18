// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxDB compatibility: error carriers and per-family error bodies
 *
 * InfluxDB 2.x answers with `{"code","message"}` while 1.x/3.x answer with `{"error": "..."}`. The
 * compatibility layer keeps one internal carrier and renders it per endpoint family, so native
 * `{error: E_CODE, message}` envelopes never leak into Influx clients.
 */

import type { ServerResponse } from 'node:http';

import { ERROR_CODE_HTTP_STATUS, isRtdbError } from '../../../../core/src/errors.ts';
import { isHttpFailure } from '../../http-error.ts';

/** InfluxDB API generation of the calling endpoint */
export type InfluxErrorFamily = 'v1' | 'v2' | 'v3';

export interface InfluxErrorDataItem {
  line_number: number;
  error_message: string;
}

export class InfluxCompatError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  readonly data: readonly InfluxErrorDataItem[] | undefined;
  /** Native ss-rtdb error code, reported through `X-Rtdb-Error-Code` for troubleshooting */
  readonly nativeCode: string | undefined;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    hint?: string;
    data?: readonly InfluxErrorDataItem[];
    nativeCode?: string;
  }) {
    super(options.message);
    this.name = 'InfluxCompatError';
    this.status = options.status;
    this.code = options.code;
    this.hint = options.hint;
    this.data = options.data;
    this.nativeCode = options.nativeCode;
  }
}

/** Map a numeric status onto the InfluxDB 2.x error `code` vocabulary */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not found';
    case 405:
      return 'method not allowed';
    case 409:
      return 'unprocessable entity';
    case 413:
      return 'request too large';
    case 415:
      return 'unsupported media type';
    case 429:
      return 'too many requests';
    case 501:
      return 'not implemented';
    case 503:
      return 'unavailable';
    default:
      return 'internal error';
  }
}

export function invalid(message: string, options: { hint?: string; nativeCode?: string } = {}): InfluxCompatError {
  return new InfluxCompatError({ status: 400, code: 'invalid', message, ...options });
}

export function notImplemented(message: string, hint: string): InfluxCompatError {
  return new InfluxCompatError({ status: 501, code: 'not implemented', message, hint });
}

/**
 * Convert any thrown value into an {@link InfluxCompatError}.
 *
 * Ordering mirrors `toHttpErrorResponse`: route-level `HttpFailure` first (token/user not found etc.),
 * then core `RtdbError` (status from `ERROR_CODE_HTTP_STATUS`), then a generic 500.
 */
export function toInfluxError(error: unknown): InfluxCompatError {
  if (error instanceof InfluxCompatError) return error;
  if (isHttpFailure(error)) {
    return new InfluxCompatError({
      status: error.status,
      code: codeForStatus(error.status),
      message: error.message,
      nativeCode: error.code,
    });
  }
  if (isRtdbError(error)) {
    const status = ERROR_CODE_HTTP_STATUS[error.code] ?? 500;
    return new InfluxCompatError({
      status,
      code: codeForStatus(status),
      message: error.message,
      nativeCode: error.code,
    });
  }
  return new InfluxCompatError({
    status: 500,
    code: 'internal error',
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Write one error response in the shape expected by the endpoint family */
export function sendInfluxError(response: ServerResponse, failure: InfluxCompatError, family: InfluxErrorFamily): void {
  const body: Record<string, unknown> =
    family === 'v2'
      ? { code: failure.code, message: failure.message }
      : { error: failure.message };
  if (failure.hint !== undefined) body.hint = failure.hint;
  if (failure.data !== undefined && failure.data.length > 0) body.data = failure.data;

  const payload = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  };
  if (failure.nativeCode !== undefined) headers['X-Rtdb-Error-Code'] = failure.nativeCode;
  if (failure.status === 405) headers['Allow'] = 'GET, POST';
  if (failure.status === 429) headers['Retry-After'] = '1';
  response.writeHead(failure.status, headers);
  response.end(payload);
}

/** Write a JSON body with the given status (compat responses only; native handlers keep their own helper) */
export function sendCompatJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** 204 response with count headers (write endpoints) */
export function sendNoContent(response: ServerResponse, headers: Readonly<Record<string, string>>): void {
  response.writeHead(204, headers);
  response.end();
}
