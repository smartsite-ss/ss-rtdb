// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxQL compatibility: planner / executor over the four query primitives
 *
 * Mapping (kept deliberately narrow — anything that would need JOIN / cross-measurement merge with
 * unbounded memory is rejected by the parser):
 *   raw SELECT          -> queryRange
 *   count()             -> queryCount / queryAggregate(count)
 *   sum/min/max/last()  -> queryAggregate
 *   mean()              -> sum / count (point-equal-weight mean, matching InfluxQL; the native `avg` is
 *                          time-weighted and is intentionally not reused)
 *   first()             -> queryRange(limit=1, asc) per window (bounded: <= 2000 windows)
 *   SHOW ...            -> listDatabases / listMetrics (+ metric-name unfolding)
 */

import type { MetricSummary, RtdbEngine } from '../../../../../core/src/engine.ts';
import { MAX_AGGREGATE_WINDOWS } from '../../../../../core/src/engine.ts';
import { readDatabaseRetentionDays } from '../../../../../core/src/size.ts';
import type { AggregateType, Point, ValueType } from '../../../../../core/src/types.ts';
import { ValueType as ValueTypeEnum } from '../../../../../core/src/types.ts';
import { InfluxCompatError } from '../errors.ts';
import { escapeComponent, unfoldMetricName } from '../naming.ts';
import type { MetricIdentity } from '../naming.ts';
import type { AggregateFunction, InfluxStatement, SelectStatement, ShowStatement } from './parser.ts';

export type InfluxValue = string | number | boolean | null;

export interface InfluxSeries {
  name: string;
  tags?: Record<string, string>;
  columns: string[];
  values: InfluxValue[][];
}

export interface ExecuteOptions {
  database: string;
  nowMs: number;
  metricPrefix: string;
  /** Effective cap when the query has no LIMIT (native `query.defaultLimit`) */
  defaultLimit: number;
  /** Global retention fallback (days) used by SHOW RETENTION POLICIES */
  retentionDays: number;
  dataDir: string;
  /** Called for metric names that cannot be unfolded into measurement/field/tags */
  onUnmappedMetric?: () => void;
}

/** Maximum number of windows for `first()`, which is evaluated with one bounded range read per window */
const MAX_FIRST_WINDOWS = 2_000;

export async function executeInfluxStatement(
  engine: RtdbEngine,
  statement: InfluxStatement,
  options: ExecuteOptions,
): Promise<InfluxSeries[]> {
  if (statement.kind === 'show') return executeShow(engine, statement, options);
  return executeSelect(engine, statement, options);
}

interface Candidate {
  metricName: string;
  identity: MetricIdentity;
  summary: MetricSummary;
}

/* ---------- SELECT ---------- */

async function executeSelect(
  engine: RtdbEngine,
  statement: SelectStatement,
  options: ExecuteOptions,
): Promise<InfluxSeries[]> {
  const candidates = await selectCandidates(engine, statement.measurement, statement.tags, options);
  if (candidates.length === 0) return [];

  const earliest = candidates.reduce((min, item) => Math.min(min, item.summary.firstTs), Number.MAX_SAFE_INTEGER);
  const latest = candidates.reduce((max, item) => Math.max(max, item.summary.lastTs), Number.MIN_SAFE_INTEGER);
  const start = statement.time.start ?? earliest;
  // Grouped queries default to the last data point instead of "now": a 1s window over a nine-month gap would
  // otherwise materialize millions of empty windows and hit MAX_AGGREGATE_WINDOWS.
  const end = statement.time.end ?? (statement.group.windowMs !== null ? Math.max(latest, start) : options.nowMs);
  if (start > end) return [];

  const specs = expandFields(statement, candidates);
  const series: InfluxSeries[] = [];
  for (const spec of specs) {
    const matching = candidates.filter((candidate) => candidate.identity.field === spec.field);
    if (matching.length === 0) continue;
    if (spec.fn === null) {
      for (const candidate of matching) {
        const raw = await evalRaw(engine, statement, candidate, spec.field, start, end, options);
        if (raw !== null) series.push(raw);
      }
    } else {
      series.push(...(await evalAggregate(engine, statement, matching, spec.fn, start, end, options)));
    }
  }
  series.sort(compareSeries);
  return series;
}

interface FieldSpecResolved {
  field: string;
  fn: AggregateFunction | null;
}

