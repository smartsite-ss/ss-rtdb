#!/usr/bin/env node
// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `rtdb-server` process entry (Form B; aligns with "Detailed Design v2.0" §5 CLI `serve` in-process main program part)
 *
 * Only responsible for: load config → start service → register SIGINT/SIGTERM graceful shutdown.
 * The full CLI (serve/status/backup/... subcommands) belongs to S9 `rtdbctl`.
 */

import { loadServerConfig } from './config.ts';
import { Logger } from './logger.ts';
import { RtdbServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadServerConfig();
  const logger = new Logger(config.log.level);
  const server = new RtdbServer({ config, logger });
  const address = await server.start();
  logger.info(`rtdb-server started: http://${address.host}:${address.port} (dataDir=${config.dataDir})`);

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    server
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error('Shutdown failed: ', error);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[ss-rtdb] rtdb-server failed to start: ', error);
  process.exitCode = 1;
});
