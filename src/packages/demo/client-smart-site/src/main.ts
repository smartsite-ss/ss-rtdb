// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Smart Site demo client: streams Smart Site shaped real-time data into rtdb-server.
 *
 * Run it from the workspace root (`src/`):
 *   node packages/demo/client-smart-site/src/main.ts --once --verify
 *   node packages/demo/client-smart-site/src/main.ts --interval 1000 --duration 60 --verify
 *   node packages/demo/client-smart-site/src/main.ts --dry-run     # print one batch, send nothing
 *   node packages/demo/client-smart-site/src/main.ts --list        # print the device/tag catalog
 *
 * Performance runs (`--points-per-tick` / `--rate` / `--total-points`) decouple the batch size from the
 * 44-tag catalog so a single client can saturate the write path:
 *   node packages/demo/client-smart-site/src/main.ts --rate 20000 --duration 30
 *   node packages/demo/client-smart-site/src/main.ts --points-per-tick 5000 --total-points 100000
 *
 * Defaults (server URL, token file, database, generation parameters) come from
 * `packages/demo/conf/client-smart-site.json`; command-line arguments always win, and
 * `--no-config` skips the file entirely.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { DEMO_DATABASE } from './catalog.ts';
import { DEFAULT_DEMO_CLIENT_CONFIG_PATH, applyDemoClientConfig, readDemoClientConfig } from './config.ts';
import {
  DemoHttpError,
  DemoRtdbClient,
  decodeWirePoint,
  decodeWireWindowValue,
  encodeWritePoint,
} from './client.ts';
import type { WireWindow } from './client.ts';
import { SmartSiteSimulator } from './generator.ts';
import type { MetricDescriptor, SimulatedPoint } from './generator.ts';
import type { DemoValueType } from './catalog.ts';

const DEFAULT_URL = 'http://127.0.0.1:6180';
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LOG_EVERY = 5;
const MIN_INTERVAL_MS = 100;
const MAX_CONSECUTIVE_FAILURES = 5;

interface CliOptions {
  url: string;
  token: string;
  tokenFile: string;
  /** True only when `--token-file` was passed on the command line (a missing file is then an error) */
  tokenFileRequired: boolean;
  database: string;
  intervalMs: number;
  durationMs: number;
  /** Samples per tick (0 = one sample per metric), for performance runs */
  pointsPerTick: number;
  /** Target points per second (0 = disabled; mutually exclusive with `pointsPerTick`) */
  rate: number;
  /** Stop after this many points have been sent (0 = unlimited) */
  totalPoints: number;
  seed: number;
  devices: string[];
  glitchProbability: number;
  verify: boolean;
  dryRun: boolean;
  list: boolean;
  once: boolean;
  logEvery: number;
  timeoutMs: number;
  help: boolean;
  /** Loaded config file path (`''` = built-in defaults only) */
  configPath: string;
}

interface ConfigSelection {
  filePath: string | null;
  required: boolean;
}

