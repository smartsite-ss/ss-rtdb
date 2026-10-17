// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Error → HTTP response mapping (aligns with "Detailed Design v2.5" §3.3 error code master table)
 *
 * The core `RtdbError` code maps directly to a status code (`ERROR_CODE_HTTP_STATUS`); `429` carries `Retry-After: 1`.
 * Route-level errors (unknown route / method not allowed / RBAC denial / missing admin resource) go through
 * `HttpFailure` and carry off-table status codes; `401 E_AUTH` means "no / invalid credential", while
 * `403 E_FORBIDDEN` means "authenticated but the role lacks the scope".
 */

import { ERROR_CODE, ERROR_CODE_HTTP_STATUS, isRtdbError } from '../../core/src/errors.ts';

/** Off-table (route-level) error codes */
export const SERVER_ERROR_CODE = {
  RouteNotFound: 'E_NOT_FOUND',
  MethodNotAllowed: 'E_METHOD_NOT_ALLOWED',
  /** Authenticated but the caller's role does not grant the requested scope (403) */
  Forbidden: 'E_FORBIDDEN',
  /** User name already taken (409) */
  UserExists: 'E_USER_EXISTS',
  /** Target user does not exist (404) */
  UserNotFound: 'E_USER_NOT_FOUND',
  /** Target token does not exist (404) */
  TokenNotFound: 'E_TOKEN_NOT_FOUND',
} as const;

/** 429 `Retry-After` seconds (§3.3) */
export const RETRY_AFTER_SECONDS = 1;

/** Route-level HTTP error (carries a non-core error code and a custom status code) */
export class HttpFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, code: string, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = 'HttpFailure';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function isHttpFailure(error: unknown): error is HttpFailure {
  return error instanceof HttpFailure;
}

export interface HttpErrorBody {
  error: string;
  message: string;
  details?: readonly unknown[];
}

export interface HttpErrorResponse {
  status: number;
  headers: Record<string, string>;
  body: HttpErrorBody;
}

export function toHttpErrorResponse(error: unknown): HttpErrorResponse {
  if (isHttpFailure(error)) {
    return {
      status: error.status,
      headers: { ...error.headers },
      body: { error: error.code, message: error.message },
    };
  }
  if (isRtdbError(error)) {
    const headers: Record<string, string> =
      error.code === ERROR_CODE.RateLimited ? { 'Retry-After': String(RETRY_AFTER_SECONDS) } : {};
    const body: HttpErrorBody = { error: error.code, message: error.message };
    if (error.details.length > 0) body.details = error.details;
    return { status: ERROR_CODE_HTTP_STATUS[error.code], headers, body };
  }
  return {
    status: 500,
    headers: {},
    body: {
      error: ERROR_CODE.Internal,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
