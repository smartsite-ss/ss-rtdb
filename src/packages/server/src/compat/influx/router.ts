// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxDB compatibility: route table and dispatch
 *
 * Registered only when `compat.influx.enabled` is true; it never shadows native routes (the server
 * dispatches `/api/v1/*` first). Endpoints:
 *
 *   GET  /ping                        204 + version headers
 *   POST /write                       v1 line protocol
 *   POST /api/v2/write                v2 line protocol
 *   POST /api/v3/write_lp             v3 line protocol
 *   GET/POST /query                   InfluxQL read-only subset (when `compat.influx.influxql=read-only`)
 *   GET/POST /api/v3/query_influxql   same planner, v3 path
 *   *    /api/v2/query, /api/v3/query_sql, /api/v2/setup, /api/v2/buckets*, ...
 *                                     explicit 501 with a migration hint
 *
 * Errors are rendered in the family's shape (v2 `{code,message}`, v1/v3 `{error}`), so native
 * `{error: E_CODE}` envelopes never reach InfluxDB clients.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import type { AuthPrincipal, AuthScope } from '../../auth.ts';
import { SERVER_VERSION } from '../../version.ts';
import type { InfluxCompatContext } from './context.ts';
import { InfluxCompatError, notImplemented, sendInfluxError, toInfluxError } from './errors.ts';
import { handleInfluxQuery } from './influxql/handler.ts';
import { handleInfluxWrite } from './write.ts';
import type { InfluxWriteFamily } from './write.ts';

type Family = InfluxWriteFamily;

const WRITE_ROUTES: Readonly<Record<string, InfluxWriteFamily>> = {
  '/write': 'v1',
  '/api/v2/write': 'v2',
  '/api/v3/write_lp': 'v3',
};

const QUERY_ROUTES: readonly string[] = ['/query', '/api/v3/query_influxql'];

/** Endpoints that are recognized but intentionally not implemented (explicit 501 + hint) */
const NOT_IMPLEMENTED_ROUTES: Readonly<Record<string, { message: string; hint: string }>> = {
  '/api/v2/query': {
    message: 'Flux is not supported',
    hint: 'Use /query (InfluxQL subset) or the native /api/v1/query/* endpoints',
  },
  '/api/v3/query_sql': {
    message: 'SQL is not supported',
    hint: 'Use /api/v3/query_influxql (InfluxQL subset) or the native /api/v1/query/* endpoints',
  },
  '/api/v2/setup': {
    message: 'The setup API is not supported',
    hint: 'Create the first administrator with rtdbctl or the bootstrap settings (auth.bootstrapUsername)',
  },
  '/api/v2/signin': {
    message: 'Sign-in/session APIs are not supported',
    hint: 'Use POST /api/v1/auth/login or a Bearer/Token credential',
  },
  '/api/v2/signout': {
    message: 'Sign-in/session APIs are not supported',
    hint: 'Use POST /api/v1/auth/logout or a Bearer/Token credential',
  },
  '/api/v2/me': {
    message: 'The /api/v2/me API is not supported',
    hint: 'Use GET /api/v1/auth/session',
  },
};

export class InfluxCompatRouter {
  private readonly context: InfluxCompatContext;

  constructor(context: InfluxCompatContext) {
    this.context = context;
  }

  /** Returns true when the request belongs to the compatibility surface (handled or rejected) */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const pathname = url.pathname;
    const family = familyOf(pathname);
    if (family === null) return false;
    const method = (request.method ?? 'GET').toUpperCase();