function expandFields(statement: SelectStatement, candidates: readonly Candidate[]): FieldSpecResolved[] {
  const allFields = [...new Set(candidates.map((candidate) => candidate.identity.field))].sort();
  const resolved: FieldSpecResolved[] = [];
  const seen = new Set<string>();
  for (const spec of statement.fields) {
    if (spec.star) {
      for (const field of allFields) {
        const key = `${spec.fn ?? ''}\u0000${field}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({ field, fn: spec.fn });
      }
      continue;
    }
    if (spec.name === null) continue;
    const key = `${spec.fn ?? ''}\u0000${spec.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ field: spec.name, fn: spec.fn });
  }
  return resolved;
}

async function evalRaw(
  engine: RtdbEngine,
  statement: SelectStatement,
  candidate: Candidate,
  field: string,
  start: number,
  end: number,
  options: ExecuteOptions,
): Promise<InfluxSeries | null> {
  const offset = statement.offset ?? 0;
  const limit = offset + (statement.limit ?? options.defaultLimit);
  const result = await engine.queryRange(options.database, candidate.metricName, {
    start,
    end,
    limit,
    order: statement.order ?? 'asc',
  });
  let points = result.points;
  if (offset > 0) points = points.slice(offset);
  if (statement.limit !== null) points = points.slice(0, statement.limit);
  if (points.length === 0) return null;

  const series: InfluxSeries = {
    name: statement.measurement,
    columns: ['time', field],
    values: points.map((point) => [point.timestamp, toOutputValue(point.value)]),
  };
  const tags = candidate.identity.tags;
  if (Object.keys(tags).length > 0) series.tags = { ...tags };
  return series;
}

async function evalAggregate(
  engine: RtdbEngine,
  statement: SelectStatement,
  candidates: readonly Candidate[],
  fn: AggregateFunction,
  start: number,
  end: number,
  options: ExecuteOptions,
): Promise<InfluxSeries[]> {
  const groupTagKeys = statement.group.tags;
  const groups = new Map<string, { tags: Record<string, string>; candidates: Candidate[] }>();
  for (const candidate of candidates) {
    const tags: Record<string, string> = {};
    for (const key of groupTagKeys) tags[key] = candidate.identity.tags[key] ?? '';
    const groupKey = groupTagKeys.map((key) => tags[key]).join('\u0000');
    const existing = groups.get(groupKey);
    if (existing === undefined) groups.set(groupKey, { tags, candidates: [candidate] });
    else existing.candidates.push(candidate);
  }
  if (groupTagKeys.length === 0 && groups.size === 0) {
    groups.set('', { tags: {}, candidates: [...candidates] });
  }

  const series: InfluxSeries[] = [];
  for (const group of groups.values()) {
    const rows = await evalGroup(engine, statement, group.candidates, fn, start, end, options);
    if (rows.length === 0) continue;
    const emitted: InfluxSeries = {
      name: statement.measurement,
      columns: ['time', fn],
      values: rows,
    };
    if (groupTagKeys.length > 0) emitted.tags = { ...group.tags };
    series.push(emitted);
  }
  return series;
}

async function evalGroup(
  engine: RtdbEngine,
  statement: SelectStatement,
  candidates: readonly Candidate[],
  fn: AggregateFunction,
  start: number,
  end: number,
  options: ExecuteOptions,
): Promise<InfluxValue[][]> {
  const windowMs = statement.group.windowMs;
  if (windowMs === null) {
    const value = await aggregateRange(engine, options.database, candidates, fn, start, end);
    if (value === null) return [];
    return [[start, value]];
  }

  // InfluxQL windows are epoch-aligned: a range starting mid-window starts at the next boundary.
  const alignedStart = Math.ceil(start / windowMs) * windowMs;
  if (alignedStart > end) return [];
  const windowCount = Math.floor((end - alignedStart) / windowMs) + 1;
  if (windowCount <= 0) return [];
  if (windowCount > MAX_AGGREGATE_WINDOWS) {
    throw new InfluxCompatError({
      status: 400,
      code: 'invalid',
      message: `GROUP BY time() produces ${windowCount} windows, exceeding the limit of ${MAX_AGGREGATE_WINDOWS}`,
    });
  }

  const values =
    fn === 'first'
      ? await firstPerWindow(engine, options.database, candidates, alignedStart, end, windowMs)
      : await aggregatePerWindow(engine, options.database, candidates, fn, alignedStart, end, windowMs);

  const rows: InfluxValue[][] = [];
  let previous: InfluxValue | undefined;
  for (let index = 0; index < windowCount; index += 1) {
    const windowStart = alignedStart + index * windowMs;
    const value = values[index];
    const empty = value === undefined || value === null;
    let emitted: InfluxValue | undefined = value;
    if (empty) {
      switch (statement.group.fill) {
        case 'none':
          continue;
        case 'null':
          emitted = null;
          break;
        case 'zero':
          emitted = 0;
          break;
        case 'previous':
          emitted = previous ?? null;
          break;
        default:
          emitted = null;
      }
    }
    if (!empty) previous = emitted;
    rows.push([windowStart, emitted ?? null]);
  }
  return rows;
}

/** Single-range aggregate (no GROUP BY time) */
async function aggregateRange(
  engine: RtdbEngine,
  database: string,
  candidates: readonly Candidate[],
  fn: AggregateFunction,
  start: number,
  end: number,
): Promise<InfluxValue | null> {
  if (fn === 'count') {
    let total = 0;
    for (const candidate of candidates) {
      total += await engine.queryCount(database, candidate.metricName, { start, end, exact: true });
    }
    return total > 0 ? total : null;
  }
  if (fn === 'first') {
    return firstValue(engine, database, candidates, start, end);
  }

  const windowMs = Math.max(1, end - start + 1);
  const windows = await collectWindows(engine, database, candidates, fn, start, end, windowMs);
  const first = windows[0];
  if (first === undefined || first.count === 0) return null;
  return finalize(fn, first);
}

/** Per-window aggregate (GROUP BY time) */
async function aggregatePerWindow(
  engine: RtdbEngine,
  database: string,
  candidates: readonly Candidate[],
  fn: AggregateFunction,
  start: number,
  end: number,
  windowMs: number,
): Promise<(InfluxValue | undefined)[]> {
  const windowCount = Math.floor((end - start) / windowMs) + 1;
  const merged = await collectWindows(engine, database, candidates, fn, start, end, windowMs);
  const values: (InfluxValue | undefined)[] = new Array(windowCount).fill(undefined);
  for (let index = 0; index < Math.min(windowCount, merged.length); index += 1) {
    const window = merged[index];
    if (window === undefined || window.count === 0) continue;
    values[index] = finalize(fn, window);
  }
  return values;
}

interface WindowAccumulator {
  sum: number;
  count: number;
  min: number | bigint | boolean | null;
  max: number | bigint | boolean | null;
  last: Point['value'] | null;
  lastTs: number;
}

/** Merge per-candidate `queryAggregate` windows into one accumulator array (window index = start offset) */
async function collectWindows(
  engine: RtdbEngine,
  database: string,
  candidates: readonly Candidate[],
  fn: AggregateFunction,
  start: number,
  end: number,
  windowMs: number,
): Promise<WindowAccumulator[]> {
  const windowCount = Math.max(1, Math.floor((end - start) / windowMs) + 1);
  const accumulators: WindowAccumulator[] = Array.from({ length: windowCount }, () => ({
    sum: 0,
    count: 0,
    min: null,
    max: null,
    last: null,
    lastTs: Number.NEGATIVE_INFINITY,
  }));

  const aggregateType: AggregateType =
    fn === 'mean' || fn === 'sum' ? 'sum' : fn === 'count' ? 'count' : fn === 'min' ? 'min' : fn === 'max' ? 'max' : 'last';

  for (const candidate of candidates) {
    const windows = await engine.queryAggregate(database, candidate.metricName, {
      start,
      end,
      type: aggregateType,
      windowMs,
    });
    for (let index = 0; index < Math.min(windowCount, windows.length); index += 1) {
      const window = windows[index];
      const accumulator = accumulators[index];
      if (accumulator === undefined || window === undefined) continue;
      if (window.count <= 0) continue;
      accumulator.count += window.count;
      const numeric = toNumber(window.value);
      if (fn === 'mean' || fn === 'sum') accumulator.sum += numeric ?? 0;
      if (fn === 'min') accumulator.min = pickOrdered(accumulator.min, window.value, -1);
      if (fn === 'max') accumulator.max = pickOrdered(accumulator.max, window.value, 1);
      if (fn === 'last' && candidate.summary.lastTs >= accumulator.lastTs) {
        accumulator.last = window.value;
        accumulator.lastTs = candidate.summary.lastTs;
      }
    }
  }
  return accumulators;
}

function finalize(fn: AggregateFunction, window: WindowAccumulator): InfluxValue | null {
  switch (fn) {
    case 'mean':
      return window.count > 0 ? window.sum / window.count : null;
    case 'sum':
      return window.count > 0 ? window.sum : null;
    case 'count':
      return window.count;
    case 'min':
      return toOutputValue(window.min);
    case 'max':
      return toOutputValue(window.max);
    case 'last':
      return toOutputValue(window.last);
    case 'first':
      // first() never reaches this path (see firstPerWindow / firstValue)
      return null;
    default:
      return null;
  }
}

async function firstPerWindow(
  engine: RtdbEngine,
  database: string,
  candidates: readonly Candidate[],
  start: number,
  end: number,
  windowMs: number,
): Promise<(InfluxValue | undefined)[]> {
  const windowCount = Math.floor((end - start) / windowMs) + 1;
  if (windowCount > MAX_FIRST_WINDOWS) {
    throw new InfluxCompatError({
      status: 400,
      code: 'invalid',
      message: `first() with GROUP BY time() over ${windowCount} windows is not supported (limit ${MAX_FIRST_WINDOWS})`,
    });
  }
  const values: (InfluxValue | undefined)[] = new Array(windowCount).fill(undefined);
  for (let index = 0; index < windowCount; index += 1) {
    const windowStart = start + index * windowMs;
    const windowEnd = Math.min(end, windowStart + windowMs - 1);
    if (windowStart > windowEnd) continue;
    const value = await firstValue(engine, database, candidates, windowStart, windowEnd);
    if (value !== null) values[index] = value;
  }
  return values;
}

async function firstValue(
  engine: RtdbEngine,
  database: string,
  candidates: readonly Candidate[],
  start: number,
  end: number,
): Promise<InfluxValue | null> {
  let bestTimestamp = Number.POSITIVE_INFINITY;
  let bestValue: InfluxValue | null = null;
  for (const candidate of candidates) {
    if (candidate.summary.firstTs > end) continue;
    const series = await engine.queryRange(database, candidate.metricName, { start, end, limit: 1, order: 'asc' });
    const point = series.points[0];
    if (point === undefined) continue;
    if (point.timestamp < bestTimestamp) {
      bestTimestamp = point.timestamp;
      bestValue = toOutputValue(point.value);
    }
  }
  return bestValue;
}

async function selectCandidates(
  engine: RtdbEngine,
  measurement: string,
  tagFilters: readonly { key: string; value: string; negated: boolean }[],
  options: ExecuteOptions,
): Promise<Candidate[]> {
  const summaries = await engine.listMetrics(options.database);
  const expectedPrefix = `${options.metricPrefix}${escapeComponent(measurement)}|`;
  const candidates: Candidate[] = [];
  for (const summary of summaries) {
    if (!summary.metricName.startsWith(expectedPrefix)) continue;
    const identity = unfoldMetricName(options.metricPrefix, summary.metricName);
    if (identity === null || identity.measurement !== measurement) {
      options.onUnmappedMetric?.();
      continue;
    }
    if (!matchesTagFilters(identity.tags, tagFilters)) continue;
    candidates.push({ metricName: summary.metricName, identity, summary });
  }
  return candidates;
}

/** Tag predicates are exact/non-exact matches on the folded tag set; `!=` also matches a missing tag */
function matchesTagFilters(
  tags: Readonly<Record<string, string>>,
  filters: readonly { key: string; value: string; negated: boolean }[],
): boolean {
  for (const filter of filters) {
    const equal = tags[filter.key] === filter.value;
    if (filter.negated ? equal : !equal) return false;
  }
  return true;
}

/* ---------- SHOW ---------- */

async function executeShow(
  engine: RtdbEngine,
  statement: ShowStatement,
  options: ExecuteOptions,
): Promise<InfluxSeries[]> {
  const database = statement.database ?? options.database;
  switch (statement.show) {
    case 'databases': {
      const databases = await engine.listDatabases();
      return [{ name: 'databases', columns: ['name'], values: databases.map((name) => [name]) }];
    }
    case 'measurements': {
      const identities = await collectIdentities(engine, database, options, statement.measurement);
      const names = [...new Set(identities.map((identity) => identity.measurement))].sort();
      return [{ name: 'measurements', columns: ['name'], values: names.map((name) => [name]) }];
    }
    case 'tag-keys': {
      const identities = await collectIdentities(engine, database, options, statement.measurement);
      const keys = [...new Set(identities.flatMap((identity) => Object.keys(identity.tags)))].sort();
      return [{ name: statement.measurement ?? '', columns: ['tagKey'], values: keys.map((key) => [key]) }];
    }
    case 'tag-values': {
      const key = statement.tagKey;
      if (key === null) {
        throw new InfluxCompatError({
          status: 400,
          code: 'invalid',
          message: 'SHOW TAG VALUES requires WITH KEY = "..."',
        });
      }
      const identities = await collectIdentities(engine, database, options, statement.measurement);
      const values = [
        ...new Set(
          identities
            .map((identity) => identity.tags[key])
            .filter((value): value is string => value !== undefined),
        ),
      ].sort();
      return [{ name: statement.measurement ?? '', columns: ['key', 'value'], values: values.map((value) => [key, value]) }];
    }
    case 'field-keys': {
      const summaries = await engine.listMetrics(database);
      const fields = new Map<string, string>();
      for (const summary of summaries) {
        if (!summary.metricName.startsWith(options.metricPrefix)) continue;
        const identity = unfoldMetricName(options.metricPrefix, summary.metricName);
        if (identity === null) {
          options.onUnmappedMetric?.();
          continue;
        }
        if (statement.measurement !== null && identity.measurement !== statement.measurement) continue;
        fields.set(identity.field, influxFieldType(summary.valueType));
      }
      return [
        {
          name: statement.measurement ?? '',
          columns: ['fieldKey', 'fieldType'],
          values: [...fields.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        },
      ];
    }
    case 'retention-policies': {
      const days = readDatabaseRetentionDays(options.dataDir, database) ?? options.retentionDays;
      const duration = days > 0 ? `${days}d` : '0s';
      return [
        {
          name: database,
          columns: ['name', 'duration', 'shardGroupDuration', 'replicaN', 'default'],
          values: [['autogen', duration, '168h', 1, true]],
        },
      ];
    }
    default:
      return [];
  }
}

async function collectIdentities(
  engine: RtdbEngine,
  database: string,
  options: ExecuteOptions,
  measurement: string | null,
): Promise<MetricIdentity[]> {
  const summaries = await engine.listMetrics(database);
  const identities: MetricIdentity[] = [];
  for (const summary of summaries) {
    if (!summary.metricName.startsWith(options.metricPrefix)) continue;
    const identity = unfoldMetricName(options.metricPrefix, summary.metricName);
    if (identity === null) {
      options.onUnmappedMetric?.();
      continue;
    }
    if (measurement !== null && identity.measurement !== measurement) continue;
    identities.push(identity);
  }
  return identities;
}

/* ---------- helpers ---------- */

function influxFieldType(valueType: ValueType | null): string {
  switch (valueType) {
    case ValueTypeEnum.Float64:
      return 'float';
    case ValueTypeEnum.Int64:
      return 'integer';
    case ValueTypeEnum.Bool:
      return 'boolean';
    case ValueTypeEnum.String:
      return 'string';
    default:
      return 'float';
  }
}

function pickOrdered(
  current: number | bigint | boolean | null,
  candidate: Point['value'],
  direction: -1 | 1,
): number | bigint | boolean | null {
  const candidateNumber = toNumber(candidate);
  if (candidateNumber === null) return current;
  const currentNumber = toNumber(current);
  if (currentNumber === null) return typeof candidate === 'number' || typeof candidate === 'bigint' ? candidate : null;
  if (direction < 0 ? candidateNumber < currentNumber : candidateNumber > currentNumber) {
    return typeof candidate === 'number' || typeof candidate === 'bigint' ? candidate : null;
  }
  return current;
}

function toNumber(value: Point['value'] | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

function toOutputValue(value: Point['value'] | null | undefined): InfluxValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function compareSeries(left: InfluxSeries, right: InfluxSeries): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  const leftTags = JSON.stringify(left.tags ?? {});
  const rightTags = JSON.stringify(right.tags ?? {});
  if (leftTags !== rightTags) return leftTags < rightTags ? -1 : 1;
  const leftColumn = left.columns[1] ?? '';
  const rightColumn = right.columns[1] ?? '';
  return leftColumn < rightColumn ? -1 : leftColumn > rightColumn ? 1 : 0;
}
