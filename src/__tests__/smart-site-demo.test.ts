// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Smart Site demo client tests:
 *   - catalog / generator determinism, metric naming and value-type stability;
 *   - quality-fault simulation (stale value + non-zero flag);
 *   - end-to-end write + query against an in-process rtdb-server (JSON wire protocol, i64 as string).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DEMO_CLIENT_CONFIG_PATH,
  DEMO_DATABASE,
  DemoHttpError,
  DemoRtdbClient,
  SMART_SITE_DEMO_CATALOG,
  SmartSiteSimulator,
  WIRE_VALUE_TYPE,
  applyDemoClientConfig,
  decodeWirePoint,
  decodeWireWindowValue,
  encodeWritePoint,
  readDemoClientConfig,
} from '../packages/demo/client-smart-site/src/index.ts';
import { loadServerConfig, validateServerConfig } from '../packages/server/src/config.ts';
import { Logger } from '../packages/server/src/logger.ts';
import { RtdbServer } from '../packages/server/src/server.ts';

const BASE = Date.UTC(2026, 9, 17, 8, 0, 0);
const rootDirectory = mkdtempSync(join(tmpdir(), 'rtdb-smart-site-demo-'));
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

async function startServer(authEnabled = false): Promise<{ server: RtdbServer; baseUrl: string; token: string }> {
  caseCounter += 1;
  const dataDir = join(rootDirectory, `case-${caseCounter}`);
  const token = 'a'.repeat(32);
  const config = loadServerConfig({
    env: {},
    overrides: {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      admin: { enabled: false },
      log: { level: 'error' },
      auth: authEnabled
        ? { enabled: true, mode: 'token', token, tokenFile: join(dataDir, 'rtdb.token') }
        : { enabled: false, tokenFile: join(dataDir, 'rtdb.token') },
    },
  });
  const server = new RtdbServer({ config, logger: new Logger('error') });
  const address = await server.start();
  return { server, baseUrl: `http://${address.host}:${address.port}`, token };
}

const TIMESTAMPS = [BASE, BASE + 1_000, BASE + 2_000, BASE + 3_000, BASE + 4_000];

