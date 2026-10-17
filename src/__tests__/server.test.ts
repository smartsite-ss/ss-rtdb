// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * rtdb-server 单测（对齐《详细设计 v2.0》§3.1 / §3.2 / §3.3 / §3.4）：
 * 生命周期、JSON 与 Line Protocol 双协议写入、i64 十进制字符串 + vt roundtrip、四原语查询、
 * 管理路由（库表/metrics/retention/backup）、认证三模式与读写开关、错误码全覆盖、/admin 静态托管。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ERROR_CODE, RtdbError } from '../packages/core/src/errors.ts';
import type { ErrorCode } from '../packages/core/src/errors.ts';
import type { EngineStats } from '../packages/core/src/engine.ts';
import { loadServerConfig } from '../packages/server/src/config.ts';
import type { PartialServerConfig } from '../packages/server/src/config.ts';
import { HttpFailure, SERVER_ERROR_CODE, toHttpErrorResponse } from '../packages/server/src/http-error.ts';
import { Logger } from '../packages/server/src/logger.ts';
import { PROMETHEUS_METRICS_CONTENT_TYPE, encodePrometheusMetrics } from '../packages/server/src/metrics.ts';
import { RtdbServer } from '../packages/server/src/server.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-server-'));
/** 固定基日（10:00），避免跨日边界影响时间戳构造 */
const BASE = new Date(2026, 0, 10, 10, 0, 0).getTime();
const TOKEN = 'a'.repeat(32);
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/* ---------- 夹具与工具 ---------- */

interface TestServer {
  server: RtdbServer;
  baseUrl: string;
  dataDir: string;
}

/** 每个用例独占的数据目录（自增计数，避免互踩） */
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

function postJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function putJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function postText(baseUrl: string, path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
    body,
  });
}

interface ErrorBody {
  error: string;
  message: string;
  details?: readonly unknown[];
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

/* ---------- 生命周期与 status ---------- */

describe('server: 生命周期与 status', () => {
  it('start 返回绑定地址；/status 在认证开启时仍免认证；stop 后可重复关闭', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(rootDirectory, 'unused.token') },
    });
    assert.equal(server.address?.port, Number(new URL(baseUrl).port));

    const response = await fetch(`${baseUrl}/api/v1/status`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      uptimeMs: number;
      databases: number;
      metrics: number;
      write: { pointsPerSec: number; buffered: number; duplicates: number; tagsIgnored: number };
      wal: { pendingBytes: number; outstandingBatches: number };
      segments: { openFiles: number };
      cache: { blocks: number };
    };
    assert.equal(typeof body.uptimeMs, 'number');
    assert.equal(body.databases, 0);
    assert.equal(body.metrics, 0);
    assert.equal(body.write.tagsIgnored, 0);
    assert.equal(body.write.duplicates, 0);
    assert.equal(typeof body.wal.pendingBytes, 'number');
    assert.equal(typeof body.segments.openFiles, 'number');
    assert.equal(typeof body.cache.blocks, 'number');

