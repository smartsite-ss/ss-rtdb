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
}

export interface RtdbMetricSummary {
  metricName: string;
  firstTs: number;
  lastTs: number;
}

export interface RtdbStatusReport {
  uptimeMs: number;
  databases: number;
  metrics: number;
  write: { pointsPerSec: number; buffered: number; duplicates: number; tagsIgnored: number };
  wal: { pendingBytes: number; outstandingBatches: number; pendingPoints: number; lastFsyncMs: number };
  segments: { openFiles: number; bytesToday: number };
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
}

export interface RtdbBackupResult {
  database: string;
  targetDirectory: string;
  fileCount: number;
  totalBytes: number;
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

  async listMetrics(database: string): Promise<RtdbMetricSummary[]> {
    const body = await this.request<{ metrics: RtdbMetricSummary[] }>('GET', `/api/v1/metrics/${encodeURIComponent(database)}`);
    return body.metrics;
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

  async setRetentionDays(database: string, days: number): Promise<void> {
    await this.request<{ ok: boolean }>('PUT', `/api/v1/retention/${encodeURIComponent(database)}`, { days });
  }

  /** Trigger a backup; `targetDirectory` is required and must be non-empty (§3.1) */
  backup(database: string, targetDirectory: string): Promise<RtdbBackupResult> {
    return this.request<RtdbBackupResult>('POST', `/api/v1/backup/${encodeURIComponent(database)}`, {
      targetDir: targetDirectory,
    });
  }

  async listUsers(): Promise<RtdbPublicUser[]> {
    const body = await this.request<{ users: RtdbPublicUser[] }>('GET', '/api/v1/admin/users');
    return body.users;
  }

  async listTokens(): Promise<RtdbPublicToken[]> {
    const body = await this.request<{ tokens: RtdbPublicToken[] }>('GET', '/api/v1/admin/tokens');
    return body.tokens;
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

  /** Resolve a numeric value for charting; i64 decimal strings and numbers are accepted, others yield null */
  static toNumericValue(point: RtdbJsonPoint): number | null {
    if (typeof point.v === 'number') return Number.isFinite(point.v) ? point.v : null;
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
