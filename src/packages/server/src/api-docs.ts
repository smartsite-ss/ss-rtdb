// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `@ss/rtdb-server`: built-in API reference.
 *
 * The server ships its own reference page (`GET /api/docs`) and machine-readable OpenAPI 3.1 document
 * (`GET /api/docs/openapi.json`), both generated from the single `API_DOC_ENDPOINTS` table below. This
 * keeps the console, the reference page and the exported spec in sync without any third-party
 * documentation tooling (the runtime closure must stay dependency-free).
 *
 * Design points:
 *   - the page is a single self-contained HTML document (inline CSS + a tiny filter script): no CDN, so it
 *     works on an air-gapped industrial network;
 *   - it is always public, like `/status` and `/metrics`: it exposes the contract shape, never data;
 *   - endpoints are filtered by the running configuration (`compat.influx.enabled`, `admin.enabled`) so the
 *     page never advertises a route the instance does not serve;
 *   - all text is English (AGENTS.md §4 rule 11); the console links to it from its own localized nav.
 */

import type { ServerConfig } from './config.ts';
import { SERVER_VERSION } from './version.ts';

/** Human-readable reference page */
export const API_DOCS_PATH = '/api/docs';
/** Machine-readable OpenAPI 3.1 document */
export const API_DOCS_SPEC_PATH = '/api/docs/openapi.json';
export const API_DOCS_CONTENT_TYPE = 'text/html; charset=utf-8';
export const API_DOCS_SPEC_CONTENT_TYPE = 'application/json; charset=utf-8';

/* ---------- Model ---------- */

/** Authentication scope required by an endpoint (`none` = always public, `any` = any valid credential) */
export type ApiDocScope = 'none' | 'query' | 'write' | 'admin' | 'any';

export type ApiDocMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** One path, query or header parameter */
export interface ApiDocParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  type: string;
  required: boolean;
  description: string;
}

/** One field of a JSON request body */
export interface ApiDocField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ApiDocBody {
  /** Media types the endpoint accepts, in display order */
  mediaTypes: readonly string[];
  /** Documented JSON fields (omitted for raw Line Protocol bodies) */
  fields?: readonly ApiDocField[];
}

export interface ApiDocEndpoint {
  /** Group id from {@link API_DOC_GROUPS}; the group also determines the API family */
  group: string;
  method: ApiDocMethod;
  /** Path template; `{name}` placeholders match `parameters` with `in: 'path'` */
  path: string;
  summary: string;
  scope: ApiDocScope;
  parameters?: readonly ApiDocParameter[];
  body?: ApiDocBody;
  success: { status: number; description: string };
  notes?: readonly string[];
  /** Only served while the static console (`admin.enabled`) is on */
  console?: boolean;
  /** Skip in the OpenAPI document (redirects and static hosting) */
  openApi?: boolean;
}

/**
 * Top-level partition of the reference: the native ss-rtdb contract versus the InfluxDB compatibility
 * adapter. Every group belongs to exactly one family, so the page can present the two surfaces apart
 * (and hide the InfluxDB one entirely when `compat.influx.enabled=false`).
 */
export type ApiDocFamily = 'native' | 'influx';

export interface ApiDocFamilyMeta {
  id: ApiDocFamily;
  title: string;
  /** Path prefixes shown under the family heading */
  routes: string;
  description: string;
}

export interface ApiDocGroup {
  id: string;
  family: ApiDocFamily;
  title: string;
  description: string;
}

/** Recognized-but-unsupported InfluxDB endpoints (`501` + migration hint) */
export interface ApiDocUnsupported {
  paths: readonly string[];
  message: string;
  hint: string;
}

/* ---------- Groups ---------- */

export const API_DOC_FAMILIES: readonly ApiDocFamilyMeta[] = [
  {
    id: 'native',
    title: 'ss-rtdb native API',
    routes: '/api/v1/* · /metrics · /healthz · /health · /api/docs',
    description:
      'The product contract: four query primitives, idempotent writes, RBAC through the user/token directory. ' +
      'Stable across InfluxDB compatibility changes.',
  },
  {
    id: 'influx',
    title: 'InfluxDB compatibility',
    routes: '/write · /api/v2/* · /api/v3/* · /query · /ping',
    description:
      'A side adapter for InfluxDB clients and Grafana InfluxQL panels: Line Protocol writes with tag/field ' +
      'folding, plus an InfluxQL read-only subset. Everything lands in the same engine and the same auth ledger.',
  },
];

export const API_DOC_GROUPS: readonly ApiDocGroup[] = [
  {
    id: 'observability',
    family: 'native',
    title: 'Probes and metrics',
    description: 'Public endpoints for load balancers, Prometheus and connectivity checks.',
  },
  {
    id: 'catalog',
    family: 'native',
    title: 'Databases and metrics',
    description: 'Read the catalog: databases, on-disk footprint, retention override and metric summaries.',
  },
  {
    id: 'write',
    family: 'native',
    title: 'Write',
    description: 'Ingest points. Writes are idempotent on `(metric, timestamp)` and never overwrite existing data.',
  },
  {
    id: 'query',
    family: 'native',
    title: 'Query primitives',
    description: 'The four query primitives (`range`, `last`, `count`, `aggregate`) plus `at` for value lookup.',
  },
  {
    id: 'maintenance',
    family: 'native',
    title: 'Retention and backup',
    description: 'Per-database retention overrides and whole-database backups on the server host.',
  },
  {
    id: 'auth',
    family: 'native',
    title: 'Sign-in and sessions',
    description: 'Exchange a user name and password for an API token; inspect or revoke the current token.',
  },
  {
    id: 'admin',
    family: 'native',
    title: 'Users and API tokens',
    description: 'Administrative endpoints; always protected while authentication is enabled.',
  },
  {
    id: 'influx-write',
    family: 'influx',
    title: 'Line Protocol writes',
    description:
      'The same bulk-ingest pipeline behind three generations of write endpoints. Compatible with Telegraf, ' +
      'Vector and the official InfluxDB client libraries.',
  },
  {
    id: 'influx-query',
    family: 'influx',
    title: 'InfluxQL queries',
    description:
      'A read-only subset over the four native primitives, enough for Grafana InfluxQL dashboards and legacy scripts.',
  },
  {
    id: 'influx-probes',
    family: 'influx',
    title: 'Connectivity probes',
    description: 'Endpoints InfluxDB clients and Grafana ping before they write or query.',
  },
  {
    id: 'console',
    family: 'native',
    title: 'Console and docs',
    description: 'Static console hosting and this reference.',
  },
];

/* ---------- Endpoint table ---------- */

const DATABASE_PARAMETER: ApiDocParameter = {
  name: 'db',
  in: 'path',
  type: 'string',
  required: true,
  description: 'Database name: `^[a-zA-Z][a-zA-Z0-9_]{0,62}$`.',
};

