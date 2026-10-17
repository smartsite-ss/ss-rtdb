// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Core type definitions for ss-rtdb (aligned with Detailed Design v1.6 §2.1)
 *
 * Note: this file does not use TS `enum` (tsconfig enables erasableSyntaxOnly; sources must be
 *       strip-executable by Node natively). Instead it uses an `as const` object plus literal
 *       union types, used the same way as an enum (`ValueType.Float64`).
 */

import { ERROR_CODE, RtdbError } from './errors.ts';

/** Value type: locked on the first write of a metric; later type mismatches are rejected (E_TYPE_MISMATCH) */
export const ValueType = {
  Float64: 1,
  Int64: 2,
  Bool: 3,
  String: 4,
} as const;
export type ValueType = (typeof ValueType)[keyof typeof ValueType];

/** Value type → name (used in logs and error messages) */
export const VALUE_TYPE_NAME: Readonly<Record<ValueType, string>> = {
  [ValueType.Float64]: 'f64',
  [ValueType.Int64]: 'i64',
  [ValueType.Bool]: 'bool',
  [ValueType.String]: 'string',
};

/**
 * Data point: value typed per metric binding; timestamp in ms epoch (number safe integer)
 *
 * Value type resolution rules (the write entry infers from the JS type of the passed value; the
 * metric locks on its first write):
 *   `number` → f64 (JS numbers are doubles; integer semantics cannot be inferred from a value)
 *   `bigint` → i64 (the only unambiguous integer form; capped at ±2^53 to keep SDK-side numbers exact)
 *   `boolean` → bool; `string` → string (≤256B UTF-8)
 */
export interface Point {
  timestamp: number;
  /** f64→number; i64→bigint; bool→boolean; string→string */
  value: number | bigint | string | boolean;
  /** u8 quality flags, default 0 = good (M0 decision: all-zero is not persisted; see Pre-Development Checklist §2.2) */
  quality?: number;
}

export interface WritePoint extends Point {
  metricName: string;
}

export interface RangeOptions {
  /** ms epoch (inclusive) */
  start: number;
  /** ms epoch (inclusive) */
  end: number;
  /** Default 100_000, to prevent runaway */
  limit?: number;
  /** Default asc */
  order?: 'asc' | 'desc';
}

export interface Series {
  metricName: string;
  points: Point[];
  /**
   * Server receive-time window over the queried range (ms epoch): min/max of the
   * server receive times of the hit blocks plus unblocked buffered points.
   * Absent when no point carries a receive time (legacy blocks only).
   * Block/batch granularity — not per-point.
   */
  received?: { min: number; max: number };
}

export interface AggregateWindow {
  /** Window start (ms epoch, inclusive) */
  start: number;
  /** Window end (ms epoch, exclusive) */
  end: number;
  /**
   * Aggregated value; its type narrows by operator and metric value type:
   *   `avg`/`sum` → number; `count` → number; `min`/`max` → value of the base value type (f64→number, i64→bigint, bool→boolean);
   *   `last` → value of the metric value type. A window with no coverage (or an empty value) → `NaN`
   */
  value: Point['value'];
  /** Number of points participating in the aggregation within the window (excluding interpolation neighbors before/after the window) */
  count: number;
}

export type AggregateType = 'avg' | 'sum' | 'min' | 'max' | 'count' | 'last';

/** Interpolation mode of `queryAt` (MVP: `step`/`linear`; `nearest` planned) */
export type InterpolationMode = 'step' | 'linear';

/** One result of `queryAt`: the value at a requested timestamp plus where it came from */
export interface AtPoint {
  /** Requested timestamp (ms epoch, echoed) */
  timestamp: number;
  /** Value at `timestamp`; null = nothing to report (`state: 'no-data'`) */
  value: Point['value'] | null;
  /**
   * `exact` = the value exists in storage (a real point; previous-value hold included);
   * `interpolated` = computed between two real points (linear only);
   * `extrapolated` = flat from the nearest real point outside the data range (linear only);
   * `no-data` = no point is available for the request
   */
  state: 'exact' | 'interpolated' | 'extrapolated' | 'no-data';
}

