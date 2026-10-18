// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxQL compatibility: HTTP handler for `/query` (v1) and `/api/v3/query_influxql`
 *
 * Request parameters may arrive in the query string (Grafana style) or in a form/JSON body (v3 style).
 * The response is the 1.x JSON envelope shared by both endpoints:
 *   {"results":[{"statement_id":0,"series":[{"name","tags","columns","values"}]}]}
 * The `epoch` parameter controls the time column format (default RFC3339 with millisecond precision).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { InfluxCompatContext } from '../context.ts';
import { InfluxCompatError, sendCompatJson } from '../errors.ts';
import { executeInfluxStatement } from './planner.ts';
import type { InfluxSeries } from './planner.ts';
import { parseInfluxQL } from './parser.ts';

const MAX_QUERY_BODY_BYTES = 64 * 1024;

export async function handleInfluxQuery(
  context: InfluxCompatContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const params = await collectParams(request, url);
  const query = params.get('q');
  if (query === null || query.trim().length === 0) {
    throw new InfluxCompatError({ status: 400, code: 'invalid', message: 'Missing required parameter "q"' });
  }
  const statement = parseInfluxQL(query);
  const statementDatabase = statement.kind === 'show' ? statement.database : null;
  const database = statementDatabase ?? params.get('db');
  const databaseOptional = statement.kind === 'show' && statement.show === 'databases';
  if ((database === null || database.length === 0) && !databaseOptional) {
    throw new InfluxCompatError({ status: 400, code: 'invalid', message: 'Missing required parameter "db"' });
  }
  const epoch = normalizeEpoch(params.get('epoch'));
  const format = (params.get('format') ?? 'json').toLowerCase();
  if (format !== 'json') {
    throw new InfluxCompatError({
      status: 501,
      code: 'not implemented',
      message: `Only format=json is supported (requested ${format})`,
    });
  }

  const series = await executeInfluxStatement(context.engine, statement, {
    database: database ?? '',
    nowMs: Date.now(),
    metricPrefix: context.config.compat.influx.metricPrefix,
    defaultLimit: context.config.query.defaultLimit,
    retentionDays: context.config.retentionDays,
    dataDir: context.config.dataDir,
    onUnmappedMetric: () => {
      context.stats.unmappedMetrics += 1;
    },
  });
  context.stats.influxqlQueries += 1;

  const result: { statement_id: number; series?: unknown[] } = { statement_id: 0 };
  if (series.length > 0) result.series = series.map((item) => formatSeries(item, epoch));
  sendCompatJson(response, 200, { results: [result] });
}

type EpochUnit = 'ns' | 'us' | 'ms' | 's' | 'm' | 'h' | null;

function normalizeEpoch(value: string | null): EpochUnit {
  if (value === null || value.length === 0) return null;
  switch (value.toLowerCase()) {
    case 'ns':
      return 'ns';
    case 'u':
    case 'us':
      return 'us';
    case 'ms':
      return 'ms';
    case 's':
      return 's';
    case 'm':
      return 'm';
    case 'h':
      return 'h';
    default:
      throw new InfluxCompatError({ status: 400, code: 'invalid', message: `Invalid epoch: ${value}` });
  }
}

function formatSeries(series: InfluxSeries, epoch: EpochUnit): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: series.name,
    columns: series.columns,
    values: series.values.map((row) =>
      row.map((value, index) => (index === 0 && typeof value === 'number' ? formatTimestamp(value, epoch) : value)),
    ),
  };
  if (series.tags !== undefined && Object.keys(series.tags).length > 0) output.tags = series.tags;
  return output;
}

function formatTimestamp(milliseconds: number, epoch: EpochUnit): string | number {
  switch (epoch) {
    case null:
      return new Date(milliseconds).toISOString();
    case 'ms':
      return milliseconds;
    case 's':
      return Math.floor(milliseconds / 1_000);
    case 'm':
      return Math.floor(milliseconds / 60_000);
    case 'h':
      return Math.floor(milliseconds / 3_600_000);
    case 'us':
      return milliseconds * 1_000;
    case 'ns':
      return milliseconds * 1_000_000;
    default:
      return milliseconds;
  }
}

async function collectParams(request: IncomingMessage, url: URL): Promise<URLSearchParams> {
  const params = new URLSearchParams(url.searchParams);
  const method = (request.method ?? 'GET').toUpperCase();
  if (method !== 'POST') return params;

  const body = await readSmallBody(request);
  if (body.length === 0) return params;
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(body) as { q?: unknown; db?: unknown };
      if (typeof parsed.q === 'string') params.set('q', parsed.q);
      if (typeof parsed.db === 'string') params.set('db', parsed.db);
    } catch {
      throw new InfluxCompatError({ status: 400, code: 'invalid', message: 'Invalid JSON body' });
    }
    return params;
  }
  const form = new URLSearchParams(body);
  for (const [key, value] of form) params.set(key, value);
  return params;
}

function readSmallBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_QUERY_BODY_BYTES) {
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (total > MAX_QUERY_BODY_BYTES) {
        rejectPromise(
          new InfluxCompatError({ status: 413, code: 'request too large', message: 'InfluxQL request body is too large' }),
        );
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', (error) => rejectPromise(error));
  });
}
