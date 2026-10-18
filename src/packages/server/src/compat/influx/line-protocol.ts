// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxDB compatibility: full Line Protocol parser (multi-field, tags, escapes, precision)
 *
 * Differences from the native parser (`line-protocol.ts` in the server root):
 *   - **tags are folded into the metric name** (or explicitly dropped when `tagFolding=ignore`);
 *   - **multiple fields per line** are split into one point per field (metric name suffix = field key);
 *   - a plain integer literal is a **float** (`42` -> f64), `42i` is i64 and `42u` is rejected (u64 unsupported),
 *     matching InfluxDB semantics instead of the native "integer text -> i64" rule;
 *   - the timestamp unit comes from `precision` (ns/us/ms/s/m/h) instead of being fixed to nanoseconds;
 *   - per-line failures are collected (line number + message) so the caller can choose atomic vs partial writes.
 *
 * The parser never throws; it returns points plus issues.
 */

import type { WritePoint } from '../../../../core/src/types.ts';
import { WRITE_LIMITS } from '../../../../core/src/types.ts';
import { foldMetricName, metricNameByteLength, METRIC_NAME_MAX_BYTES, splitUnescaped, tagsFromPairs } from './naming.ts';

/** Timestamp units accepted by InfluxDB write APIs */
export type TimestampPrecision = 'ns' | 'us' | 'ms' | 's' | 'm' | 'h';

export interface CompatLineProtocolOptions {
  /** Server receive time used when a line omits the timestamp */
  nowMs: number;
  precision: TimestampPrecision;
  metricPrefix: string;
  tagFolding: 'metric' | 'ignore';
  fieldFolding: 'metric' | 'reject';
}

export interface CompatParseIssue {
  /** 1-based line number in the request body */
  line: number;
  message: string;
}

export interface CompatParseResult {
  points: WritePoint[];
  issues: CompatParseIssue[];
  /** Tag key/value pairs folded into metric names (for status counters) */
  tagsFolded: number;
  /** Tag key/value pairs dropped because `tagFolding=ignore` */
  tagsDropped: number;
}

/**
 * Resolve the `precision` parameter. Accepts the short forms (`ns`/`us`/`ms`/`s`/`m`/`h`) and the
 * InfluxDB 3 full names (`nanosecond`, `microsecond`, ...). Returns `null` for unknown values.
 */
export function parsePrecision(value: string | null): TimestampPrecision | null {
  if (value === null) return 'ns';
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'ns':
    case 'nanosecond':
    case 'nanoseconds':
      return 'ns';
    case 'us':
    case 'µs':
    case 'microsecond':
    case 'microseconds':
      return 'us';
    case 'ms':
    case 'millisecond':
    case 'milliseconds':
      return 'ms';
    case 's':
    case 'sec':
    case 'second':
    case 'seconds':
      return 's';
    case 'm':
    case 'min':
    case 'minute':
    case 'minutes':
      return 'm';
    case 'h':
    case 'hour':
    case 'hours':
      return 'h';
    default:
      return null;
  }
}

/** Convert a raw timestamp in the given precision to milliseconds (floor division for negatives) */
export function timestampToMs(raw: string, precision: TimestampPrecision): number {
  if (!/^[+-]?\d+$/.test(raw)) throw new Error(`Invalid timestamp: ${raw}`);
  const value = BigInt(raw);
  let milliseconds: bigint;
  switch (precision) {
    case 'ns':
      milliseconds = floorDiv(value, 1_000_000n);
      break;
    case 'us':
      milliseconds = floorDiv(value, 1_000n);
      break;
    case 'ms':
      milliseconds = value;
      break;
    case 's':
      milliseconds = value * 1_000n;
      break;
    case 'm':
      milliseconds = value * 60_000n;
      break;
    case 'h':
      milliseconds = value * 3_600_000n;
      break;
    default:
      throw new Error(`Invalid precision: ${String(precision)}`);
  }
  const asNumber = Number(milliseconds);
  if (!Number.isSafeInteger(asNumber)) throw new Error(`Timestamp exceeds the safe integer range: ${raw}`);
  return asNumber;
}

