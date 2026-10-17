// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * rtdb-server configuration loading and validation (aligns with "Detailed Design v2.0" §6.1 ~ §6.5)
 *
 * Precedence (low → high): built-in defaults < config file < environment variables < explicit arguments (CLI / SDK direct pass).
 * Out-of-range numbers are clamped by core `clampEngineOption` at engine construction time (+WARN); only "semantic conflicts" startup-time validation is handled here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ERROR_CODE, RtdbError } from '../../core/src/errors.ts';
import type { EngineOptions } from '../../core/src/types.ts';
import { isAuthMode } from './auth.ts';
import type { AuthMode } from './auth.ts';
import { isLogLevel } from './logger.ts';
import type { LogLevel } from './logger.ts';

/* ---------- Types ---------- */

export interface AuthConfig {
  enabled: boolean;
  mode: AuthMode;
  token: string;
  tokenFile: string;
  username: string;
  password: string;
  passwordHash: string;
  /**
   * Bootstrap administrator created at startup **only when the user directory is empty** (first start), so a
   * fresh instance can be signed into with a user name + password; an empty value disables the bootstrap.
   */
  bootstrapUsername: string;
  /** Password of the bootstrap administrator (hashed on creation, never stored in plaintext); empty disables it */
  bootstrapPassword: string;
  write: boolean;
  query: boolean;
  /** Multi-user directory JSON path; empty = `{dataDir}/rtdb-users.json` (§3.2) */
  usersFile: string;
  /** API token directory JSON path; empty = `{dataDir}/rtdb-tokens.json` (§3.2) */
  tokensFile: string;
}

export interface AdminConfig {
  enabled: boolean;
  /** Empty = bundled `packages/admin/dist` */
  staticDir: string;
  /**
   * Expose absolute server paths (`directory`) in `GET /api/v1/databases/{db}`.
   *
   * On for the default single-tenant deployment (the field is what makes the console usable for locating
   * data); turn it off when the API is exposed to users who must not learn the server layout — the endpoint
   * then reports `{dataDir}/{db}` instead of the resolved absolute path.
   */
  exposePaths: boolean;
}

export interface CorsConfig {
  /**
   * Origins allowed to call the REST API from another origin (the standalone rtdb-admin form).
   * `*` allows any origin; an empty list disables CORS entirely (the default).
   */
  allowedOrigins: string[];
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  retentionDays: number;
  archiveDir: string;
  archiveBeforeDelete: boolean;
  auth: AuthConfig;
  admin: AdminConfig;
  cors: CorsConfig;
  write: {
    walEnabled: boolean;
    fsyncPolicy: 'wal' | 'none';
    blockTargetPoints: number;
    blockMinPoints: number;
    flushIntervalMs: number;
    maxBufferBytes: number;
    maxPendingPoints: number;
    /** Single-batch point cap (exceeding gives 413 `E_BATCH_TOO_LARGE`, §6.2.3) */
    maxBatch: number;
  };
  storage: {
    segment: {
      maxBytes: number;
      maxPerDay: number;
    };
  };
  cache: {
    blocks: number;
    fdGroups: number;
  };
  query: {
    defaultLimit: number;
  };
  /** HTTP request body cap (bytes); exceeding gives 413 `E_BATCH_TOO_LARGE` */
  http: {
    maxBodyBytes: number;
  };
  log: {
    level: LogLevel;
  };
}

export type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends object ? DeepPartial<T[Key]> : T[Key];
};

export type PartialServerConfig = DeepPartial<ServerConfig>;

/* ---------- Defaults (item-by-item consistent with the §6.1 example) ---------- */

