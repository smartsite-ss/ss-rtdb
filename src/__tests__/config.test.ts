// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * rtdb-server configuration loading: the `conf/rtdb-server.json` runtime convention (relative to the
 * process working directory), the precedence against environment variables / explicit paths, and the
 * `admin.exposePaths` switch that decides which directory `GET /api/v1/databases/:db` reports.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_CONFIG_FILE_PATH,
  SERVER_CONFIG_DEFAULTS,
  loadServerConfig,
  reportedDatabaseDirectory,
} from '../packages/server/src/config.ts';

const tempRoot = mkdtempSync(join(tmpdir(), 'ss-rtdb-config-'));

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Run `action` with the process working directory switched to `directory` (the runtime file is cwd-relative) */
function inWorkingDirectory<T>(directory: string, action: () => T): T {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return action();
  } finally {
    process.chdir(previous);
  }
}

/** Create a data-root-like workspace that carries a runtime config file */
function createWorkspace(name: string, config: unknown): string {
  const workspace = join(tempRoot, name);
  mkdirSync(join(workspace, 'conf'), { recursive: true });
  writeFileSync(join(workspace, DEFAULT_CONFIG_FILE_PATH), `${JSON.stringify(config, null, 2)}\n`);
  return workspace;
}

describe('server: 配置加载', () => {
  it('工作目录存在 conf/rtdb-server.json 时自动加载，环境变量优先级更高', () => {
    const workspace = createWorkspace('runtime-with-conf', {
      port: 6199,
      log: { level: 'debug' },
      admin: { exposePaths: false },
    });

    const loaded = inWorkingDirectory(workspace, () => loadServerConfig({ env: {} }));
    assert.equal(loaded.port, 6199);
    assert.equal(loaded.log.level, 'debug');
    assert.equal(loaded.admin.exposePaths, false);
    assert.equal(loaded.host, SERVER_CONFIG_DEFAULTS.host);

    const overridden = inWorkingDirectory(workspace, () => loadServerConfig({ env: { RTDB_PORT: '6201' } }));
    assert.equal(overridden.port, 6201);
  });

  it('没有配置文件时退回内置默认值；RTDB_CONFIG 指定的文件取代默认文件', () => {
    const bare = join(tempRoot, 'runtime-bare');
    mkdirSync(bare, { recursive: true });
    const defaults = inWorkingDirectory(bare, () => loadServerConfig({ env: {} }));
    assert.equal(defaults.port, SERVER_CONFIG_DEFAULTS.port);
    assert.equal(defaults.dataDir, SERVER_CONFIG_DEFAULTS.dataDir);

    const workspace = createWorkspace('runtime-explicit', { port: 6199 });
    const explicitFile = join(tempRoot, 'explicit.json');
    writeFileSync(explicitFile, `${JSON.stringify({ port: 6210 }, null, 2)}\n`);
    const explicit = inWorkingDirectory(workspace, () =>
      loadServerConfig({ env: { RTDB_CONFIG: explicitFile } }),
    );
    assert.equal(explicit.port, 6210);
  });

  it('默认只报告相对于工作目录的路径，admin.exposePaths=true 才给绝对目录', () => {
    const workspace = join(tempRoot, 'runtime-paths');
    mkdirSync(workspace, { recursive: true });
    const insideDataRoot = join(workspace, 'rtdb-data', 'alpha');

    const relativeConfig = inWorkingDirectory(workspace, () => loadServerConfig({ env: {} }));
    assert.equal(reportedDatabaseDirectory(relativeConfig, insideDataRoot, 'alpha'), join('rtdb-data', 'alpha'));

    const absoluteConfig = inWorkingDirectory(workspace, () =>
      loadServerConfig({ env: {}, overrides: { admin: { exposePaths: true } } }),
    );
    assert.equal(reportedDatabaseDirectory(absoluteConfig, insideDataRoot, 'alpha'), insideDataRoot);

    // Data root outside the working directory: report the configured {dataDir}/{db}, not a chain of "..".
    const outside = inWorkingDirectory(workspace, () =>
      loadServerConfig({ env: {}, overrides: { dataDir: '/srv/rtdb-data' } }),
    );
    assert.equal(
      reportedDatabaseDirectory(outside, join('/srv/rtdb-data', 'alpha'), 'alpha'),
      join('/srv/rtdb-data', 'alpha'),
    );
  });
});
