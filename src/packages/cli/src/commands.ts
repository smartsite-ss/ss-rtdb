// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `rtdbctl` subcommands (aligned with "Detailed Design v2.2" §5)
 *
 * | Command                       | Transport                                            |
 * | ----------------------------- | ---------------------------------------------------- |
 * | `serve [--config <path>]`     | in-process `RtdbServer` (shares the local data root)  |
 * | `status [--json]`             | HTTP `GET  /api/v1/status`                            |
 * | `metrics <db> [--prefix <p>]` | HTTP `GET  /api/v1/metrics/:db`                       |
 * | `backup <db> <dir>`           | HTTP `POST /api/v1/backup/:db`                        |
 * | `retention <db> [days]`       | HTTP `PUT  /api/v1/retention/:db` (set) / local read  |
 * | `size <db> [--by-day]`        | offline local data root (`local.ts`)                  |
 * | `repair <db> [<date>]`        | offline local data root (`local.ts`)                  |
 * | `restore <db> <dir>`          | offline local data root (`local.ts`)                  |
 * | `restore <db> --archive <date>` | offline local data root (`local.ts`), one archived day |
 * | `archive <db> [<date>]`       | offline local data root (`local.ts`)                  |
 * | `user add|list|remove|passwd` | HTTP `/api/v1/admin/users` (scope = admin)            |
 * | `token issue|list|revoke`     | HTTP `/api/v1/admin/tokens` (scope = admin)           |
 *
 * Exit codes: `0` success, `1` runtime failure, `2` usage failure.
 */

import { join } from 'node:path';

import { RtdbClient } from '../../client-node/src/index.ts';
import type { StatusReport, UserInfo } from '../../client-node/src/index.ts';
import { Logger } from '../../server/src/logger.ts';
import { RtdbServer } from '../../server/src/server.ts';
import type { ServerConfig } from '../../server/src/config.ts';
import { isUserRole } from '../../server/src/users.ts';
import type { UserRole } from '../../server/src/users.ts';
import { parseDateFolderName } from '../../core/src/format.ts';
import { flagBoolean, flagString } from './args.ts';
import type { ParsedArgs } from './args.ts';
import {
  archiveDatabaseDay,
  archiveDirectoryPath,
  listDatabaseArchives,
  measureDatabaseSize,
  readRetentionDays,
  repairDatabase,
  restoreDatabase,
  restoreDatabaseDayFromArchive,
} from './local.ts';
import { formatBytes, formatNumber, formatTimestamp, renderTable } from './output.ts';

/* ---------- Environment ---------- */

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** Everything a subcommand needs: parsed arguments, resolved configuration, and output sinks */
export interface CliEnvironment {
  parsed: ParsedArgs;
  io: CliIo;
  json: boolean;
  config: ServerConfig;
  /** Effective local data root (offline commands use it) */
  dataDir: string;
  /** Effective server base URL (remote commands use it) */
  baseUrl: string;
  token: string;
  timeoutMs: number | undefined;
  createClient(): RtdbClient;
  out(line: string): void;
  err(line: string): void;
}

export type CommandHandler = (environment: CliEnvironment) => Promise<number>;

/** Usage failure (bad arguments / missing positionals); `runCli` maps it to exit code 2 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/* ---------- Registry ---------- */

export const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  serve: serveCommand,
  status: statusCommand,
  backup: backupCommand,
  restore: restoreCommand,
  archive: archiveCommand,
  retention: retentionCommand,
  metrics: metricsCommand,
  size: sizeCommand,
  repair: repairCommand,
  user: userCommand,
  token: tokenCommand,
};

/* ---------- serve ---------- */

