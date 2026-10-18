// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `@ss/rtdb-client` 单测（对齐《详细设计 v2.2》§4）：
 * 六方法真实 HTTP 往返（i64 bigint / f64 / bool / string 双向编解码）、批量自动分片、
 * 429 与网络错误的重试与退避上限、业务错误不重试、超时归类、本地入参校验。
 *
 * 说明：重试与超时用例使用本地 stub server（可直接控制状态码、延迟与断连），
 * 六方法与分片用例使用真实 `RtdbServer`（`port: 0` 随机端口）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CLIENT_ERROR_CODE, RtdbClient, RtdbClientError } from '../packages/demo/client-node/src/index.ts';
import type { ClientWritePoint } from '../packages/demo/client-node/src/index.ts';
import { loadServerConfig } from '../packages/server/src/config.ts';
import { Logger } from '../packages/server/src/logger.ts';
import { RtdbServer } from '../packages/server/src/server.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-client-'));
/** 固定基日（10:00），避免跨日边界影响时间戳构造 */
const BASE = new Date(2026, 0, 10, 10, 0, 0).getTime();
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

/* ---------- 真实服务夹具 ---------- */

interface TestServer {
  server: RtdbServer;
  baseUrl: string;
  dataDir: string;
}

function nextDataDir(): string {
  caseCounter += 1;
  return join(rootDirectory, `case-${caseCounter}`);
}

async function startTestServer(): Promise<TestServer> {
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
    },
  });
  const server = new RtdbServer({ config, logger: new Logger('error') });
  const address = await server.start();
  return { server, baseUrl: `http://${address.host}:${address.port}`, dataDir };
}

/* ---------- stub server 夹具 ---------- */

interface StubResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** 直接销毁连接（模拟网络错误） */
  destroySocket?: boolean;
  /** 响应前延迟（模拟超时） */
  delayMs?: number;
}

interface StubRequest {
  method: string;
  path: string;
  rawBody: string;
  /** 该 stub 收到的第几次请求（0 基） */
  index: number;
}

interface StubServer {
  baseUrl: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

async function startStubServer(
  responder: (request: StubRequest) => StubResponse | Promise<StubResponse>,
): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const stubRequest: StubRequest = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        rawBody: Buffer.concat(chunks).toString('utf8'),
        index: requests.length,
      };
      requests.push(stubRequest);
      void (async () => {
        const stubResponse = await responder(stubRequest);
        if (stubResponse.delayMs !== undefined && stubResponse.delayMs > 0) {
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, stubResponse.delayMs));
        }
        if (stubResponse.destroySocket === true) {
          response.destroy();
          return;
        }
        const payload = stubResponse.body === undefined ? '' : JSON.stringify(stubResponse.body);
        response.writeHead(stubResponse.status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          ...(stubResponse.headers ?? {}),
        });
        response.end(payload);
      })();
    });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server 未获得随机端口');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeIdleConnections();
      }),
  };
}

/* ---------- 六方法：真实 HTTP 往返 ---------- */