export const API_DOC_ENDPOINTS: readonly ApiDocEndpoint[] = [
  /* --- Probes and metrics --- */
  {
    group: 'observability',
    method: 'GET',
    path: '/api/v1/status',
    summary: 'Runtime metrics and counters (uptime, write rate, WAL, cache, query latency, compat counters).',
    scope: 'none',
    success: { status: 200, description: 'JSON status snapshot.' },
    notes: ['Always public, even when `auth.enabled` is true.'],
  },
  {
    group: 'observability',
    method: 'GET',
    path: '/metrics',
    summary: 'Prometheus text exposition of the same counters as `/api/v1/status`.',
    scope: 'none',
    success: { status: 200, description: '`text/plain` exposition format.' },
    notes: ['Always public.'],
  },
  {
    group: 'observability',
    method: 'GET',
    path: '/healthz',
    summary: 'Liveness probe.',
    scope: 'none',
    success: { status: 200, description: '`{"status":"ok"}`.' },
    notes: ['Always public.'],
  },
  {
    group: 'observability',
    method: 'GET',
    path: '/health',
    summary: 'InfluxDB-shaped health probe used by Grafana and Telegraf connectivity checks.',
    scope: 'none',
    success: { status: 200, description: '`{"name":"ss-rtdb","status":"pass","version":…,"checks":[]}`.' },
    notes: ['Always public; returns `503` while the engine is not ready.'],
  },
  {
    group: 'influx-probes',
    method: 'GET',
    path: '/ping',
    summary: 'InfluxDB-compatible ping.',
    scope: 'none',
    success: { status: 204, description: 'Headers `X-Influxdb-Version`, `X-Rtdb-Version`, `X-Rtdb-Compat`.' },
  },

  /* --- Catalog --- */
  {
    group: 'catalog',
    method: 'GET',
    path: '/api/v1/databases',
    summary: 'List databases.',
    scope: 'query',
    success: { status: 200, description: '`{"databases":["plant_a","plant_b"]}`.' },
  },
  {
    group: 'catalog',
    method: 'GET',
    path: '/api/v1/databases/{db}',
    summary: 'On-disk footprint, per-day breakdown and the retention override of one database.',
    scope: 'query',
    parameters: [DATABASE_PARAMETER],
    success: {
      status: 200,
      description: '`database`, `directory`, `fileCount`, `totalBytes`, `breakdown`, `retentionDays`, `days[]`.',
    },
    notes: ['A pure filesystem snapshot: no data-root lock is taken, so it is safe while the instance is writing.'],
  },
  {
    group: 'catalog',
    method: 'GET',
    path: '/api/v1/metrics/{db}',
    summary: 'List the metrics of a database with their first/last timestamp and locked value type.',
    scope: 'query',
    parameters: [DATABASE_PARAMETER],
    success: {
      status: 200,
      description: '`{"metrics":[{"metricName":…,"firstTs":…,"lastTs":…,"valueType":1}]}`.',
    },
    notes: ['`valueType` is `1`=f64, `2`=i64, `3`=bool, `4`=string; `null` until a block is committed.'],
  },

  /* --- Write --- */
  {
    group: 'write',
    method: 'POST',
    path: '/api/v1/write',
    summary: 'Write points as a JSON array or as Line Protocol.',
    scope: 'write',
    parameters: [
      {
        name: 'db',
        in: 'query',
        type: 'string',
        required: true,
        description: 'Target database; created on first write.',
      },
    ],
    body: {
      mediaTypes: ['application/json', 'text/plain'],
      fields: [
        { name: 'metricName', type: 'string', required: true, description: 'Metric identity, ≤512 UTF-8 bytes.' },
        { name: 'timestamp | t', type: 'integer', required: true, description: 'Millisecond epoch.' },
        { name: 'value | v', type: 'any', required: true, description: 'Point value.' },
        { name: 'vt', type: 'integer', required: false, description: 'Type marker: `1` f64, `2` i64, `3` bool, `4` string.' },
        { name: 'quality | q', type: 'integer', required: false, description: 'Quality flag; only `0` is accepted in v0.1.0.' },
      ],
    },
    success: { status: 200, description: '`{"accepted":N,"duplicates":N}`.' },
    notes: [
      'Line Protocol tags are parsed and then ignored by the native parser; the compatibility `/write` folds them instead.',
      'Any invalid line rejects the whole batch (`400 E_INVALID_POINT`, `details` carries line numbers).',
      '`413 E_BATCH_TOO_LARGE` over `write.maxBatch` points or `http.maxBodyBytes`; `429 E_RATE_LIMITED` under backpressure.',
    ],
  },

  /* --- Query primitives --- */
  {
    group: 'query',
    method: 'POST',
    path: '/api/v1/query/range',
    summary: 'Raw points inside an inclusive time range.',
    scope: 'query',
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'db', type: 'string', required: true, description: 'Database name.' },
        { name: 'metricName', type: 'string', required: true, description: 'Metric name.' },
        { name: 'start', type: 'integer', required: true, description: 'Inclusive start, ms epoch.' },
        { name: 'end', type: 'integer', required: true, description: 'Inclusive end, ms epoch.' },
        { name: 'limit', type: 'integer', required: false, description: 'Defaults to `query.defaultLimit` (100000).' },
        { name: 'order', type: 'string', required: false, description: '`asc` (default) or `desc`.' },
      ],
    },
    success: { status: 200, description: '`{"series":{"metricName":…,"points":[…],"received":{"min":…,"max":…}}}`.' },
  },
  {
    group: 'query',
    method: 'POST',
    path: '/api/v1/query/last',
    summary: 'Latest point at or before a timestamp.',
    scope: 'query',
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'db', type: 'string', required: true, description: 'Database name.' },
        { name: 'metricName', type: 'string', required: true, description: 'Metric name.' },
        { name: 'before', type: 'integer', required: false, description: 'Upper bound, ms epoch; default = latest overall.' },
      ],
    },
    success: { status: 200, description: '`{"point":{"t":…,"v":…,"vt":…}}` (`point` is `null` when empty).' },
  },
  {
    group: 'query',
    method: 'POST',
    path: '/api/v1/query/count',
    summary: 'Point count of a range (index estimate or exact decode).',
    scope: 'query',
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'db', type: 'string', required: true, description: 'Database name.' },
        { name: 'metricName', type: 'string', required: true, description: 'Metric name.' },
        { name: 'start', type: 'integer', required: true, description: 'Inclusive start, ms epoch.' },
        { name: 'end', type: 'integer', required: true, description: 'Inclusive end, ms epoch.' },
        {
          name: 'exact',
          type: 'boolean',
          required: false,
          description: '`false` (default) sums block counts; `true` decodes and counts precisely.',
        },
      ],
    },
    success: { status: 200, description: '`{"count":N}`.' },
  },
  {
    group: 'query',
    method: 'POST',
    path: '/api/v1/query/aggregate',
    summary: 'Windowed aggregation over a time range.',
    scope: 'query',
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'db', type: 'string', required: true, description: 'Database name.' },
        { name: 'metricName', type: 'string', required: true, description: 'Metric name.' },
        { name: 'start', type: 'integer', required: true, description: 'Inclusive start, ms epoch.' },
        { name: 'end', type: 'integer', required: true, description: 'Inclusive end, ms epoch.' },
        { name: 'type', type: 'string', required: true, description: '`avg` | `sum` | `min` | `max` | `count` | `last`.' },
        { name: 'windowMs', type: 'integer', required: true, description: 'Window width in milliseconds.' },
      ],
    },
    success: { status: 200, description: '`{"windows":[{"start":…,"end":…,"v":…,"vt":…,"count":…}]}`.' },
    notes: [
      '`avg` is time-weighted (industrial convention); compute `sum / count` client-side for an equal-weight mean.',
      'A window with no coverage returns `v: null` and `count: 0`; more than 100000 windows → `400 E_INVALID_RANGE`.',
    ],
  },
  {
    group: 'query',
    method: 'POST',
    path: '/api/v1/query/at',
    summary: 'Point-in-time lookup with step or linear interpolation.',
    scope: 'query',
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'db', type: 'string', required: true, description: 'Database name.' },
        { name: 'metricName', type: 'string', required: true, description: 'Metric name.' },
        {
          name: 'timestamps',
          type: 'integer[]',
          required: true,
          description: 'Millisecond epochs, any order; at most 10000 per call.',
        },
        {
          name: 'mode',
          type: 'string',
          required: false,
          description: '`step` (default, previous-value hold) or `linear` (f64/i64 only).',
        },
      ],
    },
    success: {
      status: 200,
      description: '`{"points":[{"t":…,"v":…,"vt":…,"state":"exact|interpolated|extrapolated|no-data"}]}`.',
    },
  },

  /* --- Retention and backup --- */
  {
    group: 'maintenance',
    method: 'PUT',
    path: '/api/v1/retention/{db}',
    summary: 'Set the per-database retention override.',
    scope: 'write',
    parameters: [DATABASE_PARAMETER],
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'days', type: 'integer', required: true, description: 'Retention in days; `0` keeps data forever.' },
      ],
    },
    success: { status: 200, description: '`{"ok":true}`.' },
  },
  {
    group: 'maintenance',
    method: 'POST',
    path: '/api/v1/backup/{db}',
    summary: 'Trigger a whole-database backup on the server host.',
    scope: 'write',
    parameters: [DATABASE_PARAMETER],
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'targetDir', type: 'string', required: true, description: 'Destination directory on the server filesystem.' },
      ],
    },
    success: {
      status: 200,
      description: '`{"files":N,"totalBytes":N,"database":…,"targetDirectory":…}`.',
    },
  },

  /* --- Sign-in and sessions --- */
  {
    group: 'auth',
    method: 'POST',
    path: '/api/v1/auth/login',
    summary: 'Exchange a user name and password for an API token.',
    scope: 'none',
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'username', type: 'string', required: true, description: 'User name from the user directory.' },
        { name: 'password', type: 'string', required: true, description: 'Password.' },
        { name: 'ttlMs', type: 'integer', required: false, description: 'Token lifetime in ms; omitted = no expiry.' },
      ],
    },
    success: { status: 200, description: '`{"token":"<64 hex>","expiresAt":…,"user":{"username":…,"role":…}}`.' },
    notes: [
      'Issuing a new token revokes the same user\'s previous `console login` tokens (single-session semantics).',
      'Unknown user and wrong password both return `401 E_AUTH` (no user enumeration).',
    ],
  },
  {
    group: 'auth',
    method: 'GET',
    path: '/api/v1/auth/session',
    summary: 'Identity, credential source and granted scopes of the presented credential.',
    scope: 'any',
    success: { status: 200, description: '`{"user":{…},"source":"token|config|basic","scopes":["query","write","admin"]}`.' },
  },
  {
    group: 'auth',
    method: 'POST',
    path: '/api/v1/auth/logout',
    summary: 'Revoke the API token used by the request.',
    scope: 'any',
    success: { status: 200, description: '`{"ok":true,"revoked":true}`; static/config credentials report `revoked:false`.' },
  },

  /* --- Users and API tokens --- */
  {
    group: 'admin',
    method: 'GET',
    path: '/api/v1/admin/users',
    summary: 'List users (passwords are never returned).',
    scope: 'admin',
    success: { status: 200, description: '`{"users":[{"username":…,"role":…,"enabled":…,"createdAt":…}]}`.' },
  },
  {
    group: 'admin',
    method: 'POST',
    path: '/api/v1/admin/users',
    summary: 'Create a user.',
    scope: 'admin',
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'username', type: 'string', required: true, description: '`^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`.' },
        { name: 'password', type: 'string', required: true, description: 'Stored as a scrypt hash.' },
        { name: 'role', type: 'string', required: false, description: '`admin` | `write` | `readonly`.' },
        { name: 'enabled', type: 'boolean', required: false, description: 'Defaults to `true`.' },
      ],
    },
    success: { status: 201, description: '`{"user":{…}}`.' },
  },
  {
    group: 'admin',
    method: 'PUT',
    path: '/api/v1/admin/users/{username}',
    summary: 'Update the role, password or enabled state of a user.',
    scope: 'admin',
    parameters: [
      { name: 'username', in: 'path', type: 'string', required: true, description: 'User name.' },
    ],
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'password', type: 'string', required: false, description: 'New password.' },
        { name: 'role', type: 'string', required: false, description: '`admin` | `write` | `readonly`.' },
        { name: 'enabled', type: 'boolean', required: false, description: 'Enable or disable the account.' },
      ],
    },
    success: { status: 200, description: '`{"user":{…}}`.' },
  },
  {
    group: 'admin',
    method: 'DELETE',
    path: '/api/v1/admin/users/{username}',
    summary: 'Delete a user.',
    scope: 'admin',
    parameters: [
      { name: 'username', in: 'path', type: 'string', required: true, description: 'User name.' },
    ],
    success: { status: 200, description: '`{"ok":true}`.' },
  },
  {
    group: 'admin',
    method: 'GET',
    path: '/api/v1/admin/tokens',
    summary: 'List API tokens with runtime usage statistics.',
    scope: 'admin',
    success: {
      status: 200,
      description: '`{"tokens":[…],"configToken":{…}}`; each entry carries `lastUsedAt`, `lastDatabase`, `pointsPerSec`, `bytesPerSec`.',
    },
  },
  {
    group: 'admin',
    method: 'POST',
    path: '/api/v1/admin/tokens',
    summary: 'Issue an API token (the plaintext is returned once).',
    scope: 'admin',
    body: {
      mediaTypes: ['application/json'],
      fields: [
        { name: 'user', type: 'string', required: false, description: 'Owner user name; defaults to the caller.' },
        { name: 'role', type: 'string', required: false, description: '`admin` | `write` | `readonly`; defaults to the owner role.' },
        { name: 'label', type: 'string', required: false, description: 'Free-form label shown by the console.' },
        { name: 'ttlMs', type: 'integer', required: false, description: 'Lifetime in ms; omitted = no expiry.' },
      ],
    },
    success: { status: 201, description: '`{"token":"<64 hex>","tokenRecord":{…}}`.' },
  },
  {
    group: 'admin',
    method: 'DELETE',
    path: '/api/v1/admin/tokens/{tokenId}',
    summary: 'Revoke an API token.',
    scope: 'admin',
    parameters: [
      { name: 'tokenId', in: 'path', type: 'string', required: true, description: 'Token id (not the plaintext).' },
    ],
    success: { status: 200, description: '`{"ok":true}`.' },
  },

  /* --- InfluxDB compatibility --- */
  {
    group: 'influx-write',
    method: 'POST',
    path: '/write',
    summary: 'InfluxDB 1.x Line Protocol write.',
    scope: 'write',
    parameters: [
      { name: 'db', in: 'query', type: 'string', required: true, description: 'Target database.' },
      { name: 'precision', in: 'query', type: 'string', required: false, description: '`ns` (default) | `us` | `ms` | `s` | `m` | `h`.' },
      { name: 'u', in: 'query', type: 'string', required: false, description: 'Basic-auth user; only with `allowQueryCredentials`.' },
      { name: 'p', in: 'query', type: 'string', required: false, description: 'Basic-auth password; only with `allowQueryCredentials`.' },
    ],
    body: { mediaTypes: ['text/plain'] },
    success: { status: 204, description: 'Counters in `X-Rtdb-Accepted` / `X-Rtdb-Duplicates` / `X-Rtdb-Truncated-Points`.' },
  },
  {
    group: 'influx-write',
    method: 'POST',
    path: '/api/v2/write',
    summary: 'InfluxDB 2.x Line Protocol write (tags and fields folded into the metric name).',
    scope: 'write',
    parameters: [
      { name: 'org', in: 'query', type: 'string', required: true, description: 'Recorded only; `compat.influx.defaultOrg` may supply it.' },
      { name: 'bucket', in: 'query', type: 'string', required: true, description: 'Mapped to a database; the resolved name is echoed in `X-Rtdb-Database`.' },
      { name: 'precision', in: 'query', type: 'string', required: false, description: '`ns` (default) | `us` | `ms` | `s`.' },
      { name: 'Authorization', in: 'header', type: 'string', required: false, description: '`Token <t>`, `Bearer <t>` or `Basic <b64>`.' },
    ],
    body: { mediaTypes: ['text/plain'] },
    success: { status: 204, description: 'Same counters; `X-Rtdb-Database` carries the resolved database.' },
    notes: [
      'Tag keys are sorted and folded as `measurement|field|key=value`; `fieldFolding=metric` emits one metric per field.',
      'Bucket names are normalized deterministically (invalid characters → `_`, ≤63 chars); no bucket registry exists.',
    ],
  },
  {
    group: 'influx-write',
    method: 'POST',
    path: '/api/v3/write_lp',
    summary: 'InfluxDB 3 Core Line Protocol write.',
    scope: 'write',
    parameters: [
      { name: 'db', in: 'query', type: 'string', required: true, description: 'Target database.' },
      { name: 'precision', in: 'query', type: 'string', required: false, description: 'Short (`ns`…`h`) or full (`nanosecond`…) names.' },
      { name: 'no_sync', in: 'query', type: 'string', required: false, description: 'Accepted but ignored (`X-Rtdb-NoSync: ignored`) unless `rejectNoSync`.' },
      { name: 'accept_partial', in: 'query', type: 'string', required: false, description: '`true` → skip bad lines and answer `200` with `rejected[]`.' },
    ],
    body: { mediaTypes: ['text/plain'] },
    success: { status: 204, description: '`204` atomic; `200 {"accepted":N,"rejected":[…]}` with `accept_partial=true`.' },
  },
  {
    group: 'influx-query',
    method: 'GET',
    path: '/query',
    summary: 'InfluxQL read-only subset (v1 shape).',
    scope: 'query',
    parameters: [
      { name: 'db', in: 'query', type: 'string', required: true, description: 'Database name.' },
      { name: 'q', in: 'query', type: 'string', required: true, description: 'InfluxQL statement (`SELECT …` / `SHOW …`).' },
      { name: 'epoch', in: 'query', type: 'string', required: false, description: '`ns|u|ms|s|m|h`; default RFC3339 timestamps.' },
    ],
    success: { status: 200, description: '`{"results":[{"statement_id":0,"series":[…]}]}`; statement errors keep HTTP 200.' },
    notes: ['Registered only while `compat.influx.influxql=read-only`; otherwise `501` with a hint.'],
  },
  {
    group: 'influx-query',
    method: 'POST',
    path: '/query',
    summary: 'InfluxQL read-only subset via a form or JSON body.',
    scope: 'query',
    body: {
      mediaTypes: ['application/x-www-form-urlencoded', 'application/json'],
      fields: [
        { name: 'db', type: 'string', required: true, description: 'Database name.' },
        { name: 'q', type: 'string', required: true, description: 'InfluxQL statement.' },
        { name: 'epoch', type: 'string', required: false, description: 'Timestamp format.' },
      ],
    },
    success: { status: 200, description: 'Same shape as `GET /query`.' },
  },
  {
    group: 'influx-query',
    method: 'GET',
    path: '/api/v3/query_influxql',
    summary: 'InfluxQL read-only subset (InfluxDB 3 path).',
    scope: 'query',
    parameters: [
      { name: 'db', in: 'query', type: 'string', required: true, description: 'Database name.' },
      { name: 'q', in: 'query', type: 'string', required: true, description: 'InfluxQL statement.' },
      { name: 'format', in: 'query', type: 'string', required: false, description: '`json` only; `csv`/`parquet` → `501`.' },
    ],
    success: { status: 200, description: 'Same `{"results":[…]}` shape as v1.' },
  },
  {
    group: 'influx-query',
    method: 'POST',
    path: '/api/v3/query_influxql',
    summary: 'InfluxQL read-only subset (InfluxDB 3 path, JSON or form body).',
    scope: 'query',
    body: {
      mediaTypes: ['application/x-www-form-urlencoded', 'application/json'],
      fields: [
        { name: 'db', type: 'string', required: true, description: 'Database name.' },
        { name: 'q', type: 'string', required: true, description: 'InfluxQL statement.' },
        { name: 'format', type: 'string', required: false, description: '`json` only.' },
      ],
    },
    success: { status: 200, description: 'Same `{"results":[…]}` shape as v1.' },
  },

  /* --- Console and docs --- */
  {
    group: 'console',
    method: 'GET',
    path: '/api/docs',
    summary: 'This API reference page (self-contained HTML, public).',
    scope: 'none',
    success: { status: 200, description: '`text/html`.' },
  },
  {
    group: 'console',
    method: 'GET',
    path: '/api/docs/openapi.json',
    summary: 'OpenAPI 3.1 document generated from the same endpoint table.',
    scope: 'none',
    success: { status: 200, description: '`application/json` OpenAPI 3.1 object.' },
  },
  {
    group: 'console',
    method: 'GET',
    path: '/admin/',
    summary: 'Static web console (`admin.enabled`).',
    scope: 'none',
    success: { status: 200, description: '`text/html` bundle.' },
    console: true,
    openApi: false,
  },
  {
    group: 'console',
    method: 'GET',
    path: '/',
    summary: 'Redirect to `/admin/`; returns `404` when `admin.enabled=false`.',
    scope: 'none',
    success: { status: 302, description: '`Location: /admin/`.' },
    console: true,
    openApi: false,
  },
];