describe('demo: Smart Site catalog 与生成器', () => {
  it('目录覆盖 9 台设备 / 44 个标签，指标名唯一且符合 Smart Site tag path', () => {
    const simulator = new SmartSiteSimulator();
    const descriptors = simulator.describe();
    assert.equal(simulator.deviceCount, 9);
    assert.equal(simulator.metricCount, 44);
    assert.equal(descriptors.length, simulator.metricCount);

    const names = new Set(simulator.metricNames);
    assert.equal(names.size, descriptors.length, 'metric names must be unique');

    for (const descriptor of descriptors) {
      const [deviceCode, variable] = descriptor.metricName.split('.');
      assert.equal(deviceCode, descriptor.deviceCode);
      assert.equal(variable, descriptor.variable);
      assert.match(descriptor.metricName, /^[a-z0-9-]+\.[a-z0-9-]+$/);
    }
    assert.deepEqual(
      SMART_SITE_DEMO_CATALOG.map((device) => device.deviceCode),
      [...new Set(descriptors.map((descriptor) => descriptor.deviceCode))],
    );
  });

  it('同 seed 的生成序列完全一致，不同 seed 产生不同数据', () => {
    const run = (seed: number): unknown[] => {
      const simulator = new SmartSiteSimulator({ seed });
      return TIMESTAMPS.map((timestamp) => simulator.tick(timestamp));
    };
    assert.deepEqual(run(42), run(42));
    assert.notDeepEqual(run(42), run(43));
  });

  it('每个指标的值类型在连续采样中保持稳定，并落在工程范围内', () => {
    const simulator = new SmartSiteSimulator({ seed: 7 });
    const descriptors = simulator.describe();
    const values = new Map<string, Array<number | bigint | boolean | string>>();

    for (let index = 0; index < 20; index += 1) {
      for (const point of simulator.tick(BASE + index * 1_000)) {
        const bucket = values.get(point.metricName) ?? [];
        bucket.push(point.value);
        values.set(point.metricName, bucket);
      }
    }

    for (const descriptor of descriptors) {
      const samples = values.get(descriptor.metricName) ?? [];
      assert.equal(samples.length, 20, `${descriptor.metricName} should be sampled on every tick`);
      for (const sample of samples) {
        switch (descriptor.type) {
          case 'f64':
            assert.equal(typeof sample, 'number', `${descriptor.metricName} should stay f64`);
            assert.ok(Number.isFinite(sample as number));
            if (descriptor.min !== undefined) assert.ok((sample as number) >= descriptor.min, `${descriptor.metricName} below min`);
            if (descriptor.max !== undefined) assert.ok((sample as number) <= descriptor.max, `${descriptor.metricName} above max`);
            break;
          case 'i64':
            assert.equal(typeof sample, 'bigint', `${descriptor.metricName} should stay i64`);
            break;
          case 'bool':
            assert.equal(typeof sample, 'boolean', `${descriptor.metricName} should stay bool`);
            break;
          case 'string':
            assert.equal(typeof sample, 'string', `${descriptor.metricName} should stay string`);
            break;
        }
      }
      if (descriptor.variable.includes('yong-dian-liang') || descriptor.variable.includes('lei-ji') || descriptor.variable.includes('yun-xing-shi-jian')) {
        for (let index = 1; index < samples.length; index += 1) {
          assert.ok(asNumber(samples[index]) >= asNumber(samples[index - 1]), `${descriptor.metricName} should be monotonic`);
        }
      }
    }
  });

  it('glitch-rate > 0 时重复上一采样（stale），报文始终不带质量位', () => {
    const faulty = new SmartSiteSimulator({ seed: 1, glitchProbability: 1 });
    const first = faulty.tick(BASE);
    const second = faulty.tick(BASE + 1_000);
    for (let index = 0; index < first.length; index += 1) {
      assert.equal(second[index]?.stale, true);
      assert.equal(second[index]?.value, first[index]?.value);
    }
    for (const point of first) {
      assert.equal(Object.hasOwn(encodeWritePoint(point), 'q'), false);
    }

    const healthy = new SmartSiteSimulator({ seed: 1 });
    for (const point of healthy.tick(BASE)) {
      assert.equal(point.stale, undefined);
    }
  });

  it('i64 按十进制字符串 + vt=2 编码，解码后可还原 bigint', () => {
    const encoder = new SmartSiteSimulator({ seed: 3 });
    const points = encoder.tick(BASE);
    const i64Point = points.find((point) => typeof point.value === 'bigint');
    assert.ok(i64Point !== undefined);
    const wire = encodeWritePoint(i64Point);
    assert.equal(wire.vt, WIRE_VALUE_TYPE.Int64);
    assert.equal(typeof wire.v, 'string');
    const decoded = decodeWirePoint({ t: wire.t, v: wire.v, vt: wire.vt });
    assert.equal(typeof decoded.value, 'bigint');
    assert.equal(decoded.value, i64Point.value);
  });
});

