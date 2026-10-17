// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * HTTP/JSON value encoding and decoding (aligns with "Detailed Design v2.0" §3.1 and the S8 protocol decision)
 *
 * Protocol decision (settled 2026-10-16): **i64 is expressed in JSON as a "decimal string + `vt` type marker"**,
 * with `vt` values consistent with the WAL row format (1=f64, 2=i64, 3=bool, 4=string, see core `VALUE_TYPE_NAME` / `ValueType`).
 * The read side (response) always carries `vt`; the write side `vt` is optional and defaults to inference by JS value type (number→f64, boolean→bool, string→string, bigint is unreachable in JSON).
 * Short-key aliases: `t` = `timestamp`, `v` = `value`, `q` = `quality`; long keys take precedence.
 */

import { ERROR_CODE, RtdbError } from '../../core/src/errors.ts';
import { ValueType } from '../../core/src/types.ts';
import type { AggregateWindow, Point, Series, WritePoint } from '../../core/src/types.ts';

/* ---------- Read-side (response) types ---------- */

export interface JsonPoint {
  /** millisecond epoch */
  t: number;
  /** f64→number; i64→decimal string; bool→boolean; string→string; non-finite f64→null */
  v: number | string | boolean | null;
  vt: ValueType;
  q?: number;
}

export interface JsonSeries {
  metricName: string;
  points: JsonPoint[];
}

export interface JsonWindow {
  start: number;
  end: number;
  v: number | string | boolean | null;
  vt: ValueType;
  count: number;
}

/** metric summary (structurally equivalent to core `MetricSummary` to avoid coupling the server side to the engine module) */
export interface JsonMetricSummary {
  metricName: string;
  firstTs: number;
  lastTs: number;
}

interface EncodedValue {
  v: number | string | boolean | null;
  vt: ValueType;
}

/* ---------- Encoding (core → JSON) ---------- */

export function encodeValue(value: Point['value']): EncodedValue {
  if (typeof value === 'bigint') return { v: value.toString(), vt: ValueType.Int64 };
  if (typeof value === 'boolean') return { v: value, vt: ValueType.Bool };
  if (typeof value === 'string') return { v: value, vt: ValueType.String };
  return { v: Number.isFinite(value) ? value : null, vt: ValueType.Float64 };
}

export function encodePoint(point: Point): JsonPoint {
  const encoded = encodeValue(point.value);
  const json: JsonPoint = { t: point.timestamp, v: encoded.v, vt: encoded.vt };
  if (point.quality !== undefined) json.q = point.quality;
  return json;
}

export function encodeSeries(series: Series): JsonSeries {
  return { metricName: series.metricName, points: series.points.map(encodePoint) };
}

export function encodeAggregateWindows(windows: readonly AggregateWindow[]): JsonWindow[] {
  return windows.map((window) => {
    const encoded = encodeValue(window.value);
    return { start: window.start, end: window.end, v: encoded.v, vt: encoded.vt, count: window.count };
  });
}

/* ---------- Decoding (JSON → core) ---------- */

export function decodeWritePointBatch(input: unknown): WritePoint[] {
  if (!Array.isArray(input)) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, 'Write body must be a WritePoint[] array');
  }
  const points: WritePoint[] = [];
  const issues: string[] = [];
  const indexes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const decoded = decodeWritePoint(input[index]);
    if (decoded === null) {
      issues.push(`index ${index}`);
      indexes.push(index);
      continue;
    }
    points.push(decoded);
  }
  if (issues.length > 0) {
    throw new RtdbError(
      ERROR_CODE.InvalidPoint,
      `Write body contains invalid points (${issues.join('; ')})`,
      ...indexes,
    );
  }
  return points;
}

function decodeWritePoint(raw: unknown): WritePoint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const metricName = record.metricName;
  if (typeof metricName !== 'string' || metricName.length === 0) return null;

  const timestamp = record.timestamp ?? record.t;
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) return null;

  const hasLongValue = Object.prototype.hasOwnProperty.call(record, 'value');
  const hasShortValue = Object.prototype.hasOwnProperty.call(record, 'v');
  if (!hasLongValue && !hasShortValue) return null;

  let value: Point['value'];
  try {
    value = decodeValue(hasLongValue ? record.value : record.v, record.vt);
  } catch {
    return null;
  }

  const point: WritePoint = { metricName, timestamp, value };
  const quality = record.quality ?? record.q;
  if (typeof quality === 'number' && Number.isInteger(quality)) point.quality = quality;
  return point;
}

function decodeValue(rawValue: unknown, marker: unknown): Point['value'] {
  if (marker === undefined || marker === null) {
    if (typeof rawValue === 'number') return rawValue;
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue === 'string') return rawValue;
    throw new Error('Value type cannot be inferred from the JSON value; provide a vt marker');
  }
  if (marker === ValueType.Float64) {
    if (typeof rawValue !== 'number') throw new Error(`vt=1(f64) expected number, got ${typeof rawValue}`);
    return rawValue;
  }
  if (marker === ValueType.Int64) {
    if (typeof rawValue === 'string') {
      if (!/^[+-]?\d+$/.test(rawValue)) throw new Error(`vt=2(i64) expected a decimal string: ${rawValue}`);
      return BigInt(rawValue);
    }
    if (typeof rawValue === 'number' && Number.isInteger(rawValue)) return BigInt(rawValue);
    throw new Error(`vt=2(i64) expected a decimal string or integer, got ${typeof rawValue}`);
  }
  if (marker === ValueType.Bool) {
    if (typeof rawValue !== 'boolean') throw new Error(`vt=3(bool) expected boolean, got ${typeof rawValue}`);
    return rawValue;
  }
  if (marker === ValueType.String) {
    if (typeof rawValue !== 'string') throw new Error(`vt=4(string) expected string, got ${typeof rawValue}`);
    return rawValue;
  }
  throw new Error(`Unknown vt type marker: ${String(marker)}`);
}

/* ---------- metric summary (pass-through, itself JSON-safe) ---------- */

export function encodeMetricSummaries(summaries: readonly JsonMetricSummary[]): JsonMetricSummary[] {
  return summaries.map((summary) => ({
    metricName: summary.metricName,
    firstTs: summary.firstTs,
    lastTs: summary.lastTs,
  }));
}