describe('client: 六方法与 i64 vt 双向编解码', () => {
  it('writeBatch 写入 i64/f64/bool/string，queryRange 同口径读回（i64 还原为 bigint）', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const client = new RtdbClient({ baseUrl });
      const points: ClientWritePoint[] = [
        { metricName: 'counter', timestamp: BASE, value: 1234567890123n },
        { metricName: 'temperature', timestamp: BASE, value: 21.5 },
        { metricName: 'switch', timestamp: BASE, value: true },
        { metricName: 'label', timestamp: BASE, value: 'running' },
      ];
      const written = await client.writeBatch('demo', points);
      assert.equal(written.accepted, 4);

      const counter = await client.queryRange('demo', 'counter', { start: BASE, end: BASE });
      assert.equal(counter.metricName, 'counter');
      assert.equal(counter.points.length, 1);
      assert.equal(counter.points[0].timestamp, BASE);
      assert.equal(counter.points[0].value, 1234567890123n);
      assert.equal(typeof counter.points[0].value, 'bigint');
      assert.ok(counter.received !== undefined, 'range 响应应透传服务器接收时间窗口');
      assert.ok(counter.received.min <= counter.received.max);

      const temperature = await client.queryRange('demo', 'temperature', { start: BASE, end: BASE });
      assert.equal(temperature.points[0].value, 21.5);

      const switchSeries = await client.queryRange('demo', 'switch', { start: BASE, end: BASE });
      assert.equal(switchSeries.points[0].value, true);

      const label = await client.queryRange('demo', 'label', { start: BASE, end: BASE });
      assert.equal(label.points[0].value, 'running');
    } finally {
      await server.stop();
    }
  });

  it('queryAt：批量插值取值，state 区分实测与推算', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const client = new RtdbClient({ baseUrl });
      await client.writeBatch('demo', [
        { metricName: 'atm', timestamp: BASE, value: 0 },
        { metricName: 'atm', timestamp: BASE + 1000, value: 10 },
      ]);

      const results = await client.queryAt('demo', 'atm', {
        timestamps: [BASE, BASE + 500, BASE + 5000],
        mode: 'linear',
      });
      assert.deepEqual(
        results.map((point) => [point.state, point.value]),
        [
          ['exact', 0],
          ['interpolated', 5],
          ['extrapolated', 10],
        ],
      );

      // 空指标 → 服务端预检 404 E_METRIC_NOT_FOUND（引擎层的 no-data 语义由 engine 套件覆盖）
      await assert.rejects(
        () => client.queryAt('demo', 'ghost.metric', { timestamps: [BASE] }),
        (error: unknown) => error instanceof RtdbClientError && error.code === 'E_METRIC_NOT_FOUND',
      );
    } finally {
      await server.stop();
    }
  });

  it('queryLastBatch 一次请求取回多指标最新点（顺序不变、未知指标为 null）', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const client = new RtdbClient({ baseUrl });
      await client.writeBatch('query', [
        { metricName: 'flow', timestamp: BASE, value: 10 },
        { metricName: 'flow', timestamp: BASE + 1000, value: 20 },
        { metricName: 'temp', timestamp: BASE + 500, value: 36.5 },
      ]);

      const latest = await client.queryLastBatch('query', ['flow', 'temp', 'gone']);
      assert.deepEqual([...latest.keys()], ['flow', 'temp', 'gone']);
      assert.equal(latest.get('flow')?.timestamp, BASE + 1000);
      assert.equal(latest.get('flow')?.value, 20);
      assert.equal(latest.get('temp')?.value, 36.5);
      assert.equal(latest.get('gone'), null);

      const bounded = await client.queryLastBatch('query', ['flow'], { before: BASE + 500 });
      assert.equal(bounded.get('flow')?.value, 10);
    } finally {
      await server.stop();
    }
  });

  it('queryLast / queryCount / queryAggregate / status 与真实服务口径一致', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const client = new RtdbClient({ baseUrl });
      await client.writeBatch(
        'query',
        Array.from({ length: 5 }, (_, index): ClientWritePoint => ({
          metricName: 'flow',
          timestamp: BASE + index * 1000,
          value: (index + 1) * 10,
        })),
      );

      const last = await client.queryLast('query', 'flow');
      assert.equal(last?.value, 50);
      const lastBefore = await client.queryLast('query', 'flow', { before: BASE + 2000 });
      assert.equal(lastBefore?.value, 30);
      const missing = await client.queryLast('query', 'flow', { before: BASE - 10_000 });
      assert.equal(missing, null);

      assert.equal(await client.queryCount('query', 'flow', { start: BASE + 1000, end: BASE + 3000 }), 3);
      assert.equal(
        await client.queryCount('query', 'flow', { start: BASE + 1000, end: BASE + 3000, exact: true }),
        3,
      );

      const windows = await client.queryAggregate('query', 'flow', {
        start: BASE,
        end: BASE + 4000,
        type: 'avg',
        windowMs: 2000,
      });
      assert.equal(windows.length, 3);
      assert.equal(windows[0].count, 2);
      // 时间加权平均：[0,2000) 面积 = (10+20)/2*1000 + (20+30)/2*1000 = 40000，除以窗口宽度 2000 → 20
      assert.equal(windows[0].value, 20);
      assert.equal(windows[1].value, 40);
      // 末窗按窗口宽度边界补齐：只有 50 一个点 → 平坦外延后仍为 50
      assert.equal(windows[2].value, 50);

      const status = await client.status();
      assert.equal(status.databases, 1);
      assert.equal(status.metrics, 1);
      assert.equal(typeof status.write.pointsPerSec, 'number');
      // 5 个点均低于 blockMinPoints，仍在未成块缓冲中：buffered 至少为 5，WAL 批次仍未推进安全点
      assert.ok(status.write.buffered >= 5);
      assert.ok(status.wal.outstandingBatches >= 1);
      assert.equal(typeof status.cache.blocks, 'number');
      // §3.4 补全项：status 已输出待落段点数、fsync 时刻、今日占用、缓存命中率/内存与 gc/query 分位
      assert.ok(status.wal.pendingPoints >= 0);
      assert.equal(typeof status.wal.lastFsyncMs, 'number');
      assert.ok(status.segments.bytesToday >= 0);
      assert.ok(status.cache.blockHitRate >= 0 && status.cache.blockHitRate <= 1);
      assert.ok(status.cache.heapUsedMb > 0);
      assert.ok(status.cpu.percent >= 0);
      assert.ok(status.cpu.systemPercent >= 0);
      assert.ok(status.memory.rssMb > 0);
      assert.ok(status.memory.systemTotalMb > 0);
      assert.ok(status.memory.heapPercent >= 0 && status.memory.heapPercent <= 100);
      assert.equal(typeof status.gc.count, 'number');
      assert.ok(status.query.count >= 0);
    } finally {
      await server.stop();
    }
  });

  it('管理面：listDatabases / listMetrics / setRetention / backup', async () => {
    const { server, baseUrl, dataDir } = await startTestServer();
    try {
      const client = new RtdbClient({ baseUrl });
      await client.writeBatch('alpha', [{ metricName: 'm1', timestamp: BASE, value: 1 }]);
      await client.writeBatch('beta', [{ metricName: 'm2', timestamp: BASE, value: 2 }]);

      assert.deepEqual(await client.listDatabases(), ['alpha', 'beta']);
      const metrics = await client.listMetrics('alpha');
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].metricName, 'm1');
      assert.equal(metrics[0].firstTs, BASE);
      assert.equal(metrics[0].valueType, 1);

      await client.setRetention('alpha', 30);
      const backup = await client.backup('alpha', join(dataDir, 'backup'));
      assert.equal(backup.database, 'alpha');
      assert.ok(backup.files >= 1);
      assert.equal(backup.targetDirectory, join(dataDir, 'backup', 'alpha'));
    } finally {
      await server.stop();
    }
  });

  it('i64 边界：±2^53（含）可精确往返为 bigint，超出 ±2^53 被服务端拒绝', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const client = new RtdbClient({ baseUrl });
      const values = [2n ** 53n, -(2n ** 53n), 0n, 42n];
      await client.writeBatch(
        'boundary',
        values.map((value, index): ClientWritePoint => ({
          metricName: 'counter',
          timestamp: BASE + index,
          value,
        })),
      );
      const series = await client.queryRange('boundary', 'counter', { start: BASE, end: BASE + 3 });
      assert.deepEqual(
        series.points.map((point) => point.value),
        values,
      );

      // 超出 ±2^53 的 i64 会被服务端整批拒绝（该边界用于保证 SDK 返回的 number 精确）
      await assert.rejects(
        () =>
          client.writeBatch('boundary', [
            { metricName: 'counter', timestamp: BASE + 10, value: 9007199254740991000n },
          ]),
        (error: unknown) => error instanceof RtdbClientError && error.code === 'E_INVALID_POINT',
      );
    } finally {
      await server.stop();
    }
  });
});