    await server.stop();
    assert.equal(server.address, null);
    await server.stop(); // 幂等
  });

  it('认证开启且无 token 时首启自动生成 token 并写入 tokenFile', async () => {
    const dataDir = nextDataDir();
    const tokenFile = join(dataDir, 'rtdb.token');
    const config = loadServerConfig({
      env: {},
      overrides: {
        port: 0,
        host: '127.0.0.1',
        dataDir,
        admin: { enabled: false },
        log: { level: 'error' },
        auth: { enabled: true, mode: 'token', tokenFile },
      },
    });
    const server = new RtdbServer({ config, logger: new Logger('error') });
    await server.start();
    try {
      assert.equal(existsSync(tokenFile), true);
      const generated = readFileSync(tokenFile, 'utf8').trim();
      assert.ok(generated.length >= 16);

      // 生成的 token 应可用
      const okResponse = await postText(
        `http://127.0.0.1:${server.address?.port}`,
        '/api/v1/write?db=demo',
        'm 1',
        { Authorization: `Bearer ${generated}` },
      );
      assert.equal(okResponse.status, 200);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- 写入：JSON 协议（i64 vt 决策） ---------- */

describe('server: JSON 写入与 i64 vt 协议', () => {
  it('vt=2 十进制字符串写 i64，读回仍为十进制字符串 + vt=2；f64/bool/string 按值推断', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const writeResponse = await postJson(baseUrl, '/api/v1/write?db=demo', [
        { metricName: 'counter', t: BASE, v: '12345678901', vt: 2 },
        { metricName: 'temperature', t: BASE, v: 21.5 },
        { metricName: 'switch', t: BASE, v: true },
        { metricName: 'label', t: BASE, v: 'running' },
      ]);
      assert.equal(writeResponse.status, 200);
      const writeResult = (await writeResponse.json()) as { accepted: number; duplicates: number };
      assert.equal(writeResult.accepted, 4);
      assert.equal(writeResult.duplicates, 0);

      const counter = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'demo',
        metricName: 'counter',
        start: BASE - 1,
        end: BASE + 1,
      });
      const counterBody = (await counter.json()) as { series: { points: { t: number; v: unknown; vt: number }[] } };
      assert.equal(counterBody.series.points.length, 1);
      assert.equal(counterBody.series.points[0].vt, 2);
      assert.equal(counterBody.series.points[0].v, '12345678901');

      const temperature = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'demo',
        metricName: 'temperature',
        start: BASE - 1,
        end: BASE + 1,
      });
      const temperatureBody = (await temperature.json()) as { series: { points: { v: unknown; vt: number }[] } };
      assert.equal(temperatureBody.series.points[0].vt, 1);
      assert.equal(temperatureBody.series.points[0].v, 21.5);

      const switchSeries = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'demo',
        metricName: 'switch',
        start: BASE - 1,
        end: BASE + 1,
      });
      const switchBody = (await switchSeries.json()) as { series: { points: { v: unknown; vt: number }[] } };
      assert.equal(switchBody.series.points[0].vt, 3);
      assert.equal(switchBody.series.points[0].v, true);

      const label = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'demo',
        metricName: 'label',
        start: BASE - 1,
        end: BASE + 1,
      });
      const labelBody = (await label.json()) as { series: { points: { v: unknown; vt: number }[] } };
      assert.equal(labelBody.series.points[0].vt, 4);
      assert.equal(labelBody.series.points[0].v, 'running');
    } finally {
      await server.stop();
    }
  });

  it('批内同 (metric, ts) 重复点静默丢弃并计入 duplicates', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await postJson(baseUrl, '/api/v1/write?db=dupe', [
        { metricName: 'm', t: BASE, v: 1 },
        { metricName: 'm', t: BASE, v: 2 },
      ]);
      const result = (await response.json()) as { accepted: number; duplicates: number };
      assert.equal(result.accepted, 1);
      assert.equal(result.duplicates, 1);
    } finally {
      await server.stop();
    }
  });

  it('JSON body 含非法点时返回 400 E_INVALID_POINT 且 details 携带索引', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await postJson(baseUrl, '/api/v1/write?db=demo', [
        { metricName: 'ok', t: BASE, v: 1 },
        { metricName: 'bad-ts', t: 'not-a-number', v: 1 },
      ]);
      assert.equal(response.status, 400);
      const body = await readErrorBody(response);
      assert.equal(body.error, ERROR_CODE.InvalidPoint);
      assert.deepEqual(body.details, [1]);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- 写入：Line Protocol ---------- */

describe('server: Line Protocol 兼容', () => {
  it('整数→i64、浮点→f64、布尔、字符串；tag 忽略计数；ns 时间戳取 ms', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const nanosecondBase = BASE * 1_000_000;
      const text = [
        `cpu,host=node1 12.5 ${nanosecondBase}`,
        `counter,host=node1,region=east 42 ${nanosecondBase}`,
        `flag,host=node1 value=true ${nanosecondBase}`,
        `note value="hello world" ${nanosecondBase}`,
      ].join('\n');
      const response = await postText(baseUrl, '/api/v1/write?db=lp', text);
      assert.equal(response.status, 200);
      const result = (await response.json()) as { accepted: number; duplicates: number };
      assert.equal(result.accepted, 4);
      assert.equal(result.duplicates, 0);

      const counter = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'lp',
        metricName: 'counter',
        start: BASE,
        end: BASE,
      });
      const counterBody = (await counter.json()) as { series: { points: { t: number; v: unknown; vt: number }[] } };
      assert.equal(counterBody.series.points.length, 1);
      assert.equal(counterBody.series.points[0].t, BASE);
      assert.equal(counterBody.series.points[0].vt, 2);
      assert.equal(counterBody.series.points[0].v, '42');

      const cpu = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'lp',
        metricName: 'cpu',
        start: BASE,
        end: BASE,
      });
      const cpuBody = (await cpu.json()) as { series: { points: { t: number; v: unknown; vt: number }[] } };
      assert.equal(cpuBody.series.points[0].t, BASE);
      assert.equal(cpuBody.series.points[0].vt, 1);
      assert.equal(cpuBody.series.points[0].v, 12.5);

      // tag 计数：cpu 1 + counter 2 + flag 1 + note 0 = 4
      const status = (await (await fetch(`${baseUrl}/api/v1/status`)).json()) as {
        write: { tagsIgnored: number };
      };
      assert.equal(status.write.tagsIgnored, 4);
    } finally {
      await server.stop();
    }
  });

  it('字段集形式 key=value 与 i 后缀整数均可解析；空行与 # 注释跳过', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const text = [
        '# 注释行',
        '',
        `value field=7 ${BASE * 1_000_000}`,
        `suffix field=9i ${BASE * 1_000_000}`,
      ].join('\n');
      const response = await postText(baseUrl, '/api/v1/write?db=fieldset', text);
      assert.equal(response.status, 200);
      const result = (await response.json()) as { accepted: number };
      assert.equal(result.accepted, 2);

      const series = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'fieldset',
        metricName: 'value',
        start: BASE,
        end: BASE,
      });
      const body = (await series.json()) as { series: { points: { v: unknown; vt: number }[] } };
      assert.equal(body.series.points[0].vt, 2);
      assert.equal(body.series.points[0].v, '7');

      const suffixed = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'fieldset',
        metricName: 'suffix',
        start: BASE,
        end: BASE,
      });
      const suffixedBody = (await suffixed.json()) as { series: { points: { v: unknown; vt: number }[] } };
      assert.equal(suffixedBody.series.points[0].vt, 2);
      assert.equal(suffixedBody.series.points[0].v, '9');
    } finally {
      await server.stop();
    }
  });

  it('Line Protocol 含非法行时整批拒绝（400 E_INVALID_POINT，details 携带行号）', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await postText(baseUrl, '/api/v1/write?db=lp', ['good 1', 'broken'].join('\n'));
      assert.equal(response.status, 400);
      const body = await readErrorBody(response);
      assert.equal(body.error, ERROR_CODE.InvalidPoint);
      assert.deepEqual(body.details, [2]);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- 查询四原语 ---------- */

describe('server: 查询四原语', () => {
  async function seed(baseUrl: string, metricName: string, values: readonly number[], stepMs = 1000): Promise<void> {
    const points = values.map((value, index) => ({ metricName, t: BASE + index * stepMs, v: value }));
    const response = await postJson(baseUrl, '/api/v1/write?db=query', points);
    assert.equal(response.status, 200);
  }

  it('query/range 支持 asc/desc 与 limit；query/last 返回最新点或 null', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await seed(baseUrl, 'flow', [10, 20, 30, 40, 50]);

      const ascending = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'query',
        metricName: 'flow',
        start: BASE,
        end: BASE + 4000,
        limit: 3,
      });
      const ascendingBody = (await ascending.json()) as { series: { points: { t: number; v: unknown }[] } };
      assert.deepEqual(
        ascendingBody.series.points.map((point) => point.v),
        [10, 20, 30],
      );

      const descending = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'query',
        metricName: 'flow',
        start: BASE,
        end: BASE + 4000,
        order: 'desc',
        limit: 2,
      });
      const descendingBody = (await descending.json()) as { series: { points: { t: number; v: unknown }[] } };
      assert.deepEqual(
        descendingBody.series.points.map((point) => point.v),
        [50, 40],
      );

      const last = await postJson(baseUrl, '/api/v1/query/last', { db: 'query', metricName: 'flow' });
      const lastBody = (await last.json()) as { point: { t: number; v: unknown } | null };
      assert.equal(lastBody.point?.v, 50);

      const lastBefore = await postJson(baseUrl, '/api/v1/query/last', {
        db: 'query',
        metricName: 'flow',
        before: BASE + 2000,
      });
      const lastBeforeBody = (await lastBefore.json()) as { point: { v: unknown } | null };
      assert.equal(lastBeforeBody.point?.v, 30);

      const missing = await postJson(baseUrl, '/api/v1/query/last', {
        db: 'query',
        metricName: 'flow',
        before: BASE - 5000,
      });
      const missingBody = (await missing.json()) as { point: unknown };
      assert.equal(missingBody.point, null);
    } finally {
      await server.stop();
    }
  });

  it('query/count 支持索引估算与 exact 精确', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await seed(baseUrl, 'pulse', [1, 2, 3, 4, 5]);
      const estimated = await postJson(baseUrl, '/api/v1/query/count', {
        db: 'query',
        metricName: 'pulse',
        start: BASE + 1000,
        end: BASE + 3000,
      });
      assert.equal(((await estimated.json()) as { count: number }).count, 3);

      const exact = await postJson(baseUrl, '/api/v1/query/count', {
        db: 'query',
        metricName: 'pulse',
        start: BASE + 1000,
        end: BASE + 3000,
        exact: true,
      });
      assert.equal(((await exact.json()) as { count: number }).count, 3);
    } finally {
      await server.stop();
    }
  });

  it('query/aggregate 返回窗口 + 算子值 + vt', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await seed(baseUrl, 'temp', [10, 20, 30, 40, 50], 1000);
      const response = await postJson(baseUrl, '/api/v1/query/aggregate', {
        db: 'query',
        metricName: 'temp',
        start: BASE,
        end: BASE + 4000,
        type: 'avg',
        windowMs: 2000,
      });
      const body = (await response.json()) as {
        windows: { start: number; end: number; v: unknown; vt: number; count: number }[];
      };
      assert.equal(body.windows.length, 3);
      assert.equal(body.windows[0].start, BASE);
      assert.equal(body.windows[0].end, BASE + 2000);
      assert.equal(body.windows[0].count, 2);
      assert.equal(body.windows[0].vt, 1);
      // 时间加权平均：[0,2000) 面积 = (10+20)/2*1000 + (20+30)/2*1000 = 40000，除以窗口宽度 2000 → 20
      assert.equal(body.windows[0].v, 20);
      // [2000,4000)：面积 = (30+40)/2*1000 + (40+50)/2*1000 = 80000 → 40
      assert.equal(body.windows[1].v, 40);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- 管理路由 ---------- */

describe('server: 管理路由', () => {
  it('/api/v1/databases 与 /api/v1/metrics/:db', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await postJson(baseUrl, '/api/v1/write?db=alpha', [{ metricName: 'm1', t: BASE, v: 1 }]);
      await postJson(baseUrl, '/api/v1/write?db=beta', [{ metricName: 'm2', t: BASE, v: 1 }]);

      const databases = await fetch(`${baseUrl}/api/v1/databases`);
      assert.equal(databases.status, 200);
      const databasesBody = (await databases.json()) as { databases: string[] };
      assert.deepEqual(databasesBody.databases, ['alpha', 'beta']);

      const metrics = await fetch(`${baseUrl}/api/v1/metrics/alpha`);
      assert.equal(metrics.status, 200);
      const metricsBody = (await metrics.json()) as { metrics: { metricName: string; firstTs: number; lastTs: number }[] };
      assert.equal(metricsBody.metrics.length, 1);
      assert.equal(metricsBody.metrics[0].metricName, 'm1');
      assert.equal(metricsBody.metrics[0].firstTs, BASE);
    } finally {
      await server.stop();
    }
  });

  it('PUT /api/v1/retention/:db 写入 retention.json 并返回 {ok:true}', async () => {
    const { server, baseUrl, dataDir } = await startTestServer();
    try {
      await postJson(baseUrl, '/api/v1/write?db=alpha', [{ metricName: 'm1', t: BASE, v: 1 }]);
      const response = await putJson(baseUrl, '/api/v1/retention/alpha', { days: 30 });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });

      const retentionFile = join(dataDir, 'alpha', 'retention.json');
      assert.equal(existsSync(retentionFile), true);
      const parsed = JSON.parse(readFileSync(retentionFile, 'utf8')) as {
        retentionDays: number;
      };
      assert.equal(parsed.retentionDays, 30);
    } finally {
      await server.stop();
    }
  });

  it('POST /api/v1/backup/:db 返回复制文件数', async () => {
    const { server, baseUrl, dataDir } = await startTestServer();
    try {
      await postJson(baseUrl, '/api/v1/write?db=alpha', [{ metricName: 'm1', t: BASE, v: 1 }]);
      const response = await postJson(baseUrl, '/api/v1/backup/alpha', { targetDir: join(dataDir, 'backup') });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { files: number; totalBytes: number; database: string };
      assert.equal(body.database, 'alpha');
      assert.ok(body.files >= 1);
      assert.equal(existsSync(join(dataDir, 'backup', 'alpha')), true);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- 认证 ---------- */

describe('server: 认证', () => {
  it('token 模式：无 token 401，正确 token 放行', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(rootDirectory, 'unused.token') },
    });
    try {
      const denied = await postText(baseUrl, '/api/v1/write?db=demo', 'm 1');
      assert.equal(denied.status, 401);
      assert.equal((await readErrorBody(denied)).error, ERROR_CODE.Auth);

      const allowed = await postText(baseUrl, '/api/v1/write?db=demo', 'm 1', {
        Authorization: `Bearer ${TOKEN}`,
      });
      assert.equal(allowed.status, 200);

      const wrong = await postText(baseUrl, '/api/v1/write?db=demo', 'm 1', {
        Authorization: `Bearer ${'b'.repeat(32)}`,
      });
      assert.equal(wrong.status, 401);
    } finally {
      await server.stop();
    }
  });

  it('basic 模式：正确口令放行、错误口令 401', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        mode: 'basic',
        username: 'admin',
        password: 'password123',
        tokenFile: join(rootDirectory, 'unused.token'),
      },
    });
    try {
      const wrong = await postText(baseUrl, '/api/v1/write?db=demo', 'm 1', {
        Authorization: `Basic ${Buffer.from('admin:wrong-password').toString('base64')}`,
      });
      assert.equal(wrong.status, 401);

      const allowed = await postText(baseUrl, '/api/v1/write?db=demo', 'm 1', {
        Authorization: `Basic ${Buffer.from('admin:password123').toString('base64')}`,
      });
      assert.equal(allowed.status, 200);
    } finally {
      await server.stop();
    }
  });

  it('both 模式：token 与 basic 任一通过', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        mode: 'both',
        token: TOKEN,
        username: 'admin',
        password: 'password123',
        tokenFile: join(rootDirectory, 'unused.token'),
      },
    });
    try {
      const viaToken = await postText(baseUrl, '/api/v1/write?db=demo', 'm 1', {
        Authorization: `Bearer ${TOKEN}`,
      });
      assert.equal(viaToken.status, 200);

      const viaBasic = await postText(baseUrl, '/api/v1/write?db=demo', 'm 2', {
        Authorization: `Basic ${Buffer.from('admin:password123').toString('base64')}`,
      });
      assert.equal(viaBasic.status, 200);
    } finally {
      await server.stop();
    }
  });

  it('auth.write=false 免写认证；auth.query=true 仍拦截读接口', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        mode: 'token',
        token: TOKEN,
        write: false,
        query: true,
        tokenFile: join(rootDirectory, 'unused.token'),
      },
    });
    try {
      const write = await postText(baseUrl, '/api/v1/write?db=demo', 'm 1');
      assert.equal(write.status, 200);

      const read = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'demo',
        metricName: 'm',
        start: BASE - 1,
        end: BASE + 1,
      });
      assert.equal(read.status, 401);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- 错误码全覆盖 ---------- */

