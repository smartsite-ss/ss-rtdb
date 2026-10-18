// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Public REST client of the rtdb-admin console.
 *
 * Only the endpoints documented in "Detailed Design" §3.1 are used (status read, database and metric
 * listing, range query, retention policy write, backup trigger, admin user / token management), so the
 * same build works against any rtdb-server instance, bundled or remote.
 */

import type { AdminSettings } from './settings';

/** Value type markers, mirroring the WAL / JSON protocol `vt` field (§3.1) */
export const RTDB_VALUE_TYPE = {
  float64: 1,
  int64: 2,
  bool: 3,
  string: 4,
} as const;

export interface RtdbJsonPoint {
  /** millisecond epoch */
  t: number;
  /** f64 → number, i64 → decimal string, bool → boolean, string → string, non-finite f64 → null */
  v: number | string | boolean | null;
  vt: number;
  q?: number;
}

export interface RtdbJsonSeries {
  metricName: string;
  points: RtdbJsonPoint[];
  /** Server receive-time window over the queried range (ms epoch); absent when unavailable */
  received?: { min: number; max: number };
}

export interface RtdbMetricSummary {
  metricName: string;
  firstTs: number;
  lastTs: number;
  /** Value type marker locked on the metric's first write (mirrors the JSON `vt` marker; null when unknown) */
  valueType: number | null;
}

/** `POST /api/v1/query/aggregate` window: `[start, end)` with the aggregated value and its sample count */
export interface RtdbAggregateWindow {
  start: number;
  end: number;
  /** f64 → number, i64 → decimal string, bool → boolean, string → string, no coverage → null */
  v: number | string | boolean | null;
  vt: number;
  count: number;
}

/** Operators accepted by `POST /api/v1/query/aggregate` (mirrors `AggregateType` in the engine) */
export const RTDB_AGGREGATE_TYPE = {
  avg: 'avg',
  sum: 'sum',
  min: 'min',
  max: 'max',
  count: 'count',
  last: 'last',
} as const;
export type RtdbAggregateType = (typeof RTDB_AGGREGATE_TYPE)[keyof typeof RTDB_AGGREGATE_TYPE];

/** Modes accepted by `POST /api/v1/query/at` (mirrors `InterpolationMode` in the engine; `nearest` planned) */
export const RTDB_INTERPOLATION_MODE = {
  step: 'step',
  linear: 'linear',
} as const;
export type RtdbInterpolationMode = (typeof RTDB_INTERPOLATION_MODE)[keyof typeof RTDB_INTERPOLATION_MODE];

/** `POST /api/v1/query/at` result point: value at a requested timestamp plus its provenance */
export interface RtdbAtPoint {
  /** requested timestamp (millisecond epoch, echoed) */
  t: number;
  /** f64 → number, i64 → decimal string, bool → boolean, string → string; null = no data */
  v: number | string | boolean | null;
  vt: number;
  /** `exact` = a real stored point; `interpolated`/`extrapolated` = computed (linear only); `no-data` */
  state: 'exact' | 'interpolated' | 'extrapolated' | 'no-data';
}