describe('demo: 性能模式（每批多点）', () => {
  it('tickBatch 在窗口内均分时间戳：点数精确、同指标时间戳唯一', () => {
    const simulator = new SmartSiteSimulator({ seed: 9 });
    const metrics = simulator.metricCount;
    const windowMs = 1_000;
    const samplesPerMetric = 5;
    const points = simulator.tickBatch(BASE, windowMs, metrics * samplesPerMetric);

    assert.equal(points.length, metrics * samplesPerMetric);

    const seen = new Set<string>();
    const perMetric = new Map<string, number[]>();
    for (const point of points) {
      const key = `${point.metricName}@${point.timestamp}`;
      assert.equal(seen.has(key), false, `duplicate (metric, timestamp): ${key}`);
      seen.add(key);
      assert.ok(point.timestamp > BASE - windowMs, `${key} before the window`);
      assert.ok(point.timestamp <= BASE, `${key} after the window`);
      const bucket = perMetric.get(point.metricName) ?? [];
      bucket.push(point.timestamp);
      perMetric.set(point.metricName, bucket);
    }

    assert.equal(perMetric.size, metrics);
    for (const [metricName, timestamps] of perMetric) {
      assert.equal(timestamps.length, samplesPerMetric, `${metricName} sample count`);
      for (let index = 1; index < timestamps.length; index += 1) {
        assert.ok((timestamps[index] ?? 0) > (timestamps[index - 1] ?? 0), `${metricName} timestamps must ascend`);
      }
    }
  });

  it('每指标一个采样时与 tick() 完全一致（保持确定性）', () => {
    const native = new SmartSiteSimulator({ seed: 42 });
    const batched = new SmartSiteSimulator({ seed: 42 });
    assert.deepEqual(batched.tickBatch(BASE, 1_000, native.metricCount), native.tick(BASE));
  });

  it('请求点数超出窗口可容纳的容量时直接报错，而不是静默产生重复时间戳', () => {
    const simulator = new SmartSiteSimulator({ seed: 9 });
    assert.throws(
      () => simulator.tickBatch(BASE, 1_000, simulator.metricCount * 1_001),
      /without repeating a timestamp/,
    );
  });

  it('配置文件接受性能参数（pointsPerTick / rate / totalPoints / metrics）并校验类型', () => {
    const directory = mkdtempSync(join(rootDirectory, 'perf-config-'));

    const valid = join(directory, 'valid.json');
    writeFileSync(valid, JSON.stringify({ pointsPerTick: 5_000, rate: 0, totalPoints: 100_000, metrics: 10_000 }), 'utf8');
    const config = readDemoClientConfig(valid);
    assert.equal(config.pointsPerTick, 5_000);
    assert.equal(config.rate, 0);
    assert.equal(config.totalPoints, 100_000);
    assert.equal(config.metrics, 10_000);

    const badRate = join(directory, 'bad-rate.json');
    writeFileSync(badRate, JSON.stringify({ rate: -1 }), 'utf8');
    assert.throws(() => readDemoClientConfig(badRate), /"rate"/);

    const badPoints = join(directory, 'bad-points.json');
    writeFileSync(badPoints, JSON.stringify({ pointsPerTick: 1.5 }), 'utf8');
    assert.throws(() => readDemoClientConfig(badPoints), /"pointsPerTick"/);

    const badMetrics = join(directory, 'bad-metrics.json');
    writeFileSync(badMetrics, JSON.stringify({ metrics: -1 }), 'utf8');
    assert.throws(() => readDemoClientConfig(badMetrics), /"metrics"/);
  });
});

