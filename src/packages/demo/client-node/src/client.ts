// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `@ss/rtdb-client`: the Node.js SDK over the Form B HTTP protocol (aligned with "Detailed Design v2.2" §4)
 *
 * Scope: the six methods (`writeBatch` / `queryRange` / `queryLast` / `queryCount` / `queryAggregate` / `status`)
 * and two built-in policies:
 *   - **Retry**: only for `429 E_RATE_LIMITED` and transport failures (network / timeout), with exponential
 *     backoff, at most `maxRetries` (default 3, capped at 3) extra attempts; business errors (`400` / `401` /
 *     `404` / `413` / `500` ...) are **never** retried.
 *   - **Chunking**: `writeBatch` splits the input into batches of at most `maxBatchPoints` (default 100_000) and
 *     sends them **sequentially**, preserving order and keeping peak memory bounded.
 *
 * Design notes:
 *   - The SDK holds **no engine dependency**: it speaks HTTP only and uses the local protocol codec in `protocol.ts`.
 *   - `429` is decided by re-reading the response body so the caller still receives the server error code; the
 *     `Retry-After` header is **not** honored (the server always sends a fixed `1`s and embedded callers need
 *     bounded, predictable latency); the backoff base is configurable through `retryDelayMs`.
 */

import { CLIENT_ERROR_CODE, RtdbClientError } from './errors.ts';
import {
  decodeAggregateWindows,
  decodePoint,
  decodeSeries,
  encodeWritePoint,
} from './protocol.ts';
import type {
  AggregateType,
  AggregateWindowResult,
  ClientPoint,
  ClientSeries,
  ClientWritePoint,
  JsonPoint,
  JsonSeries,
  JsonWindow,
} from './protocol.ts';

/* ---------- Constants ---------- */

/** Default request timeout (ms) */
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

/** Default extra attempts for retryable failures */
const DEFAULT_MAX_RETRIES = 3;
const MAX_RETRIES_LIMIT = 3;

/** Default chunk size of a single write batch (points) */
const DEFAULT_MAX_BATCH_POINTS = 100_000;

/** Default backoff base (ms); the wait for attempt `n` is `base * 2^n` */
const DEFAULT_RETRY_DELAY_MS = 200;

/** The only HTTP status that participates in backoff retry (core backpressure) */
const RETRYABLE_STATUS = 429;

/* ---------- Public types ---------- */

export interface RtdbClientOptions {
  /** Service base URL, e.g. `http://127.0.0.1:6180` (a trailing slash is ignored) */
  baseUrl: string;
  /** Access token; when present it is sent as `Authorization: Bearer <token>` */
  token?: string;
  /** Request timeout in ms (default 10000, clamped to 1000~60000) */
  timeoutMs?: number;
  /** Extra attempts for retryable failures (default 3, capped at 3) */
  maxRetries?: number;
  /** Max points per write batch (default 100000); larger inputs are auto-chunked */
  maxBatchPoints?: number;
  /** Backoff base in ms (default 200); mainly lowered by tests to keep them fast */
  retryDelayMs?: number;
}

export interface RangeQueryOptions {
  /** Start of the range (ms epoch, inclusive) */
  start: number;
  /** End of the range (ms epoch, inclusive) */
  end: number;
  /** Max points returned; server default 100000 when omitted */
  limit?: number;
  /** Default `asc` */
  order?: 'asc' | 'desc';
}

export interface LastQueryOptions {
  /** Return the latest point at or before this timestamp; defaults to the latest overall */
  before?: number;
}

export interface CountQueryOptions {
  start: number;
  end: number;
  /** `true` counts point by point instead of using the index estimate */
  exact?: boolean;
}

export interface AggregateQueryOptions {
  start: number;
  end: number;
  type: AggregateType;
  /** Window width in ms (≥ 1) */
  windowMs: number;
}

export interface WriteBatchResult {
  /** Points actually accepted (sum over chunks, after server-side dedupe) */
  accepted: number;
}

