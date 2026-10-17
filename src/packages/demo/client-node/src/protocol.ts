// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * HTTP/JSON value codec on the SDK side (the mirror image of server `json-codec.ts`, aligned with "Detailed Design v2.2" §3.1)
 *
 * Protocol decision (settled 2026-10-16 on the server side, reused here): **i64 travels as a "decimal string
 * + `vt` type marker"**, with `vt` values 1=f64, 2=i64, 3=bool, 4=string.
 *   - Write side: the SDK always emits `vt` explicitly (bigint -> 2, boolean -> 3, string -> 4, finite number -> 1);
 *   - Read side: `vt` is always present, so a decimal string narrows back to `bigint` and `null` (non-finite f64) maps to `NaN`.
 * Short-key aliases: `t` = `timestamp`, `v` = `value`, `q` = `quality`.
 *
 * Constraint: the SDK must stay free of engine dependencies, so these types are structurally identical to core
 * `Point` / `Series` / `AggregateWindow` but are declared locally; `bigint` remains the i64 carrier end to end.
 */

import { CLIENT_ERROR_CODE, RtdbClientError } from './errors.ts';

/* ---------- Value type markers (identical to the server / WAL row format) ---------- */

export const VALUE_TYPE = {
  Float64: 1,
  Int64: 2,
  Bool: 3,
  String: 4,
} as const;
export type ValueType = (typeof VALUE_TYPE)[keyof typeof VALUE_TYPE];

/* ---------- Public types ---------- */

/** f64 -> number; i64 -> bigint; bool -> boolean; string -> string */
export type PointValue = number | bigint | string | boolean;

export interface ClientPoint {
  /** Millisecond epoch */
  timestamp: number;
  value: PointValue;
  /** u8 quality flags; omitted when the server does not carry one */
  quality?: number;
}

export interface ClientWritePoint extends ClientPoint {
  metricName: string;
}

export interface ClientSeries {
  metricName: string;
  points: ClientPoint[];
  /**
   * Server receive-time window over the queried range (ms epoch): min/max of the server receive
   * times of the hit points (block/batch granularity); absent when the server does not provide one.
   */
  received?: { min: number; max: number };
}

/** Aggregated window; `avg` / `sum` / `count` -> number, `min` / `max` / `last` -> the metric value type; an empty window -> `NaN` */
export interface AggregateWindowResult {
  start: number;
  end: number;
  value: PointValue;
  count: number;
}

export type AggregateType = 'avg' | 'sum' | 'min' | 'max' | 'count' | 'last';

/** Interpolation mode of `queryAt` (MVP: `step`/`linear`) */
export type InterpolationMode = 'step' | 'linear';

/** Options of `RtdbClient.queryAt` */
export interface AtQueryOptions {
  /** Timestamps to evaluate (ms epoch, any order, ≤10 000 per call) */
  timestamps: number[];
  /** `step` (default) = previous-value hold; `linear` = piecewise-linear (f64/i64 metrics only) */
  mode?: InterpolationMode;
}

/** Where a `queryAt` value came from */
export type AtPointState = 'exact' | 'interpolated' | 'extrapolated' | 'no-data';

/** One `queryAt` result: the value at a requested timestamp plus its provenance */
export interface ClientAtPoint {
  /** Requested timestamp (ms epoch, echoed) */
  timestamp: number;
  /** Value at `timestamp`; null = nothing to report (`state: 'no-data'`) */
  value: PointValue | null;
  /** `exact` = a real stored point; `interpolated`/`extrapolated` = computed (linear only); `no-data` */
  state: AtPointState;
}

/* ---------- Wire shapes (server response fragments) ---------- */

export interface JsonPoint {
  t: number;
  v: number | string | boolean | null;
  vt: ValueType;
  q?: number;
}

export interface JsonSeries {
  metricName: string;
  points: JsonPoint[];
  received?: { min: number; max: number };
}

export interface JsonWindow {
  start: number;
  end: number;
  v: number | string | boolean | null;
  vt: ValueType;
  count: number;
}

export interface JsonAtPoint {
  t: number;
  v: number | string | boolean | null;
  vt: ValueType;
  state: string;
}

/* ---------- Encoding (SDK value -> wire JSON) ---------- */

/**
 * Encode a single write point into the wire shape; when `vt` is given explicitly it is emitted as-is, otherwise
 * it is inferred from the JS type of the value (`bigint` -> i64, `boolean` -> bool, `string` -> string, `number` -> f64).
 *
 * A non-finite number (`NaN` / `±Infinity`) is rejected locally with `E_CLIENT_INVALID_ARGUMENT`, since it cannot
 * be represented in JSON and would otherwise silently become `null`.
 */