describe('demo: 变量规模缩放（--metrics）', () => {
  it('metricTarget 精确控制指标数：不足截断、超出按 #k 后缀复制', () => {
    const native = new SmartSiteSimulator({ seed: 5 });
    assert.equal(native.metricCount, 44);
    assert.equal(native.baseMetricCount, 44);
    assert.equal(native.replicaCount, 1);

    const truncated = new SmartSiteSimulator({ seed: 5, metricTarget: 10 });
    assert.equal(truncated.metricCount, 10);
    assert.equal(truncated.baseMetricCount, 44);
    assert.equal(truncated.replicaCount, 1);
    assert.deepEqual(truncated.metricNames, native.metricNames.slice(0, 10));

    const scaled = new SmartSiteSimulator({ seed: 5, metricTarget: 100 });
    assert.equal(scaled.metricCount, 100);
    assert.equal(scaled.baseMetricCount, 44);
    assert.equal(scaled.replicaCount, 3);
    const names = new Set(scaled.metricNames);
    assert.equal(names.size, 100, 'scaled metric names must stay unique');
    // The original catalog keeps its plain names; only replicas carry the "#k" suffix.
    for (const name of native.metricNames) assert.ok(names.has(name), `original tag lost: ${name}`);
    assert.ok(names.has('hvac-chiller.supply-temp#2'));
    assert.ok(names.has('hvac-chiller.supply-temp#3'));
    assert.equal(names.has('hvac-chiller.supply-temp#4'), false);
  });

  it('副本是独立信号流：同 seed 可复现，取值与原标签不同', () => {
    const stamps = [BASE, BASE + 1_000, BASE + 2_000];
    const read = (metricTarget: number): unknown[][] => {
      const simulator = new SmartSiteSimulator({ seed: 5, metricTarget });
      return stamps.map((timestamp) => simulator.tick(timestamp));
    };
    assert.deepEqual(read(88), read(88), 'same seed + metricTarget must reproduce the stream');

    const simulator = new SmartSiteSimulator({ seed: 5, metricTarget: 88 });
    const original: unknown[] = [];
    const replica: unknown[] = [];
    for (const timestamp of stamps) {
      for (const point of simulator.tick(timestamp)) {
        if (point.metricName === 'hvac-chiller.supply-temp') original.push(point.value);
        if (point.metricName === 'hvac-chiller.supply-temp#2') replica.push(point.value);
      }
    }
    assert.equal(original.length, stamps.length);
    assert.equal(replica.length, stamps.length);
    assert.notDeepEqual(original, replica, 'a replica must not repeat the original signal');
  });

  it('缩放后每个指标仍保持锁定值类型与工程范围', () => {
    const simulator = new SmartSiteSimulator({ seed: 7, metricTarget: 200 });
    const descriptors = new Map(simulator.describe().map((descriptor) => [descriptor.metricName, descriptor]));
    assert.equal(descriptors.size, 200);

    for (let index = 0; index < 5; index += 1) {
      for (const point of simulator.tick(BASE + index * 1_000)) {
        const descriptor = descriptors.get(point.metricName);
        assert.ok(descriptor !== undefined, `unexpected metric ${point.metricName}`);
        switch (descriptor.type) {
          case 'f64':
            assert.equal(typeof point.value, 'number');
            assert.ok(Number.isFinite(point.value as number));
            if (descriptor.min !== undefined) assert.ok((point.value as number) >= descriptor.min);
            if (descriptor.max !== undefined) assert.ok((point.value as number) <= descriptor.max);
            break;
          case 'i64':
            assert.equal(typeof point.value, 'bigint');
            break;
          case 'bool':
            assert.equal(typeof point.value, 'boolean');
            break;
          default:
            assert.equal(typeof point.value, 'string');
        }
      }
    }
  });

  it('副本的 counter.rateFrom 在本副本组内解析，累计量各自独立推进', () => {
    const simulator = new SmartSiteSimulator({ seed: 5, metricTarget: 88 });
    const stamps = [BASE, BASE + 1_000, BASE + 2_000];
    const samples = new Map<string, Map<number, number | bigint | boolean | string>>();
    for (const timestamp of stamps) {
      for (const point of simulator.tick(timestamp)) {
        const bucket = samples.get(point.metricName) ?? new Map<number, number | bigint | boolean | string>();
        bucket.set(timestamp, point.value);
        samples.set(point.metricName, bucket);
      }
    }

    const at = (metricName: string, timestamp: number): number => {
      const value = samples.get(metricName)?.get(timestamp);
      assert.equal(typeof value, 'number', `${metricName} should stay f64`);
      return value as number;
    };

    // 用电量 accumulates initial + Σ(own gong-l x dt x factor); dt = 1 s (the first sample adds nothing).
    const expected = 38_210.5 + (at('ws-a-meter-01.gong-l#2', BASE + 1_000) + at('ws-a-meter-01.gong-l#2', BASE + 2_000)) / 3_600;
    assert.ok(Math.abs(at('ws-a-meter-01.yong-dian-liang#2', BASE + 2_000) - expected) < 0.011);
    // The replica integrates its own driving signal, so it does not equal the original's counter.
    assert.notEqual(
      at('ws-a-meter-01.yong-dian-liang', BASE + 2_000),
      at('ws-a-meter-01.yong-dian-liang#2', BASE + 2_000),
    );
  });

  it('--devices 与缩放叠加：只复制所选设备的标签', () => {
    const simulator = new SmartSiteSimulator({ seed: 5, deviceCodes: ['hvac-chiller'], metricTarget: 20 });
    assert.equal(simulator.metricCount, 20);
    assert.equal(simulator.baseMetricCount, 11);
    assert.equal(simulator.replicaCount, 2);
    assert.equal(simulator.deviceCount, 1);
    for (const metricName of simulator.metricNames) {
      assert.ok(metricName.startsWith('hvac-chiller.'), `${metricName} must belong to the filtered device`);
    }
  });

  it('metricTarget 非法值直接报错', () => {
    assert.throws(() => new SmartSiteSimulator({ metricTarget: -1 }), /metricTarget/);
    assert.throws(() => new SmartSiteSimulator({ metricTarget: 1.5 }), /metricTarget/);
    assert.throws(() => new SmartSiteSimulator({ metricTarget: 100_001 }), /100000-metric limit/);
  });
});

