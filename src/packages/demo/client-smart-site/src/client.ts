// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Minimal rtdb HTTP client used by the Smart Site demo (zero third-party dependencies).
 *
 * It speaks the same wire protocol as `@ss/rtdb-client` (see `docs-o/zh/04-http-api.md`):
 *   - write: `POST /api/v1/write?db=<db>` with `{ metricName, t, v, vt, q? }[]`
 *   - query: `POST /api/v1/query/{range,last,count,aggregate}`
 *   - retry: only for `429 E_RATE_LIMITED` and transport failures, at most `maxRetries` extra attempts
 */

import type { SimulatedPoint } from './generator.ts';

/** Wire `vt` markers, identical to the server (`1`=f64, `2`=i64, `3`=bool, `4`=string) */
export const WIRE_VALUE_TYPE = {
  Float64: 1,
  Int64: 2,
  Bool: 3,
  String: 4,
} as const;
export type WireValueType = (typeof WIRE_VALUE_TYPE)[keyof typeof WIRE_VALUE_TYPE];

export interface WireWritePoint {
  metricName: string;
  t: number;
  v: number | string | boolean;
  vt: WireValueType;
  q?: number;
}

export interface WirePoint {
  t: number;
  v: number | string | boolean | null;
  vt: WireValueType;
  q?: number;
}

export interface WireWindow {
  start: number;
  end: number;
  v: number | string | boolean | null;
  vt: WireValueType;
  count: number;
}

export interface WireSeries {
  metricName: string;
  points: WirePoint[];
}

export interface DecodedPoint {
  timestamp: number;
  value: number | bigint | boolean | string;
  quality?: number;
}

export interface WriteResult {
  accepted: number;
  duplicates: number;
}

export interface MetricSummary {
  metricName: string;
  firstTs: number;
  lastTs: number;
}

export interface StatusSnapshot {
  uptimeMs?: number;
  databases?: number;
  metrics?: number;
  write?: {
    pointsPerSec?: number;
    buffered?: number;
    duplicates?: number;
  };
  [key: string]: unknown;
}

export interface DemoClientOptions {
  /** Base URL, e.g. `http://127.0.0.1:6180`; a trailing slash is ignored */
  baseUrl: string;
  /** Bearer token; empty = anonymous */
  token?: string;
  /** Per-request timeout (default 10 s) */
  timeoutMs?: number;
  /** Extra attempts after the first failure (default 3) */
  maxRetries?: number;
  /** Backoff base in ms (default 200) */
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 200;
const RETRYABLE_STATUS = 429;

/** Error carrying the HTTP status and the server error code (`E_*`) */
export class DemoHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DemoHttpError';
    this.status = status;
    this.code = code;
  }
}

/** SimulatedPoint -> wire JSON (i64 travels as a decimal string with `vt: 2`) */
export function encodeWritePoint(point: SimulatedPoint): WireWritePoint {
  const encoded = encodeWireValue(point.value);
  // No `q` is emitted: rtdb v0.1.0 (M0) only accepts quality 0, which is the wire default.
  return { metricName: point.metricName, t: point.timestamp, v: encoded.v, vt: encoded.vt };
}

function encodeWireValue(value: number | bigint | boolean | string): { v: number | string | boolean; vt: WireValueType } {
  if (typeof value === 'bigint') return { v: value.toString(), vt: WIRE_VALUE_TYPE.Int64 };
  if (typeof value === 'boolean') return { v: value, vt: WIRE_VALUE_TYPE.Bool };
  if (typeof value === 'string') return { v: value, vt: WIRE_VALUE_TYPE.String };
  return { v: value, vt: WIRE_VALUE_TYPE.Float64 };
}

/** Wire point -> decoded point (`vt: 2` becomes a bigint) */
export function decodeWirePoint(point: WirePoint): DecodedPoint {
  const decoded: DecodedPoint = { timestamp: point.t, value: decodeWireValue(point.v, point.vt) };
  if (point.q !== undefined) decoded.quality = point.q;
  return decoded;
}

