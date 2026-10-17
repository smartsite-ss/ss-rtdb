// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `rtdbctl` entry orchestration (aligned with "Detailed Design v2.2" §5)
 *
 * `runCli` is kept free of `process.exit`: it resolves the configuration, builds an environment, dispatches to a
 * single subcommand, and returns an exit code (`0` success / `1` runtime failure / `2` usage failure) so tests can
 * drive it in-process with captured IO.
 *
 * Resolution order (low -> high): built-in defaults < config file (`--config` / `RTDB_CONFIG`) < environment
 * variables (`RTDB_DATA_DIR` / `RTDB_URL` / `RTDB_TOKEN`) < explicit CLI flags. Everything is shared with
 * `@ss/rtdb-server` through `loadServerConfig`, so `serve` and the offline commands always agree on `dataDir`.
 */

import { RtdbClient, isRtdbClientError } from '../../client-node/src/index.ts';
import { isRtdbError } from '../../core/src/errors.ts';
import { loadServerConfig } from '../../server/src/config.ts';
import type { ServerConfig } from '../../server/src/config.ts';
import { USAGE_TEXT, flagBoolean, flagString, parseArgv } from './args.ts';
import { COMMANDS, UsageError } from './commands.ts';
import type { CliEnvironment, CliIo } from './commands.ts';

/** CLI version (`rtdbctl --version`) */
export const CLI_VERSION = '0.1.0';

export interface RunCliOptions {
  /** Output sinks; defaults to `process.stdout` / `process.stderr` */
  io?: CliIo;
  /** Environment source; defaults to `process.env` */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run one CLI invocation and return the process exit code.
 *
 * Never throws for user-level failures: argument problems map to `2`, and configuration / transport / engine
 * failures map to `1` after being rendered to `stderr`.
 */
export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? defaultIo();
  const processEnv = options.env ?? process.env;
  const parsed = parseArgv(argv);

  if (flagBoolean(parsed, 'version')) {
    io.stdout(`rtdbctl ${CLI_VERSION}`);
    return 0;
  }
  if (parsed.command.length === 0 || parsed.command === 'help' || flagBoolean(parsed, 'help')) {
    io.stdout(USAGE_TEXT);
    return 0;
  }

  const handler = COMMANDS[parsed.command];
  if (handler === undefined) {
    io.stderr(`unknown command: ${parsed.command}`);
    io.stderr(USAGE_TEXT);
    return 2;
  }

  try {
    const config = loadServerConfig({ configFilePath: flagString(parsed, 'config'), env: processEnv });
    const timeoutMs = parsePositiveInteger(flagString(parsed, 'timeout'), 'timeout');
    const dataDir = flagString(parsed, 'data-dir') ?? config.dataDir;
    const baseUrl = flagString(parsed, 'url') ?? processEnv.RTDB_URL ?? `http://127.0.0.1:${config.port}`;
    const token = flagString(parsed, 'token') ?? processEnv.RTDB_TOKEN ?? defaultToken(config);

    const environment: CliEnvironment = {
      parsed,
      io,
      json: flagBoolean(parsed, 'json'),
      config,
      dataDir,
      baseUrl,
      token,
      timeoutMs,
      createClient: (): RtdbClient =>
        new RtdbClient({
          baseUrl,
          token,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      out: (line: string): void => io.stdout(line),
      err: (line: string): void => io.stderr(line),
    };

    return await handler(environment);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(error.message);
      io.stderr('Run "rtdbctl --help" for usage.');
      return 2;
    }
    reportError(io, error);
    return 1;
  }
}

/* ---------- Internals ---------- */

function defaultIo(): CliIo {
  return {
    stdout: (line: string): void => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string): void => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/** The token implied by the config (token / both modes only; basic mode needs a username + password) */
function defaultToken(config: ServerConfig): string {
  if (!config.auth.enabled) return '';
  return config.auth.mode === 'basic' ? '' : config.auth.token;
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${label} must be a positive integer: ${value}`);
  }
  return parsed;
}

function reportError(io: CliIo, error: unknown): void {
  if (isRtdbClientError(error)) {
    io.stderr(`[${error.code}]${error.status > 0 ? ` HTTP ${error.status}` : ''} ${error.message}`);
    if (error.details.length > 0) io.stderr(`details: ${JSON.stringify(error.details)}`);
    return;
  }
  if (isRtdbError(error)) {
    io.stderr(`[${error.code}] ${error.message}`);
    if (error.details.length > 0) io.stderr(`details: ${JSON.stringify(error.details)}`);
    return;
  }
  io.stderr(error instanceof Error ? error.message : String(error));
}
