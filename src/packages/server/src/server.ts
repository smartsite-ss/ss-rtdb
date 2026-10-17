// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `@ss/rtdb-server`: Form B standalone service (`node:http` hand-written routing, no framework)
 *
 * Implements the "Detailed Design v2.0" §3.1 route table, §3.2 authentication, §3.3 error codes, §3.4 status metrics and `/admin` static hosting.
 * Design points:
 *   - Reuses the engine already opened in the same process (Form A mounts an HTTP shell) or creates its own engine; it is responsible for closing only when this class is the one that opened it.
 *   - Database existence / metric existence are explicitly determined at the server layer before falling through to core (core returns empty results for a nonexistent database and does not throw 404).
 *   - Single-batch points and request body bytes are both capped (413 `E_BATCH_TOO_LARGE`); core backpressure (429) is passed through as-is + `Retry-After: 1`.
 *   - `/status` is always exempt from authentication; write / query endpoints are authorized by `auth.write` / `auth.query` respectively.
 *   - `/metrics` (Prometheus exposition of the §3.4 status metrics) and `/healthz` (liveness probe) are always exempt from authentication too.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODE, RtdbError } from '../../core/src/errors.ts';
import { RtdbEngine } from '../../core/src/engine.ts';
import type { AggregateType, RangeOptions, WritePoint } from '../../core/src/types.ts';
import { AuthVerifier, hashPassword, loadOrCreateAuthToken } from './auth.ts';
import type { AuthScope } from './auth.ts';
import { toEngineOptions, validateServerConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { HttpFailure, SERVER_ERROR_CODE, toHttpErrorResponse } from './http-error.ts';
import { decodeWritePointBatch, encodeAggregateWindows, encodeMetricSummaries, encodePoint, encodeSeries } from './json-codec.ts';
import { parseLineProtocol } from './line-protocol.ts';
import { Logger } from './logger.ts';
import { PROMETHEUS_METRICS_CONTENT_TYPE, encodePrometheusMetrics } from './metrics.ts';
import { TokenStore } from './tokens.ts';
import type { TokenRecord } from './tokens.ts';
import { USER_ROLE, UserStore, isUserRole } from './users.ts';
import type { UserRecord, UserRole } from './users.ts';

/* ---------- Constants ---------- */

/** Database name rules: first char a letter, subsequent letters / digits / underscores, ≤63 chars (§6.2.1) */
const DATABASE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;

const AGGREGATE_TYPES: readonly AggregateType[] = ['avg', 'sum', 'min', 'max', 'count', 'last'];

const ADMIN_PATH = '/admin';
const ADMIN_USERS_PATH = '/api/v1/admin/users';
const ADMIN_USERS_PREFIX = '/api/v1/admin/users/';
const ADMIN_TOKENS_PATH = '/api/v1/admin/tokens';
const ADMIN_TOKENS_PREFIX = '/api/v1/admin/tokens/';
const METRICS_PREFIX = '/api/v1/metrics/';
/** Prometheus scrape endpoint (§3.4 exposition, S14); always exempt from authentication */
const PROMETHEUS_METRICS_PATH = '/metrics';
/** Liveness probe (S14); always exempt from authentication */
const HEALTHZ_PATH = '/healthz';
const RETENTION_PREFIX = '/api/v1/retention/';
const BACKUP_PREFIX = '/api/v1/backup/';

/** User name rules: first char a letter, subsequent letters / digits / `_` / `-` / `.`, ≤64 chars */
const USER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------- Public types ---------- */

export interface RtdbServerOptions {
  config: ServerConfig;
  /** Reuse an externally opened engine (Form A mounts the HTTP shell in the same process); defaults to this class creating its own */
  engine?: RtdbEngine;
  logger?: Logger;
}

export interface RtdbServerAddress {
  host: string;
  port: number;
}

/* ---------- Service ---------- */

export class RtdbServer {
  readonly config: ServerConfig;
  readonly engine: RtdbEngine;

  private readonly logger: Logger;
  private auth: AuthVerifier | null = null;
  private userStore: UserStore | null = null;
  private tokenStore: TokenStore | null = null;
  private httpServer: Server | null = null;
  private boundAddress: RtdbServerAddress | null = null;
  private openedEngine = false;
  private tagsIgnoredCount = 0;

  constructor(options: RtdbServerOptions) {
    this.config = options.config;
    this.logger = options.logger ?? new Logger(options.config.log.level);
    if (options.engine !== undefined) {
      this.engine = options.engine;
    } else {
      this.engine = new RtdbEngine(toEngineOptions(options.config));
    }
  }

  /** Bound address (null when not started) */
  get address(): RtdbServerAddress | null {
    return this.boundAddress;
  }

  /* ---------- Lifecycle ---------- */

  async start(): Promise<RtdbServerAddress> {
    if (this.httpServer !== null) {
      throw new RtdbError(ERROR_CODE.Internal, 'rtdb-server is already started');
    }
    validateServerConfig(this.config);
    this.userStore = this.buildUserStore();
    this.tokenStore = this.buildTokenStore();
    this.auth = this.buildAuthVerifier();

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });

    try {
      if (!this.engine.isOpen) {
        await this.engine.open();
        this.openedEngine = true;
      }
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = (error: Error): void => rejectPromise(error);
        server.once('error', onError);
        server.listen(this.config.port, this.config.host, () => {
          server.off('error', onError);
          resolvePromise();
        });
      });
    } catch (error) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      if (this.openedEngine) {
        this.openedEngine = false;
        await this.engine.close();
      }
      throw new RtdbError(ERROR_CODE.Io, `Failed to start rtdb-server: ${(error as Error).message}`);
    }

    const address = server.address();
    if (address === null || typeof address === 'string') {
      await this.stop();
      throw new RtdbError(ERROR_CODE.Internal, 'Unable to resolve the listen address');
    }

    this.httpServer = server;
    this.boundAddress = { host: address.address, port: address.port };
    if (this.config.admin.enabled) {
      const rootDirectory = this.resolveAdminRoot();
      if (!existsSync(rootDirectory)) {
        this.logger.warn(`Built-in admin is enabled but the static resource directory does not exist: ${rootDirectory} (GET /admin/* will return 404)`);
      }
    }
    return this.boundAddress;
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    this.boundAddress = null;
    if (server !== null) {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeIdleConnections();
      });
    }
    if (this.openedEngine) {
      this.openedEngine = false;
      await this.engine.close();
    }
  }

  private buildUserStore(): UserStore {
    const store = new UserStore({ filePath: this.resolveAuthStorePath(this.config.auth.usersFile, 'rtdb-users.json') });
    store.load();
    return store;
  }

  private buildTokenStore(): TokenStore {
    const store = new TokenStore({ filePath: this.resolveAuthStorePath(this.config.auth.tokensFile, 'rtdb-tokens.json') });
    store.load();
    return store;
  }

  /** Resolve a user / token store path: a configured path wins, otherwise it defaults to `{dataDir}/{fileName}` */
  private resolveAuthStorePath(configuredPath: string, defaultFileName: string): string {
    if (configuredPath.length > 0) return resolve(configuredPath);
    return join(resolve(this.config.dataDir), defaultFileName);
  }

  private buildAuthVerifier(): AuthVerifier {
    const auth = this.config.auth;
    if (!auth.enabled) {
      return new AuthVerifier({
        enabled: false,
        mode: auth.mode,
        token: '',
        username: auth.username,
        passwordHash: '',
        write: auth.write,
        query: auth.query,
      });
    }
    let token = auth.token;
    if (auth.mode !== 'basic' && token.length === 0) {
      token = loadOrCreateAuthToken(resolve(auth.tokenFile), this.logger);
    }
    let passwordHash = auth.passwordHash;
    if (passwordHash.length === 0 && auth.password.length > 0) {
      passwordHash = hashPassword(auth.password);
      this.logger.warn('Generated a scrypt hash from the plaintext auth.password (in-memory only; consider switching to auth.passwordHash on disk)');
    }
    return new AuthVerifier({
      enabled: true,
      mode: auth.mode,
      token,
      username: auth.username,
      passwordHash,
      write: auth.write,
      query: auth.query,
      tokenStore: this.tokenStore,
    });
  }

  /* ---------- Request dispatch ---------- */

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.dispatch(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const mapped = toHttpErrorResponse(error);
      this.logger.warn(`Request failed: ${request.method ?? '-'} ${request.url ?? '-'} → ${mapped.status} ${mapped.body.error}`);
      this.sendJson(response, mapped.status, mapped.body, mapped.headers);
    }
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    const pathname = url.pathname;

    // Opt-in CORS: when the operator allowlists an origin, the standalone rtdb-admin form can call
    // this instance directly. Error responses inherit the header too, so the browser can read them.
    const corsOrigin = this.resolveCorsOrigin(request);
    if (corsOrigin !== null) {
      response.setHeader('Access-Control-Allow-Origin', corsOrigin);
      if (corsOrigin !== '*') response.setHeader('Vary', 'Origin');
    }
    if (method === 'OPTIONS' && corsOrigin !== null) {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Max-Age', '600');
      response.writeHead(204);
      response.end();
      return;
    }

    if (pathname === '/api/v1/status') {
      if (method !== 'GET') throw methodNotAllowed('GET');
      await this.handleStatus(response);
      return;
    }
    if (pathname === PROMETHEUS_METRICS_PATH) {
      if (method !== 'GET') throw methodNotAllowed('GET');
      await this.handlePrometheusMetrics(response);
      return;
    }
    if (pathname === HEALTHZ_PATH) {
      if (method !== 'GET') throw methodNotAllowed('GET');
      this.handleHealthz(response);
      return;
    }
    if (pathname === '/api/v1/databases') {
      if (method !== 'GET') throw methodNotAllowed('GET');
      await this.handleDatabases(request, response);
      return;
    }
    if (pathname === '/api/v1/write') {
      if (method !== 'POST') throw methodNotAllowed('POST');
      await this.handleWrite(request, response, url);
      return;
    }
    if (pathname === '/api/v1/query/range') {
      if (method !== 'POST') throw methodNotAllowed('POST');
      await this.handleQueryRange(request, response);
      return;
    }
    if (pathname === '/api/v1/query/last') {
      if (method !== 'POST') throw methodNotAllowed('POST');
      await this.handleQueryLast(request, response);
      return;
    }
    if (pathname === '/api/v1/query/count') {
      if (method !== 'POST') throw methodNotAllowed('POST');
      await this.handleQueryCount(request, response);
      return;
    }
    if (pathname === '/api/v1/query/aggregate') {
      if (method !== 'POST') throw methodNotAllowed('POST');
      await this.handleQueryAggregate(request, response);
      return;
    }
    if (pathname === ADMIN_USERS_PATH) {
      await this.handleAdminUsers(request, response, method);
      return;
    }
    if (pathname.startsWith(ADMIN_USERS_PREFIX)) {
      await this.handleAdminUser(request, response, method, safeDecode(pathname.slice(ADMIN_USERS_PREFIX.length)));
      return;
    }
    if (pathname === ADMIN_TOKENS_PATH) {
      await this.handleAdminTokens(request, response, method);
      return;
    }
    if (pathname.startsWith(ADMIN_TOKENS_PREFIX)) {
      await this.handleAdminToken(request, response, method, safeDecode(pathname.slice(ADMIN_TOKENS_PREFIX.length)));
      return;
    }
    if (pathname.startsWith(METRICS_PREFIX)) {
      if (method !== 'GET') throw methodNotAllowed('GET');
      await this.handleMetrics(request, response, requireDatabaseName(safeDecode(pathname.slice(METRICS_PREFIX.length))));
      return;
    }
    if (pathname.startsWith(RETENTION_PREFIX)) {
      if (method !== 'PUT') throw methodNotAllowed('PUT');
      await this.handleRetention(request, response, requireDatabaseName(safeDecode(pathname.slice(RETENTION_PREFIX.length))));
      return;
    }
    if (pathname.startsWith(BACKUP_PREFIX)) {
      if (method !== 'POST') throw methodNotAllowed('POST');
      await this.handleBackup(request, response, requireDatabaseName(safeDecode(pathname.slice(BACKUP_PREFIX.length))));
      return;
    }
    if (pathname === '/') {
      if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed('GET');
      // The console lives under `/admin/`, so a bare-origin visit is redirected instead of returning
      // the JSON 404 (`E_NOT_FOUND: Unregistered route: /`), which reads like a broken deployment.
      // 302 (not 301) keeps the hop out of browser caches if `admin.enabled` is switched off later.
      if (!this.config.admin.enabled) throw routeNotFound(pathname);
      response.setHeader('Location', `${ADMIN_PATH}/`);
      response.writeHead(302);
      response.end();
      return;
    }
    if (pathname === ADMIN_PATH) {
      if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed('GET');
      // `index.html` references its assets relatively (`./assets/...`), so the document URL must end
      // with a slash; otherwise the browser resolves them against `/` and every asset 404s.
      response.setHeader('Location', `${ADMIN_PATH}/`);
      response.writeHead(301);
      response.end();
      return;
    }
    if (pathname.startsWith(`${ADMIN_PATH}/`)) {
      if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed('GET');
      await this.handleAdmin(pathname, response);
      return;
    }
    throw routeNotFound(pathname);
  }

  /**
   * Origin allowed to call this server from another origin (CORS, opt-in through `cors.allowedOrigins`).
   * Returns `null` when CORS is disabled or the request carries no allowed `Origin`; the caller then
   * emits no CORS header at all.
   */
  private resolveCorsOrigin(request: IncomingMessage): string | null {
    const allowedOrigins = this.config.cors.allowedOrigins;
    if (allowedOrigins.length === 0) return null;
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0) return null;
    if (allowedOrigins.includes('*')) return '*';
    return allowedOrigins.includes(origin) ? origin : null;
  }

  /* ---------- Route handlers ---------- */

  /**
   * Enforce the credential for a scope. Returns quietly when the scope needs no credential; otherwise:
   * `401 E_AUTH` when the credential is missing / invalid, `403 E_FORBIDDEN` when it is valid but the role does
   * not grant the scope (RBAC denial).
   */
  private requireAuth(request: IncomingMessage, scope: AuthScope): void {
    const auth = this.auth;
    if (auth === null) throw new RtdbError(ERROR_CODE.Internal, 'Authenticator not initialized');
    if (!auth.isScopeProtected(scope)) return;
    const principal = auth.authenticate(request.headers);
    if (principal === null) {
      throw new RtdbError(ERROR_CODE.Auth, `Authentication failed (scope=${scope})`);
    }
    if (!auth.roleAllows(principal.role, scope)) {
      throw new HttpFailure(
        403,
        SERVER_ERROR_CODE.Forbidden,
        `Role "${principal.role}" (user "${principal.username}") is not allowed to access scope "${scope}"`,
      );
    }
  }

  private async handleStatus(response: ServerResponse): Promise<void> {
    const stats = await this.engine.stats();
    this.sendJson(response, 200, {
      uptimeMs: stats.uptimeMs,
      databases: stats.databases,
      metrics: stats.metrics,
      write: {
        pointsPerSec: stats.write.pointsPerSec,
        buffered: stats.write.bufferedPoints,
        duplicates: stats.write.duplicatePoints,
        tagsIgnored: this.tagsIgnoredCount,
      },
      wal: {
        pendingBytes: stats.wal.pendingBytes,
        outstandingBatches: stats.wal.outstandingBatches,
        pendingPoints: stats.wal.pendingPoints,
        lastFsyncMs: stats.wal.lastFsyncMs,
      },
      segments: { openFiles: stats.segments.openFiles, bytesToday: stats.segments.bytesToday },
      cache: {
        blocks: stats.cache.blocks,
        blockHitRate: stats.cache.blockHitRate,
        heapUsedMb: stats.cache.heapUsedMb,
        externalMb: stats.cache.externalMb,
      },
      gc: stats.gc,
      query: stats.query,
    });
  }

  /** Prometheus text exposition of the §3.4 status metrics (S14); exempt from authentication like `/status` */
  private async handlePrometheusMetrics(response: ServerResponse): Promise<void> {
    const stats = await this.engine.stats();
    const body = encodePrometheusMetrics({ stats, tagsIgnored: this.tagsIgnoredCount });
    this.sendText(response, 200, body, PROMETHEUS_METRICS_CONTENT_TYPE);
  }

  /** Liveness probe (S14): returns 200 once the HTTP listener is accepting requests; exempt from authentication */
  private handleHealthz(response: ServerResponse): void {
    this.sendJson(response, 200, { status: 'ok' });
  }

  private async handleDatabases(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireAuth(request, 'query');
    const databases = await this.engine.listDatabases();
    this.sendJson(response, 200, { databases });
  }

  private async handleMetrics(request: IncomingMessage, response: ServerResponse, database: string): Promise<void> {
    this.requireAuth(request, 'query');
    await this.requireDatabaseExists(database);
    const metrics = await this.engine.listMetrics(database);
    this.sendJson(response, 200, { metrics: encodeMetricSummaries(metrics) });
  }

  private async handleWrite(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireAuth(request, 'write');
    const database = requireDatabaseName(url.searchParams.get('db'));
    const contentType = String(request.headers['content-type'] ?? '');
    const body = await this.readRequestBody(request);

    let points: WritePoint[];
    if (contentType.toLowerCase().includes('application/json')) {
      points = decodeWritePointBatch(this.parseJsonBody(body, 'write'));
    } else {
      const parsed = parseLineProtocol(body.toString('utf8'), Date.now());
      points = parsed.points;
      this.tagsIgnoredCount += parsed.tagsIgnored;
    }

    if (points.length > this.config.write.maxBatch) {
      throw new RtdbError(
        ERROR_CODE.BatchTooLarge,
        `Single batch has ${points.length} points, exceeding the limit of ${this.config.write.maxBatch}`,
      );
    }
    const { accepted } = await this.engine.writeBatch(database, points);
    this.sendJson(response, 200, { accepted, duplicates: points.length - accepted });
  }

  private async handleQueryRange(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireAuth(request, 'query');
    const body = requireJsonObject(this.parseJsonBody(await this.readRequestBody(request), 'query/range'), 'query/range');
    const database = requireDatabaseName(readOptionalString(body.db));
    const metricName = requireMetricName(body.metricName);
    await this.requireMetric(database, metricName);

    const options: RangeOptions = {
      start: requireIntegerField(body.start, 'start'),
      end: requireIntegerField(body.end, 'end'),
    };
    if (body.limit !== undefined) options.limit = requireIntegerField(body.limit, 'limit');
    if (body.order !== undefined) {
      if (body.order !== 'asc' && body.order !== 'desc') {
        throw new RtdbError(ERROR_CODE.InvalidRange, `Invalid order: ${String(body.order)} (should be asc|desc)`);
      }
      options.order = body.order;
    }
    const series = await this.engine.queryRange(database, metricName, options);
    this.sendJson(response, 200, { series: encodeSeries(series) });
  }

  private async handleQueryLast(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireAuth(request, 'query');
    const body = requireJsonObject(this.parseJsonBody(await this.readRequestBody(request), 'query/last'), 'query/last');
    const database = requireDatabaseName(readOptionalString(body.db));
    const metricName = requireMetricName(body.metricName);
    await this.requireMetric(database, metricName);
    const before = body.before === undefined ? undefined : requireIntegerField(body.before, 'before');
    const point = await this.engine.queryLast(database, metricName, before === undefined ? {} : { before });
    this.sendJson(response, 200, { point: point === null ? null : encodePoint(point) });
  }

  private async handleQueryCount(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireAuth(request, 'query');
    const body = requireJsonObject(this.parseJsonBody(await this.readRequestBody(request), 'query/count'), 'query/count');
    const database = requireDatabaseName(readOptionalString(body.db));
    const metricName = requireMetricName(body.metricName);
    await this.requireMetric(database, metricName);
    const count = await this.engine.queryCount(database, metricName, {
      start: requireIntegerField(body.start, 'start'),
      end: requireIntegerField(body.end, 'end'),
      exact: body.exact === true,
    });
    this.sendJson(response, 200, { count });
  }

  private async handleQueryAggregate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireAuth(request, 'query');
    const body = requireJsonObject(
      this.parseJsonBody(await this.readRequestBody(request), 'query/aggregate'),
      'query/aggregate',
    );
    const database = requireDatabaseName(readOptionalString(body.db));
    const metricName = requireMetricName(body.metricName);
    await this.requireMetric(database, metricName);
    const windows = await this.engine.queryAggregate(database, metricName, {
      start: requireIntegerField(body.start, 'start'),
      end: requireIntegerField(body.end, 'end'),
      type: toAggregateType(body.type),
      windowMs: requireIntegerField(body.windowMs, 'windowMs'),
    });
    this.sendJson(response, 200, { windows: encodeAggregateWindows(windows) });
  }

  private async handleRetention(request: IncomingMessage, response: ServerResponse, database: string): Promise<void> {
    this.requireAuth(request, 'write');
    const body = requireJsonObject(
      this.parseJsonBody(await this.readRequestBody(request), 'retention'),
      'retention',
    );
    await this.engine.setRetention(database, requireIntegerField(body.days, 'days'));
    this.sendJson(response, 200, { ok: true });
  }

  private async handleBackup(request: IncomingMessage, response: ServerResponse, database: string): Promise<void> {
    this.requireAuth(request, 'write');
    const body = requireJsonObject(this.parseJsonBody(await this.readRequestBody(request), 'backup'), 'backup');
    const targetDir = requireNonEmptyString(body.targetDir, 'targetDir');
    const result = await this.engine.backup(database, targetDir);
    this.sendJson(response, 200, {
      files: result.fileCount,
      totalBytes: result.totalBytes,
      database: result.database,
      targetDirectory: result.targetDirectory,
    });
  }

  /* ---------- Admin: users and tokens (§3.2, scope = admin) ---------- */

  private async handleAdminUsers(request: IncomingMessage, response: ServerResponse, method: string): Promise<void> {
    this.requireAuth(request, 'admin');
    const store = this.requireUserStore();

    if (method === 'GET') {
      this.sendJson(response, 200, { users: store.list().map(toPublicUser) });
      return;
    }
    if (method === 'POST') {
      const body = requireJsonObject(this.parseJsonBody(await this.readRequestBody(request), 'admin/users'), 'admin/users');
      const username = requireUserName(body.username);
      const password = requireUserPassword(body.password);
      const role = body.role === undefined ? USER_ROLE.Write : requireUserRole(body.role);
      const enabled = body.enabled === undefined ? true : requireBoolean(body.enabled, 'enabled');
      if (store.has(username)) {
        throw new HttpFailure(409, SERVER_ERROR_CODE.UserExists, `User already exists: ${username}`);
      }
      this.sendJson(response, 201, { user: toPublicUser(store.create({ username, password, role, enabled })) });
      return;
    }
    throw methodNotAllowed('GET, POST');
  }

  private async handleAdminUser(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    rawUserName: string,
  ): Promise<void> {
    this.requireAuth(request, 'admin');
    const store = this.requireUserStore();
    const username = requireUserName(rawUserName);

    if (method === 'PUT') {
      const body = requireJsonObject(this.parseJsonBody(await this.readRequestBody(request), 'admin/users'), 'admin/users');
      const updated = store.update(username, {
        role: body.role === undefined ? undefined : requireUserRole(body.role),
        password: body.password === undefined ? undefined : requireUserPassword(body.password),
        enabled: body.enabled === undefined ? undefined : requireBoolean(body.enabled, 'enabled'),
      });
      if (updated === null) throw userNotFound(username);
      this.sendJson(response, 200, { user: toPublicUser(updated) });
      return;
    }
    if (method === 'DELETE') {
      if (!store.remove(username)) throw userNotFound(username);
      this.sendJson(response, 200, { ok: true });
      return;
    }
    throw methodNotAllowed('PUT, DELETE');
  }

  private async handleAdminTokens(request: IncomingMessage, response: ServerResponse, method: string): Promise<void> {
    this.requireAuth(request, 'admin');
    const store = this.requireTokenStore();

    if (method === 'GET') {
      this.sendJson(response, 200, { tokens: store.list().map(toPublicToken) });
      return;
    }
    if (method === 'POST') {
      const body = requireJsonObject(this.parseJsonBody(await this.readRequestBody(request), 'admin/tokens'), 'admin/tokens');
      const user = requireUserName(body.user);
      // Default the token role to the owner's role when the user exists, otherwise to `write`.
      const defaultRole = this.userStore?.get(user)?.role ?? USER_ROLE.Write;
      const role = body.role === undefined ? defaultRole : requireUserRole(body.role);
      const label = body.label === undefined ? '' : requireStringField(body.label, 'label');
      const ttlMs = body.ttlMs === undefined ? null : requirePositiveIntegerField(body.ttlMs, 'ttlMs');
      const issued = store.issue({ user, role, label, ttlMs });
      // The plaintext `token` is returned exactly once; only its hash is persisted.
      this.sendJson(response, 201, { token: issued.token, tokenRecord: toPublicToken(issued.record) });
      return;
    }
    throw methodNotAllowed('GET, POST');
  }

  private async handleAdminToken(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    tokenId: string,
  ): Promise<void> {
    this.requireAuth(request, 'admin');
    const store = this.requireTokenStore();

    if (method === 'DELETE') {
      if (tokenId.length === 0 || !store.revoke(tokenId)) {
        throw new HttpFailure(404, SERVER_ERROR_CODE.TokenNotFound, `Token does not exist: ${tokenId}`);
      }
      this.sendJson(response, 200, { ok: true });
      return;
    }
    throw methodNotAllowed('DELETE');
  }

  private requireUserStore(): UserStore {
    if (this.userStore === null) throw new RtdbError(ERROR_CODE.Internal, 'User store not initialized');
    return this.userStore;
  }

  private requireTokenStore(): TokenStore {
    if (this.tokenStore === null) throw new RtdbError(ERROR_CODE.Internal, 'Token store not initialized');
    return this.tokenStore;
  }

  private async handleAdmin(pathname: string, response: ServerResponse): Promise<void> {
    if (!this.config.admin.enabled) throw routeNotFound(pathname);
    const rootDirectory = this.resolveAdminRoot();

    let relative = safeDecode(pathname.slice(ADMIN_PATH.length));
    if (relative.startsWith('/') || relative.startsWith('\\')) relative = relative.slice(1);
    if (relative.length === 0) relative = 'index.html';
    const normalized = normalize(relative).replace(/\\/g, '/');
    if (normalized.startsWith('..') || normalized.includes('/../')) throw routeNotFound(pathname);

    let filePath = join(rootDirectory, normalized);
    if (filePath !== rootDirectory && !filePath.startsWith(`${rootDirectory}${sep}`)) throw routeNotFound(pathname);
    if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      const fallback = join(rootDirectory, 'index.html');
      if (!existsSync(fallback)) throw routeNotFound(pathname);
      filePath = fallback;
    }
    await this.sendFile(response, filePath);
  }

  /**
   * Absolute root of the admin bundle. Always passed through `resolve()` so the trailing separator that
   * `fileURLToPath` keeps for a directory URL is dropped — `handleAdmin` compares against
   * `${rootDirectory}${sep}`, which would otherwise never match.
   */
  private resolveAdminRoot(): string {
    const configured = this.config.admin.staticDir;
    if (configured.length > 0) return resolve(configured);
    return resolve(fileURLToPath(new URL('../../admin/dist/', import.meta.url)));
  }

  /* ---------- Existence and parameter validation ---------- */

  private async requireDatabaseExists(database: string): Promise<void> {
    const databases = await this.engine.listDatabases();
    if (!databases.includes(database)) {
      throw new RtdbError(ERROR_CODE.DatabaseNotFound, `Database does not exist: ${database}`);
    }
  }

  private async requireMetric(database: string, metricName: string): Promise<void> {
    await this.requireDatabaseExists(database);
    const metrics = await this.engine.listMetrics(database);
    if (!metrics.some((summary) => summary.metricName === metricName)) {
      throw new RtdbError(ERROR_CODE.MetricNotFound, `Metric does not exist: ${database}/${metricName}`);
    }
  }

  /* ---------- Transport-layer utilities ---------- */

  private readRequestBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      request.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > this.config.http.maxBodyBytes) {
          request.destroy();
          rejectPromise(
            new RtdbError(
              ERROR_CODE.BatchTooLarge,
              `Request body exceeds the limit of ${this.config.http.maxBodyBytes} bytes`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolvePromise(Buffer.concat(chunks)));
      request.on('error', (error) => rejectPromise(error));
    });
  }

  private parseJsonBody(body: Buffer, label: string): unknown {
    if (body.length === 0) throw new RtdbError(ERROR_CODE.InvalidPoint, `${label} request body is empty`);
    const text = body.toString('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new RtdbError(ERROR_CODE.InvalidPoint, `${label} request body JSON parse failed: ${(error as Error).message}`);
    }
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      ...headers,
    });
    response.end(payload);
  }

  private sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
    response.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  }

  private sendFile(response: ServerResponse, filePath: string): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const stat = statSync(filePath);
      response.writeHead(200, {
        'Content-Type': MIME_TYPE_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': stat.size,
      });
      const stream = createReadStream(filePath);
      stream.on('error', rejectPromise);
      stream.on('end', () => resolvePromise());
      stream.pipe(response);
    });
  }
}

