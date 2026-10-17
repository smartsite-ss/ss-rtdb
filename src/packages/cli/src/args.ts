// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `rtdbctl` argument parsing (hand-written; the CLI must stay free of third-party dependencies)
 *
 * Accepted forms:
 *   - `--key=value` -> value
 *   - `--key value` -> value (the next token is consumed when it does not start with `--`)
 *   - `--flag` (a member of `BOOLEAN_FLAGS`) -> `true`
 *   - `--key` with no consumable value -> `true` (the command validates required values)
 *   - `-h` / `-v` short aliases for `--help` / `--version`
 * The first non-flag token is the command; every later non-flag token is a positional argument.
 */

/** Flags that never consume the next token */
const BOOLEAN_FLAGS = new Set(['json', 'by-day', 'help', 'version', 'disabled']);

export interface ParsedArgs {
  /** Subcommand name (empty when not provided) */
  command: string;
  /** Positional arguments in order */
  positionals: string[];
  /** Flag map: value flags hold a string, boolean flags hold `true` */
  flags: Record<string, string | boolean>;
}

export function parseArgv(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = '';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '-v') {
      flags.version = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const separatorIndex = body.indexOf('=');
      if (separatorIndex >= 0) {
        flags[body.slice(0, separatorIndex)] = body.slice(separatorIndex + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        index += 1;
        continue;
      }
      flags[body] = true;
      continue;
    }
    if (command.length === 0) command = token;
    else positionals.push(token);
  }

  return { command, positionals, flags };
}

/** Read a value flag (returns `undefined` when absent or given as a bare boolean flag) */
export function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Read a boolean flag */
export function flagBoolean(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export const USAGE_TEXT = [
  'rtdbctl - ss-rtdb management CLI',
  '',
  'Usage: rtdbctl <command> [arguments] [options]',
  '',
  'Commands:',
  '  serve [--config <path>]                 Start the server in the foreground',
  '  status [--json]                         Print the status report',
  '  backup <db> <dir>                       Back up a database to <dir>/<db>',
  '  restore <db> <dir>                      Restore a database from <dir>/<db>',
  '  restore <db> --archive <yyyyMMdd>       Restore one archived day into the data root',
  '  archive <db> [<yyyyMMdd>]               Archive a day (no date: list the existing archives)',
  '  retention <db> [days]                   Print (no days) or set the retention policy',
  '  metrics <db> [--prefix <text>]          List metric summaries',
  '  size <db> [--by-day]                    Report the on-disk size of a database',
  '  repair <db> [<date>]                    Rebuild indexes / truncate corrupt block tails',
  '  user add <name> --password <pw> [--role <role>] [--disabled]  Create a user',
  '  user list                               List users',
  '  user remove <name>                      Remove a user',
  '  user passwd <name> --password <pw>      Change a user password',
  '  token issue <user> [--role <role>] [--label <text>] [--ttl <ms>]  Issue an API token',
  '  token list                              List API tokens',
  '  token revoke <tokenId>                  Revoke an API token',
  '',
  'Options:',
  '  --config <path>     rtdb.config.json path (also RTDB_CONFIG)',
  '  --data-dir <path>   Local data root for offline commands (also RTDB_DATA_DIR)',
  '  --url <baseUrl>     Server base URL for remote commands (also RTDB_URL)',
  '  --token <token>     Access token (also RTDB_TOKEN)',
  '  --timeout <ms>      Per-request timeout for remote commands',
  '  --role <role>       User / token role: admin | write | readonly',
  '  --password <pw>     User password (user add / user passwd)',
  '  --label <text>      Token label (token issue)',
  '  --ttl <ms>          Token time to live in ms (token issue; omit for no expiry)',
  '  --disabled          Create the user in a disabled state (user add)',
  '  --json              Emit machine-readable JSON',
  '  --by-day            Include the per-day detail (size)',
  '  -h, --help          Show this help',
  '  -v, --version       Show the CLI version',
  '',
  'Offline commands (size / repair / restore / archive / "retention" without days) read the local',
  'data root directly and must not run while a server holds the data root lock.',
].join('\n');