/** Pre-scan `--config` / `--no-config` so the file is loaded before the remaining arguments */
function findConfigSelection(argv: readonly string[]): ConfigSelection {
  let filePath: string | null = DEFAULT_DEMO_CLIENT_CONFIG_PATH;
  let required = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--no-config') {
      filePath = null;
      required = false;
      continue;
    }
    if (argument === '--config') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('Option --config needs a value');
      filePath = resolve(value);
      required = true;
      index += 1;
      continue;
    }
    if (argument.startsWith('--config=')) {
      const value = argument.slice('--config='.length);
      if (value.length === 0) throw new Error('Option --config needs a value');
      filePath = resolve(value);
      required = true;
    }
  }
  return { filePath, required };
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    url: DEFAULT_URL,
    token: '',
    tokenFile: '',
    tokenFileRequired: false,
    database: DEMO_DATABASE,
    intervalMs: DEFAULT_INTERVAL_MS,
    durationMs: 0,
    pointsPerTick: 0,
    rate: 0,
    totalPoints: 0,
    seed: 20261017,
    devices: [],
    glitchProbability: 0,
    verify: false,
    dryRun: false,
    list: false,
    once: false,
    logEvery: DEFAULT_LOG_EVERY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
    configPath: '',
  };

  // Precedence: built-in defaults < config file < command-line arguments
  const selection = findConfigSelection(argv);
  if (selection.filePath !== null) {
    if (existsSync(selection.filePath)) {
      applyDemoClientConfig(options, readDemoClientConfig(selection.filePath));
      options.configPath = selection.filePath;
    } else if (selection.required) {
      throw new Error(`Config file not found: ${selection.filePath}`);
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);

    const equals = argument.indexOf('=');
    const name = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const inline = equals >= 0 ? argument.slice(equals + 1) : undefined;
    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`Option --${name} needs a value`);
      index += 1;
      return next;
    };

    switch (name) {
      case 'config':
        // Already consumed by findConfigSelection()
        takeValue();
        break;
      case 'no-config':
        // Already consumed by findConfigSelection()
        break;
      case 'url':
        options.url = takeValue();
        break;
      case 'token':
        options.token = takeValue();
        break;
      case 'token-file':
        options.tokenFile = takeValue();
        options.tokenFileRequired = true;
        break;
      case 'db':
        options.database = takeValue();
        break;
      case 'interval':
        options.intervalMs = readInteger(takeValue(), 'interval', MIN_INTERVAL_MS);
        break;
      case 'duration':
        options.durationMs = readFloat(takeValue(), 'duration', 0) * 1000;
        break;
      case 'points-per-tick':
        options.pointsPerTick = readInteger(takeValue(), 'points-per-tick', 1);
        break;
      case 'rate':
        options.rate = readFloat(takeValue(), 'rate', 1);
        break;
      case 'total-points':
        options.totalPoints = readInteger(takeValue(), 'total-points', 1);
        break;
      case 'seed':
        options.seed = readInteger(takeValue(), 'seed', 0);
        break;
      case 'devices':
        options.devices = takeValue()
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        break;
      case 'glitch-rate':
        options.glitchProbability = readFloat(takeValue(), 'glitch-rate', 0, 1);
        break;
      case 'verify':
        options.verify = true;
        break;
      case 'dry-run':
        options.dryRun = true;
        break;
      case 'list':
        options.list = true;
        break;
      case 'once':
        options.once = true;
        break;
      case 'log-every':
        options.logEvery = readInteger(takeValue(), 'log-every', 1);
        break;
      case 'timeout':
        options.timeoutMs = readInteger(takeValue(), 'timeout', 100);
        break;
      case 'help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: --${name}`);
    }
  }

  if (!/^https?:\/\//.test(options.url)) throw new Error(`--url must start with http:// or https://: ${options.url}`);
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(options.database)) {
    throw new Error(`--db must match ^[a-zA-Z][a-zA-Z0-9_]{0,62}$: ${options.database}`);
  }
  return options;
}

function readInteger(raw: string, name: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}: ${raw}`);
  return value;
}

function readFloat(raw: string, name: string, min: number, max = Number.POSITIVE_INFINITY): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${name} must be a number in [${min}, ${max}]: ${raw}`);
  }
  return value;
}

/** Resolved batch shape: how many samples one tick carries */
interface BatchPlan {
  /** Samples per tick; 0 = native mode (one sample per metric) */
  pointsPerTick: number;
  /** Human readable origin of the plan (printed in the startup header) */
  source: string;
}

/**
 * Turn `--points-per-tick` / `--rate` into a concrete batch size.
 *
 * Both options target the same knob, so passing both is an error instead of a silent precedence.
 * The batch size is capped by the catalog: a metric cannot hold two points with the same millisecond
 * timestamp (the write path drops the later one as a duplicate), so a tick of `intervalMs` milliseconds
 * can carry at most `metricCount * intervalMs` samples.
 */
function resolveBatchPlan(options: CliOptions, metricCount: number): BatchPlan {
  if (options.rate > 0 && options.pointsPerTick > 0) {
    throw new Error('--rate and --points-per-tick are mutually exclusive; pass only one of them');
  }
  if (options.rate <= 0 && options.pointsPerTick <= 0) {
    return { pointsPerTick: 0, source: 'one sample per metric' };
  }

  const pointsPerTick =
    options.rate > 0
      ? Math.max(1, Math.round((options.rate * options.intervalMs) / 1000))
      : options.pointsPerTick;
  const source = options.rate > 0 ? `--rate ${options.rate}` : '--points-per-tick';

  const capacity = metricCount * options.intervalMs;
  if (pointsPerTick > capacity) {
    throw new Error(
      `${pointsPerTick} points per ${options.intervalMs} ms batch exceed the catalog capacity ` +
        `(${metricCount} metrics x ${options.intervalMs} ms = ${capacity} distinct (metric, timestamp) pairs); ` +
        'raise --interval, lower the point count, or widen --devices',
    );
  }
  return { pointsPerTick, source };
}

