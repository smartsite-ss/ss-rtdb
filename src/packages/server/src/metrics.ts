// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Prometheus text exposition of the §3.4 status metrics (S14).
 *
 * Purpose: expose every field of the `/api/v1/status` report over `GET /metrics` in the
 * Prometheus text format (version 0.0.4) so an external scraper can collect them.
 * Design points:
 *   - Zero dependencies: the text format is rendered by hand, no Prometheus client library.
 *   - One metric family per status field; names and label sets are stable and documented in
 *     the Detailed Design §3.4. Absolute byte / second units are used (the status report uses
 *     size suffixes and milliseconds, which are awkward for Prometheus).
 *   - No database / metric labels: the status report is an aggregate, so samples carry no labels
 *     except the `quantile` label of the query latency family.
 */

import type { EngineStats } from '../../core/src/engine.ts';

/* ---------- Constants ---------- */

/** Prometheus text format content type (version 0.0.4), matching the prometheus/client_golang exposition */
export const PROMETHEUS_METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const BYTES_PER_MEBIBYTE = 1_048_576;
const MILLISECONDS_PER_SECOND = 1_000;

/* ---------- Public types ---------- */

export interface PrometheusMetricsInput {
  /** Engine runtime metrics (§3.4) */
  stats: EngineStats;
  /** Line Protocol tag fragments ignored this session (server-layer counter, not part of `EngineStats`) */
  tagsIgnored: number;
  /** InfluxDB compatibility counters (null when the compatibility layer is disabled) */
  compat?: InfluxCompatCounters | null;
}

/** Minimal structural copy of the compat counters to keep `metrics.ts` free of handler imports */
export interface InfluxCompatCounters {
  requests: number;
  writePoints: number;
  duplicates: number;
  truncatedPoints: number;
  rejectedLines: number;
  tagsFolded: number;
  tagsDropped: number;
  influxqlQueries: number;
  unmappedMetrics: number;
  cardinalityWarn: boolean;
}

interface PrometheusSample {
  /** Pre-rendered label block (e.g. `quantile="0.5"`), omitted when empty */
  labels?: string;
  value: number;
}

/* ---------- Rendering ---------- */

/**
 * Render the §3.4 status metrics as a Prometheus text exposition body.
 * The output always ends with a trailing newline (required by the text format).
 */