export function parseCompatLineProtocol(text: string, options: CompatLineProtocolOptions): CompatParseResult {
  const points: WritePoint[] = [];
  const issues: CompatParseIssue[] = [];
  let tagsFolded = 0;
  let tagsDropped = 0;

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].replace(/\r$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    try {
      const parsed = parseLine(line, options);
      points.push(...parsed.points);
      tagsFolded += parsed.tagsFolded;
      tagsDropped += parsed.tagsDropped;
    } catch (error) {
      issues.push({ line: lineNumber, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { points, issues, tagsFolded, tagsDropped };
}

interface ParsedLine {
  points: WritePoint[];
  tagsFolded: number;
  tagsDropped: number;
}

function parseLine(line: string, options: CompatLineProtocolOptions): ParsedLine {
  const firstSpace = indexOfUnescaped(line, ' ');
  if (firstSpace < 0) throw new Error('Missing field set');
  const head = line.slice(0, firstSpace);
  const remainder = line.slice(firstSpace + 1).trim();
  if (remainder.length === 0) throw new Error('Missing field set');

  const headParts = splitUnescaped(head, ',');
  const measurement = unescapeKey(headParts[0]);
  if (measurement.length === 0) throw new Error('Missing measurement name');

  const pairs: [string, string][] = [];
  const seenTagKeys = new Set<string>();
  for (let index = 1; index < headParts.length; index += 1) {
    const segment = headParts[index];
    const separator = indexOfUnescaped(segment, '=');
    if (separator <= 0) throw new Error(`Invalid tag segment: ${segment}`);
    const key = unescapeKey(segment.slice(0, separator));
    const value = unescapeKey(segment.slice(separator + 1));
    if (key.length === 0) throw new Error('Empty tag key');
    if (seenTagKeys.has(key)) throw new Error(`Duplicate tag key: ${key}`);
    seenTagKeys.add(key);
    pairs.push([key, value]);
  }

  const tags = options.tagFolding === 'metric' ? tagsFromPairs(pairs) : {};
  const tagsFolded = options.tagFolding === 'metric' ? pairs.length : 0;
  const tagsDropped = options.tagFolding === 'ignore' ? pairs.length : 0;

  const { fieldSet, timestampToken } = splitFieldSetAndTimestamp(remainder);
  const timestamp =
    timestampToken.length === 0 ? options.nowMs : timestampToMs(timestampToken, options.precision);

  const fieldParts = splitOutsideQuotes(fieldSet, ',');
  if (fieldParts.length === 0 || (fieldParts.length === 1 && fieldParts[0].trim().length === 0)) {
    throw new Error('Missing field set');
  }
  if (fieldParts.length > 1 && options.fieldFolding === 'reject') {
    throw new Error('Multi-field line is rejected by fieldFolding=reject');
  }

  const seenFieldKeys = new Set<string>();
  const points: WritePoint[] = [];
  for (const part of fieldParts) {
    const separator = indexOfUnescaped(part, '=');
    if (separator <= 0) throw new Error(`Invalid field segment: ${part}`);
    const fieldKey = unescapeKey(part.slice(0, separator));
    if (fieldKey.length === 0) throw new Error('Empty field key');
    if (seenFieldKeys.has(fieldKey)) throw new Error(`Duplicate field key: ${fieldKey}`);
    seenFieldKeys.add(fieldKey);

    const value = parseFieldValue(part.slice(separator + 1));
    const metricName = foldMetricName(options.metricPrefix, measurement, fieldKey, tags);
    assertMetricName(metricName);
    points.push({ metricName, timestamp, value });
  }

  return {
    points,
    tagsFolded: tagsFolded * points.length,
    tagsDropped: tagsDropped * points.length,
  };
}

/** Split `<field set> [timestamp]` at the first space outside a quoted string */
function splitFieldSetAndTimestamp(text: string): { fieldSet: string; timestampToken: string } {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (character === ' ' && !inString) {
      return { fieldSet: text.slice(0, index), timestampToken: text.slice(index + 1).trim() };
    }
  }
  if (inString) throw new Error('Unterminated string field value');
  return { fieldSet: text, timestampToken: '' };
}

/** Split a field set on commas that are outside quoted strings */
function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      current += character;
      continue;
    }
    if (character === separator && !inString) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function parseFieldValue(raw: string): WritePoint['value'] {
  const token = raw.trim();
  if (token.length === 0) throw new Error('Empty field value');

  if (token.startsWith('"')) {
    if (!hasClosingQuote(token)) throw new Error('Unterminated string field value');
    const value = unescapeString(token.slice(1, -1));
    if (Buffer.byteLength(value, 'utf8') > WRITE_LIMITS.stringValueMaxBytes) {
      throw new Error(`String field value exceeds ${WRITE_LIMITS.stringValueMaxBytes} bytes`);
    }
    return value;
  }

  const lowered = token.toLowerCase();
  if (lowered === 't' || lowered === 'true') return true;
  if (lowered === 'f' || lowered === 'false') return false;

  if (token.endsWith('u') && /^[+-]?\d+u$/.test(token)) {
    throw new Error('Unsigned integer (u suffix) is not supported');
  }
  if (/^[+-]?\d+i$/.test(token)) {
    const parsed = BigInt(token.slice(0, -1));
    assertInt64(parsed);
    return parsed;
  }
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
    const numeric = Number(token);
    if (!Number.isFinite(numeric)) throw new Error(`Invalid numeric value: ${token}`);
    return numeric;
  }
  throw new Error(`Unsupported field value: ${token}`);
}

function hasClosingQuote(token: string): boolean {
  for (let index = token.length - 1; index > 0; index -= 1) {
    if (token[index] !== '"') continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor > 0 && token[cursor] === '\\'; cursor -= 1) backslashes += 1;
    return backslashes % 2 === 0;
  }
  return false;
}

/** Unescape a measurement / tag / field key (`\,` `\ ` `\=` `\\`) */
function unescapeKey(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) {
      const next = text[index + 1];
      if (next === ',' || next === ' ' || next === '=' || next === '\\') {
        out += next;
        index += 1;
        continue;
      }
    }
    out += character;
  }
  return out;
}

/** Unescape a quoted string field value (`\"` `\\`) */
function unescapeString(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) {
      const next = text[index + 1];
      if (next === '"' || next === '\\') {
        out += next;
        index += 1;
        continue;
      }
    }
    out += character;
  }
  return out;
}

function assertInt64(value: bigint): void {
  const limit = BigInt(WRITE_LIMITS.int64MaxSafeInteger);
  if (value > limit || value < -limit) {
    throw new Error(`Integer value exceeds the ±2^53 range: ${value.toString()}`);
  }
}

function assertMetricName(metricName: string): void {
  if (/[\u0000-\u001f\u007f]/.test(metricName)) {
    throw new Error('Metric name contains control characters after folding');
  }
  if (metricNameByteLength(metricName) > METRIC_NAME_MAX_BYTES) {
    throw new Error(`Metric name exceeds ${METRIC_NAME_MAX_BYTES} bytes after folding: ${metricName}`);
  }
}

/** First index of `character` that is not escaped by a backslash */
function indexOfUnescaped(text: string, character: string): number {
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (current === '\\') {
      escaped = true;
      continue;
    }
    if (current === character) return index;
  }
  return -1;
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  if (value % divisor !== 0n && value < 0n) return quotient - 1n;
  return quotient;
}