describe('server: 错误码映射与 HTTP 全覆盖', () => {
  it('core 错误码 → HTTP 状态码映射全表一致；429 附 Retry-After: 1', () => {
    const expected: readonly [ErrorCode, number][] = [
      [ERROR_CODE.InvalidPoint, 400],
      [ERROR_CODE.InvalidRange, 400],
      [ERROR_CODE.BadMetricName, 400],
      [ERROR_CODE.TypeMismatch, 400],
      [ERROR_CODE.Auth, 401],
      [ERROR_CODE.DatabaseNotFound, 404],
      [ERROR_CODE.MetricNotFound, 404],
      [ERROR_CODE.DatabaseLocked, 409],
      [ERROR_CODE.BatchTooLarge, 413],
      [ERROR_CODE.RateLimited, 429],
      [ERROR_CODE.Io, 500],
      [ERROR_CODE.CorruptBlock, 500],
      [ERROR_CODE.CorruptSegment, 500],
      [ERROR_CODE.Internal, 500],
    ];
    for (const [code, status] of expected) {
      const mapped = toHttpErrorResponse(new RtdbError(code, '测试'));
      assert.equal(mapped.status, status, `错误码 ${code} 状态码应为 ${status}`);
      assert.equal(mapped.body.error, code);
    }

    const rateLimited = toHttpErrorResponse(new RtdbError(ERROR_CODE.RateLimited, '背压'));
    assert.equal(rateLimited.headers['Retry-After'], '1');
  });

  it('400：库名非法 / 区间非法 / 测点名非法 / 类型不符', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const badDatabase = await postText(baseUrl, '/api/v1/write?db=%20bad', 'm 1');
      assert.equal(badDatabase.status, 400);
      assert.equal((await readErrorBody(badDatabase)).error, ERROR_CODE.InvalidPoint);

      const missingDatabase = await postText(baseUrl, '/api/v1/write', 'm 1');
      assert.equal(missingDatabase.status, 400);
      assert.equal((await readErrorBody(missingDatabase)).error, ERROR_CODE.InvalidPoint);

      await postJson(baseUrl, '/api/v1/write?db=demo', [{ metricName: 'm', t: BASE, v: 1 }]);

      const badRange = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'demo',
        metricName: 'm',
        start: 'oops',
        end: BASE,
      });
      assert.equal(badRange.status, 400);
      assert.equal((await readErrorBody(badRange)).error, ERROR_CODE.InvalidRange);

      const badMetricName = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'demo',
        start: BASE,
        end: BASE,
      });
      assert.equal(badMetricName.status, 400);
      assert.equal((await readErrorBody(badMetricName)).error, ERROR_CODE.BadMetricName);

      const typeMismatch = await postJson(baseUrl, '/api/v1/write?db=demo', [
        { metricName: 'm', t: BASE + 1, v: 'text' },
      ]);
      assert.equal(typeMismatch.status, 400);
      assert.equal((await readErrorBody(typeMismatch)).error, ERROR_CODE.TypeMismatch);

      const badAggregate = await postJson(baseUrl, '/api/v1/query/aggregate', {
        db: 'demo',
        metricName: 'm',
        start: BASE,
        end: BASE + 1000,
        type: 'median',
        windowMs: 1000,
      });
      assert.equal(badAggregate.status, 400);
      assert.equal((await readErrorBody(badAggregate)).error, ERROR_CODE.InvalidRange);

      const zeroWindow = await postJson(baseUrl, '/api/v1/query/aggregate', {
        db: 'demo',
        metricName: 'm',
        start: BASE,
        end: BASE + 1000,
        type: 'avg',
        windowMs: 0,
      });
      assert.equal(zeroWindow.status, 400);
      assert.equal((await readErrorBody(zeroWindow)).error, ERROR_CODE.InvalidRange);
    } finally {
      await server.stop();
    }
  });

  it('404：库不存在 / 测点不存在', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const noDatabase = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'ghost',
        metricName: 'm',
        start: BASE,
        end: BASE + 1,
      });
      assert.equal(noDatabase.status, 404);
      assert.equal((await readErrorBody(noDatabase)).error, ERROR_CODE.DatabaseNotFound);

      await postJson(baseUrl, '/api/v1/write?db=demo', [{ metricName: 'present', t: BASE, v: 1 }]);
      const noMetric = await postJson(baseUrl, '/api/v1/query/range', {
        db: 'demo',
        metricName: 'absent',
        start: BASE,
        end: BASE + 1,
      });
      assert.equal(noMetric.status, 404);
      assert.equal((await readErrorBody(noMetric)).error, ERROR_CODE.MetricNotFound);

      const metricsOfGhost = await fetch(`${baseUrl}/api/v1/metrics/ghost`);
      assert.equal(metricsOfGhost.status, 404);
      assert.equal((await readErrorBody(metricsOfGhost)).error, ERROR_CODE.DatabaseNotFound);
    } finally {
      await server.stop();
    }
  });

  it('413：单批点数超上限', async () => {
    const { server, baseUrl } = await startTestServer({ write: { maxBatch: 1 } });
    try {
      const response = await postJson(baseUrl, '/api/v1/write?db=demo', [
        { metricName: 'm', t: BASE, v: 1 },
        { metricName: 'm', t: BASE + 1, v: 2 },
      ]);
      assert.equal(response.status, 413);
      assert.equal((await readErrorBody(response)).error, ERROR_CODE.BatchTooLarge);
    } finally {
      await server.stop();
    }
  });

  it('404/405：未知路由、方法不允许', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const unknown = await fetch(`${baseUrl}/api/v1/nope`);
      assert.equal(unknown.status, 404);
      assert.equal((await readErrorBody(unknown)).error, SERVER_ERROR_CODE.RouteNotFound);

      const wrongMethod = await fetch(`${baseUrl}/api/v1/write`);
      assert.equal(wrongMethod.status, 405);
      assert.equal((await readErrorBody(wrongMethod)).error, SERVER_ERROR_CODE.MethodNotAllowed);
      assert.equal(wrongMethod.headers.get('allow'), 'POST');
    } finally {
      await server.stop();
    }
  });

  it('403：E_FORBIDDEN 映射为 403 且独立于 401 E_AUTH', () => {
    const mapped = toHttpErrorResponse(new HttpFailure(403, SERVER_ERROR_CODE.Forbidden, '权限不足'));
    assert.equal(mapped.status, 403);
    assert.equal(mapped.body.error, SERVER_ERROR_CODE.Forbidden);
    assert.equal(SERVER_ERROR_CODE.Forbidden, 'E_FORBIDDEN');
  });

  it('非 RtdbError 统一归为 500 E_INTERNAL', () => {
    const mapped = toHttpErrorResponse(new Error('意外错误'));
    assert.equal(mapped.status, 500);
    assert.equal(mapped.body.error, ERROR_CODE.Internal);
    assert.equal(mapped.body.message, '意外错误');
  });
});

