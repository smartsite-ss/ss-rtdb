// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxDB compatibility layer tests (L1 write + L2 InfluxQL read-only subset):
 *   - /write, /api/v2/write, /api/v3/write_lp: tag/field folding, precision, gzip, atomic vs partial,
 *     in-request duplicate policy, error families, `Token` scheme
 *   - /ping, /health
 *   - /query and /api/v3/query_influxql: raw SELECT, count/mean, GROUP BY time + fill, SHOW statements,
 *     LIMIT/OFFSET, explicit 501 for Flux/SQL and disabled InfluxQL
 *   - the native `/api/v1/*` surface keeps working next to the adapter
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { loadServerConfig } from '../packages/server/src/config.ts';
import type { PartialServerConfig } from '../packages/server/src/config.ts';
import { Logger } from '../packages/server/src/logger.ts';
import { RtdbServer } from '../packages/server/src/server.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-compat-'));
const BASE = new Date(2026, 0, 10, 10, 0, 0).getTime();
const TOKEN = 'c'.repeat(32);
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

interface TestServer {
  server: RtdbServer;
  baseUrl: string;
  dataDir: string;
}

function nextDataDir(): string {
  caseCounter += 1;
  return join(rootDirectory, `case-${caseCounter}`);
}

async function startTestServer(overrides: PartialServerConfig = {}): Promise<TestServer> {
  const dataDir = nextDataDir();
  const config = loadServerConfig({
    env: {},
    overrides: {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      admin: { enabled: false },
      log: { level: 'error' },
      auth: { enabled: false, tokenFile: join(dataDir, 'rtdb.token') },
      ...overrides,
    },
  });
  const server = new RtdbServer({ config, logger: new Logger('error') });
  const address = await server.start();
  return { server, baseUrl: `http://${address.host}:${address.port}`, dataDir };
}

function postText(baseUrl: string, path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
    body,
  });
}

function postJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

interface QueryRangeBody {
  series: { metricName: string; points: { t: number; v: number | string | boolean }[] };
}

async function readPoints(
  server: TestServer,
  database: string,
  metricName: string,
  start = BASE,
  end = BASE + 60_000,
): Promise<{ timestamp: number; value: unknown }[]> {
  const response = await postJson(server.baseUrl, '/api/v1/query/range', { db: database, metricName, start, end });
  assert.equal(response.status, 200);
  const body = (await response.json()) as QueryRangeBody;
  return body.series.points.map((point) => ({ timestamp: point.t, value: point.v }));
}

interface InfluxQLResponse {
  results: { statement_id: number; series?: { name: string; tags?: Record<string, string>; columns: string[]; values: (string | number | boolean | null)[][] }[] }[];
}

