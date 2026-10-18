// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxDB compatibility: metric-name folding and unfolding
 *
 * InfluxDB identifies a series by `measurement + tag set` and allows several typed fields per point;
 * ss-rtdb identifies a point by a single flat `metricName` and a single value. The compatibility layer maps
 * `(measurement, tag set, field)` onto one metric name with a deterministic, reversible encoding:
 *
 *   metricName = [prefix]<measurement>|<field>[|<tagKey>=<tagValue>]...   (tag keys sorted ascending)
 *
 * Escape rules (applied to every component): `\` -> `\\`, `|` -> `\|`, `=` -> `\=`.
 * The encoding is the single authority for both the write path (fold) and the InfluxQL read path (unfold);
 * native metric names that do not match the shape simply unfold to `null` and are invisible to InfluxQL.
 */

/** Metric name cap enforced by the core write path (UTF-8 bytes) */
export const METRIC_NAME_MAX_BYTES = 512;

/** Database name rule shared with the native server routes */
const DATABASE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;

export interface MetricIdentity {
  measurement: string;
  field: string;
  tags: Record<string, string>;
}

/** Escape one component of the folded metric name */
export function escapeComponent(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/=/g, '\\=');
}

/** Reverse {@link escapeComponent}; unknown escape sequences are kept verbatim */
export function unescapeComponent(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\' || index + 1 >= value.length) {
      out += character;
      continue;
    }
    const next = value[index + 1];
    if (next === '\\' || next === '|' || next === '=') {
      out += next;
      index += 1;
      continue;
    }
    out += character;
  }
  return out;
}

/** Split on a separator that is not escaped by a backslash; escapes stay in the segments */
export function splitUnescaped(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
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
    if (character === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** Fold `(measurement, field, tags)` into one metric name */
export function foldMetricName(
  prefix: string,
  measurement: string,
  field: string,
  tags: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [escapeComponent(measurement), escapeComponent(field)];
  for (const key of Object.keys(tags).sort()) {
    parts.push(`${escapeComponent(key)}=${escapeComponent(tags[key])}`);
  }
  return `${prefix}${parts.join('|')}`;
}

/**
 * Unfold a metric name produced by {@link foldMetricName}.
 * Returns `null` for names outside the compatibility namespace (native metrics, truncated or malformed names).
 */
export function unfoldMetricName(prefix: string, metricName: string): MetricIdentity | null {
  if (prefix.length > 0) {
    if (!metricName.startsWith(prefix)) return null;
    metricName = metricName.slice(prefix.length);
  }
  const parts = splitUnescaped(metricName, '|');
  if (parts.length < 2) return null;
  const measurement = unescapeComponent(parts[0]);
  const field = unescapeComponent(parts[1]);
  if (measurement.length === 0 || field.length === 0) return null;
  const tags: Record<string, string> = {};
  for (let index = 2; index < parts.length; index += 1) {
    const segment = parts[index];
    const separatorIndex = findUnescaped(segment, '=');
    if (separatorIndex <= 0) return null;
    const key = unescapeComponent(segment.slice(0, separatorIndex));
    const value = unescapeComponent(segment.slice(separatorIndex + 1));
    if (key.length === 0) return null;
    tags[key] = value;
  }
  return { measurement, field, tags };
}

/** Build a tag map from `key=value` pairs already unescaped; duplicate keys are rejected by the caller */
export function tagsFromPairs(pairs: readonly (readonly [string, string])[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of pairs) tags[key] = value;
  return tags;
}

/** UTF-8 byte length of a metric name (used before handing points to the engine) */
export function metricNameByteLength(metricName: string): number {
  return Buffer.byteLength(metricName, 'utf8');
}

export function isDatabaseName(value: string): boolean {
  return DATABASE_NAME_PATTERN.test(value);
}

/**
 * Map an InfluxDB bucket name onto a database name.
 *
 * InfluxDB bucket names are more permissive than ss-rtdb database names (they may contain `-`, `.` and
 * spaces), so an invalid name is normalized deterministically: invalid characters become `_`, a leading
 * digit is prefixed with `b_`, and the result is truncated to 63 characters. The resolved database is
 * echoed back in the `X-Rtdb-Database` response header so the mapping stays observable.
 */
export function resolveBucketDatabase(bucket: string): string {
  if (DATABASE_NAME_PATTERN.test(bucket)) return bucket;
  let normalized = bucket.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/^[a-zA-Z]/.test(normalized)) normalized = `b_${normalized}`;
  normalized = normalized.slice(0, 63);
  return normalized.length > 0 ? normalized : 'b_bucket';
}

/** Find the first occurrence of `character` that is not preceded by a backslash */
function findUnescaped(text: string, character: string): number {
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