export interface RtdbStatusReport {
  uptimeMs: number;
  databases: number;
  metrics: number;
  write: { pointsPerSec: number; buffered: number; duplicates: number; tagsIgnored: number };
  wal: { pendingBytes: number; outstandingBatches: number; pendingPoints: number; lastFsyncMs: number };
  segments: { openFiles: number; bytesToday: number };
  cpu: { percent: number; systemPercent: number; userMs: number; systemMs: number };
  memory: {
    rssMb: number;
    heapTotalMb: number;
    heapUsedMb: number;
    externalMb: number;
    systemTotalMb: number;
    systemPercent: number;
    heapPercent: number;
  };
  cache: { blocks: number; blockHitRate: number; heapUsedMb: number; externalMb: number };
  gc: { count: number; totalMs: number; maxMs: number };
  query: { count: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
}

export interface RtdbPublicUser {
  username: string;
  role: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RtdbPublicToken {
  tokenId: string;
  user: string;
  role: string;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  /** Last authenticated request (ms); `null` when the token was never used */
  lastUsedAt: number | null;
  /** Database of the last request that addressed one; `null` for admin-only usage */
  lastDatabase: string | null;
  /** Accepted points/s over the server's rolling window (reset on restart) */
  pointsPerSec: number;
  /** Request payload bytes/s over the rolling window (reset on restart) */
  bytesPerSec: number;
}

/**
 * Usage of the **static** `auth.token` (`rtdb.token`). That credential has no record in the token store, but
 * clients such as the Smart Site demo write with it, so the server reports its runtime usage separately.
 */
export interface RtdbConfigTokenUsage {
  user: string;
  lastUsedAt: number | null;
  lastDatabase: string | null;
  pointsPerSec: number;
  bytesPerSec: number;
}

/** `GET /api/v1/admin/tokens`: persisted token records plus the static-token usage snapshot */
export interface RtdbTokenListReport {
  tokens: RtdbPublicToken[];
  /** Absent on servers predating the usage statistics */
  configToken?: RtdbConfigTokenUsage;
}

/** Day range of a range backup (`null` for a whole-database backup); days are `yyyyMMdd` in server local time */
export interface RtdbBackupRange {
  startDay: number;
  endDay: number;
  dayCount: number;
  startTimestamp: number;
  endTimestamp: number;
}

/** Raw `POST /api/v1/backup/{db}` response (the server reports `files`, not `fileCount`) */
interface RtdbBackupResponse {
  database: string;
  targetDirectory: string;
  files: number;
  totalBytes: number;
  partial?: boolean;
  range?: RtdbBackupRange | null;
  days?: number[] | null;
}

export interface RtdbBackupResult {
  database: string;
  targetDirectory: string;
  fileCount: number;
  totalBytes: number;
  /** `true` = range backup (restoring it merges those days, it does not replace the database) */
  partial: boolean;
  range: RtdbBackupRange | null;
  /** Day directories copied (`yyyyMMdd`, ascending); `null` for a whole-database backup */
  days: number[] | null;
}

export interface IssueTokenResult {
  /** Plaintext token; returned by the server exactly once */
  token: string;
  tokenRecord: RtdbPublicToken;
}

/** `POST /api/v1/auth/login` result: the plaintext token is returned once, then kept by the browser only */
export interface RtdbLoginResult {
  token: string;
  expiresAt: number | null;
  user: { username: string; role: string };
}

/** `GET /api/v1/auth/session` result: who the current token belongs to and which scopes its role grants */
export interface RtdbSessionInfo {
  user: { username: string; role: string };
  source: string;
  scopes: string[];
}

/** Footer of one day directory inside a database (`yyyyMMdd`) */
export interface RtdbDatabaseDaySize {
  dateNumber: number;
  /** `yyyyMMdd` label */
  dayLabel: string;
  fileCount: number;
  totalBytes: number;
}

/** Byte split by file role, so the console can show segments / index / WAL separately */
export interface RtdbDatabaseSizeBreakdown {
  segmentBytes: number;
  indexBytes: number;
  walBytes: number;
  otherBytes: number;
}

/** `GET /api/v1/databases/{database}` result: on-disk footprint plus the database-level retention override */
export interface RtdbDatabaseReport {
  database: string;
  /** Absolute database directory on the server */
  directory: string;
  fileCount: number;
  totalBytes: number;
  breakdown: RtdbDatabaseSizeBreakdown;
  /** Database-level retention override; `null` = absent (the global default applies) */
  retentionDays: number | null;
  /** Per-day detail, `yyyyMMdd` ascending */
  days: RtdbDatabaseDaySize[];
}

/** Error raised for a non-2xx REST response; `status` / `code` mirror the §3.3 error table */
export class RtdbAdminApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RtdbAdminApiError';
    this.status = status;
    this.code = code;
  }
}

interface RtdbErrorBody {
  error?: unknown;
  message?: unknown;
}

export class RtdbAdminApiClient {
  private readonly apiBaseUrl: string;
  private readonly accessToken: string;

  constructor(settings: AdminSettings) {
    this.apiBaseUrl = settings.apiBaseUrl;
    this.accessToken = settings.accessToken;
  }

  getStatus(): Promise<RtdbStatusReport> {
    return this.request<RtdbStatusReport>('GET', '/api/v1/status');
  }