export function encodeWritePoint(point: ClientWritePoint): Record<string, unknown> {
  if (typeof point.metricName !== 'string' || point.metricName.length === 0) {
    throw new RtdbClientError(CLIENT_ERROR_CODE.InvalidArgument, 'WritePoint.metricName must be a non-empty string');
  }
  if (typeof point.timestamp !== 'number' || !Number.isInteger(point.timestamp)) {
    throw new RtdbClientError(
      CLIENT_ERROR_CODE.InvalidArgument,
      `WritePoint.timestamp must be an integer (ms epoch): ${String(point.timestamp)}`,
    );
  }

  const encoded: Record<string, unknown> = { metricName: point.metricName, t: point.timestamp };
  encoded.v = encodeValue(point.value);
  encoded.vt = valueTypeOf(point.value);
  if (point.quality !== undefined) encoded.q = point.quality;
  return encoded;
}

function valueTypeOf(value: PointValue): ValueType {
  if (typeof value === 'bigint') return VALUE_TYPE.Int64;
  if (typeof value === 'boolean') return VALUE_TYPE.Bool;
  if (typeof value === 'string') return VALUE_TYPE.String;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RtdbClientError(
        CLIENT_ERROR_CODE.InvalidArgument,
        `Numeric value must be finite (NaN / Infinity cannot be encoded): ${String(value)}`,
      );
    }
    return VALUE_TYPE.Float64;
  }
  throw new RtdbClientError(CLIENT_ERROR_CODE.InvalidArgument, `Unsupported value type: ${typeof value}`);
}

function encodeValue(value: PointValue): number | string | boolean {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RtdbClientError(
        CLIENT_ERROR_CODE.InvalidArgument,
        `Numeric value must be finite (NaN / Infinity cannot be encoded): ${String(value)}`,
      );
    }
    return value;
  }
  throw new RtdbClientError(CLIENT_ERROR_CODE.InvalidArgument, `Unsupported value type: ${typeof value}`);
}

/* ---------- Decoding (wire JSON -> SDK value) ---------- */

/**
 * Decode a timestamped value pair.
 *
 * `vt=1` with `v=null` means a non-finite f64 (an aggregation window with no coverage) and maps to `NaN`;
 * `vt=2` accepts the decimal string form (and tolerates an integral number) and narrows back to `bigint`.
 */
export function decodeValue(rawValue: unknown, marker: unknown): PointValue {
  if (marker === VALUE_TYPE.Int64) {
    if (typeof rawValue === 'string' && /^[+-]?\d+$/.test(rawValue)) return BigInt(rawValue);
    if (typeof rawValue === 'number' && Number.isInteger(rawValue)) return BigInt(rawValue);
    throw new RtdbClientError(
      CLIENT_ERROR_CODE.Transport,
      `vt=2(i64) expects a decimal string or an integer, got ${typeof rawValue}`,
    );
  }
  if (marker === VALUE_TYPE.Bool) {
    if (typeof rawValue === 'boolean') return rawValue;
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `vt=3(bool) expects a boolean, got ${typeof rawValue}`);
  }
  if (marker === VALUE_TYPE.String) {
    if (typeof rawValue === 'string') return rawValue;
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `vt=4(string) expects a string, got ${typeof rawValue}`);
  }
  if (marker === VALUE_TYPE.Float64) {
    if (rawValue === null) return Number.NaN;
    if (typeof rawValue === 'number') return rawValue;
    throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `vt=1(f64) expects a number or null, got ${typeof rawValue}`);
  }
  throw new RtdbClientError(CLIENT_ERROR_CODE.Transport, `Unknown vt type marker: ${String(marker)}`);
}

export function decodePoint(json: JsonPoint): ClientPoint {
  const point: ClientPoint = { timestamp: json.t, value: decodeValue(json.v, json.vt) };
  if (typeof json.q === 'number') point.quality = json.q;
  return point;
}

export function decodeSeries(json: JsonSeries): ClientSeries {
  const series: ClientSeries = { metricName: json.metricName, points: json.points.map(decodePoint) };
  if (json.received !== undefined) series.received = json.received;
  return series;
}

export function decodeAggregateWindows(windows: readonly JsonWindow[]): AggregateWindowResult[] {
  return windows.map((window) => ({
    start: window.start,
    end: window.end,
    value: decodeValue(window.v, window.vt),
    count: window.count,
  }));
}

const AT_POINT_STATES: readonly AtPointState[] = ['exact', 'interpolated', 'extrapolated', 'no-data'];

export function decodeAtPoints(records: readonly JsonAtPoint[]): ClientAtPoint[] {
  return records.map((record) => {
    if (!AT_POINT_STATES.includes(record.state as AtPointState)) {
      throw new RtdbClientError(
        CLIENT_ERROR_CODE.Transport,
        `query/at point.state must be one of exact|interpolated|extrapolated|no-data: ${String(record.state)}`,
      );
    }
    return {
      timestamp: record.t,
      value: record.v === null ? null : decodeValue(record.v, record.vt),
      state: record.state as AtPointState,
    };
  });
}
