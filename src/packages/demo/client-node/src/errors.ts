// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * SDK error type (aligned with "Detailed Design v2.2" §4)
 *
 * The SDK never imports core types, so it cannot reuse `RtdbError`. It carries:
 *   - `status`: HTTP status code; `0` means a transport-level failure (network / timeout) with no response
 *   - `code`: the server error code from the response body (e.g. `E_BATCH_TOO_LARGE`), or a client-side code
 *   - `details`: the optional `details` array of the server error body (e.g. invalid point indexes / line numbers)
 */

/** Error codes raised on the client side (the server side returns codes verbatim) */
export const CLIENT_ERROR_CODE = {
  /** Network failure, DNS failure, connection reset, or an abnormal response stream */
  Transport: 'E_CLIENT_TRANSPORT',
  /** Request timeout (`timeoutMs` exceeded) */
  Timeout: 'E_CLIENT_TIMEOUT',
  /** Invalid call arguments detected locally before any request is sent */
  InvalidArgument: 'E_CLIENT_INVALID_ARGUMENT',
} as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODE)[keyof typeof CLIENT_ERROR_CODE];

/** Unified SDK error (server business errors and transport errors share one type) */
export class RtdbClientError extends Error {
  /** HTTP status code; `0` = transport-level failure (no response received) */
  readonly status: number;
  /** Server error code (`E_*`) or a member of `CLIENT_ERROR_CODE` */
  readonly code: string;
  /** Error details from the server body (invalid point indexes / line numbers); empty when absent */
  readonly details: readonly unknown[];

  constructor(code: string, message: string, status = 0, details: readonly unknown[] = []) {
    super(message);
    this.name = 'RtdbClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isRtdbClientError(error: unknown): error is RtdbClientError {
  return error instanceof RtdbClientError;
}