/** InfluxDB endpoints that are recognized but answer `501` with a migration hint */
export const API_DOC_UNSUPPORTED: readonly ApiDocUnsupported[] = [
  {
    paths: ['/api/v2/query'],
    message: 'Flux is not supported',
    hint: 'Use /query (InfluxQL subset) or the native /api/v1/query/* endpoints',
  },
  {
    paths: ['/api/v3/query_sql'],
    message: 'SQL is not supported',
    hint: 'Use /api/v3/query_influxql (InfluxQL subset) or the native /api/v1/query/* endpoints',
  },
  {
    paths: ['/api/v2/buckets', '/api/v2/buckets/{id}'],
    message: 'Bucket management is not supported',
    hint: 'List databases with GET /api/v1/databases, set retention with PUT /api/v1/retention/:db, and write with bucket=<name>',
  },
  {
    paths: ['/api/v3/configure/*'],
    message: 'InfluxDB 3 configure APIs are not supported',
    hint: 'Manage databases with /api/v1/databases and write with /api/v3/write_lp',
  },
  {
    paths: ['/api/v2/setup'],
    message: 'The setup API is not supported',
    hint: 'Create the first administrator with rtdbctl or the bootstrap settings (auth.bootstrapUsername)',
  },
  {
    paths: ['/api/v2/signin', '/api/v2/signout', '/api/v2/me'],
    message: 'Sign-in/session APIs are not supported',
    hint: 'Use POST /api/v1/auth/login or a Bearer/Token credential',
  },
  {
    paths: ['/api/v2/tasks', '/api/v2/tasks/{id}'],
    message: 'Tasks are not supported',
    hint: 'Query from the client or use /api/v1/query/* on a schedule',
  },
  {
    paths: ['/api/v2/orgs', '/api/v2/authorizations'],
    message: 'Organizations and authorizations are not supported',
    hint: 'ss-rtdb is single-tenant; use /api/v1/admin/users and /api/v1/admin/tokens',
  },
];