export function encodePrometheusMetrics(input: PrometheusMetricsInput): string {
  const { stats, tagsIgnored, compat } = input;
  const lines: string[] = [];

  appendFamily(lines, 'rtdb_uptime_seconds', 'Seconds elapsed since the engine was opened.', 'gauge', [
    { value: stats.uptimeMs / MILLISECONDS_PER_SECOND },
  ]);
  appendFamily(lines, 'rtdb_databases', 'Number of databases under the data root.', 'gauge', [{ value: stats.databases }]);
  appendFamily(lines, 'rtdb_metrics', 'Number of metrics across all databases.', 'gauge', [{ value: stats.metrics }]);

  appendFamily(lines, 'rtdb_write_points_per_second', 'Session-average accepted points per second.', 'gauge', [
    { value: stats.write.pointsPerSec },
  ]);
  appendFamily(lines, 'rtdb_write_buffered_points', 'Points accepted but not yet sealed into a block.', 'gauge', [
    { value: stats.write.bufferedPoints },
  ]);
  appendFamily(lines, 'rtdb_write_duplicate_points_total', 'Duplicate points silently discarded this session.', 'counter', [
    { value: stats.write.duplicatePoints },
  ]);
  appendFamily(lines, 'rtdb_write_tags_ignored_total', 'Line Protocol tag fragments ignored this session.', 'counter', [
    { value: tagsIgnored },
  ]);

  appendFamily(lines, 'rtdb_wal_pending_bytes', 'Unreleased WAL bytes.', 'gauge', [{ value: stats.wal.pendingBytes }]);
  appendFamily(lines, 'rtdb_wal_outstanding_batches', 'Outstanding WAL batches.', 'gauge', [
    { value: stats.wal.outstandingBatches },
  ]);
  appendFamily(lines, 'rtdb_wal_pending_points', 'Points in outstanding WAL batches.', 'gauge', [
    { value: stats.wal.pendingPoints },
  ]);
  appendFamily(lines, 'rtdb_wal_last_fsync_timestamp_seconds', 'Epoch seconds of the last WAL group fsync (0 = none).', 'gauge', [
    { value: stats.wal.lastFsyncMs / MILLISECONDS_PER_SECOND },
  ]);

  appendFamily(lines, 'rtdb_segments_open_files', 'Live segment file handle count.', 'gauge', [{ value: stats.segments.openFiles }]);
  appendFamily(lines, 'rtdb_segments_bytes_today', 'Bytes occupied by the current day directories across all databases.', 'gauge', [
    { value: stats.segments.bytesToday },
  ]);

  appendFamily(lines, 'rtdb_process_cpu_percent', 'Process CPU usage since the previous sample, percent of one core.', 'gauge', [
    { value: stats.cpu.percent },
  ]);
  appendFamily(
    lines,
    'rtdb_process_cpu_system_percent',
    'Process CPU usage since the previous sample, percent of the whole machine ([0,100]).',
    'gauge',
    [{ value: stats.cpu.systemPercent }],
  );
  appendFamily(lines, 'rtdb_process_cpu_user_seconds_total', 'Cumulative process user CPU time since the engine was opened.', 'counter', [
    { value: stats.cpu.userMs / MILLISECONDS_PER_SECOND },
  ]);
  appendFamily(lines, 'rtdb_process_cpu_system_seconds_total', 'Cumulative process kernel CPU time since the engine was opened.', 'counter', [
    { value: stats.cpu.systemMs / MILLISECONDS_PER_SECOND },
  ]);
  appendFamily(lines, 'rtdb_process_resident_memory_bytes', 'Resident set size (bytes).', 'gauge', [
    { value: stats.memory.rssMb * BYTES_PER_MEBIBYTE },
  ]);
  appendFamily(lines, 'rtdb_process_memory_usage_percent', 'RSS as a percentage of host total memory ([0,100]).', 'gauge', [
    { value: stats.memory.systemPercent },
  ]);
  appendFamily(lines, 'rtdb_process_heap_total_bytes', 'Node heap total (bytes).', 'gauge', [
    { value: stats.memory.heapTotalMb * BYTES_PER_MEBIBYTE },
  ]);
  appendFamily(lines, 'rtdb_process_heap_usage_percent', 'Heap used / heap total ([0,100]).', 'gauge', [
    { value: stats.memory.heapPercent },
  ]);

  appendFamily(lines, 'rtdb_cache_blocks', 'Decoded block cache entries.', 'gauge', [{ value: stats.cache.blocks }]);
  appendFamily(lines, 'rtdb_cache_block_hit_rate', 'Decoded block cache hit rate this session ([0,1]).', 'gauge', [
    { value: stats.cache.blockHitRate },
  ]);
  appendFamily(lines, 'rtdb_process_heap_used_bytes', 'Node heap used (bytes).', 'gauge', [
    { value: stats.cache.heapUsedMb * BYTES_PER_MEBIBYTE },
  ]);
  appendFamily(lines, 'rtdb_process_external_bytes', 'Node external memory including ArrayBuffers (bytes).', 'gauge', [
    { value: stats.cache.externalMb * BYTES_PER_MEBIBYTE },
  ]);

  appendFamily(lines, 'rtdb_gc_count_total', 'GC cycles observed since the engine was opened.', 'counter', [
    { value: stats.gc.count },
  ]);
  appendFamily(lines, 'rtdb_gc_pause_total_seconds', 'Cumulative GC pause since the engine was opened.', 'counter', [
    { value: stats.gc.totalMs / MILLISECONDS_PER_SECOND },
  ]);
  appendFamily(lines, 'rtdb_gc_pause_max_seconds', 'Longest single GC pause since the engine was opened.', 'gauge', [
    { value: stats.gc.maxMs / MILLISECONDS_PER_SECOND },
  ]);

  appendFamily(lines, 'rtdb_query_count_total', 'Successful queries executed since the engine was opened.', 'counter', [
    { value: stats.query.count },
  ]);
  appendFamily(lines, 'rtdb_query_duration_seconds', 'Query latency quantile over the recent sample window.', 'gauge', [
    { labels: 'quantile="0.5"', value: stats.query.p50Ms / MILLISECONDS_PER_SECOND },
    { labels: 'quantile="0.95"', value: stats.query.p95Ms / MILLISECONDS_PER_SECOND },
    { labels: 'quantile="0.99"', value: stats.query.p99Ms / MILLISECONDS_PER_SECOND },
  ]);
  appendFamily(lines, 'rtdb_query_duration_max_seconds', 'Longest observed query latency over the recent sample window.', 'gauge', [
    { value: stats.query.maxMs / MILLISECONDS_PER_SECOND },
  ]);

  if (compat !== undefined && compat !== null) {
    appendFamily(lines, 'rtdb_compat_influx_requests_total', 'InfluxDB compatibility requests handled.', 'counter', [
      { value: compat.requests },
    ]);
    appendFamily(lines, 'rtdb_compat_influx_write_points_total', 'Points accepted through InfluxDB write endpoints.', 'counter', [
      { value: compat.writePoints },
    ]);
    appendFamily(lines, 'rtdb_compat_influx_write_duplicates_total', 'InfluxDB write points discarded as duplicates.', 'counter', [
      { value: compat.duplicates },
    ]);
    appendFamily(lines, 'rtdb_compat_influx_truncated_points_total', 'Points merged because of ns-to-ms truncation.', 'counter', [
      { value: compat.truncatedPoints },
    ]);
    appendFamily(lines, 'rtdb_compat_influx_rejected_lines_total', 'Line Protocol lines rejected in partial-write mode.', 'counter', [
      { value: compat.rejectedLines },
    ]);
    appendFamily(lines, 'rtdb_compat_influx_tags_folded_total', 'Tag fragments folded into metric names.', 'counter', [
      { value: compat.tagsFolded },
    ]);
    appendFamily(lines, 'rtdb_compat_influx_tags_dropped_total', 'Tag fragments dropped (tagFolding=ignore).', 'counter', [
      { value: compat.tagsDropped },
    ]);
    appendFamily(lines, 'rtdb_compat_influx_influxql_queries_total', 'InfluxQL subset queries executed.', 'counter', [
      { value: compat.influxqlQueries },
    ]);
    appendFamily(lines, 'rtdb_compat_influx_unmapped_metrics_total', 'Metric names skipped because they cannot be unfolded.', 'counter', [
      { value: compat.unmappedMetrics },
    ]);
    appendFamily(lines, 'rtdb_compat_influx_cardinality_warn', '1 when folded metric cardinality crossed the warn threshold.', 'gauge', [
      { value: compat.cardinalityWarn ? 1 : 0 },
    ]);
  }

  return `${lines.join('\n')}\n`;
}

function appendFamily(
  lines: string[],
  name: string,
  help: string,
  type: 'gauge' | 'counter',
  samples: readonly PrometheusSample[],
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  for (const sample of samples) {
    if (sample.labels === undefined) {
      lines.push(`${name} ${formatMetricValue(sample.value)}`);
    } else {
      lines.push(`${name}{${sample.labels}} ${formatMetricValue(sample.value)}`);
    }
  }
}

/** Render a sample value; the text format uses the Gleam-style `NaN` / `+Inf` / `-Inf` spellings */
function formatMetricValue(value: number): string {
  if (Number.isFinite(value)) return String(value);
  if (Number.isNaN(value)) return 'NaN';
  return value > 0 ? '+Inf' : '-Inf';
}
