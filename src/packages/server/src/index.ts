// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `@ss/rtdb-server` public export surface (Detailed Design §3 / §6)
 *
 * Constraint: this package depends only on core and Node built-in modules; HTTP routing is hand-written (no framework).
 */

/* ---------- Logging ---------- */
export { LOG_LEVEL_RANK, Logger, isLogLevel } from './logger.ts';
export type { LogLevel } from './logger.ts';

/* ---------- Authentication (§3.2 / §6.2.4) ---------- */
export {
  AUTH_MODE,
  AuthVerifier,
  generateAuthToken,
  hashPassword,
  isAuthMode,
  loadOrCreateAuthToken,
  verifyPasswordHash,
} from './auth.ts';
export type { AuthMode, AuthPrincipal, AuthScope, AuthSource, AuthVerifierOptions } from './auth.ts';

/* ---------- Multi-user store (§3.2) ---------- */
export { USER_ROLE, UserStore, isUserRole } from './users.ts';
export type { CreateUserInput, UpdateUserInput, UserRecord, UserRole, UserStoreOptions } from './users.ts';
export { TokenStore, hashToken } from './tokens.ts';
export type { IssueTokenInput, IssuedToken, TokenRecord, TokenStoreOptions } from './tokens.ts';

/* ---------- Configuration (§6.1 ~ §6.5) ---------- */
export {
  SERVER_CONFIG_DEFAULTS,
  isLoopbackHost,
  loadServerConfig,
  toEngineOptions,
  validateServerConfig,
} from './config.ts';
export type {
  AdminConfig,
  AuthConfig,
  DeepPartial,
  LoadServerConfigOptions,
  PartialServerConfig,
  ServerConfig,
} from './config.ts';

/* ---------- Protocol codec (§3.1) ---------- */
export { decodeWritePointBatch, encodeAggregateWindows, encodeAtPoints, encodeMetricSummaries, encodePoint, encodeSeries } from './json-codec.ts';
export type { JsonAtPoint, JsonMetricSummary, JsonPoint, JsonSeries, JsonWindow } from './json-codec.ts';
export { parseLineProtocol } from './line-protocol.ts';
export type { LineProtocolResult } from './line-protocol.ts';

/* ---------- Error mapping (§3.3) ---------- */
export { HttpFailure, RETRY_AFTER_SECONDS, SERVER_ERROR_CODE, isHttpFailure, toHttpErrorResponse } from './http-error.ts';
export type { HttpErrorBody, HttpErrorResponse } from './http-error.ts';

/* ---------- Prometheus exposition (§3.4, S14) ---------- */
export { PROMETHEUS_METRICS_CONTENT_TYPE, encodePrometheusMetrics } from './metrics.ts';
export type { PrometheusMetricsInput } from './metrics.ts';

/* ---------- Service (§3.1 / §3.4) ---------- */
export { RtdbServer } from './server.ts';
export type { RtdbServerAddress, RtdbServerOptions } from './server.ts';