async function queryInfluxQL(
  baseUrl: string,
  database: string,
  query: string,
  extra: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<InfluxQLResponse> {
  const params = new URLSearchParams({ db: database, q: query, epoch: 'ms', ...extra });
  const response = await fetch(`${baseUrl}/query?${params.toString()}`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()) as InfluxQLResponse;
}

describe('InfluxDB compat: write endpoints (L1)', () => {
  it('folds tags and multi-field lines into one metric per field (v2)', async () => {
    const server = await startTestServer();
    try {
      const response = await postText(
        server.baseUrl,
        '/api/v2/write?org=smart-site&bucket=plant-a&precision=ns',
        'cpu,host=srv01,region=us usage_idle=97.2,usage_user=2i 1000000000\n',
      );
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('x-rtdb-database'), 'plant_a');
      assert.equal(response.headers.get('x-rtdb-accepted'), '2');

      const idle = await readPoints(server, 'plant_a', 'cpu|usage_idle|host=srv01|region=us', 1_000, 2_000);
      assert.deepEqual(idle.map((point) => [point.timestamp, point.value]), [[1000, 97.2]]);

      const user = await readPoints(server, 'plant_a', 'cpu|usage_user|host=srv01|region=us', 1_000, 2_000);
      // i64 travels as a decimal string in the native JSON contract (vt=2)
      assert.deepEqual(user.map((point) => [point.timestamp, point.value]), [[1000, '2']]);
    } finally {
      await server.server.stop();
    }
  });

  it('honours precision on the v1 endpoint and keeps the last in-request duplicate', async () => {
    const server = await startTestServer();
    try {
      const response = await postText(
        server.baseUrl,
        '/write?db=plant_a&precision=s',
        'kwh,site=a value=1 1700000000\nkwh,site=a value=2 1700000000\n',
      );
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('x-rtdb-truncated-points'), '1');
      const points = await readPoints(server, 'plant_a', 'kwh|value|site=a', 1_700_000_000_000, 1_700_000_001_000);
      assert.deepEqual(points.map((point) => [point.timestamp, point.value]), [[1_700_000_000_000, 2]]);
    } finally {
      await server.server.stop();
    }
  });

  it('accepts gzip bodies, v3 full precision names and reports no_sync', async () => {
    const server = await startTestServer();
    try {
      const payload = Buffer.from('temp,room=r1 celsius=21.5 1700000000000000000\n', 'utf8');
      const response = await fetch(
        `${server.baseUrl}/api/v3/write_lp?db=plant_a&precision=nanosecond&no_sync=true`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' },
          body: gzipSync(payload),
        },
      );
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('x-rtdb-nosync'), 'ignored');
      const points = await readPoints(server, 'plant_a', 'temp|celsius|room=r1', 1_700_000_000_000, 1_700_000_001_000);
      assert.deepEqual(points.map((point) => point.value), [21.5]);
    } finally {
      await server.server.stop();
    }
  });

  it('returns atomic 400 with line numbers and the v2 error shape', async () => {
    const server = await startTestServer();
    try {
      const response = await postText(
        server.baseUrl,
        '/api/v2/write?org=o&bucket=plant_a',
        'ok value=1 1000000000\nbroken value\n',
      );
      assert.equal(response.status, 400);
      const body = (await response.json()) as { code: string; message: string; data?: { line_number: number }[] };
      assert.equal(body.code, 'invalid');
      assert.equal(body.data?.[0]?.line_number, 2);
      // Atomic mode: the whole batch is rejected, so the database was never created.
      const databases = (await (await fetch(`${server.baseUrl}/api/v1/databases`)).json()) as { databases: string[] };
      assert.equal(databases.databases.includes('plant_a'), false);
    } finally {
      await server.server.stop();
    }
  });

  it('writes valid lines in accept_partial mode and reports rejected ones', async () => {
    const server = await startTestServer();
    try {
      const response = await postText(
        server.baseUrl,
        '/api/v3/write_lp?db=plant_a&accept_partial=true',
        'ok value=1 1000000000\nbroken value\nok value2=2 1000000000\n',
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { accepted: number; rejected: { line_number: number; error_message: string }[] };
      assert.equal(body.accepted, 2);
      assert.equal(body.rejected.length, 1);
      assert.equal(body.rejected[0].line_number, 2);
      assert.equal((await readPoints(server, 'plant_a', 'ok|value', 1_000, 2_000)).length, 1);
      assert.equal((await readPoints(server, 'plant_a', 'ok|value2', 1_000, 2_000)).length, 1);
    } finally {
      await server.server.stop();
    }
  });

  it('rejects unsigned integers and multi-field lines when configured', async () => {
    const server = await startTestServer({ compat: { influx: { fieldFolding: 'reject' } } });
    try {
      const response = await postText(server.baseUrl, '/write?db=plant_a', 'm f=1,i=2u 1000000000\n');
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /u suffix|Multi-field|unsigned/i);
    } finally {
      await server.server.stop();
    }
  });

  it('drops tags only when explicitly configured and exposes the counter', async () => {
    const server = await startTestServer({ compat: { influx: { tagFolding: 'ignore' } } });
    try {
      const response = await postText(server.baseUrl, '/write?db=plant_a', 'm,host=a v=1 1000000000\n');
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('x-rtdb-tags-dropped'), '1');
      assert.equal((await readPoints(server, 'plant_a', 'm|v', 1_000, 2_000)).length, 1);
      const status = await fetch(`${server.baseUrl}/api/v1/status`);
      const body = (await status.json()) as { compat: { influx: { tagsDropped: number } } };
      assert.equal(body.compat.influx.tagsDropped, 1);
    } finally {
      await server.server.stop();
    }
  });

  it('accepts the InfluxDB v2 Token scheme and rejects missing credentials', async () => {
    const server = await startTestServer({ auth: { enabled: true, mode: 'token', token: TOKEN } });
    try {
      const unauthorized = await postText(server.baseUrl, '/api/v2/write?org=o&bucket=plant_a', 'm v=1 1000000000\n');
      assert.equal(unauthorized.status, 401);
      const errorBody = (await unauthorized.json()) as { code: string };
      assert.equal(errorBody.code, 'unauthorized');

      const accepted = await postText(server.baseUrl, '/api/v2/write?org=o&bucket=plant_a', 'm v=1 1000000000\n', {
        Authorization: `Token ${TOKEN}`,
      });
      assert.equal(accepted.status, 204);
    } finally {
      await server.server.stop();
    }
  });

  it('serves /ping and /health', async () => {
    const server = await startTestServer();
    try {
      const ping = await fetch(`${server.baseUrl}/ping`);
      assert.equal(ping.status, 204);
      assert.equal(ping.headers.get('x-influxdb-version'), '2.7.8');

      const health = await fetch(`${server.baseUrl}/health`);
      assert.equal(health.status, 200);
      const body = (await health.json()) as { status: string; name: string };
      assert.equal(body.status, 'pass');
      assert.equal(body.name, 'ss-rtdb');
    } finally {
      await server.server.stop();
    }
  });

  it('keeps the native write/query surface unchanged', async () => {
    const server = await startTestServer();
    try {
      const write = await postJson(server.baseUrl, '/api/v1/write?db=plant_a', [
        { metricName: 'native.metric', timestamp: BASE, value: 5 },
      ]);
      assert.equal(write.status, 200);
      assert.deepEqual((await readPoints(server, 'plant_a', 'native.metric')).map((point) => point.value), [5]);
    } finally {
      await server.server.stop();
    }
  });
});

