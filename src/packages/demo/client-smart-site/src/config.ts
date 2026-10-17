// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Shared demo configuration under `packages/demo/conf/`.
 *
 * The Smart Site demo client reads `client-smart-site.json` from that directory by default so the
 * server URL, token file, database and generation defaults live in exactly one place. Precedence:
 * built-in defaults < config file < command-line arguments. Paths inside the file are resolved
 * against the process working directory, which is the repository `src/` directory when the client
 * is started through `bin\demo-smart-site.bat` (or `npm run demo:smart-site`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Fields accepted in `packages/demo/conf/client-smart-site.json` (all optional) */
export interface DemoClientConfig {
  url?: string;
  database?: string;
  tokenFile?: string;
  intervalMs?: number;
  seed?: number;
  devices?: string[];
  glitchProbability?: number;
  logEvery?: number;
  timeoutMs?: number;
}

/** Mutable option subset the config is applied to (structurally satisfied by the CLI options) */
export interface DemoClientConfigTarget {
  url: string;
  database: string;
  tokenFile: string;
  intervalMs: number;
  seed: number;
  devices: string[];
  glitchProbability: number;
  logEvery: number;
  timeoutMs: number;
}

/** Default config path: `<repo>/src/packages/demo/conf/client-smart-site.json` */
export const DEFAULT_DEMO_CLIENT_CONFIG_PATH = fileURLToPath(
  new URL('../../conf/client-smart-site.json', import.meta.url),
);

const KNOWN_KEYS = new Set<string>([
  'url',
  'database',
  'tokenFile',
  'intervalMs',
  'seed',
  'devices',
  'glitchProbability',
  'logEvery',
  'timeoutMs',
]);

const DATABASE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;

/** Read and strictly validate a demo config file (unknown keys and wrong types are errors) */
export function readDemoClientConfig(filePath: string): DemoClientConfig {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read demo config ${filePath}: ${describeError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse demo config ${filePath}: ${describeError(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Demo config ${filePath} must contain a JSON object at the root`);
  }

  const source = parsed as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) throw invalid(filePath, `unknown key "${key}"`);
  }

  const config: DemoClientConfig = {};
  if (source.url !== undefined) {
    const url = requireString(filePath, 'url', source.url);
    if (!/^https?:\/\//.test(url)) throw invalid(filePath, '"url" must start with http:// or https://');
    config.url = url;
  }
  if (source.database !== undefined) {
    const database = requireString(filePath, 'database', source.database);
    if (!DATABASE_PATTERN.test(database)) {
      throw invalid(filePath, `"database" must match ${DATABASE_PATTERN.source}`);
    }
    config.database = database;
  }
  if (source.tokenFile !== undefined) {
    config.tokenFile = requireString(filePath, 'tokenFile', source.tokenFile);
  }
  if (source.intervalMs !== undefined) {
    config.intervalMs = requireInteger(filePath, 'intervalMs', source.intervalMs, 100);
  }
  if (source.seed !== undefined) {
    config.seed = requireInteger(filePath, 'seed', source.seed, 0);
  }
  if (source.devices !== undefined) {
    if (!Array.isArray(source.devices)) throw invalid(filePath, '"devices" must be an array of device codes');
    const devices = source.devices.map((item, index) => {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw invalid(filePath, `"devices[${index}]" must be a non-empty string`);
      }
      return item.trim();
    });
    config.devices = devices;
  }
  if (source.glitchProbability !== undefined) {
    const probability = source.glitchProbability;
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw invalid(filePath, '"glitchProbability" must be a number in [0, 1]');
    }
    config.glitchProbability = probability;
  }
  if (source.logEvery !== undefined) {
    config.logEvery = requireInteger(filePath, 'logEvery', source.logEvery, 1);
  }
  if (source.timeoutMs !== undefined) {
    config.timeoutMs = requireInteger(filePath, 'timeoutMs', source.timeoutMs, 100);
  }
  return config;
}

/** Apply config values onto mutable options; command-line parsing runs afterwards and wins */
export function applyDemoClientConfig(target: DemoClientConfigTarget, config: DemoClientConfig): void {
  if (config.url !== undefined) target.url = config.url;
  if (config.database !== undefined) target.database = config.database;
  if (config.tokenFile !== undefined) target.tokenFile = config.tokenFile;
  if (config.intervalMs !== undefined) target.intervalMs = config.intervalMs;
  if (config.seed !== undefined) target.seed = config.seed;
  if (config.devices !== undefined) target.devices = [...config.devices];
  if (config.glitchProbability !== undefined) target.glitchProbability = config.glitchProbability;
  if (config.logEvery !== undefined) target.logEvery = config.logEvery;
  if (config.timeoutMs !== undefined) target.timeoutMs = config.timeoutMs;
}

function requireString(filePath: string, key: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(filePath, `"${key}" must be a non-empty string`);
  }
  return value.trim();
}

function requireInteger(filePath: string, key: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalid(filePath, `"${key}" must be an integer >= ${min}`);
  }
  return value;
}

function invalid(filePath: string, message: string): Error {
  return new Error(`Invalid demo config ${filePath}: ${message}`);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