    try {
      this.context.stats.requests += 1;
      await this.dispatch(request, response, url, pathname, method);
    } catch (error) {
      const failure = toInfluxError(error);
      if (failure.status >= 500) {
        this.context.logger.warn(
          `InfluxDB compat request failed: ${method} ${pathname} → ${failure.status} ${failure.message}`,
        );
      }
      if (response.headersSent) {
        response.destroy();
      } else {
        sendInfluxError(response, failure, family);
      }
    }
    return true;
  }

  private async dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<void> {
    if (pathname === '/ping') {
      requireMethod(method, ['GET']);
      this.sendPing(response);
      return;
    }

    const writeFamily = WRITE_ROUTES[pathname];
    if (writeFamily !== undefined) {
      requireMethod(method, ['POST']);
      const principal = this.authenticate(request, url, 'write');
      await handleInfluxWrite(this.context, request, response, url, writeFamily, principal);
      return;
    }

    if (QUERY_ROUTES.includes(pathname)) {
      requireMethod(method, ['GET', 'POST']);
      if (this.context.config.compat.influx.influxql === 'off') {
        throw notImplemented(
          'InfluxQL is disabled by configuration',
          'Set compat.influx.influxql=read-only (env RTDB_COMPAT_INFLUX_INFLUXQL) to enable the read-only subset',
        );
      }
      this.authenticate(request, url, 'query');
      await handleInfluxQuery(this.context, request, response, url);
      return;
    }

    const planned = NOT_IMPLEMENTED_ROUTES[pathname];
    if (planned !== undefined) throw notImplemented(planned.message, planned.hint);

    if (pathname === '/api/v2/buckets' || pathname.startsWith('/api/v2/buckets/')) {
      throw notImplemented(
        'Bucket management is not supported',
        'List databases with GET /api/v1/databases, set retention with PUT /api/v1/retention/:db, and write with bucket=<name>',
      );
    }
    if (pathname === '/api/v2/tasks' || pathname.startsWith('/api/v2/tasks/')) {
      throw notImplemented('Tasks are not supported', 'Query from the client or use /api/v1/query/* on a schedule');
    }
    if (pathname === '/api/v2/orgs' || pathname.startsWith('/api/v2/orgs/')) {
      throw notImplemented('Organizations are not supported', 'ss-rtdb is single-tenant; use /api/v1/admin/users');
    }
    if (pathname === '/api/v2/authorizations' || pathname.startsWith('/api/v2/authorizations/')) {
      throw notImplemented('Authorizations are not supported', 'Use /api/v1/admin/tokens (role-based API tokens)');
    }
    if (pathname.startsWith('/api/v3/configure/')) {
      throw notImplemented(
        'InfluxDB 3 configure APIs are not supported',
        'Manage databases with /api/v1/databases and write with /api/v3/write_lp',
      );
    }

    throw new InfluxCompatError({ status: 404, code: 'not found', message: `Unregistered route: ${pathname}` });
  }

  private sendPing(response: ServerResponse): void {
    const version = this.context.config.compat.influx.versionHeader;
    response.writeHead(204, {
      'X-Influxdb-Version': version,
      'X-Influxdb-Build': 'OSS',
      'X-Rtdb-Version': SERVER_VERSION,
      'X-Rtdb-Compat': `influx-${version}`,
    });
    response.end();
  }

  /** Authenticate with InfluxDB scheme normalization (`Token` -> `Bearer`, optional query credentials) */
  private authenticate(
    request: IncomingMessage,
    url: URL,
    scope: AuthScope,
  ): AuthPrincipal | null {
    const headers = normalizeAuthHeaders(request.headers, url, this.context.config.compat.influx.allowQueryCredentials);
    return this.context.requireAuth(headers, scope);
  }
}

function familyOf(pathname: string): Family | null {
  if (pathname === '/ping' || pathname === '/write' || pathname === '/query') return 'v1';
  if (pathname.startsWith('/api/v2/')) return 'v2';
  if (pathname.startsWith('/api/v3/')) return 'v3';
  return null;
}

function requireMethod(method: string, allowed: readonly string[]): void {
  if (allowed.includes(method)) return;
  throw new InfluxCompatError({
    status: 405,
    code: 'method not allowed',
    message: `Method ${method} is not allowed; expected ${allowed.join(' or ')}`,
  });
}

/**
 * InfluxDB 2.x uses `Authorization: Token <t>` while 1.x/3.x and ss-rtdb use `Bearer`. Accept both, plus
 * `?u=&p=` / `?access_token=` only when explicitly enabled (URL credentials end up in access logs).
 */
function normalizeAuthHeaders(
  headers: IncomingHttpHeaders,
  url: URL,
  allowQueryCredentials: boolean,
): IncomingHttpHeaders {
  const normalized: IncomingHttpHeaders = { ...headers };
  const authorization = normalized.authorization;
  if (typeof authorization === 'string' && /^token\s+/i.test(authorization)) {
    normalized.authorization = `Bearer ${authorization.replace(/^token\s+/i, '').trim()}`;
    return normalized;
  }
  if (normalized.authorization !== undefined || !allowQueryCredentials) return normalized;

  const accessToken = url.searchParams.get('access_token');
  if (accessToken !== null && accessToken.length > 0) {
    normalized.authorization = `Bearer ${accessToken}`;
    return normalized;
  }
  const username = url.searchParams.get('u');
  if (username !== null) {
    const password = url.searchParams.get('p') ?? '';
    normalized.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  return normalized;
}
