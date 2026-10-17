// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Error codes and unified error type (aligned with the error code master table in Detailed Design v1.6 §3.3)
 */

export const ERROR_CODE = {
  InvalidPoint: 'E_INVALID_POINT',
  InvalidRange: 'E_INVALID_RANGE',
  BadMetricName: 'E_BAD_METRIC_NAME',
  TypeMismatch: 'E_TYPE_MISMATCH',
  Auth: 'E_AUTH',
  DatabaseNotFound: 'E_DB_NOT_FOUND',
  MetricNotFound: 'E_METRIC_NOT_FOUND',
  DatabaseLocked: 'E_DB_LOCKED',
  BatchTooLarge: 'E_BATCH_TOO_LARGE',
  RateLimited: 'E_RATE_LIMITED',
  Io: 'E_IO',
  CorruptBlock: 'E_CORRUPT_BLOCK',
  /** Segment-level corruption (Footer/index region/rolling checksum failure) */
  CorruptSegment: 'E_CORRUPT_SEGMENT',
  /** Internal consistency (unreachable branch, mismatched format constant) */
  Internal: 'E_INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** Error code → HTTP status code (for Form B; Form A throws directly) */
export const ERROR_CODE_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  [ERROR_CODE.InvalidPoint]: 400,
  [ERROR_CODE.InvalidRange]: 400,
  [ERROR_CODE.BadMetricName]: 400,
  [ERROR_CODE.TypeMismatch]: 400,
  [ERROR_CODE.Auth]: 401,
  [ERROR_CODE.DatabaseNotFound]: 404,
  [ERROR_CODE.MetricNotFound]: 404,
  [ERROR_CODE.DatabaseLocked]: 409,
  [ERROR_CODE.BatchTooLarge]: 413,
  [ERROR_CODE.RateLimited]: 429,
  [ERROR_CODE.Io]: 500,
  [ERROR_CODE.CorruptBlock]: 500,
  [ERROR_CODE.CorruptSegment]: 500,
  [ERROR_CODE.Internal]: 500,
};

/** Unified engine error: code carries semantics across forms (library integration / HTTP) */
export class RtdbError extends Error {
  readonly code: ErrorCode;
  readonly details: readonly unknown[];

  constructor(code: ErrorCode, message: string, ...details: readonly unknown[]) {
    super(message);
    this.name = 'RtdbError';
    this.code = code;
    this.details = details;
  }
}

export function isRtdbError(error: unknown): error is RtdbError {
  return error instanceof RtdbError;
}