/* ---------- Module-level utilities ---------- */

function routeNotFound(pathname: string): HttpFailure {
  return new HttpFailure(404, SERVER_ERROR_CODE.RouteNotFound, `Unregistered route: ${pathname}`);
}

function methodNotAllowed(allowed: string): HttpFailure {
  return new HttpFailure(405, SERVER_ERROR_CODE.MethodNotAllowed, `Method not allowed; expected ${allowed}`, { Allow: allowed });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function requireDatabaseName(value: string | null): string {
  if (value === null || value.length === 0) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, 'Missing database name parameter db');
  }
  if (!DATABASE_NAME_PATTERN.test(value)) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, `Invalid database name (first char a letter, subsequent letters/digits/underscores, ≤63 chars): ${value}`);
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requireMetricName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RtdbError(ERROR_CODE.BadMetricName, `Invalid metric name: ${String(value)}`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, `${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireIntegerField(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RtdbError(ERROR_CODE.InvalidRange, `${fieldName} must be an integer: ${String(value)}`);
  }
  return value;
}

function requireJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, `${label} request body must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function toAggregateType(value: unknown): AggregateType {
  if (typeof value === 'string' && (AGGREGATE_TYPES as readonly string[]).includes(value)) {
    return value as AggregateType;
  }
  throw new RtdbError(
    ERROR_CODE.InvalidRange,
    `Invalid aggregate type: ${String(value)} (should be ${AGGREGATE_TYPES.join('|')})`,
  );
}

/* ---------- Admin payload validation and public projections (§3.2) ---------- */

/** User projection returned by the admin API: the password hash is never exposed */
interface PublicUser {
  username: string;
  role: UserRole;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Token projection returned by the admin API: the token hash is never exposed */
interface PublicToken {
  tokenId: string;
  user: string;
  role: UserRole;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

function toPublicUser(record: UserRecord): PublicUser {
  return {
    username: record.username,
    role: record.role,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toPublicToken(record: TokenRecord): PublicToken {
  return {
    tokenId: record.tokenId,
    user: record.user,
    role: record.role,
    label: record.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

function userNotFound(username: string): HttpFailure {
  return new HttpFailure(404, SERVER_ERROR_CODE.UserNotFound, `User does not exist: ${username}`);
}

function requireUserName(value: unknown): string {
  if (typeof value !== 'string' || !USER_NAME_PATTERN.test(value)) {
    throw new RtdbError(
      ERROR_CODE.InvalidPoint,
      `Invalid user name (first char a letter, subsequent letters/digits/_/-/., ≤64 chars): ${String(value)}`,
    );
  }
  return value;
}

function requireUserPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, 'User password must be a string of at least 8 characters');
  }
  return value;
}

function requireUserRole(value: unknown): UserRole {
  if (!isUserRole(value)) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, `Invalid user role: ${String(value)} (should be admin|write|readonly)`);
  }
  return value;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RtdbError(ERROR_CODE.InvalidPoint, `${fieldName} must be a boolean: ${String(value)}`);
  }
  return value;
}

function requireStringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new RtdbError(ERROR_CODE.InvalidPoint, `${fieldName} must be a string: ${String(value)}`);
  }
  return value;
}

function requirePositiveIntegerField(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, `${fieldName} must be a positive integer: ${String(value)}`);
  }
  return value;
}