/* ---------- 多用户管理（admin/users） ---------- */

interface AdminUserBody {
  user: { username: string; role: string; enabled: boolean; createdAt: number; updatedAt: number };
}

interface AdminUsersBody {
  users: Array<{ username: string; role: string; enabled: boolean; createdAt: number; updatedAt: number }>;
}

interface AdminTokenBody {
  token: string;
  tokenRecord: {
    tokenId: string;
    user: string;
    role: string;
    label: string;
    createdAt: number;
    expiresAt: number | null;
    revokedAt: number | null;
  };
}

interface AdminTokensBody {
  tokens: AdminTokenBody['tokenRecord'][];
}

describe('server: 多用户管理（admin/users）', () => {
  it('认证关闭时 admin 路由免认证；用户 CRUD 全流程与错误码', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const created = await postJson(baseUrl, '/api/v1/admin/users', {
        username: 'alice',
        password: 'password123',
        role: 'write',
      });
      assert.equal(created.status, 201);
      const createdBody = (await created.json()) as AdminUserBody;
      assert.equal(createdBody.user.username, 'alice');
      assert.equal(createdBody.user.role, 'write');
      assert.equal(createdBody.user.enabled, true);
      // 口令哈希绝不出现在对外投影中
      assert.equal(Object.hasOwn(createdBody.user, 'passwordHash'), false);

      const listed = await fetch(`${baseUrl}/api/v1/admin/users`);
      assert.equal(listed.status, 200);
      const listedBody = (await listed.json()) as AdminUsersBody;
      assert.equal(listedBody.users.length, 1);
      assert.equal(listedBody.users[0].username, 'alice');

      const duplicate = await postJson(baseUrl, '/api/v1/admin/users', { username: 'alice', password: 'password123' });
      assert.equal(duplicate.status, 409);
      assert.equal((await readErrorBody(duplicate)).error, SERVER_ERROR_CODE.UserExists);

      const badName = await postJson(baseUrl, '/api/v1/admin/users', { username: '1bad', password: 'password123' });
      assert.equal(badName.status, 400);
      assert.equal((await readErrorBody(badName)).error, ERROR_CODE.InvalidPoint);

      const shortPassword = await postJson(baseUrl, '/api/v1/admin/users', { username: 'bob', password: 'short' });
      assert.equal(shortPassword.status, 400);
      assert.equal((await readErrorBody(shortPassword)).error, ERROR_CODE.InvalidPoint);

      const disabled = await putJson(baseUrl, '/api/v1/admin/users/alice', { enabled: false });
      assert.equal(disabled.status, 200);
      assert.equal(((await disabled.json()) as AdminUserBody).user.enabled, false);

      const missing = await putJson(baseUrl, '/api/v1/admin/users/ghost', { enabled: false });
      assert.equal(missing.status, 404);
      assert.equal((await readErrorBody(missing)).error, SERVER_ERROR_CODE.UserNotFound);

      const removed = await fetch(`${baseUrl}/api/v1/admin/users/alice`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.deepEqual(await removed.json(), { ok: true });

      const removedAgain = await fetch(`${baseUrl}/api/v1/admin/users/alice`, { method: 'DELETE' });
      assert.equal(removedAgain.status, 404);
      assert.equal((await readErrorBody(removedAgain)).error, SERVER_ERROR_CODE.UserNotFound);

      const empty = await fetch(`${baseUrl}/api/v1/admin/users`);
      assert.deepEqual(((await empty.json()) as AdminUsersBody).users, []);
    } finally {
      await server.stop();
    }
  });

  it('admin 路由方法不允许返回 405 且带 Allow 头', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const patch = await fetch(`${baseUrl}/api/v1/admin/users`, { method: 'PATCH' });
      assert.equal(patch.status, 405);
      assert.equal((await readErrorBody(patch)).error, SERVER_ERROR_CODE.MethodNotAllowed);
      assert.equal(patch.headers.get('allow'), 'GET, POST');
    } finally {
      await server.stop();
    }
  });
});

/* ---------- 登录与会话（auth/login · session · logout） ---------- */

interface LoginBody {
  token: string;
  expiresAt: number | null;
  user: { username: string; role: string };
}

interface SessionBody {
  user: { username: string; role: string };
  source: string;
  scopes: string[];
}