/* ---------- 自动分片 ---------- */

describe('client: 批量自动分片', () => {
  it('maxBatchPoints=2 时 5 个点拆成 3 批顺序发送，accepted 为各批之和', async () => {
    const stub = await startStubServer((request) => {
      const points = JSON.parse(request.rawBody) as unknown[];
      return { status: 200, body: { accepted: points.length, duplicates: 0 } };
    });
    try {
      const client = new RtdbClient({ baseUrl: stub.baseUrl, maxBatchPoints: 2 });
      const points = Array.from({ length: 5 }, (_, index): ClientWritePoint => ({
        metricName: 'm',
        timestamp: BASE + index,
        value: index,
      }));
      const result = await client.writeBatch('demo', points);
      assert.equal(result.accepted, 5);
      assert.equal(stub.requests.length, 3);
      // 顺序分片：2 / 2 / 1
      assert.deepEqual(
        stub.requests.map((request) => (JSON.parse(request.rawBody) as unknown[]).length),
        [2, 2, 1],
      );
      assert.match(stub.requests[0].path, /^\/api\/v1\/write\?db=demo$/);
    } finally {
      await stub.close();
    }
  });

  it('某批失败即中止后续分片并抛出该批的业务错误', async () => {
    const stub = await startStubServer((request) => {
      if (request.index === 0) {
        return { status: 200, body: { accepted: 2, duplicates: 0 } };
      }
      return { status: 413, body: { error: 'E_BATCH_TOO_LARGE', message: 'too many points' } };
    });
    try {
      const client = new RtdbClient({ baseUrl: stub.baseUrl, maxBatchPoints: 2, maxRetries: 3, retryDelayMs: 1 });
      const points = Array.from({ length: 6 }, (_, index): ClientWritePoint => ({
        metricName: 'm',
        timestamp: BASE + index,
        value: index,
      }));
      await assert.rejects(
        () => client.writeBatch('demo', points),
        (error: unknown) =>
          error instanceof RtdbClientError && error.code === 'E_BATCH_TOO_LARGE' && error.status === 413,
      );
      // 首批成功后第二批失败，第三批不会再发送
      assert.equal(stub.requests.length, 2);
    } finally {
      await stub.close();
    }
  });
});