/** Engine options (all config items for Form A library integration; the key mapping for Form B is in Detailed Design §6.2) */
export interface EngineOptions {
  /** Data root directory */
  dataDir: string;
  /** Global default retention in days; 0 = forever (default 0) */
  retentionDays?: number;
  /** Whether to package expired day directories into a tar.gz archive before deleting them; default false (see Detailed Design §2.9 for archiving) */
  archiveBeforeDelete?: boolean;
  /** Archive destination directory; default `{dataDir}/archive` (must be on the same volume as dataDir) */
  archiveDir?: string;
  /** Segment soft size cap; default 200MB (209715200), clamped to 16MB~4GB */
  segmentMaxBytes?: number;
  /** Max segments per day; default 1000 */
  segmentMaxPerDay?: number;
  /** Target block size (primary block-finalize trigger); default 16384 */
  blockTargetPoints?: number;
  /** Point lower bound for the 5s fallback block finalize; default 1024 */
  blockMinPoints?: number;
  /** Periodic fallback interval (ms); default 5000 */
  flushIntervalMs?: number;
  /** In-memory buffer watermark for un-finalized points (bytes); default 256MB */
  maxBufferBytes?: number;
  /** Unflushed point-count watermark; default 2_000_000 */
  maxPendingPoints?: number;
  /** Decoded block cache LRU entries; default 256 */
  cacheBlocks?: number;
  /** Segment file handle LRU entries; default 32 */
  cacheFdGroups?: number;
  /** Default true; false only for scenarios where data can be reloaded */
  walEnabled?: boolean;
  /** Default 'wal': group fsync after WAL append */
  fsyncPolicy?: 'wal' | 'none';
}

/** Engine defaults (item-by-item consistent with the authoritative table in Detailed Design §6.2) */
export const ENGINE_DEFAULTS = {
  retentionDays: 0,
  archiveBeforeDelete: false,
  segmentMaxBytes: 209_715_200,
  segmentMaxPerDay: 1_000,
  blockTargetPoints: 16_384,
  blockMinPoints: 1_024,
  flushIntervalMs: 5_000,
  maxBufferBytes: 268_435_456,
  maxPendingPoints: 2_000_000,
  cacheBlocks: 256,
  cacheFdGroups: 32,
  walEnabled: true,
  fsyncPolicy: 'wal',
} as const;

/** Container-level clamps (Detailed Design §6.2.2 / §6.5: out-of-range values are always clamped + WARN, startup is not blocked) */
export const ENGINE_CLAMPS = {
  segmentMaxBytes: { min: 16_777_216, max: 4_294_967_296 },
  blockTargetPoints: { min: 4_096, max: 65_536 },
  blockMinPoints: { min: 64, max: 65_536 },
  flushIntervalMs: { min: 200, max: 60_000 },
  maxBufferBytes: { min: 16_777_216, max: 2_147_483_648 },
  maxPendingPoints: { min: 100_000, max: 10_000_000 },
  cacheBlocks: { min: 16, max: 4_096 },
  cacheFdGroups: { min: 4, max: 256 },
  retentionDays: { min: 0, max: 3_650 },
  segmentMaxPerDay: { min: 1, max: 1_000 },
} as const;

/** Names of clampable config items (= keys of ENGINE_CLAMPS) */
export type EngineOptionName = keyof typeof ENGINE_CLAMPS;

/**
 * Container-level clamps (Detailed Design §6.2.2 / §6.5): out-of-range values are always clamped to
 * the boundary, **without blocking startup**
 *
 * The caller (engine.ts) is responsible for logging a WARN when clamping occurred; this function
 * only does arithmetic and emits no logs.
 * Non-finite values (NaN / ±Infinity) are caller bugs and throw E_INTERNAL.
 */
export function clampEngineOption(name: EngineOptionName, value: number): number {
  const range = ENGINE_CLAMPS[name];
  const rounded = Math.trunc(value);
  if (!Number.isFinite(rounded)) {
    throw new RtdbError(ERROR_CODE.Internal, `Config item ${name} is not a finite number: ${String(value)}`);
  }
  if (rounded < range.min) return range.min;
  if (rounded > range.max) return range.max;
  return rounded;
}

/** Write-path validation limits (Detailed Design §2.1 / §2.6) */
export const WRITE_LIMITS = {
  /** Metric name length limit (UTF-8 bytes) */
  metricNameMaxBytes: 512,
  /** String value length limit (UTF-8 bytes) */
  stringValueMaxBytes: 256,
  /** i64 absolute value limit (keeps SDK numbers exact) */
  int64MaxSafeInteger: 2 ** 53,
} as const;

/** Default query count (corresponds to config#query.defaultLimit) */
export const DEFAULT_RANGE_LIMIT = 100_000;
