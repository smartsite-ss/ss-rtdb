// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Public export surface of `@ss/rtdb-cli` (aligned with "Detailed Design v2.2" §5)
 *
 * The `rtdbctl` bin points at `main.ts`; tests and embedders use `runCli` directly so that IO and the
 * environment can be injected.
 */

export { CLI_VERSION, runCli } from './cli.ts';
export type { RunCliOptions } from './cli.ts';

export { USAGE_TEXT, flagBoolean, flagString, parseArgv } from './args.ts';
export type { ParsedArgs } from './args.ts';

export { COMMANDS, UsageError } from './commands.ts';
export type { CliEnvironment, CliIo, CommandHandler } from './commands.ts';

export {
  archiveDatabaseDay,
  archiveDirectoryPath,
  listDatabaseArchives,
  measureDatabaseSize,
  readRetentionDays,
  repairDatabase,
  restoreDatabase,
  restoreDatabaseDayFromArchive,
} from './local.ts';
export type {
  ArchiveDaySummary,
  ArchivedDaySummary,
  DatabaseSizeReport,
  DaySizeEntry,
  RepairSummary,
  RestoreDaySummary,
  RestoreSummary,
} from './local.ts';