export const SERVER_CONFIG_DEFAULTS: ServerConfig = {
  port: 6180,
  host: '127.0.0.1',
  dataDir: './rtdb-data',
  retentionDays: 0,
  archiveDir: '',
  archiveBeforeDelete: false,
  auth: {
    enabled: true,
    mode: 'token',
    token: '',
    tokenFile: './rtdb.token',
    username: 'admin',
    password: '',
    passwordHash: '',
    bootstrapUsername: 'admin',
    bootstrapPassword: 'ss-rtdb',
    write: true,
    query: true,
    usersFile: '',
    tokensFile: '',
  },
  admin: { enabled: true, staticDir: '', exposePaths: true },
  cors: { allowedOrigins: [] },
  write: {
    walEnabled: true,
    fsyncPolicy: 'wal',
    blockTargetPoints: 16_384,
    blockMinPoints: 1_024,
    flushIntervalMs: 5_000,
    maxBufferBytes: 268_435_456,
    maxPendingPoints: 2_000_000,
    maxBatch: 1_000_000,
  },
  storage: { segment: { maxBytes: 209_715_200, maxPerDay: 1_000 } },
  cache: { blocks: 256, fdGroups: 32 },
  query: { defaultLimit: 100_000 },
  http: { maxBodyBytes: 67_108_864 },
  log: { level: 'info' },
};

/* ---------- Loading ---------- */

export interface LoadServerConfigOptions {
  configFilePath?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: PartialServerConfig;
}

export function loadServerConfig(options: LoadServerConfigOptions = {}): ServerConfig {
  const env = options.env ?? process.env;
  const raw = structuredClone(SERVER_CONFIG_DEFAULTS) as unknown as JsonObject;

  const configFilePath = options.configFilePath ?? env.RTDB_CONFIG;
  if (configFilePath !== undefined && configFilePath.length > 0) {
    mergeDeep(raw, readConfigFile(configFilePath));
  }
  applyEnvironment(raw, env);
  if (options.overrides !== undefined) mergeDeep(raw, options.overrides as unknown as JsonObject);

  return normalizeServerConfig(raw);
}