/** `status()` report (Detailed Design §3.4; the runtime metrics reported by the server) */
export interface StatusReport {
  uptimeMs: number;
  databases: number;
  metrics: number;
  write: {
    /** Session-average write rate (accepted points / seconds since the first write) */
    pointsPerSec: number;
    buffered: number;
    duplicates: number;
    tagsIgnored: number;
  };
  wal: {
    pendingBytes: number;
    outstandingBatches: number;
    /** Points in unreleased WAL batches (accepted but not yet flushed into segments) */
    pendingPoints: number;
    /** Epoch ms of the last WAL group fsync (0 = no fsync yet) */
    lastFsyncMs: number;
  };
  segments: {
    openFiles: number;
    /** Bytes occupied by today's day directories */
    bytesToday: number;
  };
  cache: {
    blocks: number;
    /** Decoded block cache hit rate this session ([0,1]) */
    blockHitRate: number;
    /** Node heap used (MiB) */
    heapUsedMb: number;
    /** Node external memory including ArrayBuffers (MiB) */
    externalMb: number;
  };
  gc: { count: number; totalMs: number; maxMs: number };
  query: { count: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
}

/* ---------- Multi-user administration (§3.2) ---------- */

/** User roles accepted by the multi-user API (aligned with the server `USER_ROLE`) */
export type RtdbUserRole = 'admin' | 'write' | 'readonly';

/** One user as returned by the admin API (no password material is ever returned) */
export interface UserInfo {
  username: string;
  role: RtdbUserRole;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One API token as returned by the admin token endpoints (the plaintext only appears in `issueToken`) */
export interface TokenInfo {
  tokenId: string;
  user: string;
  role: RtdbUserRole;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  role?: RtdbUserRole;
  /** Defaults to `true` on the server */
  enabled?: boolean;
}

export interface UpdateUserRequest {
  role?: RtdbUserRole;
  password?: string;
  enabled?: boolean;
}

export interface IssueTokenRequest {
  user: string;
  role?: RtdbUserRole;
  label?: string;
  /** Time to live in ms; omit for a token that never expires */
  ttlMs?: number;
}

/** Result of `issueToken`: the plaintext token (returned once) and its stored metadata */
export interface IssuedTokenResult {
  token: string;
  tokenRecord: TokenInfo;
}

/* ---------- Client ---------- */

export class RtdbClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxBatchPoints: number;
  private readonly retryDelayMs: number;