function printUsage(): void {
  console.log(
    [
      'Smart Site demo client — stream Smart Site shaped real-time data into rtdb-server.',
      '',
      'Usage: node packages/demo/client-smart-site/src/main.ts [options]',
      '',
      'Options:',
      `  --url <url>            rtdb-server base URL (default ${DEFAULT_URL})`,
      '  --config <path>        Demo config file (default packages/demo/conf/client-smart-site.json)',
      '  --no-config            Ignore the demo config file and use built-in defaults',
      '  --token <token>        Bearer token (default: RTDB_TOKEN, then rtdb.token)',
      '  --token-file <path>    Explicit token file (read when --token is absent)',
      `  --db <name>            Target database (default ${DEMO_DATABASE})`,
      `  --interval <ms>        Write frequency: one tick per N ms (default ${DEFAULT_INTERVAL_MS}, min ${MIN_INTERVAL_MS})`,
      '  --duration <seconds>   Stop after N seconds (default 0 = until Ctrl+C)',
      '  --points-per-tick <n>  Points written per tick (default 0 = one sample per metric)',
      '  --rate <points/s>      Target write rate; derives the points per tick from --interval',
      '  --total-points <n>     Stop after N written points (default 0 = unlimited)',
      '  --once                 Write exactly one batch and exit',
      '  --seed <int>           RNG seed (default 20261017)',
      '  --devices <list>       Comma-separated device codes (default: all)',
      '  --glitch-rate <0..1>   Per-tick probability of a simulated comm fault (default 0)',
      '  --verify               Query last / count / aggregate after the run',
      '  --dry-run              Print one batch in wire format without sending it',
      '  --list                 Print the device/tag catalog and exit',
      `  --log-every <n>        Progress line every n ticks (default ${DEFAULT_LOG_EVERY})`,
      `  --timeout <ms>         HTTP timeout (default ${DEFAULT_TIMEOUT_MS})`,
      '  --help                 Show this help',
      '',
      'Examples:',
      '  node packages/demo/client-smart-site/src/main.ts --once --verify',
      '  node packages/demo/client-smart-site/src/main.ts --duration 60 --verify',
      '  node packages/demo/client-smart-site/src/main.ts --devices hvac-chiller,sewage-in --interval 500',
      '  node packages/demo/client-smart-site/src/main.ts --rate 20000 --duration 30',
      '  node packages/demo/client-smart-site/src/main.ts --points-per-tick 5000 --total-points 100000',
    ].join('\n'),
  );
}

interface TokenResolution {
  token: string;
  source: string;
}

function resolveToken(options: CliOptions): TokenResolution {
  if (options.token.length > 0) {
    // `--token` carries the token value, not a path. A mistaken `--token rtdb.token` would win over
    // the (correct) tokenFile from the config and fail every write with 401 E_AUTH.
    if (looksLikeTokenFile(options.token)) {
      console.error(
        `[WARN] --token receives the token value, not a file path ("${options.token.trim()}"); ` +
          'use --token-file <path> instead. Sending the value as-is.',
      );
    }
    return { token: options.token.trim(), source: '--token' };
  }
  const fromEnv = (process.env.RTDB_TOKEN ?? '').trim();
  if (fromEnv.length > 0) return { token: fromEnv, source: 'RTDB_TOKEN' };

  const candidates: string[] = [];
  if (options.tokenFile.length > 0) candidates.push(resolve(options.tokenFile));
  candidates.push(resolve(process.cwd(), 'rtdb.token'));
  const executableDirectory = dirname(process.execPath);
  if (executableDirectory.length > 0) candidates.push(resolve(executableDirectory, 'rtdb.token'));

  for (const candidate of candidates) {
    try {
      const token = readFileSync(candidate, 'utf8').trim();
      if (token.length > 0) return { token, source: candidate };
    } catch {
      // Try the next candidate; a missing implicit token file simply means "anonymous".
    }
  }
  if (options.tokenFileRequired) {
    throw new Error(`Cannot read the token file: ${resolve(options.tokenFile)}`);
  }
  return { token: '', source: 'anonymous' };
}