/** Wire window -> decoded value (only the value is narrowed; `start`/`end`/`count` stay as-is) */
export function decodeWireWindowValue(window: WireWindow): number | bigint | boolean | string {
  return decodeWireValue(window.v, window.vt);
}

function decodeWireValue(value: number | string | boolean | null, vt: WireValueType): number | bigint | boolean | string {
  switch (vt) {
    case WIRE_VALUE_TYPE.Float64:
      return typeof value === 'number' ? value : 0;
    case WIRE_VALUE_TYPE.Int64:
      return typeof value === 'string' ? BigInt(value) : BigInt(Math.trunc(typeof value === 'number' ? value : 0));
    case WIRE_VALUE_TYPE.Bool:
      return value === true;
    case WIRE_VALUE_TYPE.String:
      return typeof value === 'string' ? value : '';
  }
}

export class DemoRtdbClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: DemoClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.token = (options.token ?? '').trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async writeBatch(database: string, points: readonly SimulatedPoint[]): Promise<WriteResult> {
    const body = points.map(encodeWritePoint);
    return this.request<WriteResult>('POST', `/api/v1/write?db=${encodeURIComponent(database)}`, body);
  }

  async queryLast(database: string, metricName: string): Promise<WirePoint | null> {
    const response = await this.request<{ point: WirePoint | null }>('POST', '/api/v1/query/last', {
      db: database,
      metricName,
    });
    return response.point;
  }

  async queryRange(
    database: string,
    metricName: string,
    start: number,
    end: number,
    limit?: number,
  ): Promise<WireSeries> {
    const body: Record<string, unknown> = { db: database, metricName, start, end, order: 'asc' };
    if (limit !== undefined) body.limit = limit;
    const response = await this.request<{ series: WireSeries }>('POST', '/api/v1/query/range', body);
    return response.series;
  }

  async queryCount(database: string, metricName: string, start: number, end: number, exact = true): Promise<number> {
    const response = await this.request<{ count: number }>('POST', '/api/v1/query/count', {
      db: database,
      metricName,
      start,
      end,
      exact,
    });
    return response.count;
  }

  async queryAggregate(
    database: string,
    metricName: string,
    start: number,
    end: number,
    windowMs: number,
    type: 'avg' | 'sum' | 'min' | 'max' | 'count' | 'last',
  ): Promise<WireWindow[]> {
    const response = await this.request<{ windows: WireWindow[] }>('POST', '/api/v1/query/aggregate', {
      db: database,
      metricName,
      start,
      end,
      windowMs,
      type,
    });
    return response.windows;
  }

  async listMetrics(database: string): Promise<MetricSummary[]> {
    const response = await this.request<{ metrics: MetricSummary[] }>(
      'GET',
      `/api/v1/metrics/${encodeURIComponent(database)}`,
    );
    return response.metrics;
  }

  async status(): Promise<StatusSnapshot> {
    return this.request<StatusSnapshot>('GET', '/api/v1/status');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.requestOnce<T>(method, path, body);
      } catch (error) {
        const httpError = error instanceof DemoHttpError ? error : null;
        const retryable = httpError === null || httpError.status === 0 || httpError.status === RETRYABLE_STATUS;
        if (!retryable || attempt >= this.maxRetries) throw error;
        await sleep(this.retryDelayMs * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  private async requestOnce<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token.length > 0) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DemoHttpError(0, 'E_NETWORK', `Cannot reach ${this.baseUrl}: ${describeError(error)}`);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new DemoHttpError(0, 'E_NETWORK', `Reading the response failed: ${describeError(error)}`);
    }
    if (!response.ok) {
      const parsed = parseJsonObject(text);
      const code = typeof parsed?.error === 'string' ? parsed.error : `E_HTTP_${response.status}`;
      const detail = typeof parsed?.message === 'string' ? parsed.message : text.trim();
      throw new DemoHttpError(response.status, code, detail.length > 0 ? detail : `HTTP ${response.status}`);
    }
    if (text.length === 0) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DemoHttpError(response.status, 'E_BAD_JSON', `Response is not JSON: ${text.slice(0, 120)}`);
    }
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