  constructor(options: RtdbClientOptions) {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.trim().length === 0) {
      throw new RtdbClientError(CLIENT_ERROR_CODE.InvalidArgument, 'RtdbClient.options.baseUrl must be a non-empty string');
    }
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.token = options.token ?? '';
    this.timeoutMs = clampInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.maxRetries = clampInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, 0, MAX_RETRIES_LIMIT);
    this.maxBatchPoints = Math.max(1, Math.trunc(options.maxBatchPoints ?? DEFAULT_MAX_BATCH_POINTS));
    this.retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  }

  /* ---------- Write ---------- */

  /**
   * Write points; when the input exceeds `maxBatchPoints` it is split into ordered chunks and sent sequentially.
   *
   * A whole chunk is either accepted or rejected (the server applies no partial success), so a failure aborts the
   * remaining chunks and propagates the server error; `accepted` sums only the chunks that already succeeded.
   */
  async writeBatch(database: string, points: readonly ClientWritePoint[]): Promise<WriteBatchResult> {
    const databaseName = requireDatabaseName(database);
    let accepted = 0;
    for (let offset = 0; offset < points.length; offset += this.maxBatchPoints) {
      const chunk = points.slice(offset, offset + this.maxBatchPoints);
      const body = await this.request('POST', `/api/v1/write?db=${encodeURIComponent(databaseName)}`, chunk.map(encodeWritePoint));
      accepted += readIntegerField(requireObject(body, 'write response body'), 'accepted');
    }
    return { accepted };
  }

  /* ---------- Query ---------- */

  async queryRange(database: string, metricName: string, options: RangeQueryOptions): Promise<ClientSeries> {
    const body = await this.request('POST', '/api/v1/query/range', {
      db: requireDatabaseName(database),
      metricName: requireMetricName(metricName),
      ...options,
    });
    return decodeSeries(readSeriesField(body));
  }

  async queryLast(database: string, metricName: string, options: LastQueryOptions = {}): Promise<ClientPoint | null> {
    const requestBody: Record<string, unknown> = {
      db: requireDatabaseName(database),
      metricName: requireMetricName(metricName),
    };
    if (options.before !== undefined) requestBody.before = options.before;
    const body = await this.request('POST', '/api/v1/query/last', requestBody);
    const record = requireObject(body, 'query/last response body');
    if (record.point === null || record.point === undefined) return null;
    return decodePoint(requireJsonPoint(record.point, 'query/last response point'));
  }

  async queryCount(database: string, metricName: string, options: CountQueryOptions): Promise<number> {
    const requestBody: Record<string, unknown> = {
      db: requireDatabaseName(database),
      metricName: requireMetricName(metricName),
      start: options.start,
      end: options.end,
    };
    if (options.exact !== undefined) requestBody.exact = options.exact;
    const body = await this.request('POST', '/api/v1/query/count', requestBody);
    return readIntegerField(requireObject(body, 'query/count response body'), 'count');
  }

  async queryAggregate(
    database: string,
    metricName: string,
    options: AggregateQueryOptions,
  ): Promise<AggregateWindowResult[]> {
    const body = await this.request('POST', '/api/v1/query/aggregate', {
      db: requireDatabaseName(database),
      metricName: requireMetricName(metricName),
      ...options,
    });
    const record = requireObject(body, 'query/aggregate response body');
    const windows = record.windows;
    if (!Array.isArray(windows)) {
      throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, 'query/aggregate response is missing the windows array');
    }
    return decodeAggregateWindows(windows.map((item) => requireJsonWindow(item)));
  }

  /* ---------- Management ---------- */

  async status(): Promise<StatusReport> {
    const body = await this.request('GET', '/api/v1/status');
    const record = requireObject(body, 'status response body');
    const write = requireObject(record.write, 'status.write');
    const wal = requireObject(record.wal, 'status.wal');
    const segments = requireObject(record.segments, 'status.segments');
    const cache = requireObject(record.cache, 'status.cache');
    const gc = requireObject(record.gc, 'status.gc');
    const query = requireObject(record.query, 'status.query');
    return {
      uptimeMs: readIntegerField(record, 'uptimeMs'),
      databases: readIntegerField(record, 'databases'),
      metrics: readIntegerField(record, 'metrics'),
      write: {
        pointsPerSec: readIntegerField(write, 'pointsPerSec'),
        buffered: readIntegerField(write, 'buffered'),
        duplicates: readIntegerField(write, 'duplicates'),
        tagsIgnored: readIntegerField(write, 'tagsIgnored'),
      },
      wal: {
        pendingBytes: readIntegerField(wal, 'pendingBytes'),
        outstandingBatches: readIntegerField(wal, 'outstandingBatches'),
        pendingPoints: readIntegerField(wal, 'pendingPoints'),
        lastFsyncMs: readIntegerField(wal, 'lastFsyncMs'),
      },
      segments: {
        openFiles: readIntegerField(segments, 'openFiles'),
        bytesToday: readIntegerField(segments, 'bytesToday'),
      },
      cache: {
        blocks: readIntegerField(cache, 'blocks'),
        blockHitRate: readNumberField(cache, 'blockHitRate'),
        heapUsedMb: readNumberField(cache, 'heapUsedMb'),
        externalMb: readNumberField(cache, 'externalMb'),
      },
      gc: {
        count: readIntegerField(gc, 'count'),
        totalMs: readNumberField(gc, 'totalMs'),
        maxMs: readNumberField(gc, 'maxMs'),
      },
      query: {
        count: readIntegerField(query, 'count'),
        p50Ms: readNumberField(query, 'p50Ms'),
        p95Ms: readNumberField(query, 'p95Ms'),
        p99Ms: readNumberField(query, 'p99Ms'),
        maxMs: readNumberField(query, 'maxMs'),
      },
    };
  }

  /** Known databases (server `GET /api/v1/databases`) */
  async listDatabases(): Promise<string[]> {
    const body = await this.request('GET', '/api/v1/databases');
    const record = requireObject(body, 'databases response body');
    if (!Array.isArray(record.databases)) {
      throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, 'databases response is missing the databases array');
    }
    return record.databases.map((name) => String(name));
  }

  /** Metric summaries of a database (server `GET /api/v1/metrics/:db`) */
  async listMetrics(database: string): Promise<Array<{ metricName: string; firstTs: number; lastTs: number }>> {
    const databaseName = requireDatabaseName(database);
    const body = await this.request('GET', `/api/v1/metrics/${encodeURIComponent(databaseName)}`);
    const record = requireObject(body, 'metrics response body');
    if (!Array.isArray(record.metrics)) {
      throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, 'metrics response is missing the metrics array');
    }
    return record.metrics.map((item) => {
      const summary = requireObject(item, 'metric summary');
      return {
        metricName: String(summary.metricName),
        firstTs: readIntegerField(summary, 'firstTs'),
        lastTs: readIntegerField(summary, 'lastTs'),
      };
    });
  }

  /** Set the database retention policy in days (server `PUT /api/v1/retention/:db`) */
  async setRetention(database: string, days: number): Promise<void> {
    const databaseName = requireDatabaseName(database);
    await this.request('PUT', `/api/v1/retention/${encodeURIComponent(databaseName)}`, { days });
  }

  /** Back up a database to `{targetDir}/{database}` (server `POST /api/v1/backup/:db`) */
  async backup(
    database: string,
    targetDirectory: string,
  ): Promise<{ database: string; targetDirectory: string; files: number; totalBytes: number }> {
    const databaseName = requireDatabaseName(database);
    if (typeof targetDirectory !== 'string' || targetDirectory.length === 0) {
      throw new RtdbClientError(CLIENT_ERROR_CODE.InvalidArgument, 'backup targetDirectory must be a non-empty string');
    }
    const body = await this.request('POST', `/api/v1/backup/${encodeURIComponent(databaseName)}`, {
      targetDir: targetDirectory,
    });
    const record = requireObject(body, 'backup response body');
    return {
      database: String(record.database ?? databaseName),
      targetDirectory: String(record.targetDirectory ?? ''),
      files: readIntegerField(record, 'files'),
      totalBytes: readIntegerField(record, 'totalBytes'),
    };
  }

  /* ---------- Multi-user administration (§3.2; the server enforces the admin scope) ---------- */

  /** List users (server `GET /api/v1/admin/users`) */
  async listUsers(): Promise<UserInfo[]> {
    const body = await this.request('GET', '/api/v1/admin/users');
    const record = requireObject(body, 'admin/users response body');
    if (!Array.isArray(record.users)) {
      throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, 'admin/users response is missing the users array');
    }
    return record.users.map((item) => readUserInfo(item, 'admin/users user'));
  }

  /** Create a user (server `POST /api/v1/admin/users`) */
  async createUser(input: CreateUserRequest): Promise<UserInfo> {
    const body = await this.request('POST', '/api/v1/admin/users', input);
    return readUserInfo(requireObject(body, 'admin/users create response body').user, 'admin/users create user');
  }

  /** Update a user (role / password / enabled) (server `PUT /api/v1/admin/users/:name`) */
  async updateUser(username: string, patch: UpdateUserRequest): Promise<UserInfo> {
    const path = `/api/v1/admin/users/${encodeURIComponent(requireUserName(username))}`;
    const body = await this.request('PUT', path, patch);
    return readUserInfo(requireObject(body, 'admin/users update response body').user, 'admin/users update user');
  }

  /** Remove a user (server `DELETE /api/v1/admin/users/:name`) */
  async removeUser(username: string): Promise<void> {
    await this.request('DELETE', `/api/v1/admin/users/${encodeURIComponent(requireUserName(username))}`);
  }

  /** Issue an API token; the returned `token` is plaintext and shown only once (server `POST /api/v1/admin/tokens`) */
  async issueToken(input: IssueTokenRequest): Promise<IssuedTokenResult> {
    const body = await this.request('POST', '/api/v1/admin/tokens', input);
    const record = requireObject(body, 'admin/tokens issue response body');
    if (typeof record.token !== 'string' || record.token.length === 0) {
      throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, 'admin/tokens issue response is missing the plaintext token');
    }
    return { token: record.token, tokenRecord: readTokenInfo(record.tokenRecord, 'admin/tokens issue record') };
  }

  /** List API tokens (server `GET /api/v1/admin/tokens`) */
  async listTokens(): Promise<TokenInfo[]> {
    const body = await this.request('GET', '/api/v1/admin/tokens');
    const record = requireObject(body, 'admin/tokens response body');
    if (!Array.isArray(record.tokens)) {
      throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, 'admin/tokens response is missing the tokens array');
    }
    return record.tokens.map((item) => readTokenInfo(item, 'admin/tokens token'));
  }

  /** Revoke an API token (server `DELETE /api/v1/admin/tokens/:tokenId`) */
  async revokeToken(tokenId: string): Promise<void> {
    if (typeof tokenId !== 'string' || tokenId.length === 0) {
      throw new RtdbClientError(CLIENT_ERROR_CODE.InvalidArgument, 'tokenId must be a non-empty string');
    }
    await this.request('DELETE', `/api/v1/admin/tokens/${encodeURIComponent(tokenId)}`);
  }

  /* ---------- Transport with retry ---------- */

  /**
   * Send one request with retry: `429` and transport failures back off exponentially up to `maxRetries` extra
   * attempts; every other outcome (including 4xx / 5xx business errors) returns or throws immediately.
   */
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.sendOnce(method, path, body);
        if (response.status === RETRYABLE_STATUS && attempt < this.maxRetries) {
          await delayMs(this.backoffMs(attempt));
          attempt += 1;
          continue;
        }
        if (!response.ok) throw await toResponseError(response, path);
        return await readResponseBody(response, path);
      } catch (error) {
        // Business errors are final; only transport-level failures are retried.
        if (error instanceof RtdbClientError) throw error;
        if (attempt < this.maxRetries) {
          await delayMs(this.backoffMs(attempt));
          attempt += 1;
          continue;
        }
        throw toTransportError(error, path);
      }
    }
  }

  private sendOnce(method: string, path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    if (this.token.length > 0) headers['Authorization'] = `Bearer ${this.token}`;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${this.baseUrl}${path}`, init);
  }

  private backoffMs(attempt: number): number {
    return this.retryDelayMs * 2 ** attempt;
  }
}

/* ---------- Internals: response handling ---------- */

async function toResponseError(response: Response, path: string): Promise<RtdbClientError> {
  const parsed = await readJsonSafely(response);
  const record = isPlainObject(parsed) ? parsed : {};
  const code = typeof record.error === 'string' ? record.error : `E_HTTP_${response.status}`;
  const message = typeof record.message === 'string' ? record.message : `Request ${path} failed with HTTP ${response.status}`;
  const details = Array.isArray(record.details) ? (record.details as readonly unknown[]) : [];
  return new RtdbClientError(code, message, response.status, details);
}

async function readResponseBody(response: Response, path: string): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RtdbClientError(
      CLIENT_ERROR_CODE.Transport,
      `Failed to parse the response body of ${path}: ${(error as Error).message}`,
    );
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function toTransportError(error: unknown, path: string): RtdbClientError {
  const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  if (isTimeout) {
    return new RtdbClientError(
      CLIENT_ERROR_CODE.Timeout,
      `Request ${path} timed out (exceeded the SDK request timeout)`,
      0,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RtdbClientError(CLIENT_ERROR_CODE.Transport, `Request ${path} failed: ${message}`, 0);
}

/* ---------- Internals: validation ---------- */

function requireDatabaseName(database: string): string {
  if (typeof database !== 'string' || database.length === 0) {
    throw new RtdbClientError(CLIENT_ERROR_CODE.InvalidArgument, 'Database name must be a non-empty string');
  }
  return database;
}

function requireMetricName(metricName: string): string {
  if (typeof metricName !== 'string' || metricName.length === 0) {
    throw new RtdbClientError(CLIENT_ERROR_CODE.InvalidArgument, 'Metric name must be a non-empty string');
  }
  return metricName;
}

function requireUserName(username: string): string {
  if (typeof username !== 'string' || username.length === 0) {
    throw new RtdbClientError(CLIENT_ERROR_CODE.InvalidArgument, 'User name must be a non-empty string');
  }
  return username;
}

function readUserInfo(value: unknown, label: string): UserInfo {
  const record = requireObject(value, label);
  return {
    username: String(record.username ?? ''),
    role: readRole(record.role, label),
    enabled: record.enabled === true,
    createdAt: readIntegerField(record, 'createdAt'),
    updatedAt: readIntegerField(record, 'updatedAt'),
  };
}

function readTokenInfo(value: unknown, label: string): TokenInfo {
  const record = requireObject(value, label);
  return {
    tokenId: String(record.tokenId ?? ''),
    user: String(record.user ?? ''),
    role: readRole(record.role, label),
    label: typeof record.label === 'string' ? record.label : '',
    createdAt: readIntegerField(record, 'createdAt'),
    expiresAt: readNullableIntegerField(record, 'expiresAt'),
    revokedAt: readNullableIntegerField(record, 'revokedAt'),
  };
}

function readRole(value: unknown, label: string): RtdbUserRole {
  if (value === 'admin' || value === 'write' || value === 'readonly') return value;
  throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `${label}.role is not a valid role: ${String(value)}`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `${label} must be a JSON object`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readIntegerField(container: Record<string, unknown>, fieldName: string): number {
  const value = container[fieldName];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `Response field ${fieldName} must be an integer: ${String(value)}`);
  }
  return value;
}

/** Read a finite (possibly fractional) numeric field (used by the status float metrics: hit rate / MiB / ms) */
function readNumberField(container: Record<string, unknown>, fieldName: string): number {
  const value = container[fieldName];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `Response field ${fieldName} must be a number: ${String(value)}`);
  }
  return value;
}

/** Read an optional integer field: `null` / `undefined` map to `null`, a non-integer is a transport error */
function readNullableIntegerField(container: Record<string, unknown>, fieldName: string): number | null {
  const value = container[fieldName];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RtdbClientError(
      CLIENT_ERROR_CODE.Transport,
      `Response field ${fieldName} must be an integer or null: ${String(value)}`,
    );
  }
  return value;
}

function readSeriesField(body: unknown): JsonSeries {
  const record = requireObject(body, 'query/range response body');
  const series = requireObject(record.series, 'query/range response series');
  const points = series.points;
  if (!Array.isArray(points)) {
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, 'query/range response series.points must be an array');
  }
  return {
    metricName: String(series.metricName ?? ''),
    points: points.map((item) => requireJsonPoint(item, 'query/range point')),
  };
}

function requireJsonPoint(value: unknown, label: string): JsonPoint {
  const record = requireObject(value, label);
  const timestamp = record.t;
  const marker = record.vt;
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) {
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `${label}.t must be an integer timestamp`);
  }
  if (typeof marker !== 'number') {
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `${label}.vt must carry a value type marker`);
  }
  const point: JsonPoint = { t: timestamp, v: record.v as JsonPoint['v'], vt: marker as JsonPoint['vt'] };
  if (typeof record.q === 'number') point.q = record.q;
  return point;
}

function requireJsonWindow(value: unknown): JsonWindow {
  const record = requireObject(value, 'query/aggregate window');
  const marker = record.vt;
  if (typeof record.start !== 'number' || typeof record.end !== 'number' || typeof marker !== 'number') {
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, 'query/aggregate window is missing start/end/vt');
  }
  return {
    start: record.start,
    end: record.end,
    v: record.v as JsonWindow['v'],
    vt: marker as JsonWindow['vt'],
    count: typeof record.count === 'number' ? record.count : 0,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  const truncated = Math.trunc(value);
  if (!Number.isFinite(truncated)) return min;
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}

function delayMs(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}