describe('server: 登录与会话（auth/login）', () => {
  it('首启空用户目录自动创建默认管理员 admin/ss-rtdb；登录换令牌后可写可查可管理，登出后令牌失效', async () => {
    const dataDir = nextDataDir();
    const config = loadServerConfig({
      env: {},
      overrides: {
        port: 0,
        host: '127.0.0.1',
        dataDir,
        admin: { enabled: false },
        log: { level: 'error' },
        auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(dataDir, 'rtdb.token') },
      },
    });
    const server = new RtdbServer({ config, logger: new Logger('error') });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    try {
      // 默认管理员已落盘，且只存 scrypt 哈希（不含明文口令）
      const usersFile = join(dataDir, 'rtdb-users.json');
      assert.equal(existsSync(usersFile), true);
      const usersText = readFileSync(usersFile, 'utf8');
      assert.match(usersText, /"username":\s*"admin"/);
      assert.doesNotMatch(usersText, /ss-rtdb/);

      const login = await postJson(baseUrl, '/api/v1/auth/login', { username: 'admin', password: 'ss-rtdb' });
      assert.equal(login.status, 200);
      const body = (await login.json()) as LoginBody;
      assert.equal(body.user.username, 'admin');
      assert.equal(body.user.role, 'admin');
      assert.equal(body.expiresAt, null);
      assert.ok(body.token.length >= 16);

      const headers = { Authorization: `Bearer ${body.token}` };

      const session = await fetch(`${baseUrl}/api/v1/auth/session`, { headers });
      assert.equal(session.status, 200);
      const sessionBody = (await session.json()) as SessionBody;
      assert.deepEqual(sessionBody.user, { username: 'admin', role: 'admin' });
      assert.equal(sessionBody.source, 'token');
      assert.deepEqual(sessionBody.scopes, ['query', 'write', 'admin']);

      // 该令牌覆盖写入 / 查询 / 管理三个域
      const write = await postJson(
        baseUrl,
        '/api/v1/write?db=demo',
        [{ metricName: 'login', t: BASE, v: 1 }],
        headers,
      );
      assert.equal(write.status, 200);
      const read = await postJson(
        baseUrl,
        '/api/v1/query/range',
        { db: 'demo', metricName: 'login', start: BASE - 1, end: BASE + 1 },
        headers,
      );
      assert.equal(read.status, 200);
      const listing = await fetch(`${baseUrl}/api/v1/admin/users`, { headers });
      assert.equal(listing.status, 200);

      // 登出吊销令牌
      const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST', headers });
      assert.equal(logout.status, 200);
      assert.deepEqual(await logout.json(), { ok: true, revoked: true });

      const afterLogout = await fetch(`${baseUrl}/api/v1/auth/session`, { headers });
      assert.equal(afterLogout.status, 401);
      assert.equal((await readErrorBody(afterLogout)).error, ERROR_CODE.Auth);
    } finally {
      await server.stop();
    }
  });

  it('错误口令与未知用户统一 401 E_AUTH；缺字段 400；失败不签发令牌', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(rootDirectory, 'login-fail.token') },
    });
    try {
      const wrong = await postJson(baseUrl, '/api/v1/auth/login', { username: 'admin', password: 'nope' });
      assert.equal(wrong.status, 401);
      assert.equal((await readErrorBody(wrong)).error, ERROR_CODE.Auth);

      const ghost = await postJson(baseUrl, '/api/v1/auth/login', { username: 'ghost', password: 'ss-rtdb' });
      assert.equal(ghost.status, 401);
      assert.equal((await readErrorBody(ghost)).error, ERROR_CODE.Auth);

      const missing = await postJson(baseUrl, '/api/v1/auth/login', { username: 'admin' });
      assert.equal(missing.status, 400);
      assert.equal((await readErrorBody(missing)).error, ERROR_CODE.InvalidPoint);

      // 令牌目录仍为空：失败的登录不会留下可用凭据
      const tokens = await fetch(`${baseUrl}/api/v1/admin/tokens`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.deepEqual(((await tokens.json()) as AdminTokensBody).tokens, []);
    } finally {
      await server.stop();
    }
  });

  it('用户目录非空时不再创建默认管理员；改密后旧口令失效、新口令可登录', async () => {
    const dataDir = nextDataDir();
    const start = async (): Promise<TestServer> => {
      const config = loadServerConfig({
        env: {},
        overrides: {
          port: 0,
          host: '127.0.0.1',
          dataDir,
          admin: { enabled: false },
          log: { level: 'error' },
          auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(dataDir, 'rtdb.token') },
        },
      });
      const server = new RtdbServer({ config, logger: new Logger('error') });
      const address = await server.start();
      return { server, baseUrl: `http://${address.host}:${address.port}`, dataDir };
    };

    const first = await start();
    try {
      const login = await postJson(first.baseUrl, '/api/v1/auth/login', { username: 'admin', password: 'ss-rtdb' });
      assert.equal(login.status, 200);
      const token = ((await login.json()) as LoginBody).token;
      const changed = await putJson(
        first.baseUrl,
        '/api/v1/admin/users/admin',
        { password: 'n3w-password' },
        { Authorization: `Bearer ${token}` },
      );
      assert.equal(changed.status, 200);
    } finally {
      await first.server.stop();
    }

    const second = await start();
    try {
      const withOld = await postJson(second.baseUrl, '/api/v1/auth/login', { username: 'admin', password: 'ss-rtdb' });
      assert.equal(withOld.status, 401);
      const withNew = await postJson(second.baseUrl, '/api/v1/auth/login', { username: 'admin', password: 'n3w-password' });
      assert.equal(withNew.status, 200);
      // bootstrap 只在空目录生效：重启后仍只有这一个用户
      const users = await fetch(`${second.baseUrl}/api/v1/admin/users`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(((await users.json()) as AdminUsersBody).users.length, 1);
    } finally {
      await second.server.stop();
    }
  });

  it('登录/登出路由：方法不允许返回 405；静态令牌登出报告 revoked=false', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(rootDirectory, 'logout.token') },
    });
    try {
      const getLogin = await fetch(`${baseUrl}/api/v1/auth/login`);
      assert.equal(getLogin.status, 405);
      assert.equal(getLogin.headers.get('allow'), 'POST');

      const getSession = await fetch(`${baseUrl}/api/v1/auth/session`, { method: 'POST' });
      assert.equal(getSession.status, 405);

      const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(logout.status, 200);
      assert.deepEqual(await logout.json(), { ok: true, revoked: false });
    } finally {
      await server.stop();
    }
  });
});

/* ---------- 角色 scope 授权（401 / 403） ---------- */