describe('demo: 对 rtdb-server 的端到端写入与查询', () => {
  it('写入 3 个采样批次后 last/range/count/aggregate/metrics 全部可读', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const simulator = new SmartSiteSimulator({ seed: 11 });
      const client = new DemoRtdbClient({ baseUrl, timeoutMs: 5_000 });
      const batches = TIMESTAMPS.slice(0, 3).map((timestamp) => simulator.tick(timestamp));

      for (const batch of batches) {
        const result = await client.writeBatch(DEMO_DATABASE, batch);
        assert.equal(result.accepted, simulator.metricCount);
        assert.equal(result.duplicates, 0);
      }

      const descriptors = simulator.describe();
      const f64Metric = descriptors.find((descriptor) => descriptor.type === 'f64');
      const i64Metric = descriptors.find((descriptor) => descriptor.type === 'i64');
      assert.ok(f64Metric !== undefined);
      assert.ok(i64Metric !== undefined);

      const lastF64 = await client.queryLast(DEMO_DATABASE, f64Metric.metricName);
      assert.ok(lastF64 !== null);
      const decodedF64 = decodeWirePoint(lastF64);
      assert.equal(typeof decodedF64.value, 'number');
      assert.equal(decodedF64.timestamp, TIMESTAMPS[2]);

      const lastI64 = await client.queryLast(DEMO_DATABASE, i64Metric.metricName);
      assert.ok(lastI64 !== null);
      const decodedI64 = decodeWirePoint(lastI64);
      assert.equal(typeof decodedI64.value, 'bigint');
      assert.equal(lastI64.vt, WIRE_VALUE_TYPE.Int64);

      const count = await client.queryCount(DEMO_DATABASE, f64Metric.metricName, BASE, BASE + 5_000, true);
      assert.equal(count, 3);

      const series = await client.queryRange(DEMO_DATABASE, f64Metric.metricName, BASE, BASE + 5_000);
      assert.equal(series.points.length, 3);
      assert.deepEqual(
        series.points.map((point) => point.t),
        TIMESTAMPS.slice(0, 3),
      );

      const windows = await client.queryAggregate(DEMO_DATABASE, f64Metric.metricName, BASE, BASE + 5_000, 1_000, 'avg');
      assert.ok(windows.length >= 1);
      const firstWindow = windows[0];
      assert.ok(firstWindow !== undefined);
      assert.equal(typeof decodeWireWindowValue(firstWindow), 'number');

      const metrics = await client.listMetrics(DEMO_DATABASE);
      const listed = new Set(metrics.map((metric) => metric.metricName));
      for (const metricName of simulator.metricNames) assert.ok(listed.has(metricName), `missing ${metricName}`);
    } finally {
      await server.stop();
    }
  });

  it('令牌缺失时写入返回 401 E_AUTH', async () => {
    const { server, baseUrl } = await startServer(true);
    try {
      const simulator = new SmartSiteSimulator({ seed: 5, deviceCodes: ['hvac-chiller'] });
      const client = new DemoRtdbClient({ baseUrl, maxRetries: 0 });
      await assert.rejects(
        () => client.writeBatch(DEMO_DATABASE, simulator.tick(BASE)),
        (error: unknown) => {
          assert.ok(error instanceof DemoHttpError);
          assert.equal(error.status, 401);
          assert.equal(error.code, 'E_AUTH');
          return true;
        },
      );
    } finally {
      await server.stop();
    }
  });
});