/** Heuristic for the `--token rtdb.token` mistake: a path separator or a `.token` suffix */
function looksLikeTokenFile(value: string): boolean {
  const trimmed = value.trim();
  return /[\\/]/.test(trimmed) || trimmed.toLowerCase().endsWith('.token');
}

function printCatalog(descriptors: readonly MetricDescriptor[]): void {
  const header = ['device', 'metric', 'smart-site', 'rtdb', 'unit', 'name'];
  const rows = descriptors.map((descriptor) => [
    descriptor.deviceCode,
    descriptor.metricName,
    descriptor.dataType,
    descriptor.type,
    descriptor.unit === undefined || descriptor.unit.length === 0 ? '-' : descriptor.unit,
    descriptor.name,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join('  ').trimEnd();

  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
  const devices = new Set(descriptors.map((descriptor) => descriptor.deviceCode));
  console.log('');
  console.log(`Total: ${devices.size} devices, ${descriptors.length} metrics`);
}

function describeValueType(value: number | bigint | boolean | string): DemoValueType {
  if (typeof value === 'bigint') return 'i64';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'string';
  return 'f64';
}

function formatValue(value: number | bigint | boolean | string): string {
  if (typeof value === 'number') return Number.isInteger(value) ? value.toFixed(0) : value.toString();
  return String(value);
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[position] ?? 0;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function printDryRun(options: CliOptions, points: readonly SimulatedPoint[]): void {
  console.log(`POST ${options.url}/api/v1/write?db=${options.database}`);
  console.log('Content-Type: application/json');
  console.log('');
  console.log(JSON.stringify(points.map(encodeWritePoint), null, 2));
  console.log('');
  console.log(`(${points.length} points; i64 values travel as decimal strings with "vt": 2)`);
}

async function verify(
  client: DemoRtdbClient,
  simulator: SmartSiteSimulator,
  database: string,
  from: number,
  to: number,
  intervalMs: number,
): Promise<boolean> {
  console.log('');
  console.log('Verification');
  let ok = true;

  for (const descriptor of simulator.representatives()) {
    try {
      const last = await client.queryLast(database, descriptor.metricName);
      if (last === null) {
        console.error(`  FAIL  ${descriptor.metricName}  no point returned by query/last`);
        ok = false;
        continue;
      }
      const decoded = decodeWirePoint(last);
      const count = await client.queryCount(database, descriptor.metricName, from, to, true);
      const type = describeValueType(decoded.value);
      const typeOk = type === descriptor.type;
      const countOk = count > 0;
      if (!typeOk || !countOk) ok = false;
      const quality = decoded.quality === undefined ? 'good' : `q=${decoded.quality}`;
      console.log(
        `  ${typeOk && countOk ? 'PASS' : 'FAIL'}  ${descriptor.metricName}  type=${type}  count=${count}  ` +
          `last=${formatValue(decoded.value)}  ${quality}`,
      );
    } catch (error) {
      ok = false;
      console.error(`  FAIL  ${descriptor.metricName}  ${describeError(error)}`);
    }
  }

  const first = simulator.representatives()[0];
  if (first !== undefined && first.type === 'f64') {
    try {
      const windows: WireWindow[] = await client.queryAggregate(
        database,
        first.metricName,
        from,
        to,
        Math.max(intervalMs, 1000),
        'avg',
      );
      const firstWindow = windows[0];
      const value = firstWindow === undefined ? 'n/a' : formatValue(decodeWireWindowValue(firstWindow));
      console.log(`  ${windows.length > 0 ? 'PASS' : 'FAIL'}  aggregate/avg ${first.metricName}  windows=${windows.length}  first=${value}`);
      if (windows.length === 0) ok = false;
    } catch (error) {
      ok = false;
      console.error(`  FAIL  aggregate ${first.metricName}  ${describeError(error)}`);
    }
  }

  try {
    const metrics = await client.listMetrics(database);
    const names = new Set(metrics.map((metric) => metric.metricName));
    const missing = simulator.metricNames.filter((metricName) => !names.has(metricName));
    if (missing.length > 0) ok = false;
    console.log(
      `  ${missing.length === 0 ? 'PASS' : 'FAIL'}  database ${database}: ${metrics.length} metrics` +
        (missing.length === 0 ? '' : ` (missing ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''})`),
    );
  } catch (error) {
    ok = false;
    console.error(`  FAIL  listMetrics ${describeError(error)}`);
  }

  return ok;
}

function describeError(error: unknown): string {
  if (error instanceof DemoHttpError) {
    return `[${error.status}/${error.code}] ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function authHint(): string {
  return (
    'Hint: pass --token <token> (the value, not a file path), set RTDB_TOKEN, or point --token-file at ' +
    "the server's rtdb.token; --token wins over the config tokenFile."
  );
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return 0;
  }

  const simulator = new SmartSiteSimulator({
    seed: options.seed,
    glitchProbability: options.glitchProbability,
    deviceCodes: options.devices,
  });

  if (options.list) {
    printCatalog(simulator.describe());
    return 0;
  }

  const batchPlan = resolveBatchPlan(options, simulator.metricCount);

  const resolution = resolveToken(options);
  const client = new DemoRtdbClient({
    baseUrl: options.url,
    token: resolution.token,
    timeoutMs: options.timeoutMs,
  });

  console.log('Smart Site demo client');
  console.log(`  server    : ${options.url}`);
  console.log(`  database  : ${options.database}`);
  console.log(
    `  catalog   : ${simulator.deviceCount} devices / ${simulator.metricCount} metrics ` +
      `(seed=${options.seed}, glitch=${options.glitchProbability})`,
  );
  console.log(
    `  sampling  : ${options.intervalMs} ms` +
      (options.durationMs > 0 ? `, duration ${(options.durationMs / 1000).toFixed(0)} s` : ', until Ctrl+C'),
  );
  console.log(
    `  batch     : ${batchPlan.pointsPerTick > 0 ? `${batchPlan.pointsPerTick} pts/tick` : `${simulator.metricCount} pts/tick`}` +
      ` (${batchPlan.source}` +
      (batchPlan.pointsPerTick > 0
        ? `, ~${Math.round((batchPlan.pointsPerTick / options.intervalMs) * 1000)} pts/s`
        : '') +
      ')' +
      (options.totalPoints > 0 ? `, stop after ${options.totalPoints} pts` : ''),
  );
  console.log(`  config    : ${options.configPath.length > 0 ? options.configPath : 'none (built-in defaults)'}`);
  console.log(`  auth      : ${resolution.source}`);

  if (options.dryRun) {
    const points =
      batchPlan.pointsPerTick > 0
        ? simulator.tickBatch(Date.now(), options.intervalMs, batchPlan.pointsPerTick)
        : simulator.tick(Date.now());
    printDryRun(options, points);
    return 0;
  }

  try {
    const status = await client.status();
    const uptime = typeof status.uptimeMs === 'number' ? `${(status.uptimeMs / 1000).toFixed(0)} s` : 'n/a';
    const databases = typeof status.databases === 'number' ? status.databases : 'n/a';
    console.log(`  server up : uptime ${uptime}, databases ${databases}`);
  } catch (error) {
    console.error(`[ERROR] ${describeError(error)}`);
    console.error('Hint: start rtdb-server first (bin\\build-sea.bat or bin\\start-server.bat), then retry.');
    return 3;
  }

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const startedAt = Date.now();
  const deadline = options.durationMs > 0 ? startedAt + options.durationMs : null;
  const latencies: number[] = [];
  let tickCount = 0;
  let pointsTotal = 0;
  let acceptedTotal = 0;
  let duplicatesTotal = 0;
  let faultyTotal = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let lastTimestamp = startedAt;
  /** Remaining points allowed by `--total-points` (`Infinity` when unlimited) */
  let remainingPoints = options.totalPoints > 0 ? options.totalPoints : Number.POSITIVE_INFINITY;

  while (!stopping) {
    const timestamp = Date.now();
    // A tick covers the previous interval: multiple samples per metric are spread over that window so
    // their timestamps stay distinct (the write path drops repeated `(metric, timestamp)` pairs).
    const batchSize = batchPlan.pointsPerTick > 0 ? batchPlan.pointsPerTick : simulator.metricCount;
    const wanted = Math.min(batchSize, remainingPoints);
    const generated =
      batchPlan.pointsPerTick > 0
        ? simulator.tickBatch(timestamp, options.intervalMs, wanted)
        : simulator.tick(timestamp);
    const points = generated.length > remainingPoints ? generated.slice(0, remainingPoints) : generated;
    const began = performance.now();
    try {
      const result = await client.writeBatch(options.database, points);
      latencies.push(performance.now() - began);
      acceptedTotal += result.accepted;
      duplicatesTotal += result.duplicates;
      remainingPoints -= points.length;
      consecutiveFailures = 0;
    } catch (error) {
      failures += 1;
      consecutiveFailures += 1;
      console.error(`[WARN] write failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${describeError(error)}`);
      if (error instanceof DemoHttpError && error.status === 401) console.error(authHint());
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[ERROR] giving up after repeated write failures.');
        return 3;
      }
    }

    tickCount += 1;
    pointsTotal += points.length;
    faultyTotal += points.reduce((total, point) => (point.stale === true ? total + 1 : total), 0);
    lastTimestamp = timestamp;

    if (options.logEvery > 0 && tickCount % options.logEvery === 0) {
      const sorted = [...latencies].sort((left, right) => left - right);
      const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      console.log(
        `[t=${((timestamp - startedAt) / 1000).toFixed(0)}s] tick ${tickCount} · ${points.length} pts ` +
          `(accepted ${acceptedTotal}, dup ${duplicatesTotal}) · ` +
          `${(acceptedTotal / elapsedSeconds).toFixed(0)} pts/s · ` +
          `p50 ${percentile(sorted, 0.5).toFixed(1)} ms · p95 ${percentile(sorted, 0.95).toFixed(1)} ms · ` +
          `stale ${faultyTotal}`,
      );
    }

    if (options.once) break;
    if (remainingPoints <= 0) break;
    if (deadline !== null && Date.now() >= deadline) break;

    const nextAt = startedAt + tickCount * options.intervalMs;
    const waitMs = nextAt - Date.now();
    if (waitMs > 0) await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, waitMs));
  }

  const elapsedMs = Math.max(1, Date.now() - startedAt);
  const sortedLatencies = [...latencies].sort((left, right) => left - right);
  console.log('');
  console.log('Summary');
  console.log(`  ticks        ${tickCount}`);
  console.log(
    `  points       ${pointsTotal} generated, ${acceptedTotal} accepted, ${duplicatesTotal} duplicates, ` +
      `${faultyTotal} stale, ${failures} failed batches`,
  );
  if (sortedLatencies.length > 0) {
    console.log(
      `  latency      avg ${average(sortedLatencies).toFixed(1)} ms, ` +
        `p50 ${percentile(sortedLatencies, 0.5).toFixed(1)} ms, ` +
        `p95 ${percentile(sortedLatencies, 0.95).toFixed(1)} ms, ` +
        `p99 ${percentile(sortedLatencies, 0.99).toFixed(1)} ms, ` +
        `max ${(sortedLatencies[sortedLatencies.length - 1] ?? 0).toFixed(1)} ms`,
    );
  }
  if (tickCount > 1) {
    const targetRate = batchPlan.pointsPerTick > 0 ? (batchPlan.pointsPerTick / options.intervalMs) * 1000 : 0;
    console.log(
      `  throughput   ${((acceptedTotal / elapsedMs) * 1000).toFixed(1)} points/s over ${(elapsedMs / 1000).toFixed(1)} s` +
        (targetRate > 0 ? ` (target ${targetRate.toFixed(0)} points/s)` : ''),
    );
  }

  if (options.verify) {
    if (tickCount === 0) {
      console.error('[WARN] nothing was written, skipping verification.');
      return 0;
    }
    const verified = await verify(
      client,
      simulator,
      options.database,
      startedAt - 1,
      lastTimestamp + 1,
      options.intervalMs,
    );
    return verified ? 0 : 2;
  }

  return 0;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[ERROR] ${describeError(error)}`);
    console.error('Run with --help to see the available options.');
    process.exitCode = 1;
  });