/* ---------- 重试策略 ---------- */

describe('client: 重试与退避', () => {
  it('429 会退避重试，成功后返回正常结果（Retry-After 不参与延迟计算）', async () => {
    const stub = await startStubServer((request) => {
      if (request.index < 2) {
        return { status: 429, headers: { 'Retry-After': '1' }, body: { error: 'E_RATE_LIMITED', message: 'busy' } };
      }
      return { status: 200, body: { accepted: 1, duplicates: 0 } };
    });
    try {
      const client = new RtdbClient({ baseUrl: stub.baseUrl, retryDelayMs: 1 });
      const started = Date.now();
      const result = await client.writeBatch('demo', [{ metricName: 'm', timestamp: BASE, value: 1 }]);
      assert.equal(result.accepted, 1);
      assert.equal(stub.requests.length, 3);
      // Retry-After: 1 未被采用（否则至少 2s），指数退避为 1ms + 2ms
      assert.ok(Date.now() - started < 1000, '重试延迟应远小于 Retry-After 的 1s');
    } finally {
      await stub.close();
    }
  });

  it('持续 429 时最多尝试 maxRetries+1 次后抛出 E_RATE_LIMITED（默认上限 3）', async () => {
    const stub = await startStubServer(() => ({
      status: 429,
      headers: { 'Retry-After': '1' },
      body: { error: 'E_RATE_LIMITED', message: 'busy' },
    }));
    try {
      const client = new RtdbClient({ baseUrl: stub.baseUrl, retryDelayMs: 1 });
      await assert.rejects(
        () => client.writeBatch('demo', [{ metricName: 'm', timestamp: BASE, value: 1 }]),
        (error: unknown) =>
          error instanceof RtdbClientError && error.code === 'E_RATE_LIMITED' && error.status === 429,
      );
      assert.equal(stub.requests.length, 4);

      // maxRetries 上限被钳位到 3：传入 9 仍只尝试 4 次
      const clampedStub = await startStubServer(() => ({
        status: 429,
        body: { error: 'E_RATE_LIMITED', message: 'busy' },
      }));
      try {
        const clampedClient = new RtdbClient({ baseUrl: clampedStub.baseUrl, maxRetries: 9, retryDelayMs: 1 });
        await assert.rejects(() => clampedClient.status(), (error: unknown) => error instanceof RtdbClientError);
        assert.equal(clampedStub.requests.length, 4);
      } finally {
        await clampedStub.close();
      }
    } finally {
      await stub.close();
    }
  });

  it('网络错误（连接被销毁）会重试并在耗尽后归为 E_CLIENT_TRANSPORT', async () => {
    const stub = await startStubServer(() => ({ status: 200, destroySocket: true }));
    try {
      const client = new RtdbClient({ baseUrl: stub.baseUrl, maxRetries: 2, retryDelayMs: 1 });
      await assert.rejects(
        () => client.status(),
        (error: unknown) =>
          error instanceof RtdbClientError &&
          error.code === CLIENT_ERROR_CODE.Transport &&
          error.status === 0,
      );
      assert.equal(stub.requests.length, 3);
    } finally {
      await stub.close();
    }
  });

  it('业务错误（400/404）不重试，仅尝试一次', async () => {
    const stub = await startStubServer(() => ({
      status: 404,
      body: { error: 'E_DB_NOT_FOUND', message: 'database does not exist: ghost' },
    }));
    try {
      const client = new RtdbClient({ baseUrl: stub.baseUrl, retryDelayMs: 1 });
      await assert.rejects(
        () => client.queryRange('ghost', 'm', { start: BASE, end: BASE + 1 }),
        (error: unknown) =>
          error instanceof RtdbClientError && error.code === 'E_DB_NOT_FOUND' && error.status === 404,
      );
      assert.equal(stub.requests.length, 1);
    } finally {
      await stub.close();
    }
  });

  it('服务端 details 数组原样带出（400 非法点索引）', async () => {
    const stub = await startStubServer(() => ({
      status: 400,
      body: { error: 'E_INVALID_POINT', message: 'invalid points', details: [1, 3] },
    }));
    try {
      const client = new RtdbClient({ baseUrl: stub.baseUrl });
      await assert.rejects(
        () => client.writeBatch('demo', [{ metricName: 'm', timestamp: BASE, value: 1 }]),
        (error: unknown) =>
          error instanceof RtdbClientError && error.code === 'E_INVALID_POINT' && error.details.length === 2,
      );
    } finally {
      await stub.close();
    }
  });

  it('响应超过 timeoutMs 归为 E_CLIENT_TIMEOUT（超时不重试后原样抛出）', async () => {
    const stub = await startStubServer(() => ({ status: 200, body: { databases: [] }, delayMs: 1500 }));
    try {
      const client = new RtdbClient({ baseUrl: stub.baseUrl, timeoutMs: 1000, maxRetries: 0 });
      await assert.rejects(
        () => client.listDatabases(),
        (error: unknown) => error instanceof RtdbClientError && error.code === CLIENT_ERROR_CODE.Timeout,
      );
    } finally {
      await stub.close();
    }
  });
});

