// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Built-in API reference tests: `GET /api/docs` (HTML) and `GET /api/docs/openapi.json` (OpenAPI 3.1).
 *
 * Covers: public access (even with `auth.enabled`), configuration-aware endpoint filtering
 * (`compat.influx.enabled`, `admin.enabled`), OpenAPI shape, and method rejection.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadServerConfig } from '../packages/server/src/config.ts';
import type { PartialServerConfig } from '../packages/server/src/config.ts';
import { Logger } from '../packages/server/src/logger.ts';
import { RtdbServer } from '../packages/server/src/server.ts';

const rootDirectory = mkdtempSync(join(tmpdir(), 'ss-rtdb-api-docs-'));
const TOKEN = 'd'.repeat(32);
let caseCounter = 0;

after(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

interface StartedServer {
  server: RtdbServer;
  baseUrl: string;
}

async function startServer(overrides: PartialServerConfig = {}): Promise<StartedServer> {
  caseCounter += 1;
  const dataDir = join(rootDirectory, `case-${caseCounter}`);
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
  return { server, baseUrl: `http://${address.host}:${address.port}` };
}

async function withServer(
  overrides: PartialServerConfig,
  run: (started: StartedServer) => Promise<void>,
): Promise<void> {
  const started = await startServer(overrides);
  try {
    await run(started);
  } finally {
    await started.server.stop();
  }
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { securitySchemes: Record<string, unknown> };
}

describe('api docs: /api/docs', () => {
  it('serves the reference page without a credential even when authentication is enabled', async () => {
    await withServer(
      { auth: { enabled: true, mode: 'token', token: TOKEN, tokenFile: join(rootDirectory, 'unused.token') } },
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/docs`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /^text\/html; charset=utf-8$/);
        const html = await response.text();
        assert.match(html, /ss-rtdb API reference/);
        assert.match(html, /\/api\/v1\/write/);
        assert.match(html, /\/api\/v1\/query\/aggregate/);
        assert.match(html, /\/api\/docs\/openapi\.json/);
        // Two top-level families, each with its own heading.
        assert.match(html, /id="family-native"[^>]*data-family="native"/);
        assert.match(html, /id="family-influx"[^>]*data-family="influx"/);
        assert.match(html, /ss-rtdb native API/);
        assert.match(html, /InfluxDB compatibility/);
        // Trailing slash resolves to the same document.
        const slashResponse = await fetch(`${baseUrl}/api/docs/`);
        assert.equal(slashResponse.status, 200);
        assert.match(await slashResponse.text(), /ss-rtdb API reference/);
      },
    );
  });

  it('rejects methods other than GET', async () => {
    await withServer({}, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/docs`, { method: 'POST' });
      assert.equal(response.status, 405);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, 'E_METHOD_NOT_ALLOWED');
    });
  });

  it('hides compatibility endpoints when the adapter is disabled and shows console routes only when hosted', async () => {
    await withServer({ compat: { influx: { enabled: false } } }, async ({ baseUrl }) => {
      const html = await (await fetch(`${baseUrl}/api/docs`)).text();
      assert.doesNotMatch(html, /\/api\/v2\/write/);
      assert.doesNotMatch(html, /id="family-influx"/);
      assert.doesNotMatch(html, /id="influx-write"/);
      // The console link and the static-hosting entries disappear with `admin.enabled=false`.
      assert.doesNotMatch(html, /href="\/admin\/"/);
      assert.doesNotMatch(html, /<code class="path">\/admin\/<\/code>/);
    });
    await withServer(
      { admin: { enabled: false }, compat: { influx: { enabled: true } } },
      async ({ baseUrl }) => {
        const html = await (await fetch(`${baseUrl}/api/docs`)).text();
        assert.match(html, /\/api\/v2\/write/);
        assert.match(html, /\/query/);
      },
    );
  });
});

describe('api docs: /api/docs/openapi.json', () => {
  it('returns an OpenAPI 3.1 document describing the served routes', async () => {
    await withServer({}, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/docs/openapi.json`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/);
      const document = (await response.json()) as OpenApiDocument;

      assert.equal(document.openapi, '3.1.0');
      assert.equal(document.info.title, 'ss-rtdb HTTP API');
      assert.ok(document.components.securitySchemes.bearerAuth);
      assert.ok(document.components.securitySchemes.basicAuth);

      assert.deepEqual(Object.keys(document.paths['/api/v1/write']), ['post']);
      assert.deepEqual(
        Object.keys(document.paths['/api/v1/query/range']).sort(),
        ['post'],
      );
      assert.ok(document.paths['/api/v1/databases/{db}'].get);
      assert.ok(document.paths['/api/docs'].get);
      // Redirects and static hosting are not part of the machine contract.
      assert.equal(document.paths['/'], undefined);
      assert.equal(document.paths['/admin/'], undefined);

      const write = document.paths['/api/v1/write'].post as {
        security: unknown[];
        parameters: { name: string; in: string }[];
        requestBody: { content: Record<string, unknown> };
      };
      assert.deepEqual(write.security, [{ bearerAuth: [] }, { basicAuth: [] }]);
      assert.ok(write.parameters.some((parameter) => parameter.name === 'db' && parameter.in === 'query'));
      assert.ok(write.requestBody.content['application/json']);
      assert.ok(write.requestBody.content['text/plain']);

      const status = document.paths['/api/v1/status'].get as { security: unknown[] };
      assert.deepEqual(status.security, []);

      // Operations are tagged with their family and group, so generated clients can split the two surfaces.
      const nativeWrite = document.paths['/api/v1/write'].post as { tags: string[]; 'x-family': string };
      assert.deepEqual(nativeWrite.tags, ['native', 'write']);
      assert.equal(nativeWrite['x-family'], 'native');
      const compatWrite = document.paths['/api/v2/write'].post as { tags: string[]; 'x-family': string };
      assert.deepEqual(compatWrite.tags, ['influx', 'influx-write']);
      assert.equal(compatWrite['x-family'], 'influx');
      const ping = document.paths['/ping'].get as { tags: string[] };
      assert.deepEqual(ping.tags, ['influx', 'influx-probes']);
    });
  });

  it('omits compatibility paths when the adapter is disabled', async () => {
    await withServer({ compat: { influx: { enabled: false } } }, async ({ baseUrl }) => {
      const document = (await (await fetch(`${baseUrl}/api/docs/openapi.json`)).json()) as OpenApiDocument;
      assert.equal(document.paths['/api/v2/write'], undefined);
      assert.equal(document.paths['/ping'], undefined);
      assert.ok(document.paths['/api/v1/status']);
    });
  });
});