describe('demo: demo/conf 配置统一管理', () => {
  it('conf 下的服务器配置与客户端配置可加载并通过校验', () => {
    const serverConfigPath = fileURLToPath(new URL('../packages/demo/conf/rtdb-server.json', import.meta.url));
    const serverConfig = loadServerConfig({ configFilePath: serverConfigPath, env: {} });
    validateServerConfig(serverConfig);
    assert.equal(serverConfig.port, 6180);
    assert.equal(serverConfig.host, '127.0.0.1');
    assert.equal(serverConfig.dataDir, 'packages/demo/data');
    assert.equal(serverConfig.auth.enabled, true);
    assert.equal(serverConfig.auth.tokenFile, 'packages/demo/conf/rtdb.token');
    assert.equal(serverConfig.admin.staticDir, 'packages/admin/dist');

    const clientConfig = readDemoClientConfig(DEFAULT_DEMO_CLIENT_CONFIG_PATH);
    assert.equal(clientConfig.url, 'http://127.0.0.1:6180');
    assert.equal(clientConfig.database, 'smartfactory_demo');
    assert.equal(clientConfig.tokenFile, 'packages/demo/conf/rtdb.token');
    assert.equal(clientConfig.intervalMs, 1000);
  });

  it('客户端配置拒绝未知键与错误类型，配置值可被 CLI 覆盖', () => {
    const directory = mkdtempSync(join(rootDirectory, 'config-'));

    const unknownKey = join(directory, 'unknown-key.json');
    writeFileSync(unknownKey, JSON.stringify({ url: 'http://127.0.0.1:6180', bogus: 1 }), 'utf8');
    assert.throws(() => readDemoClientConfig(unknownKey), /unknown key "bogus"/);

    const badType = join(directory, 'bad-type.json');
    writeFileSync(badType, JSON.stringify({ intervalMs: 'fast' }), 'utf8');
    assert.throws(() => readDemoClientConfig(badType), /"intervalMs"/);

    // Config values act as defaults; the CLI parser applies its own arguments afterwards.
    const target = {
      url: 'http://defaults:6180',
      database: 'defaults_db',
      tokenFile: '',
      intervalMs: 1000,
      pointsPerTick: 0,
      rate: 0,
      totalPoints: 0,
      metrics: 0,
      seed: 1,
      devices: [] as string[],
      glitchProbability: 0,
      logEvery: 5,
      timeoutMs: 10_000,
    };
    applyDemoClientConfig(target, {
      url: 'http://conf:6180',
      database: 'conf_db',
      intervalMs: 500,
      devices: ['hvac-chiller'],
      metrics: 3_000,
    });
    assert.equal(target.url, 'http://conf:6180');
    assert.equal(target.database, 'conf_db');
    assert.equal(target.intervalMs, 500);
    assert.deepEqual(target.devices, ['hvac-chiller']);
    assert.equal(target.metrics, 3_000);
  });
});

function asNumber(value: number | bigint | boolean | string | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return Number.NaN;
}