  /** Liveness probe; useful as a connection test for a remote server */
  getHealth(): Promise<{ status: string }> {
    return this.request<{ status: string }>('GET', '/healthz');
  }

  /**
   * `POST /api/v1/auth/login` — exchange a user name + password for an API token. Sent without the current
   * `Authorization` header so a stale / invalid token cannot interfere with signing in.
   */
  login(username: string, password: string): Promise<RtdbLoginResult> {
    return this.request<RtdbLoginResult>('POST', '/api/v1/auth/login', { username, password }, false);
  }

  /** `GET /api/v1/auth/session` — identity and scopes of the token currently in use */
  getSession(): Promise<RtdbSessionInfo> {
    return this.request<RtdbSessionInfo>('GET', '/api/v1/auth/session');
  }

  /** `POST /api/v1/auth/logout` — revoke the token in use (`revoked: false` for the static config token) */
  logout(): Promise<{ ok: boolean; revoked: boolean }> {
    return this.request<{ ok: boolean; revoked: boolean }>('POST', '/api/v1/auth/logout');
  }

  async listDatabases(): Promise<string[]> {
    const body = await this.request<{ databases: string[] }>('GET', '/api/v1/databases');
    return body.databases;
  }

  /** `GET /api/v1/databases/{database}` — directory, on-disk size and retention of one database */
  getDatabaseReport(database: string): Promise<RtdbDatabaseReport> {
    return this.request<RtdbDatabaseReport>('GET', `/api/v1/databases/${encodeURIComponent(database)}`);
  }

  async listMetrics(database: string): Promise<RtdbMetricSummary[]> {
    const body = await this.request<{ metrics: RtdbMetricSummary[] }>('GET', `/api/v1/metrics/${encodeURIComponent(database)}`);
    return body.metrics;
  }

  /**
   * `POST /api/v1/query/last` — newest point at or before `before` (`null` = this metric has no point yet)
   *
   * Used by the metric inventory to show a live value per row; one call per metric, so callers should cap the
   * number of metrics and the concurrency.
   */
  async queryLast(database: string, metricName: string, before?: number): Promise<RtdbJsonPoint | null> {
    const body = await this.request<{ point: RtdbJsonPoint | null }>('POST', '/api/v1/query/last', {
      db: database,
      metricName,
      ...(before === undefined ? {} : { before }),
    });
    return body.point ?? null;
  }

  /**
   * Latest point of many metrics in **one** round trip (`POST /api/v1/query/last-batch`).
   *
   * Returns a name → point map in response (= request) order; unknown or empty metrics map to `null`. The
   * inventory page feeds its visible rows here, so a 10 000-metric database still issues one request per page
   * instead of one request per row.
   */
  async queryLastBatch(
    database: string,
    metricNames: readonly string[],
    before?: number,
  ): Promise<Record<string, RtdbJsonPoint | null>> {
    const body = await this.request<{ points: Array<{ metricName: string; point: RtdbJsonPoint | null }> }>(
      'POST',
      '/api/v1/query/last-batch',
      {
        db: database,
        metricNames,
        ...(before === undefined ? {} : { before }),
      },
    );
    const latest: Record<string, RtdbJsonPoint | null> = {};
    for (const entry of body.points ?? []) latest[entry.metricName] = entry.point ?? null;
    return latest;
  }

  async queryRange(database: string, metricName: string, start: number, end: number, limit: number): Promise<RtdbJsonSeries> {
    const body = await this.request<{ series: RtdbJsonSeries }>('POST', '/api/v1/query/range', {
      db: database,
      metricName,
      start,
      end,
      limit,
      order: 'asc',
    });
    return body.series;
  }

  /**
   * `POST /api/v1/query/aggregate` — windowed aggregation over `[start, end)`.
   *
   * `avg` is the engine's **time-weighted** average (neighbours just outside the window are linearly
   * interpolated); a window without coverage comes back with `v: null` and `count: 0`.
   */
  async queryAggregate(
    database: string,
    metricName: string,
    start: number,
    end: number,
    type: RtdbAggregateType,
    windowMs: number,
  ): Promise<RtdbAggregateWindow[]> {
    const body = await this.request<{ windows: RtdbAggregateWindow[] }>('POST', '/api/v1/query/aggregate', {
      db: database,
      metricName,
      start,
      end,
      type,
      windowMs,
    });
    return body.windows;
  }