/* ---------- 本地入参校验 ---------- */

describe('client: 本地入参校验与编解码护栏', () => {
  it('baseUrl 为空、数据库名/测点名为空时在发请求前即抛出 E_CLIENT_INVALID_ARGUMENT', async () => {
    assert.throws(
      () => new RtdbClient({ baseUrl: '   ' }),
      (error: unknown) => error instanceof RtdbClientError && error.code === CLIENT_ERROR_CODE.InvalidArgument,
    );

    const client = new RtdbClient({ baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(
      () => client.queryRange('', 'm', { start: 0, end: 1 }),
      (error: unknown) => error instanceof RtdbClientError && error.code === CLIENT_ERROR_CODE.InvalidArgument,
    );
    await assert.rejects(
      () => client.queryCount('db', '', { start: 0, end: 1 }),
      (error: unknown) => error instanceof RtdbClientError && error.code === CLIENT_ERROR_CODE.InvalidArgument,
    );
  });

  it('非有限数（NaN / Infinity）与非法时间戳在编码阶段即被拒绝', async () => {
    const client = new RtdbClient({ baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(
      () => client.writeBatch('demo', [{ metricName: 'm', timestamp: BASE, value: Number.NaN }]),
      (error: unknown) => error instanceof RtdbClientError && error.code === CLIENT_ERROR_CODE.InvalidArgument,
    );
    await assert.rejects(
      () => client.writeBatch('demo', [{ metricName: 'm', timestamp: BASE + 0.5, value: 1 }]),
      (error: unknown) => error instanceof RtdbClientError && error.code === CLIENT_ERROR_CODE.InvalidArgument,
    );
  });

  it('空批量不发请求，accepted 为 0', async () => {
    const stub = await startStubServer(() => ({ status: 200, body: { accepted: 0, duplicates: 0 } }));
    try {
      const client = new RtdbClient({ baseUrl: stub.baseUrl });
      const result = await client.writeBatch('demo', []);
      assert.equal(result.accepted, 0);
      assert.equal(stub.requests.length, 0);
    } finally {
      await stub.close();
    }
  });
});