describe('InfluxDB compat: InfluxQL read-only subset (L2)', () => {
  async function seed(server: TestServer): Promise<void> {
    const response = await postText(
      server.baseUrl,
      '/api/v2/write?org=o&bucket=plant_a&precision=ms',
      [
        `cpu,host=srv01 usage_idle=90 ${BASE}`,
        `cpu,host=srv01 usage_idle=80 ${BASE + 1000}`,
        `cpu,host=srv01 usage_idle=70 ${BASE + 2000}`,
        `cpu,host=srv02 usage_idle=60 ${BASE + 1000}`,
      ].join('\n'),
    );
    assert.equal(response.status, 204);
  }

  it('returns raw series with tags and honours the time range', async () => {
    const server = await startTestServer();
    try {
      await seed(server);
      const result = await queryInfluxQL(
        server.baseUrl,
        'plant_a',
        `SELECT usage_idle FROM cpu WHERE time >= ${BASE} AND host = 'srv01'`,
      );
      const series = result.results[0].series ?? [];
      assert.equal(series.length, 1);
      assert.equal(series[0].name, 'cpu');
      assert.deepEqual(series[0].tags, { host: 'srv01' });
      assert.deepEqual(series[0].columns, ['time', 'usage_idle']);
      assert.deepEqual(series[0].values.map((row) => row[1]), [90, 80, 70]);
    } finally {
      await server.server.stop();
    }
  });

  it('computes count() across tag sets and mean() with GROUP BY time + fill(none)', async () => {
    const server = await startTestServer();
    try {
      await seed(server);
      const count = await queryInfluxQL(server.baseUrl, 'plant_a', 'SELECT count(usage_idle) FROM cpu');
      assert.deepEqual(count.results[0].series?.[0].values[0][1], 4);

      const mean = await queryInfluxQL(
        server.baseUrl,
        'plant_a',
        'SELECT mean(usage_idle) FROM cpu WHERE host = \'srv01\' GROUP BY time(1s) fill(none)',
      );
      const series = mean.results[0].series?.[0];
      assert.equal(series?.columns[1], 'mean');
      assert.deepEqual(series?.values.map((row) => [row[0], row[1]]), [
        [BASE, 90],
        [BASE + 1000, 80],
        [BASE + 2000, 70],
      ]);
    } finally {
      await server.server.stop();
    }
  });

  it('supports fill(null) and LIMIT/OFFSET on raw selects', async () => {
    const server = await startTestServer();
    try {
      await seed(server);
      const filled = await queryInfluxQL(
        server.baseUrl,
        'plant_a',
        `SELECT count(usage_idle) FROM cpu WHERE host = 'srv01' GROUP BY time(1s) fill(null)`,
      );
      const values = filled.results[0].series?.[0].values ?? [];
      assert.equal(values.length, 3);

      const limited = await queryInfluxQL(
        server.baseUrl,
        'plant_a',
        `SELECT usage_idle FROM cpu WHERE host = 'srv01' ORDER BY time DESC LIMIT 1 OFFSET 1`,
      );
      assert.deepEqual(limited.results[0].series?.[0].values.map((row) => row[1]), [80]);
    } finally {
      await server.server.stop();
    }
  });

  it('answers SHOW DATABASES / MEASUREMENTS / TAG KEYS / TAG VALUES / FIELD KEYS', async () => {
    const server = await startTestServer();
    try {
      await seed(server);
      const databases = await queryInfluxQL(server.baseUrl, 'plant_a', 'SHOW DATABASES');
      assert.ok((databases.results[0].series?.[0].values ?? []).some((row) => row[0] === 'plant_a'));

      const measurements = await queryInfluxQL(server.baseUrl, 'plant_a', 'SHOW MEASUREMENTS');
      assert.deepEqual(measurements.results[0].series?.[0].values, [['cpu']]);

      const tagKeys = await queryInfluxQL(server.baseUrl, 'plant_a', 'SHOW TAG KEYS FROM cpu');
      assert.deepEqual(tagKeys.results[0].series?.[0].values, [['host']]);

      const tagValues = await queryInfluxQL(server.baseUrl, 'plant_a', 'SHOW TAG VALUES FROM cpu WITH KEY = "host"');
      assert.deepEqual(tagValues.results[0].series?.[0].values, [
        ['host', 'srv01'],
        ['host', 'srv02'],
      ]);

      const fieldKeys = await queryInfluxQL(server.baseUrl, 'plant_a', 'SHOW FIELD KEYS FROM cpu');
      assert.deepEqual(fieldKeys.results[0].series?.[0].values, [['usage_idle', 'float']]);
    } finally {
      await server.server.stop();
    }
  });

  it('exposes the v3 path and rejects Flux/SQL/unsupported statements explicitly', async () => {
    const server = await startTestServer();
    try {
      await seed(server);
      const v3 = await fetch(
        `${server.baseUrl}/api/v3/query_influxql?${new URLSearchParams({ db: 'plant_a', q: 'SELECT count(usage_idle) FROM cpu', format: 'json' })}`,
      );
      assert.equal(v3.status, 200);
      const v3Body = (await v3.json()) as InfluxQLResponse;
      assert.equal(v3Body.results[0].series?.[0].values[0][1], 4);

      const flux = await postText(server.baseUrl, '/api/v2/query?org=o', 'from(bucket:"plant_a")');
      assert.equal(flux.status, 501);
      const fluxBody = (await flux.json()) as { code: string; hint: string };
      assert.equal(fluxBody.code, 'not implemented');

      const sql = await postJson(server.baseUrl, '/api/v3/query_sql', { db: 'plant_a', q: 'SELECT 1' });
      assert.equal(sql.status, 501);

      const grouped = await fetch(
        `${server.baseUrl}/query?${new URLSearchParams({
          db: 'plant_a',
          q: 'SELECT mean(usage_idle) FROM cpu GROUP BY time(1m), host',
          epoch: 'ms',
        })}`,
      );
      assert.equal(grouped.status, 200);
      const groupedBody = (await grouped.json()) as InfluxQLResponse;
      assert.equal(groupedBody.results[0].series?.length, 2);

      const join = await fetch(
        `${server.baseUrl}/query?${new URLSearchParams({ db: 'plant_a', q: 'SELECT * FROM cpu, mem' })}`,
      );
      assert.equal(join.status, 501);
    } finally {
      await server.server.stop();
    }
  });

  it('returns 501 for /query when InfluxQL is disabled', async () => {
    const server = await startTestServer({ compat: { influx: { influxql: 'off' } } });
    try {
      const response = await fetch(
        `${server.baseUrl}/query?${new URLSearchParams({ db: 'plant_a', q: 'SELECT * FROM cpu' })}`,
      );
      assert.equal(response.status, 501);
    } finally {
      await server.server.stop();
    }
  });
});