describe('server: 角色 scope 授权（401 / 403）', () => {
  it('readonly / write / admin 三种角色令牌的 scope 边界；无凭据 401、越权 403', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(rootDirectory, 'scope.token') },
    });
    const adminHeaders = { Authorization: `Bearer ${TOKEN}` };
    try {
      // 无凭据访问 admin 作用域 -> 401（凭据缺失）
      const noCredential = await fetch(`${baseUrl}/api/v1/admin/users`);
      assert.equal(noCredential.status, 401);
      assert.equal((await readErrorBody(noCredential)).error, ERROR_CODE.Auth);

      // 无效凭据 -> 401
      const wrongCredential = await fetch(`${baseUrl}/api/v1/admin/users`, {
        headers: { Authorization: `Bearer ${'b'.repeat(32)}` },
      });
      assert.equal(wrongCredential.status, 401);

      // 静态 admin 令牌写入种子数据，供 readonly 令牌查询
      const seed = await postJson(baseUrl, '/api/v1/write?db=demo', [{ metricName: 'm', t: BASE, v: 1 }], adminHeaders);
      assert.equal(seed.status, 200);

      const usersToCreate: readonly (readonly [string, string])[] = [
        ['reader', 'readonly'],
        ['writer', 'write'],
        ['boss', 'admin'],
      ];
      for (const [username, role] of usersToCreate) {
        const created = await postJson(baseUrl, '/api/v1/admin/users', { username, password: 'password123', role }, adminHeaders);
        assert.equal(created.status, 201);
      }

      async function tokenFor(username: string): Promise<string> {
        const issued = await postJson(baseUrl, '/api/v1/admin/tokens', { user: username }, adminHeaders);
        assert.equal(issued.status, 201);
        return ((await issued.json()) as AdminTokenBody).token;
      }
      const readerHeaders = { Authorization: `Bearer ${await tokenFor('reader')}` };
      const writerHeaders = { Authorization: `Bearer ${await tokenFor('writer')}` };
      const bossHeaders = { Authorization: `Bearer ${await tokenFor('boss')}` };

      // readonly：可查询、不可写、不可管理
      const readerQuery = await postJson(
        baseUrl,
        '/api/v1/query/range',
        { db: 'demo', metricName: 'm', start: BASE - 1, end: BASE + 1 },
        readerHeaders,
      );
      assert.equal(readerQuery.status, 200);

      const readerWrite = await postText(baseUrl, '/api/v1/write?db=demo', 'm 2', readerHeaders);
      assert.equal(readerWrite.status, 403);
      assert.equal((await readErrorBody(readerWrite)).error, SERVER_ERROR_CODE.Forbidden);

      const readerAdmin = await fetch(`${baseUrl}/api/v1/admin/users`, { headers: readerHeaders });
      assert.equal(readerAdmin.status, 403);
      assert.equal((await readErrorBody(readerAdmin)).error, SERVER_ERROR_CODE.Forbidden);

      // write：可写、不可管理
      const writerWrite = await postJson(baseUrl, '/api/v1/write?db=demo', [{ metricName: 'm', t: BASE + 1, v: 3 }], writerHeaders);
      assert.equal(writerWrite.status, 200);

      const writerAdmin = await fetch(`${baseUrl}/api/v1/admin/users`, { headers: writerHeaders });
      assert.equal(writerAdmin.status, 403);
      assert.equal((await readErrorBody(writerAdmin)).error, SERVER_ERROR_CODE.Forbidden);

      // admin：可写、可管理
      const bossWrite = await postJson(baseUrl, '/api/v1/write?db=demo', [{ metricName: 'm', t: BASE + 2, v: 4 }], bossHeaders);
      assert.equal(bossWrite.status, 200);

      const bossAdmin = await fetch(`${baseUrl}/api/v1/admin/users`, { headers: bossHeaders });
      assert.equal(bossAdmin.status, 200);
    } finally {
      await server.stop();
    }
  });

  it('basic 凭据始终以 admin 角色访问 admin 作用域', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        mode: 'basic',
        username: 'root',
        password: 'password123',
        tokenFile: join(rootDirectory, 'basic-scope.token'),
      },
    });
    const basicHeaders = { Authorization: `Basic ${Buffer.from('root:password123').toString('base64')}` };
    try {
      const listed = await fetch(`${baseUrl}/api/v1/admin/users`, { headers: basicHeaders });
      assert.equal(listed.status, 200);

      const noCredential = await fetch(`${baseUrl}/api/v1/admin/users`);
      assert.equal(noCredential.status, 401);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- API 令牌（admin/tokens） ---------- */

describe('server: API 令牌（admin/tokens）', () => {
  it('签发（role 缺省继承用户角色）/ 列表 / 吊销；明文与哈希均不落列表', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await postJson(baseUrl, '/api/v1/admin/users', { username: 'carol', password: 'password123', role: 'write' });

      const issued = await postJson(baseUrl, '/api/v1/admin/tokens', { user: 'carol', label: 'ci' });
      assert.equal(issued.status, 201);
      const issuedBody = (await issued.json()) as AdminTokenBody;
      assert.equal(issuedBody.tokenRecord.user, 'carol');
      assert.equal(issuedBody.tokenRecord.role, 'write');
      assert.equal(issuedBody.tokenRecord.label, 'ci');
      assert.equal(issuedBody.tokenRecord.expiresAt, null);
      assert.equal(issuedBody.tokenRecord.revokedAt, null);
      assert.equal(typeof issuedBody.token, 'string');
      assert.ok(issuedBody.token.length >= 32);

      const listed = await fetch(`${baseUrl}/api/v1/admin/tokens`);
      assert.equal(listed.status, 200);
      const listedBody = (await listed.json()) as AdminTokensBody;
      assert.equal(listedBody.tokens.length, 1);
      assert.equal(Object.hasOwn(listedBody.tokens[0], 'token'), false);
      assert.equal(Object.hasOwn(listedBody.tokens[0], 'tokenHash'), false);

      // 显式 role / ttlMs 覆盖缺省值
      const explicit = await postJson(baseUrl, '/api/v1/admin/tokens', {
        user: 'carol',
        role: 'readonly',
        ttlMs: 60_000,
      });
      assert.equal(explicit.status, 201);
      const explicitBody = (await explicit.json()) as AdminTokenBody;
      assert.equal(explicitBody.tokenRecord.role, 'readonly');
      assert.equal(typeof explicitBody.tokenRecord.expiresAt, 'number');

      const revoked = await fetch(`${baseUrl}/api/v1/admin/tokens/${issuedBody.tokenRecord.tokenId}`, { method: 'DELETE' });
      assert.equal(revoked.status, 200);
      assert.deepEqual(await revoked.json(), { ok: true });

      // 重复吊销幂等：仍返回 200（保留首次吊销时间）
      const revokeAgain = await fetch(`${baseUrl}/api/v1/admin/tokens/${issuedBody.tokenRecord.tokenId}`, { method: 'DELETE' });
      assert.equal(revokeAgain.status, 200);

      const revokeUnknown = await fetch(`${baseUrl}/api/v1/admin/tokens/${'0'.repeat(36)}`, { method: 'DELETE' });
      assert.equal(revokeUnknown.status, 404);
      assert.equal((await readErrorBody(revokeUnknown)).error, SERVER_ERROR_CODE.TokenNotFound);
    } finally {
      await server.stop();
    }
  });

  it('吊销后的令牌不可再用（401）；过期令牌同样被拒（401）', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(rootDirectory, 'token-lifecycle.token') },
    });
    const adminHeaders = { Authorization: `Bearer ${TOKEN}` };
    try {
      const issued = await postJson(baseUrl, '/api/v1/admin/tokens', { user: 'eve', role: 'write' }, adminHeaders);
      assert.equal(issued.status, 201);
      const issuedBody = (await issued.json()) as AdminTokenBody;

      const before = await postText(baseUrl, '/api/v1/write?db=demo', 'm 1', {
        Authorization: `Bearer ${issuedBody.token}`,
      });
      assert.equal(before.status, 200);

      await fetch(`${baseUrl}/api/v1/admin/tokens/${issuedBody.tokenRecord.tokenId}`, {
        method: 'DELETE',
        headers: adminHeaders,
      });
      const afterRevoke = await postText(baseUrl, '/api/v1/write?db=demo', 'm 2', {
        Authorization: `Bearer ${issuedBody.token}`,
      });
      assert.equal(afterRevoke.status, 401);
      assert.equal((await readErrorBody(afterRevoke)).error, ERROR_CODE.Auth);

      const expiring = await postJson(baseUrl, '/api/v1/admin/tokens', { user: 'eve', role: 'write', ttlMs: 1 }, adminHeaders);
      assert.equal(expiring.status, 201);
      const expiringToken = ((await expiring.json()) as AdminTokenBody).token;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      const expired = await postText(baseUrl, '/api/v1/write?db=demo', 'm 3', {
        Authorization: `Bearer ${expiringToken}`,
      });
      assert.equal(expired.status, 401);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- /admin 静态托管 ---------- */

describe('server: /admin 静态托管', () => {
  it('托管 index.html 与静态资源；缺失路径回落 index.html；目录穿越拒绝', async () => {
    const adminDirectory = nextDataDir();
    mkdirSync(adminDirectory, { recursive: true });
    writeFileSync(join(adminDirectory, 'index.html'), '<!doctype html><title>rtdb-admin</title>', 'utf8');
    writeFileSync(join(adminDirectory, 'app.js'), 'console.log("ok");', 'utf8');
    writeFileSync(join(rootDirectory, 'secret.txt'), 'top-secret', 'utf8');

    const { server, baseUrl } = await startTestServer({
      admin: { enabled: true, staticDir: adminDirectory },
    });
    try {
      // 无尾斜杠入口 → 301 到目录形式（index.html 以相对路径引用静态资源，文档 URL 必须以 `/` 结尾才能命中）
      const redirect = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
      assert.equal(redirect.status, 301);
      assert.equal(redirect.headers.get('location'), '/admin/');
      await redirect.text();

      const index = await fetch(`${baseUrl}/admin/`);
      assert.equal(index.status, 200);
      assert.match(index.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await index.text(), /rtdb-admin/);

      const appJs = await fetch(`${baseUrl}/admin/app.js`);
      assert.equal(appJs.status, 200);
      assert.match(appJs.headers.get('content-type') ?? '', /javascript/);

      // SPA 回落：不存在路径返回 index.html
      const fallback = await fetch(`${baseUrl}/admin/dashboard/overview`);
      assert.equal(fallback.status, 200);
      assert.match(await fallback.text(), /rtdb-admin/);

      // 目录穿越：%2e%2e 不会被 URL 归一化，交由 server 拒绝
      const traversal = await fetch(`${baseUrl}/admin/%2e%2e/secret.txt`);
      assert.equal(traversal.status, 404);
      assert.equal((await readErrorBody(traversal)).error, SERVER_ERROR_CODE.RouteNotFound);
    } finally {
      await server.stop();
    }
  });

  it('根路径 302 跳转到 /admin/；admin 关闭时保持 404', async () => {
    const adminDirectory = nextDataDir();
    mkdirSync(adminDirectory, { recursive: true });
    writeFileSync(join(adminDirectory, 'index.html'), '<!doctype html><title>rtdb-admin</title>', 'utf8');

    const enabled = await startTestServer({ admin: { enabled: true, staticDir: adminDirectory } });
    try {
      const root = await fetch(`${enabled.baseUrl}/`, { redirect: 'manual' });
      assert.equal(root.status, 302);
      assert.equal(root.headers.get('location'), '/admin/');
      await root.text();

      // 跟随跳转后应直接落在控制台首页
      const followed = await fetch(`${enabled.baseUrl}/`);
      assert.equal(followed.status, 200);
      assert.match(await followed.text(), /rtdb-admin/);

      const post = await fetch(`${enabled.baseUrl}/`, { method: 'POST' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET');
      await post.text();
    } finally {
      await enabled.server.stop();
    }

    const disabled = await startTestServer({ admin: { enabled: false } });
    try {
      const root = await fetch(`${disabled.baseUrl}/`, { redirect: 'manual' });
      assert.equal(root.status, 404);
      assert.equal((await readErrorBody(root)).error, SERVER_ERROR_CODE.RouteNotFound);
    } finally {
      await disabled.server.stop();
    }
  });

  it('admin.enabled=false 时 /admin/* 返回 404', async () => {
    const { server, baseUrl } = await startTestServer({ admin: { enabled: false } });
    try {
      const response = await fetch(`${baseUrl}/admin/index.html`);
      assert.equal(response.status, 404);
    } finally {
      await server.stop();
    }
  });

  it('内置形态默认静态根：尾分隔符被消除，/admin/ 与相对资源均可命中', async (context) => {
    const bundledIndexUrl = new URL('../packages/admin/dist/index.html', import.meta.url);
    if (!existsSync(bundledIndexUrl)) {
      context.skip('packages/admin/dist 未构建（先执行 npm run build --workspace @ss/rtdb-admin）');
      return;
    }
    const { server, baseUrl } = await startTestServer({ admin: { enabled: true, staticDir: '' } });
    try {
      // 默认静态根来自 fileURLToPath(目录 URL)（带尾分隔符）；若未归一化，`${root}${sep}` 前缀校验永不命中
      const index = await fetch(`${baseUrl}/admin/`);
      assert.equal(index.status, 200);
      const html = await index.text();
      assert.match(html, /id="app"/);

      const assetMatch = /src="\.\/([^"]+\.js)"/.exec(html);
      assert.ok(assetMatch !== null, 'index.html 应包含相对脚本引用');
      const assetPath = assetMatch === null ? '' : assetMatch[1];
      assert.notEqual(assetPath, '');
      const asset = await fetch(`${baseUrl}/admin/${assetPath}`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- CORS（可选跨域，服务独立形态 rtdb-admin） ---------- */

describe('server: CORS 跨域（cors.allowedOrigins）', () => {
  it('默认关闭：带 Origin 的请求不下发 Access-Control-Allow-Origin', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/status`, { headers: { Origin: 'http://console.example' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    } finally {
      await server.stop();
    }
  });

  it('允许列表内的 Origin 回显并带 Vary；列表外的 Origin 不下发', async () => {
    const { server, baseUrl } = await startTestServer({ cors: { allowedOrigins: ['http://console.example'] } });
    try {
      const allowed = await fetch(`${baseUrl}/api/v1/status`, { headers: { Origin: 'http://console.example' } });
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://console.example');
      assert.equal(allowed.headers.get('vary'), 'Origin');

      const denied = await fetch(`${baseUrl}/api/v1/status`, { headers: { Origin: 'http://evil.example' } });
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    } finally {
      await server.stop();
    }
  });

  it('`*` 允许任意 Origin（不下发 Vary）；OPTIONS 预检返回 204 与允许的方法/请求头', async () => {
    const { server, baseUrl } = await startTestServer({ cors: { allowedOrigins: ['*'] } });
    try {
      const preflight = await fetch(`${baseUrl}/api/v1/query/range`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://console.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
      assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
      assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Authorization/);

      const actual = await fetch(`${baseUrl}/api/v1/status`, { headers: { Origin: 'http://console.example' } });
      assert.equal(actual.headers.get('access-control-allow-origin'), '*');
      assert.equal(actual.headers.get('vary'), null);
    } finally {
      await server.stop();
    }
  });

  it('错误响应同样携带 CORS 头，浏览器可读取错误体', async () => {
    const { server, baseUrl } = await startTestServer({ cors: { allowedOrigins: ['*'] } });
    try {
      const missing = await fetch(`${baseUrl}/api/v1/nope`, { headers: { Origin: 'http://console.example' } });
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('access-control-allow-origin'), '*');
      assert.equal((await readErrorBody(missing)).error, SERVER_ERROR_CODE.RouteNotFound);
    } finally {
      await server.stop();
    }
  });

  it('环境变量 RTDB_CORS_ALLOWED_ORIGINS 按逗号分隔装载（空白项丢弃）', () => {
    const config = loadServerConfig({
      env: { RTDB_CORS_ALLOWED_ORIGINS: 'http://a.example, http://b.example ,' },
      overrides: { dataDir: nextDataDir(), port: 0, host: '127.0.0.1', log: { level: 'error' } },
    });
    assert.deepEqual(config.cors.allowedOrigins, ['http://a.example', 'http://b.example']);
  });
});

/* ---------- 配置校验 ---------- */

describe('server: 配置校验与装载', () => {
  it('非回环地址 + 关闭认证 → 启动失败；非回环 + 开启认证 → 正常', async () => {
    const dataDir = nextDataDir();
    const invalid = loadServerConfig({
      env: {},
      overrides: {
        port: 0,
        host: '0.0.0.0',
        dataDir,
        admin: { enabled: false },
        auth: { enabled: false, tokenFile: join(dataDir, 'rtdb.token') },
        log: { level: 'error' },
      },
    });
    const server = new RtdbServer({ config: invalid, logger: new Logger('error') });
    await assert.rejects(() => server.start(), (error: unknown) => {
      return error instanceof RtdbError && error.code === ERROR_CODE.Auth;
    });

    const valid = loadServerConfig({
      env: {},
      overrides: {
        port: 0,
        host: '0.0.0.0',
        dataDir,
        admin: { enabled: false },
        auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(dataDir, 'rtdb.token') },
        log: { level: 'error' },
      },
    });
    const boundServer = new RtdbServer({ config: valid, logger: new Logger('error') });
    await boundServer.start();
    assert.equal(boundServer.address?.host, '0.0.0.0');
    await boundServer.stop();
  });

  it('配置文件 < 环境变量 < 显式入参 的优先级', () => {
    const configDirectory = nextDataDir();
    mkdirSync(configDirectory, { recursive: true });
    const configFile = join(configDirectory, 'rtdb.config.json');
    writeFileSync(configFile, JSON.stringify({ port: 7001, dataDir: './from-file', retentionDays: 5 }), 'utf8');
    const config = loadServerConfig({
      configFilePath: configFile,
      env: { RTDB_PORT: '7002' },
      overrides: { retentionDays: 9 },
    });
    assert.equal(config.port, 7002); // env 覆盖文件
    assert.equal(config.dataDir, './from-file'); // 文件生效
    assert.equal(config.retentionDays, 9); // 显式入参覆盖
  });

  it('basic 模式未配置口令 → 配置校验失败', async () => {
    const dataDir = nextDataDir();
    const config = loadServerConfig({
      env: {},
      overrides: {
        port: 0,
        host: '127.0.0.1',
        dataDir,
        admin: { enabled: false },
        auth: { enabled: true, mode: 'basic', tokenFile: join(dataDir, 'rtdb.token') },
        log: { level: 'error' },
      },
    });
    const server = new RtdbServer({ config, logger: new Logger('error') });
    await assert.rejects(() => server.start(), (error: unknown) => {
      return error instanceof RtdbError && error.code === ERROR_CODE.Auth;
    });
  });
});

/* ---------- Prometheus /metrics 与 /healthz（S14） ---------- */

interface PrometheusSample {
  labels: Record<string, string>;
  value: number;
}

interface PrometheusFamily {
  type: string;
  help: string;
  samples: PrometheusSample[];
}

/** §3.4 status 全体字段对应的指标族名单（S14 契约，顺序无关） */
const EXPECTED_PROMETHEUS_METRIC_NAMES = [
  'rtdb_uptime_seconds',
  'rtdb_databases',
  'rtdb_metrics',
  'rtdb_write_points_per_second',
  'rtdb_write_buffered_points',
  'rtdb_write_duplicate_points_total',
  'rtdb_write_tags_ignored_total',
  'rtdb_wal_pending_bytes',
  'rtdb_wal_outstanding_batches',
  'rtdb_wal_pending_points',
  'rtdb_wal_last_fsync_timestamp_seconds',
  'rtdb_segments_open_files',
  'rtdb_segments_bytes_today',
  'rtdb_cache_blocks',
  'rtdb_cache_block_hit_rate',
  'rtdb_process_heap_used_bytes',
  'rtdb_process_external_bytes',
  'rtdb_gc_count_total',
  'rtdb_gc_pause_total_seconds',
  'rtdb_gc_pause_max_seconds',
  'rtdb_query_count_total',
  'rtdb_query_duration_seconds',
  'rtdb_query_duration_max_seconds',
] as const;

/** 解析 Prometheus 文本暴露格式（0.0.4）；任一行不可解析即断言失败 */
function parsePrometheusText(text: string): Map<string, PrometheusFamily> {
  assert.ok(text.endsWith('\n'), '文本格式要求以换行结尾');
  const families = new Map<string, PrometheusFamily>();
  for (const line of text.slice(0, -1).split('\n')) {
    if (line.startsWith('# HELP ')) {
      const rest = line.slice('# HELP '.length);
      const separator = rest.indexOf(' ');
      assert.ok(separator > 0, `HELP 行缺少指标名：${line}`);
      prometheusFamily(families, rest.slice(0, separator)).help = rest.slice(separator + 1);
      continue;
    }
    if (line.startsWith('# TYPE ')) {
      const rest = line.slice('# TYPE '.length);
      const separator = rest.indexOf(' ');
      assert.ok(separator > 0, `TYPE 行缺少类型：${line}`);
      prometheusFamily(families, rest.slice(0, separator)).type = rest.slice(separator + 1);
      continue;
    }
    assert.ok(!line.startsWith('#'), `未知的注释行：${line}`);
    const parsed =
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (-?(?:[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)|NaN|\+Inf|-Inf)$/.exec(line);
    assert.ok(parsed !== null, `非法指标样本行：${line}`);
    const name = parsed[1];
    prometheusFamily(families, name).samples.push({
      labels: parsePrometheusLabels(parsed[2] ?? ''),
      value: Number(parsed[3]),
    });
  }
  return families;
}

function prometheusFamily(families: Map<string, PrometheusFamily>, name: string): PrometheusFamily {
  const existing = families.get(name);
  if (existing !== undefined) return existing;
  const created: PrometheusFamily = { type: '', help: '', samples: [] };
  families.set(name, created);
  return created;
}

function parsePrometheusLabels(block: string): Record<string, string> {
  const labels: Record<string, string> = {};
  if (block.length === 0) return labels;
  for (const pair of block.slice(1, -1).split(',')) {
    const separator = pair.indexOf('=');
    labels[pair.slice(0, separator)] = pair.slice(separator + 2, -1);
  }
  return labels;
}

/** 取指定指标（可按标签子集过滤）的样本值；缺失即断言失败 */
function prometheusSampleValue(
  families: Map<string, PrometheusFamily>,
  name: string,
  labels: Record<string, string> = {},
): number {
  const entry = families.get(name);
  assert.ok(entry !== undefined, `缺少指标族：${name}`);
  const match = entry.samples.find((sample) =>
    Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  );
  assert.ok(match !== undefined, `缺少指标样本：${name}`);
  return match.value;
}

describe('server: Prometheus /metrics 与 /healthz（S14）', () => {
  it('encodePrometheusMetrics 单位换算正确（uptime/MiB/ms → 秒与字节）', () => {
    const stats: EngineStats = {
      uptimeMs: 12_500,
      databases: 3,
      metrics: 10,
      write: { acceptedPoints: 0, bufferedPoints: 7, duplicatePoints: 2, pointsPerSec: 0 },
      wal: { pendingBytes: 100, outstandingBatches: 1, pendingPoints: 5, lastFsyncMs: 2_000 },
      segments: { openFiles: 4, bytesToday: 1_000 },
      cache: { blocks: 8, blockHitRate: 0.5, heapUsedMb: 1.5, externalMb: 2 },
      gc: { count: 3, totalMs: 250, maxMs: 12 },
      query: { count: 9, p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4 },
    };
    const families = parsePrometheusText(encodePrometheusMetrics({ stats, tagsIgnored: 6 }));

    assert.equal(families.size, EXPECTED_PROMETHEUS_METRIC_NAMES.length);
    assert.equal(prometheusSampleValue(families, 'rtdb_uptime_seconds'), 12.5);
    assert.equal(prometheusSampleValue(families, 'rtdb_wal_last_fsync_timestamp_seconds'), 2);
    assert.equal(prometheusSampleValue(families, 'rtdb_process_heap_used_bytes'), 1.5 * 1_048_576);
    assert.equal(prometheusSampleValue(families, 'rtdb_process_external_bytes'), 2 * 1_048_576);
    assert.equal(prometheusSampleValue(families, 'rtdb_gc_pause_total_seconds'), 0.25);
    assert.equal(prometheusSampleValue(families, 'rtdb_write_tags_ignored_total'), 6);
    assert.equal(prometheusSampleValue(families, 'rtdb_query_duration_seconds', { quantile: '0.5' }), 0.001);
    assert.equal(prometheusSampleValue(families, 'rtdb_query_duration_seconds', { quantile: '0.95' }), 0.002);
    assert.equal(prometheusSampleValue(families, 'rtdb_query_duration_seconds', { quantile: '0.99' }), 0.003);
  });

  it('/metrics 输出可解析文本，指标名与标签稳定；/healthz 返回存活；两端点恒免认证', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(rootDirectory, 'unused.token') },
    });
    try {
      const response = await fetch(`${baseUrl}/metrics`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), PROMETHEUS_METRICS_CONTENT_TYPE);
      const families = parsePrometheusText(await response.text());

      assert.deepEqual([...families.keys()].sort(), [...EXPECTED_PROMETHEUS_METRIC_NAMES].sort());
      for (const name of EXPECTED_PROMETHEUS_METRIC_NAMES) {
        const entry = families.get(name) as PrometheusFamily;
        assert.ok(entry.help.length > 0, `${name} 缺少 HELP`);
        assert.ok(entry.type === 'gauge' || entry.type === 'counter', `${name} 类型非法：${entry.type}`);
        assert.ok(entry.samples.length > 0, `${name} 缺少样本`);
      }
      // 查询延迟以 quantile 标签呈现，标签集稳定
      const latencySamples = (families.get('rtdb_query_duration_seconds') as PrometheusFamily).samples;
      assert.deepEqual(
        latencySamples.map((sample) => sample.labels.quantile).sort(),
        ['0.5', '0.95', '0.99'],
      );

      const health = await fetch(`${baseUrl}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual((await health.json()) as unknown, { status: 'ok' });
    } finally {
      await server.stop();
    }
  });

  it('/metrics 随写入与查询推进：库数/测点数/查询计数同步', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await postJson(baseUrl, '/api/v1/write?db=alpha', [{ metricName: 'temperature', timestamp: BASE, value: 21.5 }]);
      await postJson(baseUrl, '/api/v1/query/last', { db: 'alpha', metricName: 'temperature' });

      const families = parsePrometheusText(await (await fetch(`${baseUrl}/metrics`)).text());
      assert.equal(prometheusSampleValue(families, 'rtdb_databases'), 1);
      assert.equal(prometheusSampleValue(families, 'rtdb_metrics'), 1);
      assert.ok(prometheusSampleValue(families, 'rtdb_query_count_total') >= 1);
      assert.ok(prometheusSampleValue(families, 'rtdb_uptime_seconds') >= 0);
    } finally {
      await server.stop();
    }
  });

  it('/metrics 与 /healthz 仅接受 GET（405 带 Allow 头）', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      for (const path of ['/metrics', '/healthz']) {
        const response = await fetch(`${baseUrl}${path}`, { method: 'POST' });
        assert.equal(response.status, 405);
        assert.equal((await readErrorBody(response)).error, SERVER_ERROR_CODE.MethodNotAllowed);
        assert.equal(response.headers.get('allow'), 'GET');
      }
    } finally {
      await server.stop();
    }
  });
});