/* ---------- Selection ---------- */

const GROUP_BY_ID: ReadonlyMap<string, ApiDocGroup> = new Map(API_DOC_GROUPS.map((group) => [group.id, group]));

/** API family of an endpoint, derived from its group (unknown ids fall back to the native family) */
export function apiDocFamilyOf(endpoint: ApiDocEndpoint): ApiDocFamily {
  return GROUP_BY_ID.get(endpoint.group)?.family ?? 'native';
}

/** Group definition of an endpoint; `undefined` only when the table references an unknown group id */
export function apiDocGroupOf(endpoint: ApiDocEndpoint): ApiDocGroup | undefined {
  return GROUP_BY_ID.get(endpoint.group);
}

/** Endpoints actually served by this configuration, in table order */
export function visibleApiDocEndpoints(config: ServerConfig): readonly ApiDocEndpoint[] {
  return API_DOC_ENDPOINTS.filter((endpoint) => {
    if (apiDocFamilyOf(endpoint) === 'influx' && !config.compat.influx.enabled) return false;
    if (endpoint.console === true && !config.admin.enabled) return false;
    return true;
  });
}

/* ---------- OpenAPI 3.1 ---------- */

function operationIdOf(endpoint: ApiDocEndpoint): string {
  const suffix = endpoint.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${endpoint.method.toLowerCase()}_${suffix}`;
}

function openApiTypeOf(type: string): string {
  if (type.endsWith('[]')) return 'array';
  if (type === 'integer' || type === 'number' || type === 'boolean') return type;
  if (type === 'object') return 'object';
  return 'string';
}

function openApiParameter(parameter: ApiDocParameter): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: openApiTypeOf(parameter.type) };
  if (parameter.type.endsWith('[]')) schema.items = { type: openApiTypeOf(parameter.type.slice(0, -2)) };
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required,
    description: parameter.description,
    schema,
  };
}

function openApiRequestBody(body: ApiDocBody): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const mediaType of body.mediaTypes) {
    if (body.fields === undefined || mediaType !== 'application/json') {
      content[mediaType] = { schema: { type: 'string' } };
      continue;
    }
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of body.fields) {
      const schema: Record<string, unknown> = { type: openApiTypeOf(field.type), description: field.description };
      if (field.type.endsWith('[]')) schema.items = { type: openApiTypeOf(field.type.slice(0, -2)) };
      properties[field.name] = schema;
      if (field.required) required.push(field.name);
    }
    content[mediaType] = {
      schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    };
  }
  return { required: true, content };
}

/** Build the OpenAPI 3.1 document for the endpoints this configuration serves */
export function buildOpenApiDocument(config: ServerConfig): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = [
    ...API_DOC_FAMILIES.map((family) => ({ name: family.id, description: family.description })),
    ...API_DOC_GROUPS.map((group) => ({ name: group.id, description: group.description })),
  ];

  for (const endpoint of visibleApiDocEndpoints(config)) {
    if (endpoint.openApi === false) continue;
    const family = apiDocFamilyOf(endpoint);
    const operation: Record<string, unknown> = {
      operationId: operationIdOf(endpoint),
      tags: [family, endpoint.group],
      'x-family': family,
      summary: endpoint.summary,
      responses: {
        [String(endpoint.success.status)]: {
          description: endpoint.success.description,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        '4XX': {
          description: 'Request error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        '5XX': {
          description: 'Server error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    };
    if (endpoint.notes !== undefined && endpoint.notes.length > 0) operation.description = endpoint.notes.join(' ');
    operation.security =
      endpoint.scope === 'none' ? [] : [{ bearerAuth: [] }, { basicAuth: [] }];
    if (endpoint.parameters !== undefined && endpoint.parameters.length > 0) {
      operation.parameters = endpoint.parameters.map(openApiParameter);
    }
    if (endpoint.body !== undefined) operation.requestBody = openApiRequestBody(endpoint.body);
    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ss-rtdb HTTP API',
      version: SERVER_VERSION,
      description:
        'Real-time / time-series database. Native API under /api/v1 plus the InfluxDB compatibility adapter. ' +
        'Generated from the server route metadata; see /api/docs for the human-readable reference.',
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    servers: [{ url: '/' }],
    tags,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        basicAuth: { type: 'http', scheme: 'basic' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error', 'message'],
          properties: {
            error: { type: 'string', description: 'Stable machine-readable error code.' },
            message: { type: 'string', description: 'Human-readable detail.' },
            details: { type: 'array', items: {}, description: 'Optional per-line or per-window details.' },
          },
        },
      },
    },
  };
}

/* ---------- HTML reference ---------- */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a documentation string and turn `\`code\`` spans into `<code>` elements.
 * All inputs are compile-time constants, so the only markup ever introduced is the one added here.
 */
function formatInline(value: string): string {
  return escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function methodClass(method: ApiDocMethod): string {
  return method.toLowerCase();
}

function scopeLabel(scope: ApiDocScope): string {
  switch (scope) {
    case 'none':
      return 'public';
    case 'any':
      return 'any credential';
    default:
      return scope;
  }
}

function anchorOf(endpoint: ApiDocEndpoint): string {
  return `${endpoint.method.toLowerCase()}-${endpoint.path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

function renderParameterTable(parameters: readonly ApiDocParameter[]): string {
  const rows = parameters
    .map(
      (parameter) =>
        `<tr><td><code>${escapeHtml(parameter.name)}</code></td><td>${escapeHtml(parameter.in)}</td>` +
        `<td>${escapeHtml(parameter.type)}</td><td>${parameter.required ? 'required' : 'optional'}</td>` +
        `<td>${formatInline(parameter.description)}</td></tr>`,
    )
    .join('');
  return (
    '<table class="params"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`
  );
}

function renderFieldTable(fields: readonly ApiDocField[]): string {
  const rows = fields
    .map(
      (field) =>
        `<tr><td><code>${escapeHtml(field.name)}</code></td><td>${escapeHtml(field.type)}</td>` +
        `<td>${field.required ? 'required' : 'optional'}</td><td>${formatInline(field.description)}</td></tr>`,
    )
    .join('');
  return (
    '<table class="params"><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`
  );
}

function renderBody(body: ApiDocBody): string {
  const mediaTypes = body.mediaTypes.map((mediaType) => `<code>${escapeHtml(mediaType)}</code>`).join(', ');
  const chain: string[] = [`<p class="hint-line">Body: ${mediaTypes}</p>`];
  if (body.fields !== undefined && body.fields.length > 0) chain.push(renderFieldTable(body.fields));
  return chain.join('');
}

function renderEndpoint(endpoint: ApiDocEndpoint): string {
  const family = apiDocFamilyOf(endpoint);
  const groupTitle = apiDocGroupOf(endpoint)?.title ?? endpoint.group;
  // The family / group names are part of the search index, so filtering by "influx" or "backup" works.
  const search = `${endpoint.method} ${endpoint.path} ${endpoint.summary} ${family} ${groupTitle}`.toLowerCase();
  const parts: string[] = [];
  parts.push(
    `<article class="endpoint" id="${anchorOf(endpoint)}" data-search="${escapeHtml(search)}">`,
  );
  parts.push(
    '<div class="endpoint-head">' +
      `<span class="method ${methodClass(endpoint.method)}">${endpoint.method}</span>` +
      `<code class="path">${escapeHtml(endpoint.path)}</code>` +
      `<span class="scope scope-${endpoint.scope}">${escapeHtml(scopeLabel(endpoint.scope))}</span>` +
      '</div>',
  );
  parts.push(`<p class="summary">${formatInline(endpoint.summary)}</p>`);
  if (endpoint.parameters !== undefined && endpoint.parameters.length > 0) {
    parts.push(renderParameterTable(endpoint.parameters));
  }
  if (endpoint.body !== undefined) parts.push(renderBody(endpoint.body));
  parts.push(
    `<p class="success"><span class="status">${endpoint.success.status}</span> ` +
      `${formatInline(endpoint.success.description)}</p>`,
  );
  if (endpoint.notes !== undefined && endpoint.notes.length > 0) {
    const items = endpoint.notes.map((note) => `<li>${formatInline(note)}</li>`).join('');
    parts.push(`<ul class="notes">${items}</ul>`);
  }
  parts.push('</article>');
  return parts.join('\n');
}

function renderGroup(
  group: ApiDocGroup,
  endpoints: readonly ApiDocEndpoint[],
): string {
  if (endpoints.length === 0) return '';
  return (
    `<section class="group" data-group="true" id="group-${group.id}">` +
    `<h2>${escapeHtml(group.title)}<span class="count">${endpoints.length}</span></h2>` +
    `<p class="group-desc">${formatInline(group.description)}</p>` +
    endpoints.map(renderEndpoint).join('\n') +
    '</section>'
  );
}

/** One top-level family block: heading plus its groups (and, for InfluxDB, the `501` table) */
function renderFamily(
  family: ApiDocFamilyMeta,
  groups: readonly { group: ApiDocGroup; endpoints: readonly ApiDocEndpoint[] }[],
  extraHtml: string,
): string {
  const total = groups.reduce((sum, entry) => sum + entry.endpoints.length, 0);
  return (
    `<section class="family" id="family-${family.id}" data-family="${family.id}">` +
    '<header class="family-head">' +
    `<div class="family-title"><span class="family-tag ${family.id}">${family.id === 'native' ? 'ss-rtdb' : 'InfluxDB'}</span>` +
    `<h2>${escapeHtml(family.title)}<span class="count">${total}</span></h2></div>` +
    `<code class="family-routes">${escapeHtml(family.routes)}</code>` +
    `<p class="family-desc">${formatInline(family.description)}</p>` +
    '</header>' +
    groups.map((entry) => renderGroup(entry.group, entry.endpoints)).join('\n') +
    extraHtml +
    '</section>'
  );
}

function renderUnsupported(entries: readonly ApiDocUnsupported[]): string {
  if (entries.length === 0) return '';
  const rows = entries
    .map((entry) => {
      const search = `${entry.paths.join(' ')} ${entry.message} ${entry.hint}`.toLowerCase();
      return (
        `<tr class="unsupported-row" data-search="${escapeHtml(search)}">` +
        `<td>${entry.paths.map((path) => `<code>${escapeHtml(path)}</code>`).join('<br>')}</td>` +
        `<td>${formatInline(entry.message)}</td><td>${formatInline(entry.hint)}</td></tr>`
      );
    })
    .join('');
  return (
    '<section class="group" id="unsupported">' +
    '<h2>Recognized but not implemented<span class="count">501</span></h2>' +
    `<p class="group-desc">${formatInline(
      'These InfluxDB endpoints answer `501` with a machine-readable `message` and a migration `hint`.',
    )}</p>` +
    '<table class="params"><thead><tr><th>Path</th><th>Message</th><th>Hint</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>` +
    '</section>'
  );
}

function renderIntro(
  config: ServerConfig,
  families: readonly { family: ApiDocFamilyMeta; count: number }[],
): string {
  const compat = config.compat.influx.enabled
    ? `enabled (InfluxQL: <code>${escapeHtml(config.compat.influx.influxql)}</code>)`
    : 'disabled';
  const consoleState = config.admin.enabled ? 'served at <code>/admin/</code>' : 'disabled (<code>admin.enabled=false</code>)';
  const cards = families
    .map(
      (entry) =>
        `<a class="family-card ${entry.family.id}" href="#family-${entry.family.id}">` +
        '<span class="family-card-head">' +
        `<span class="family-tag ${entry.family.id}">${entry.family.id === 'native' ? 'ss-rtdb' : 'InfluxDB'}</span>` +
        `<span class="family-card-count">${entry.count} endpoints</span></span>` +
        `<span class="family-card-title">${escapeHtml(entry.family.title)}</span>` +
        `<span class="family-card-desc">${formatInline(entry.family.description)}</span>` +
        `<code class="family-card-routes">${escapeHtml(entry.family.routes)}</code></a>`,
    )
    .join('');
  return (
    '<section class="intro">' +
    '<h1>ss-rtdb API reference</h1>' +
    `<p class="lede">Two separate surfaces, generated from the running configuration: the native ss-rtdb ` +
    `contract and the InfluxDB compatibility adapter. Machine-readable copy: ` +
    `<a href="${API_DOCS_SPEC_PATH}">${API_DOCS_SPEC_PATH}</a>.</p>` +
    `<div class="family-cards">${cards}</div>` +
    '<div class="facts">' +
    `<div><span class="fact-label">Version</span><span>${escapeHtml(SERVER_VERSION)}</span></div>` +
    '<div><span class="fact-label">Base path</span><code>/api/v1</code></div>' +
    `<div><span class="fact-label">InfluxDB compatibility</span><span>${compat}</span></div>` +
    `<div><span class="fact-label">Web console</span><span>${consoleState}</span></div>` +
    '</div>' +
    '<h3>Authentication</h3>' +
    '<table class="params"><thead><tr><th>Mode</th><th>Header</th></tr></thead><tbody>' +
    '<tr><td><code>token</code> (default)</td><td><code>Authorization: Bearer &lt;token&gt;</code></td></tr>' +
    '<tr><td><code>basic</code></td><td><code>Authorization: Basic base64(username:password)</code></td></tr>' +
    '<tr><td>InfluxDB 2.x clients</td><td><code>Authorization: Token &lt;token&gt;</code> (compatibility endpoints only)</td></tr>' +
    '<tr><td>Sign in</td><td><code>POST /api/v1/auth/login</code> → <code>{token}</code></td></tr>' +
    '</tbody></table>' +
    '<h3>Scopes</h3>' +
    '<p class="hint-line"><span class="scope scope-none">public</span> no credential · ' +
    '<span class="scope scope-query">query</span> read · ' +
    '<span class="scope scope-write">write</span> ingest / retention / backup · ' +
    '<span class="scope scope-admin">admin</span> users and tokens.</p>' +
    '<h3>Errors</h3>' +
    '<p class="hint-line">Non-2xx responses are JSON: <code>{"error":"E_CODE","message":"…","details":[]}</code>. ' +
    'Compatibility endpoints use the InfluxDB family shape (<code>{"code","message","hint"?}</code> for v2, ' +
    '<code>{"error","hint"?}</code> for v1/v3). <code>429</code> carries <code>Retry-After: 1</code>.</p>' +
    '</section>'
  );
}

/** Render the self-contained HTML reference for this configuration */
export function renderApiDocsPage(config: ServerConfig): string {
  const endpoints = visibleApiDocEndpoints(config);
  const groups = API_DOC_GROUPS.map((group) => ({
    group,
    endpoints: endpoints.filter((endpoint) => endpoint.group === group.id),
  })).filter((entry) => entry.endpoints.length > 0);

  // Two top-level families; a family with no visible group disappears entirely (InfluxDB when disabled).
  const families = API_DOC_FAMILIES.map((family) => ({
    family,
    groups: groups.filter((entry) => entry.group.family === family.id),
    count: endpoints.filter((endpoint) => apiDocFamilyOf(endpoint) === family.id).length,
  })).filter((entry) => entry.groups.length > 0);

  const toc = families
    .map((entry) => {
      const groupLinks = entry.groups
        .map(
          (group) =>
            `<a class="toc-link" href="#group-${group.group.id}">` +
            `<span>${escapeHtml(group.group.title)}</span><span class="count">${group.endpoints.length}</span></a>`,
        )
        .join('');
      const unsupportedLink =
        entry.family.id === 'influx' && API_DOC_UNSUPPORTED.length > 0
          ? '<a class="toc-link" href="#unsupported"><span>501 responses</span>' +
            `<span class="count">${API_DOC_UNSUPPORTED.length}</span></a>`
          : '';
      return (
        `<a class="toc-family ${entry.family.id}" href="#family-${entry.family.id}">` +
        `<span>${escapeHtml(entry.family.title)}</span><span class="count">${entry.count}</span></a>` +
        groupLinks +
        unsupportedLink
      );
    })
    .join('');

  const body = families
    .map((entry) =>
      renderFamily(
        entry.family,
        entry.groups,
        entry.family.id === 'influx' ? renderUnsupported(API_DOC_UNSUPPORTED) : '',
      ),
    )
    .join('\n');
  const consoleLink = config.admin.enabled ? '<a href="/admin/">Console</a>' : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>ss-rtdb API reference · ${escapeHtml(SERVER_VERSION)}</title>
<style>
:root {
  --bg: #f5f7fb;
  --panel: #ffffff;
  --text: #0f172a;
  --muted: #64748b;
  --line: #e2e8f0;
  --line-strong: #cbd5e1;
  --accent: #2563eb;
  --get: #0284c7;
  --post: #16a34a;
  --put: #d97706;
  --delete: #dc2626;
  --any: #7c3aed;
  --radius: 10px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace;
  font-size: 12.5px;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 20px;
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 15px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15); }
.brand .muted { color: var(--muted); font-weight: 500; }
.ver { padding: 1px 8px; border: 1px solid var(--line-strong); border-radius: 999px; font-size: 11.5px; color: var(--muted); }
.top-links { display: flex; gap: 16px; font-size: 13px; }
.layout { display: grid; grid-template-columns: 258px minmax(0, 1fr); max-width: 1440px; margin: 0 auto; }
.sidebar {
  position: sticky;
  top: 53px;
  align-self: start;
  max-height: calc(100vh - 53px);
  overflow: auto;
  padding: 18px 14px 48px;
  background: var(--panel);
  border-right: 1px solid var(--line);
}
.filter {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  margin-bottom: 14px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  font-size: 13px;
  outline: none;
}
.filter:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12); }
.toc { display: flex; flex-direction: column; gap: 2px; }
.toc-link {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 7px;
  color: var(--text);
  font-size: 13px;
}
.toc-link:hover { background: #eef2ff; text-decoration: none; }
.toc-link .count { color: var(--muted); font-size: 11.5px; }
.content { padding: 26px 30px 80px; min-width: 0; }
.intro, .group {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 20px 22px;
  margin-bottom: 18px;
}
h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.01em; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; font-size: 17px; }
h3 { margin: 18px 0 8px; font-size: 14px; }
.lede { margin: 0 0 14px; color: var(--muted); }
.group-desc { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px 18px;
  padding: 12px 14px;
  background: #f8fafc;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 13px;
}
.facts > div { display: flex; gap: 8px; }
.fact-label { color: var(--muted); min-width: 132px; }
.family-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  margin: 0 0 16px;
}
.family-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 9px;
  color: var(--text);
}
.family-card.influx { border-left-color: var(--any); }
.family-card:hover { text-decoration: none; border-color: var(--line-strong); box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06); }
.family-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.family-card-count { color: var(--muted); font-size: 12px; }
.family-card-title { font-weight: 650; font-size: 14px; }
.family-card-desc { color: var(--muted); font-size: 12.5px; }
.family-card-routes { color: var(--accent); font-size: 12px; word-break: break-all; }
.family {
  background: var(--panel);
  border: 1px solid var(--line);
  border-top: 3px solid var(--accent);
  border-radius: var(--radius);
  padding: 18px 22px 8px;
  margin-bottom: 18px;
}
.family[data-family="influx"] { border-top-color: var(--any); }
.family-head { padding-bottom: 12px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.family-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.family-title h2 { margin: 0; font-size: 18px; }
.family-tag {
  padding: 1px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  font: 600 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: 0.03em;
}
.family-tag.native { background: #e0f2fe; border-color: #bae6fd; color: #075985; }
.family-tag.influx { background: #ede9fe; border-color: #ddd6fe; color: #5b21b6; }
.family-routes { display: block; margin-top: 6px; color: var(--muted); font-size: 12px; }
.family-desc { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.family .group {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 14px 0 0;
  margin: 0;
}
.family .group h2 { font-size: 15px; }
.toc-family {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 14px 0 4px;
  padding: 6px 10px;
  border-radius: 7px;
  background: #f1f5f9;
  border-left: 3px solid var(--accent);
  color: var(--text);
  font-size: 12.5px;
  font-weight: 650;
}
.toc-family.influx { border-left-color: var(--any); }
.toc-family:hover { background: #e2e8f0; text-decoration: none; }
.toc-family:first-child { margin-top: 0; }
.toc-link { padding-left: 18px; }
.hint-line { margin: 6px 0; color: var(--muted); font-size: 12.8px; }
.endpoint {
  padding: 14px 0 12px;
  border-top: 1px solid var(--line);
}
.endpoint:first-of-type { border-top: none; }
.endpoint-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.method {
  min-width: 58px;
  padding: 2px 0;
  border-radius: 5px;
  color: #fff;
  font: 600 11.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
  text-align: center;
  letter-spacing: 0.02em;
}
.method.get { background: var(--get); }
.method.post { background: var(--post); }
.method.put { background: var(--put); }
.method.delete { background: var(--delete); }
.path { font-size: 13.5px; font-weight: 600; word-break: break-all; }
.scope {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.scope-none { color: #475569; background: #f1f5f9; border-color: #e2e8f0; }
.scope-query { color: #075985; background: #e0f2fe; border-color: #bae6fd; }
.scope-write { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
.scope-admin { color: #9a3412; background: #ffedd5; border-color: #fed7aa; }
.scope-any { color: #5b21b6; background: #ede9fe; border-color: #ddd6fe; }
.summary { margin: 8px 0 10px; }
.params { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 12.8px; }
.params th, .params td {
  padding: 6px 10px 6px 0;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--line);
}
.params th { color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.03em; }
.params tr:last-child td { border-bottom: none; }
.success { margin: 6px 0; }
.status {
  display: inline-block;
  min-width: 34px;
  padding: 1px 7px;
  border-radius: 5px;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  color: #047857;
  font: 600 11.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
}
.notes { margin: 6px 0 0; padding-left: 20px; color: var(--muted); font-size: 12.8px; }
.notes li { margin: 2px 0; }
.count {
  margin-left: 4px;
  padding: 0 7px;
  border-radius: 999px;
  background: #eef2ff;
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
}
.hidden { display: none !important; }
#empty { display: none; padding: 24px; text-align: center; color: var(--muted); }
#empty.visible { display: block; }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { position: static; max-height: none; border-right: none; border-bottom: 1px solid var(--line); }
  .content { padding: 18px 16px 60px; }
  .top-links { display: none; }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand"><span class="dot"></span>ss-rtdb <span class="muted">API reference</span><span class="ver">v${escapeHtml(SERVER_VERSION)}</span></div>
  <div class="top-links">
    ${consoleLink}
    <a href="${API_DOCS_SPEC_PATH}">OpenAPI 3.1</a>
    <a href="/api/v1/status">Status</a>
  </div>
</header>
<div class="layout">
  <aside class="sidebar">
    <input id="filter" class="filter" type="search" placeholder="Filter endpoints…  ( / )" autocomplete="off" spellcheck="false" />
    <nav class="toc">${toc}</nav>
  </aside>
  <main class="content">
    ${renderIntro(config, families)}
    ${body}
    <div id="empty">No endpoint matches the filter.</div>
  </main>
</div>
<script>
(function () {
  var filter = document.getElementById('filter');
  var items = Array.prototype.slice.call(document.querySelectorAll('.endpoint, .unsupported-row'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('section.group[data-group]'));
  var families = Array.prototype.slice.call(document.querySelectorAll('section.family'));
  var unsupported = document.getElementById('unsupported');
  var empty = document.getElementById('empty');

  function visibleCount(scope) {
    return scope.querySelectorAll('.endpoint:not(.hidden), .unsupported-row:not(.hidden)').length;
  }

  function applyFilter() {
    var query = filter.value.trim().toLowerCase();
    var visible = 0;
    items.forEach(function (node) {
      var hit = query.length === 0 || (node.getAttribute('data-search') || '').indexOf(query) !== -1;
      node.classList.toggle('hidden', !hit);
      if (hit) visible += 1;
    });
    groups.forEach(function (node) {
      node.classList.toggle('hidden', visibleCount(node) === 0);
    });
    if (unsupported) unsupported.classList.toggle('hidden', visibleCount(unsupported) === 0);
    families.forEach(function (node) {
      node.classList.toggle('hidden', visibleCount(node) === 0);
    });
    if (empty) empty.className = visible === 0 ? 'visible' : '';
  }

  if (filter) {
    filter.addEventListener('input', applyFilter);
    document.addEventListener('keydown', function (event) {
      if (event.key === '/' && document.activeElement !== filter) {
        event.preventDefault();
        filter.focus();
      }
    });
  }
})();
</script>
</body>
</html>
`;
}
