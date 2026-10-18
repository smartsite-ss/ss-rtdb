// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Public export surface of `@ss/rtdb-client` (aligned with "Detailed Design v2.2" §4)
 *
 * Constraint: pure HTTP SDK with no engine dependency; both the client and the protocol codec are exposed here.
 */

/* ---------- Client ---------- */
export { RtdbClient } from './client.ts';
export type {
  AggregateQueryOptions,
  BackupRangeOptions,
  BackupRangeReport,
  BackupReport,
  CountQueryOptions,
  CreateUserRequest,
  IssueTokenRequest,
  IssuedTokenResult,
  LastQueryOptions,
  RangeQueryOptions,
  RtdbClientOptions,
  RtdbUserRole,
  StatusReport,
  TokenInfo,
  UpdateUserRequest,
  UserInfo,
  WriteBatchResult,
} from './client.ts';

/* ---------- Errors ---------- */
export { CLIENT_ERROR_CODE, RtdbClientError, isRtdbClientError } from './errors.ts';
export type { ClientErrorCode } from './errors.ts';

/* ---------- Protocol codec ---------- */
export {
  VALUE_TYPE,
  decodeAggregateWindows,
  decodeAtPoints,
  decodePoint,
  decodeSeries,
  decodeValue,
  encodeWritePoint,
} from './protocol.ts';
export type {
  AggregateType,
  AggregateWindowResult,
  AtPointState,
  AtQueryOptions,
  ClientAtPoint,
  ClientPoint,
  ClientSeries,
  ClientWritePoint,
  InterpolationMode,
  JsonPoint,
  JsonSeries,
  JsonWindow,
  PointValue,
  ValueType,
} from './protocol.ts';