  /**
   * `POST /api/v1/query/at` — batch point-in-time interpolated lookup (at most 10 000 timestamps
   * per call). `step` = previous-value hold; `linear` = piecewise-linear between real neighbours
   * (f64/i64 metrics only). Each point's `state` tells a real stored value from a computed one.
   */
  async queryAt(
    database: string,
    metricName: string,
    timestamps: number[],
    mode: RtdbInterpolationMode,
  ): Promise<RtdbAtPoint[]> {
    const body = await this.request<{ points: RtdbAtPoint[] }>('POST', '/api/v1/query/at', {
      db: database,
      metricName,
      timestamps,
      mode,
    });
    return body.points;
  }

  async setRetentionDays(database: string, days: number): Promise<void> {
    await this.request<{ ok: boolean }>('PUT', `/api/v1/retention/${encodeURIComponent(database)}`, { days });
  }

  /**
   * Trigger a backup; `targetDirectory` is required and must be non-empty (§3.1)
   *
   * `range.startDay` / `range.endDay` (`yyyy-MM-dd`, inclusive) restrict the backup to those day directories;
   * leaving both empty produces a whole-database backup.
   */
  async backup(
    database: string,
    targetDirectory: string,
    range?: { startDay?: string; endDay?: string },
  ): Promise<RtdbBackupResult> {
    const body: Record<string, string> = { targetDir: targetDirectory };
    if (range?.startDay !== undefined && range.startDay.length > 0) body.startDay = range.startDay;
    if (range?.endDay !== undefined && range.endDay.length > 0) body.endDay = range.endDay;
    const raw = await this.request<RtdbBackupResponse>(
      'POST',
      `/api/v1/backup/${encodeURIComponent(database)}`,
      body,
    );
    return {
      database: raw.database,
      targetDirectory: raw.targetDirectory,
      fileCount: raw.files,
      totalBytes: raw.totalBytes,
      partial: raw.partial === true,
      range: raw.range ?? null,
      days: raw.days ?? null,
    };
  }

  async listUsers(): Promise<RtdbPublicUser[]> {
    const body = await this.request<{ users: RtdbPublicUser[] }>('GET', '/api/v1/admin/users');
    return body.users;
  }

  listTokens(): Promise<RtdbTokenListReport> {
    return this.request<RtdbTokenListReport>('GET', '/api/v1/admin/tokens');
  }

  issueToken(user: string, role: string | null, label: string, ttlMs: number | null): Promise<IssueTokenResult> {
    const body: Record<string, string | number> = { user, label };
    if (role !== null && role.length > 0) body.role = role;
    if (ttlMs !== null) body.ttlMs = ttlMs;
    return this.request<IssueTokenResult>('POST', '/api/v1/admin/tokens', body);
  }

  async revokeToken(tokenId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/api/v1/admin/tokens/${encodeURIComponent(tokenId)}`);
  }

  /** Resolve a numeric value for charting; i64 decimal strings, numbers and booleans (0/1) are accepted, others yield null */
  static toNumericValue(point: RtdbJsonPoint): number | null {
    if (typeof point.v === 'number') return Number.isFinite(point.v) ? point.v : null;
    if (typeof point.v === 'boolean') return point.v ? 1 : 0;
    if (typeof point.v === 'string' && point.vt === RTDB_VALUE_TYPE.int64) {
      const parsed = Number(point.v);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private async request<TResponse>(
    method: string,
    path: string,
    body?: unknown,
    withAuth = true,
  ): Promise<TResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (withAuth && this.accessToken.length > 0) headers.Authorization = `Bearer ${this.accessToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) throw toApiError(response.status, text);
    return (text.length === 0 ? null : JSON.parse(text)) as TResponse;
  }
}

function toApiError(status: number, text: string): RtdbAdminApiError {
  let code = `HTTP_${status}`;
  let message = text;
  try {
    const body = JSON.parse(text) as RtdbErrorBody;
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // Non-JSON error body (for example an HTML page from a proxy) falls back to HTTP_<status>.
  }
  return new RtdbAdminApiError(status, code, message.length > 0 ? message : `HTTP ${status}`);
}