function readConfigFile(filePath: string): JsonObject {
  const absolutePath = resolve(filePath);
  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new RtdbError(ERROR_CODE.Io, `Failed to read config file: ${absolutePath} (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new RtdbError(ERROR_CODE.Internal, `Failed to parse config file: ${absolutePath} (${(error as Error).message})`);
  }
  if (!isPlainObject(parsed)) {
    throw new RtdbError(ERROR_CODE.Internal, `Config file root node must be an object: ${absolutePath}`);
  }
  return parsed;
}

function applyEnvironment(raw: JsonObject, env: NodeJS.ProcessEnv): void {
  setNumberAt(raw, ['port'], env.RTDB_PORT);
  setStringAt(raw, ['host'], env.RTDB_HOST);
  setStringAt(raw, ['dataDir'], env.RTDB_DATA_DIR);
  setNumberAt(raw, ['retentionDays'], env.RTDB_RETENTION_DAYS);
  setBooleanAt(raw, ['auth', 'enabled'], env.RTDB_AUTH_ENABLED);
  setStringAt(raw, ['auth', 'token'], env.RTDB_TOKEN);
  setStringAt(raw, ['auth', 'username'], env.RTDB_AUTH_USERNAME);
  setStringAt(raw, ['auth', 'password'], env.RTDB_AUTH_PASSWORD);
  setStringAt(raw, ['auth', 'bootstrapUsername'], env.RTDB_AUTH_BOOTSTRAP_USERNAME);
  setStringAt(raw, ['auth', 'bootstrapPassword'], env.RTDB_AUTH_BOOTSTRAP_PASSWORD);
  setStringAt(raw, ['auth', 'usersFile'], env.RTDB_AUTH_USERS_FILE);
  setStringAt(raw, ['auth', 'tokensFile'], env.RTDB_AUTH_TOKENS_FILE);
  setBooleanAt(raw, ['admin', 'enabled'], env.RTDB_ADMIN_ENABLED);
  setBooleanAt(raw, ['admin', 'exposePaths'], env.RTDB_ADMIN_EXPOSE_PATHS);
  setStringListAt(raw, ['cors', 'allowedOrigins'], env.RTDB_CORS_ALLOWED_ORIGINS);
  if (env.RTDB_LOG_LEVEL !== undefined && isLogLevel(env.RTDB_LOG_LEVEL)) {
    setAtPath(raw, ['log', 'level'], env.RTDB_LOG_LEVEL);
  }
}

/** Per-field lenient coercion (invalid values fall back to defaults) to avoid bad config causing runtime type confusion */
function normalizeServerConfig(raw: JsonObject): ServerConfig {
  const defaults = SERVER_CONFIG_DEFAULTS;
  const auth = readObject(raw, 'auth');
  const admin = readObject(raw, 'admin');
  const cors = readObject(raw, 'cors');
  const write = readObject(raw, 'write');
  const storage = readObject(raw, 'storage');
  const segment = readObject(storage, 'segment');
  const cache = readObject(raw, 'cache');
  const query = readObject(raw, 'query');
  const http = readObject(raw, 'http');
  const log = readObject(raw, 'log');
  const mode = auth.mode;

  return {
    port: asInteger(raw.port, defaults.port),
    host: asString(raw.host, defaults.host),
    dataDir: asString(raw.dataDir, defaults.dataDir),
    retentionDays: asInteger(raw.retentionDays, defaults.retentionDays),
    archiveDir: asString(raw.archiveDir, defaults.archiveDir),
    archiveBeforeDelete: asBoolean(raw.archiveBeforeDelete, defaults.archiveBeforeDelete),
    auth: {
      enabled: asBoolean(auth.enabled, defaults.auth.enabled),
      mode: isAuthMode(mode) ? mode : defaults.auth.mode,
      token: asString(auth.token, defaults.auth.token),
      tokenFile: asString(auth.tokenFile, defaults.auth.tokenFile),
      username: asString(auth.username, defaults.auth.username),
      password: asString(auth.password, defaults.auth.password),
      passwordHash: asString(auth.passwordHash, defaults.auth.passwordHash),
      bootstrapUsername: asString(auth.bootstrapUsername, defaults.auth.bootstrapUsername),
      bootstrapPassword: asString(auth.bootstrapPassword, defaults.auth.bootstrapPassword),
      write: asBoolean(auth.write, defaults.auth.write),
      query: asBoolean(auth.query, defaults.auth.query),
      usersFile: asString(auth.usersFile, defaults.auth.usersFile),
      tokensFile: asString(auth.tokensFile, defaults.auth.tokensFile),
    },
    admin: {
      enabled: asBoolean(admin.enabled, defaults.admin.enabled),
      staticDir: asString(admin.staticDir, defaults.admin.staticDir),
      exposePaths: asBoolean(admin.exposePaths, defaults.admin.exposePaths),
    },
    cors: { allowedOrigins: asStringList(cors.allowedOrigins, defaults.cors.allowedOrigins) },
    write: {
      walEnabled: asBoolean(write.walEnabled, defaults.write.walEnabled),
      fsyncPolicy: write.fsyncPolicy === 'none' ? 'none' : defaults.write.fsyncPolicy,
      blockTargetPoints: asInteger(write.blockTargetPoints, defaults.write.blockTargetPoints),
      blockMinPoints: asInteger(write.blockMinPoints, defaults.write.blockMinPoints),
      flushIntervalMs: asInteger(write.flushIntervalMs, defaults.write.flushIntervalMs),
      maxBufferBytes: asInteger(write.maxBufferBytes, defaults.write.maxBufferBytes),
      maxPendingPoints: asInteger(write.maxPendingPoints, defaults.write.maxPendingPoints),
      maxBatch: asInteger(write.maxBatch, defaults.write.maxBatch),
    },
    storage: {
      segment: {
        maxBytes: asInteger(segment.maxBytes, defaults.storage.segment.maxBytes),
        maxPerDay: asInteger(segment.maxPerDay, defaults.storage.segment.maxPerDay),
      },
    },
    cache: {
      blocks: asInteger(cache.blocks, defaults.cache.blocks),
      fdGroups: asInteger(cache.fdGroups, defaults.cache.fdGroups),
    },
    query: { defaultLimit: asInteger(query.defaultLimit, defaults.query.defaultLimit) },
    http: { maxBodyBytes: asInteger(http.maxBodyBytes, defaults.http.maxBodyBytes) },
    log: { level: isLogLevel(log.level) ? log.level : defaults.log.level },
  };
}

/* ---------- Validation (§6.5 semantic conflicts → startup failure) ---------- */

export function validateServerConfig(config: ServerConfig): void {
  // 0 = a random port assigned by the system (test / container scenario extension; §6.2.5 official values are 1~65535)
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw new RtdbError(ERROR_CODE.Internal, `Invalid port (should be 0~65535, 0 = random port): ${config.port}`);
  }
  if (!isLoopbackHost(config.host) && !config.auth.enabled) {
    throw new RtdbError(
      ERROR_CODE.Auth,
      `Listen address ${config.host} is not loopback; authentication must be enabled (auth.enabled=true)`,
    );
  }
  if (config.write.blockMinPoints > config.write.blockTargetPoints) {
    throw new RtdbError(
      ERROR_CODE.Internal,
      `blockMinPoints(${config.write.blockMinPoints}) must not exceed blockTargetPoints(${config.write.blockTargetPoints})`,
    );
  }
  if (config.write.maxBatch < 1) {
    throw new RtdbError(ERROR_CODE.Internal, `write.maxBatch must be ≥ 1: ${config.write.maxBatch}`);
  }
  const needsPassword = config.auth.mode === 'basic' || config.auth.mode === 'both';
  if (config.auth.enabled && needsPassword && config.auth.password.length === 0 && config.auth.passwordHash.length === 0) {
    throw new RtdbError(
      ERROR_CODE.Auth,
      `${config.auth.mode} auth mode requires a password (auth.password or auth.passwordHash)`,
    );
  }
}

/** Loopback address check (IPv4 127.x, IPv6 ::1, localhost) */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  return /^127(\.\d{1,3}){3}$/.test(normalized);
}

/* ---------- Mapping to engine options ---------- */

export function toEngineOptions(config: ServerConfig): EngineOptions {
  return {
    dataDir: config.dataDir,
    retentionDays: config.retentionDays,
    archiveBeforeDelete: config.archiveBeforeDelete,
    archiveDir: config.archiveDir.length > 0 ? config.archiveDir : undefined,
    segmentMaxBytes: config.storage.segment.maxBytes,
    segmentMaxPerDay: config.storage.segment.maxPerDay,
    blockTargetPoints: config.write.blockTargetPoints,
    blockMinPoints: config.write.blockMinPoints,
    flushIntervalMs: config.write.flushIntervalMs,
    maxBufferBytes: config.write.maxBufferBytes,
    maxPendingPoints: config.write.maxPendingPoints,
    cacheBlocks: config.cache.blocks,
    cacheFdGroups: config.cache.fdGroups,
    walEnabled: config.write.walEnabled,
    fsyncPolicy: config.write.fsyncPolicy,
  };
}

/* ---------- Internal utilities ---------- */

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObject(container: JsonObject, key: string): JsonObject {
  const value = container[key];
  return isPlainObject(value) ? value : {};
}

function mergeDeep(target: JsonObject, source: JsonObject): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) continue;
    const targetValue = target[key];
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      mergeDeep(targetValue, sourceValue);
      continue;
    }
    target[key] = sourceValue;
  }
}

function setAtPath(raw: JsonObject, path: readonly string[], value: unknown): void {
  let cursor = raw;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const next = cursor[key];
    if (!isPlainObject(next)) cursor[key] = {};
    cursor = cursor[key] as JsonObject;
  }
  cursor[path[path.length - 1]] = value;
}

function setNumberAt(raw: JsonObject, path: readonly string[], value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  setAtPath(raw, path, numeric);
}

function setBooleanAt(raw: JsonObject, path: readonly string[], value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') setAtPath(raw, path, true);
  else if (normalized === 'false' || normalized === '0') setAtPath(raw, path, false);
}

function setStringAt(raw: JsonObject, path: readonly string[], value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  setAtPath(raw, path, value);
}

/** Comma-separated list, e.g. `RTDB_CORS_ALLOWED_ORIGINS=https://a.example,https://b.example` */
function setStringListAt(raw: JsonObject, path: readonly string[], value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length > 0) setAtPath(raw, path, items);
}

function asStringList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function asInteger(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