async function serveCommand(environment: CliEnvironment): Promise<number> {
  const server = new RtdbServer({ config: environment.config, logger: new Logger(environment.config.log.level) });
  const address = await server.start();
  environment.out(
    `rtdbctl serve: listening on http://${address.host}:${address.port} (dataDir=${environment.config.dataDir})`,
  );
  return await new Promise<number>((resolvePromise) => {
    const shutdown = (): void => {
      environment.out('rtdbctl serve: shutting down...');
      void server
        .stop()
        .then(() => resolvePromise(0))
        .catch(() => resolvePromise(1));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

/* ---------- status ---------- */

async function statusCommand(environment: CliEnvironment): Promise<number> {
  const report = await environment.createClient().status();
  printRecord(environment, statusLines(report), report);
  return 0;
}

function statusLines(report: StatusReport): Array<[string, string]> {
  return [
    ['uptimeMs', formatNumber(report.uptimeMs)],
    ['databases', String(report.databases)],
    ['metrics', String(report.metrics)],
    ['write.pointsPerSec', String(report.write.pointsPerSec)],
    ['write.buffered', formatNumber(report.write.buffered)],
    ['write.duplicates', formatNumber(report.write.duplicates)],
    ['write.tagsIgnored', formatNumber(report.write.tagsIgnored)],
    ['wal.pendingBytes', formatBytes(report.wal.pendingBytes)],
    ['wal.outstandingBatches', String(report.wal.outstandingBatches)],
    ['segments.openFiles', String(report.segments.openFiles)],
    ['cache.blocks', String(report.cache.blocks)],
  ];
}

/* ---------- metrics ---------- */

async function metricsCommand(environment: CliEnvironment): Promise<number> {
  const database = requirePositional(environment, 0, 'database');
  const prefix = flagString(environment.parsed, 'prefix') ?? '';
  const metrics = await environment.createClient().listMetrics(database);
  const filtered = prefix.length === 0 ? metrics : metrics.filter((metric) => metric.metricName.startsWith(prefix));

  if (environment.json) {
    environment.out(JSON.stringify({ database, metrics: filtered }, null, 2));
    return 0;
  }
  if (filtered.length === 0) {
    environment.out(
      prefix.length === 0
        ? `no metrics under database ${database}`
        : `no metrics under database ${database} matching prefix "${prefix}"`,
    );
    return 0;
  }
  const rows = filtered.map((metric): string[] => [
    metric.metricName,
    formatTimestamp(metric.firstTs),
    formatTimestamp(metric.lastTs),
  ]);
  for (const line of renderTable(['Metric', 'First', 'Last'], rows)) environment.out(line);
  environment.out(`${filtered.length} metric(s)`);
  return 0;
}

/* ---------- backup (HTTP) ---------- */

async function backupCommand(environment: CliEnvironment): Promise<number> {
  const database = requirePositional(environment, 0, 'database');
  const targetDirectory = requirePositional(environment, 1, 'directory');
  const result = await environment.createClient().backup(database, targetDirectory);
  printRecord(
    environment,
    [
      ['database', result.database],
      ['targetDirectory', result.targetDirectory],
      ['files', String(result.files)],
      ['totalBytes', formatBytes(result.totalBytes)],
    ],
    result,
  );
  return 0;
}

/* ---------- restore (offline) ---------- */

async function restoreCommand(environment: CliEnvironment): Promise<number> {
  const database = requirePositional(environment, 0, 'database');

  // 归档还原通道：`restore <db> --archive <yyyyMMdd>`（整日替换，与整库 restore 共用命令名）
  const archiveArgument = flagString(environment.parsed, 'archive');
  if (archiveArgument !== undefined) {
    const dateNumber = parseDateFolderName(archiveArgument);
    if (dateNumber === null) throw new UsageError(`--archive must use the yyyyMMdd form: ${archiveArgument}`);
    const day = restoreDatabaseDayFromArchive(environment.dataDir, database, dateNumber);
    printRecord(
      environment,
      [
        ['database', day.database],
        ['date', day.dayLabel],
        ['sourceArchiveFilePath', day.sourceArchiveFilePath],
        ['targetDayDirectory', day.targetDayDirectory],
        ['files', String(day.fileCount)],
        ['totalBytes', formatBytes(day.totalBytes)],
      ],
      day,
    );
    return 0;
  }

  const backupDirectory = requirePositional(environment, 1, 'directory');
  const summary = await restoreDatabase(environment.dataDir, database, backupDirectory);
  const databaseDirectory = join(summary.targetDirectory, summary.database);
  printRecord(
    environment,
    [
      ['database', summary.database],
      ['sourceDirectory', summary.sourceDirectory],
      ['targetDirectory', databaseDirectory],
      ['files', String(summary.fileCount)],
      ['totalBytes', formatBytes(summary.totalBytes)],
    ],
    { ...summary, targetDirectory: databaseDirectory },
  );
  return 0;
}

/* ---------- archive (offline) ---------- */

async function archiveCommand(environment: CliEnvironment): Promise<number> {
  const database = requirePositional(environment, 0, 'database');
  const dateArgument = environment.parsed.positionals[1];
  const archiveDirectory = archiveDirectoryPath(environment.dataDir);

  if (dateArgument === undefined) {
    const archives = listDatabaseArchives(environment.dataDir, database);
    if (environment.json) {
      environment.out(JSON.stringify({ database, archiveDirectory, archives }, null, 2));
      return 0;
    }
    environment.out(`database: ${database}`);
    environment.out(`archiveDirectory: ${archiveDirectory}`);
    if (archives.length === 0) {
      environment.out('no archives');
      return 0;
    }
    const rows = archives.map((archive): string[] => [
      archive.dayLabel,
      formatBytes(archive.totalBytes),
      archive.archiveFilePath,
    ]);
    for (const line of renderTable(['Day', 'Size', 'Archive'], rows)) environment.out(line);
    environment.out(`${archives.length} archive(s)`);
    return 0;
  }

  const dateNumber = parseDateFolderName(dateArgument);
  if (dateNumber === null) throw new UsageError(`date must use the yyyyMMdd form: ${dateArgument}`);
  const summary = archiveDatabaseDay(environment.dataDir, database, dateNumber);
  printRecord(
    environment,
    [
      ['database', summary.database],
      ['date', summary.dayLabel],
      ['archiveFilePath', summary.archiveFilePath],
      ['files', String(summary.entryCount)],
      ['totalBytes', formatBytes(summary.totalBytes)],
    ],
    summary,
  );
  return 0;
}

/* ---------- retention ---------- */

async function retentionCommand(environment: CliEnvironment): Promise<number> {
  const database = requirePositional(environment, 0, 'database');
  const daysArgument = environment.parsed.positionals[1];

  if (daysArgument === undefined) {
    const days = readRetentionDays(environment.dataDir, database);
    printRecord(
      environment,
      [
        ['database', database],
        ['retentionDays', days === null ? '(not set; the global default applies)' : String(days)],
      ],
      { database, retentionDays: days },
    );
    return 0;
  }

  const days = Number.parseInt(daysArgument, 10);
  if (!Number.isInteger(days) || days < 0) {
    throw new UsageError(`retention days must be a non-negative integer: ${daysArgument}`);
  }
  await environment.createClient().setRetention(database, days);
  printRecord(
    environment,
    [
      ['database', database],
      ['retentionDays', String(days)],
      ['ok', 'true'],
    ],
    { database, retentionDays: days, ok: true },
  );
  return 0;
}

/* ---------- size (offline) ---------- */

async function sizeCommand(environment: CliEnvironment): Promise<number> {
  const database = requirePositional(environment, 0, 'database');
  const includeDays = flagBoolean(environment.parsed, 'by-day');
  const report = measureDatabaseSize(environment.dataDir, database);
  const retentionText = report.retentionDays === null ? '(not set; the global default applies)' : String(report.retentionDays);

  if (environment.json) {
    const payload = includeDays
      ? report
      : {
          database: report.database,
          directory: report.directory,
          fileCount: report.fileCount,
          totalBytes: report.totalBytes,
          retentionDays: report.retentionDays,
        };
    environment.out(JSON.stringify(payload, null, 2));
    return 0;
  }

  environment.out(`database: ${report.database}`);
  environment.out(`directory: ${report.directory}`);
  environment.out(`files: ${report.fileCount}`);
  environment.out(`size: ${formatBytes(report.totalBytes)} (${formatNumber(report.totalBytes)} bytes)`);
  environment.out(`retentionDays: ${retentionText}`);
  if (includeDays && report.days.length > 0) {
    environment.out('');
    const rows = report.days.map((day): string[] => [
      day.dayLabel,
      String(day.fileCount),
      formatBytes(day.totalBytes),
    ]);
    for (const line of renderTable(['Day', 'Files', 'Size'], rows)) environment.out(line);
  }
  return 0;
}

/* ---------- repair (offline) ---------- */

async function repairCommand(environment: CliEnvironment): Promise<number> {
  const database = requirePositional(environment, 0, 'database');
  const dateArgument = environment.parsed.positionals[1];
  let dateNumber: number | null = null;
  if (dateArgument !== undefined) {
    dateNumber = parseDateFolderName(dateArgument);
    if (dateNumber === null) throw new UsageError(`date must use the yyyyMMdd form: ${dateArgument}`);
  }

  const summary = repairDatabase(environment.dataDir, database, dateNumber);
  printRecord(
    environment,
    [
      ['database', summary.database],
      ['date', summary.dateNumber === null ? '(whole database)' : String(summary.dateNumber)],
      ['segments', String(summary.segmentCount)],
      ['truncatedSegments', String(summary.truncatedSegmentCount)],
      ['truncatedBytes', formatBytes(summary.truncatedBytes)],
      ['rebuiltIndexes', String(summary.rebuiltIndexCount)],
      ['replayedWalEntries', String(summary.replayedEntryCount)],
      ['discardedWalTailBytes', formatBytes(summary.discardedWalTailBytes)],
    ],
    summary,
  );
  return 0;
}

/* ---------- user (multi-user administration, scope = admin) ---------- */

async function userCommand(environment: CliEnvironment): Promise<number> {
  const subcommand = requirePositional(environment, 0, 'user subcommand');
  switch (subcommand) {
    case 'add':
      return await userAddCommand(environment);
    case 'list':
      return await userListCommand(environment);
    case 'remove':
      return await userRemoveCommand(environment);
    case 'passwd':
      return await userPasswdCommand(environment);
    default:
      throw new UsageError(`unsupported user subcommand: ${subcommand} (expected add|list|remove|passwd)`);
  }
}

async function userAddCommand(environment: CliEnvironment): Promise<number> {
  const username = requirePositional(environment, 1, 'user name');
  const password = requireFlagString(environment, 'password');
  const role = resolveCliRole(environment, 'write');
  const enabled = !flagBoolean(environment.parsed, 'disabled');
  const user = await environment.createClient().createUser({ username, password, role, enabled });
  printRecord(environment, userLines(user), user);
  return 0;
}

async function userListCommand(environment: CliEnvironment): Promise<number> {
  const users = await environment.createClient().listUsers();
  if (environment.json) {
    environment.out(JSON.stringify({ users }, null, 2));
    return 0;
  }
  if (users.length === 0) {
    environment.out('no users');
    return 0;
  }
  const rows = users.map((user): string[] => [
    user.username,
    user.role,
    user.enabled ? 'enabled' : 'disabled',
    formatTimestamp(user.createdAt),
  ]);
  for (const line of renderTable(['User', 'Role', 'State', 'Created'], rows)) environment.out(line);
  environment.out(`${users.length} user(s)`);
  return 0;
}

async function userRemoveCommand(environment: CliEnvironment): Promise<number> {
  const username = requirePositional(environment, 1, 'user name');
  await environment.createClient().removeUser(username);
  printRecord(
    environment,
    [
      ['user', username],
      ['ok', 'true'],
    ],
    { user: username, ok: true },
  );
  return 0;
}

async function userPasswdCommand(environment: CliEnvironment): Promise<number> {
  const username = requirePositional(environment, 1, 'user name');
  const password = requireFlagString(environment, 'password');
  const user = await environment.createClient().updateUser(username, { password });
  printRecord(environment, userLines(user), user);
  return 0;
}

/* ---------- token (multi-user administration, scope = admin) ---------- */

async function tokenCommand(environment: CliEnvironment): Promise<number> {
  const subcommand = requirePositional(environment, 0, 'token subcommand');
  switch (subcommand) {
    case 'issue':
      return await tokenIssueCommand(environment);
    case 'list':
      return await tokenListCommand(environment);
    case 'revoke':
      return await tokenRevokeCommand(environment);
    default:
      throw new UsageError(`unsupported token subcommand: ${subcommand} (expected issue|list|revoke)`);
  }
}

async function tokenIssueCommand(environment: CliEnvironment): Promise<number> {
  const user = requirePositional(environment, 1, 'user name');
  const roleValue = flagString(environment.parsed, 'role');
  const label = flagString(environment.parsed, 'label');
  const ttlMs = parseOptionalTtlMs(environment);
  const issued = await environment.createClient().issueToken({
    user,
    ...(roleValue === undefined ? {} : { role: requireCliRole(roleValue) }),
    ...(label === undefined ? {} : { label }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  // The plaintext token is shown once; callers should store it immediately.
  printRecord(
    environment,
    [
      ['token', issued.token],
      ['tokenId', issued.tokenRecord.tokenId],
      ['user', issued.tokenRecord.user],
      ['role', issued.tokenRecord.role],
      ['label', issued.tokenRecord.label],
      ['expiresAt', issued.tokenRecord.expiresAt === null ? '(never)' : formatTimestamp(issued.tokenRecord.expiresAt)],
    ],
    issued,
  );
  return 0;
}

async function tokenListCommand(environment: CliEnvironment): Promise<number> {
  const tokens = await environment.createClient().listTokens();
  if (environment.json) {
    environment.out(JSON.stringify({ tokens }, null, 2));
    return 0;
  }
  if (tokens.length === 0) {
    environment.out('no tokens');
    return 0;
  }
  const nowMs = Date.now();
  const rows = tokens.map((token): string[] => [
    token.tokenId,
    token.user,
    token.role,
    token.label,
    tokenState(token.revokedAt, token.expiresAt, nowMs),
    formatTimestamp(token.createdAt),
  ]);
  for (const line of renderTable(['Token', 'User', 'Role', 'Label', 'State', 'Created'], rows)) environment.out(line);
  environment.out(`${tokens.length} token(s)`);
  return 0;
}

async function tokenRevokeCommand(environment: CliEnvironment): Promise<number> {
  const tokenId = requirePositional(environment, 1, 'token id');
  await environment.createClient().revokeToken(tokenId);
  printRecord(
    environment,
    [
      ['tokenId', tokenId],
      ['ok', 'true'],
    ],
    { tokenId, ok: true },
  );
  return 0;
}

/* ---------- Internals ---------- */

function requirePositional(environment: CliEnvironment, index: number, label: string): string {
  const value = environment.parsed.positionals[index];
  if (value === undefined || value.length === 0) {
    throw new UsageError(`missing required argument: <${label}>`);
  }
  return value;
}

function requireFlagString(environment: CliEnvironment, name: string): string {
  const value = flagString(environment.parsed, name);
  if (value === undefined || value.length === 0) {
    throw new UsageError(`missing required option: --${name}`);
  }
  return value;
}

function requireCliRole(value: string): UserRole {
  if (!isUserRole(value)) {
    throw new UsageError(`--role must be admin | write | readonly: ${value}`);
  }
  return value;
}

function resolveCliRole(environment: CliEnvironment, defaultRole: UserRole): UserRole {
  const value = flagString(environment.parsed, 'role');
  return value === undefined ? defaultRole : requireCliRole(value);
}

function parseOptionalTtlMs(environment: CliEnvironment): number | undefined {
  const value = flagString(environment.parsed, 'ttl');
  if (value === undefined) return undefined;
  const ttlMs = Number.parseInt(value, 10);
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new UsageError(`--ttl must be a positive integer of milliseconds: ${value}`);
  }
  return ttlMs;
}

function userLines(user: UserInfo): Array<[string, string]> {
  return [
    ['user', user.username],
    ['role', user.role],
    ['state', user.enabled ? 'enabled' : 'disabled'],
    ['createdAt', formatTimestamp(user.createdAt)],
    ['updatedAt', formatTimestamp(user.updatedAt)],
  ];
}

function tokenState(revokedAt: number | null, expiresAt: number | null, nowMs: number): string {
  if (revokedAt !== null) return 'revoked';
  if (expiresAt !== null && expiresAt <= nowMs) return 'expired';
  return 'active';
}

function printRecord(environment: CliEnvironment, lines: readonly (readonly [string, string])[], jsonValue: unknown): void {
  if (environment.json) {
    environment.out(JSON.stringify(jsonValue, null, 2));
    return;
  }
  for (const [key, value] of lines) environment.out(`${key}: ${value}`);
}
