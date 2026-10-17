#!/usr/bin/env node
// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `rtdb-server` process entry (Form B; aligns with "Detailed Design v2.0" §5 CLI `serve` in-process main program part)
 *
 * Responsibilities: load config → start service → handle SIGINT/SIGTERM and the interactive console keys:
 *
 *   q   graceful exit (stop the listener, flush the engine, release the data-root lock)
 *   r   reload: re-read the config file and restart the listener + engine in place
 *
 * The full CLI (serve/status/backup/... subcommands) belongs to S9 `rtdbctl`.
 */

import { loadServerConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { installConsoleControls } from './console-controls.ts';
import { Logger } from './logger.ts';
import { RtdbServer } from './server.ts';

interface RunningService {
  config: ServerConfig;
  logger: Logger;
  server: RtdbServer;
}

/** Load the configuration and start a fresh server instance (used for the initial boot and for reloads) */
async function startService(): Promise<RunningService> {
  const config = loadServerConfig();
  const logger = new Logger(config.log.level);
  const server = new RtdbServer({ config, logger });
  // Printed before the engine opens the data root: recovery over a large/uncached data root
  // (segment scan + missing .idx mirror rebuild) can take tens of seconds with no other output,
  // which is easy to mistake for a hung process.
  logger.info(`opening data root: ${config.dataDir} (recovery may take a while on first start)`);
  const address = await server.start();
  logger.info(`rtdb-server started: http://${address.host}:${address.port} (dataDir=${config.dataDir})`);
  return { config, logger, server };
}

async function main(): Promise<void> {
  let service = await startService();
  let busy = false;

  /** Graceful shutdown: `stop()` drains in-flight requests and closes the engine (WAL fsync + lock release) */
  const quit = async (reason: string): Promise<void> => {
    if (busy) return;
    busy = true;
    service.logger.info(`${reason}, shutting down gracefully...`);
    try {
      await service.server.stop();
      process.exit(0);
    } catch (error) {
      service.logger.error('Shutdown failed: ', error);
      process.exit(1);
    }
  };

  /**
   * Safe restart. The old listener is closed first (the data-root lock is released), then the config file is
   * re-read and a new server is started on the same process — a failed reload leaves the process alive so the
   * operator can fix the file and press r again, or quit with q.
   */
  const reload = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    const previous = service;
    previous.logger.info('Reload requested, stopping the service...');
    try {
      await previous.server.stop();
      service = await startService();
      service.logger.info('Reload complete: configuration re-read.');
    } catch (error) {
      previous.logger.error('Reload failed: ', error);
      previous.logger.error('The service is not listening. Press r to retry the reload, or q to quit.');
    } finally {
      busy = false;
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void quit(`Received ${signal}`);
    });
  }

  if (installConsoleControls({ quit: () => void quit('Console command "q"'), reload: () => void reload() })) {
    service.logger.info('Console keys: q = quit gracefully, r = reload the configuration and restart.');
  }
}

main().catch((error: unknown) => {
  console.error('[ss-rtdb] rtdb-server failed to start: ', error);
  process.exitCode = 1;
});
