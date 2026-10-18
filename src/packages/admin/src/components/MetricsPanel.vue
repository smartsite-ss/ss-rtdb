<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Metric browser: pick a database, pick a metric, then preview a time range raw, window-aggregated or
 * point-in-time interpolated.
 *
 * Uses `GET /api/v1/databases`, `GET /api/v1/metrics/{db}` plus `POST /api/v1/query/range` /
 * `POST /api/v1/query/aggregate` / `POST /api/v1/query/at` only, so the preview is exactly the data a
 * client of the public REST API would receive. The panel also states the interpolation / aggregation
 * rules next to the controls, because a raw curve connects stored samples directly (no interpolation),
 * an `avg` window is time-weighted, and the interpolation modes resample the series at a uniform grid
 * (`step` = previous-value hold, `linear` = piecewise-linear) with per-point provenance markers.
 */

import { computed, onMounted, ref, watch } from 'vue';
import LineChart from './LineChart.vue';
import TimeRangePicker from './TimeRangePicker.vue';
import { RTDB_AGGREGATE_TYPE, RTDB_INTERPOLATION_MODE, RTDB_VALUE_TYPE, RtdbAdminApiClient } from '../api';
import type {
  RtdbAggregateType,
  RtdbAggregateWindow,
  RtdbAtPoint,
  RtdbInterpolationMode,
  RtdbJsonPoint,
  RtdbJsonSeries,
  RtdbMetricSummary,
} from '../api';
import { useAsyncAction } from '../async';
import {
  formatDateTime,
  formatDateTimeWithOffset,
  formatNumber,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
} from '../format';
import { mapWithLimit } from '../concurrency';
import { t } from '../i18n';
import { downloadCsv } from '../csv-download';
import { downloadXlsWorkbook } from '../xls-download';
import type { XlsCellValue } from '../xls';

const props = defineProps<{ client: RtdbAdminApiClient }>();

const DEFAULT_RANGE_MILLISECONDS = 3_600_000;
const DEFAULT_LIMIT = 2_000;
const DEFAULT_WINDOW_SECONDS = 60;
/** A raw interval above this multiple of the median counts as a gap in the hint line */
const GAP_FACTOR = 3;
/** Server-side cap of one `query/at` call; a window that would exceed it is rejected instead of clamped */
const MAX_QUERY_AT_TIMESTAMPS = 10_000;
/**
 * The live-value refresh issues one `query/last` per metric, and on a busy database one such query can take
 * ~1.5 s (block lookup on a 200 MB segment). The limits below deliberately leave most of the browser's 6
 * connections free for real queries: never occupy the pool with a background nicety.
 */
const LIVE_METRIC_LIMIT = 50;
const LIVE_CONCURRENCY = 3;

const AGGREGATE_TYPES: RtdbAggregateType[] = Object.values(RTDB_AGGREGATE_TYPE);
const INTERPOLATION_MODES: RtdbInterpolationMode[] = Object.values(RTDB_INTERPOLATION_MODE);

/** `vt` marker → display name, mirroring the engine's `VALUE_TYPE_NAME` */
const VALUE_TYPE_NAMES: Record<number, string> = {
  [RTDB_VALUE_TYPE.float64]: 'f64',
  [RTDB_VALUE_TYPE.int64]: 'i64',
  [RTDB_VALUE_TYPE.bool]: 'bool',
  [RTDB_VALUE_TYPE.string]: 'string',
};

/** Display name of a metric's locked value type (`—` when unknown) */
function valueTypeName(valueType: number | null): string {
  return valueType === null ? '—' : VALUE_TYPE_NAMES[valueType] ?? '—';
}

const WINDOW_UNITS = { s: 1, m: 60, h: 3_600 } as const;
type WindowUnit = keyof typeof WINDOW_UNITS;

const { busy, errorMessage, run } = useAsyncAction();
/** One card, two tabs: the inventory (catalogue + live values) and the range preview (query + chart) */
type MetricsTab = 'inventory' | 'preview';
const PREVIEW_ENDPOINTS =
  'POST /api/v1/query/range · POST /api/v1/query/aggregate · POST /api/v1/query/at';
const activeTab = ref<MetricsTab>('inventory');
const databases = ref<string[]>([]);
const selectedDatabase = ref('');
const metrics = ref<RtdbMetricSummary[]>([]);
const selectedMetric = ref('');
const startInput = ref('');
const endInput = ref('');
const limitInput = ref(String(DEFAULT_LIMIT));
const aggregateType = ref<'none' | RtdbAggregateType>('none');
const windowValue = ref(String(DEFAULT_WINDOW_SECONDS));
const windowUnit = ref<WindowUnit>('s');
/** `none` = interpolation off; otherwise the preview resamples the series via `POST /api/v1/query/at` */
const interpolationMode = ref<'none' | RtdbInterpolationMode>('none');
/** Exactly one of the three previews is non-null after a successful query */
const rawSeries = ref<RtdbJsonSeries | null>(null);
const aggregateWindows = ref<RtdbAggregateWindow[] | null>(null);
const atPoints = ref<RtdbAtPoint[] | null>(null);
/** Elapsed wall time of the last successful query (ms), shown next to the summary line */
const queryElapsedMs = ref<number | null>(null);
/** Newest point per metric (`query/last`), filled by the live-value refresh; `null` = no point / not queried */
const latestByMetric = ref<Record<string, RtdbJsonPoint | null>>({});
const latestLoading = ref(false);
/** Wall time of the last live-value refresh (`null` before the first one) */
const latestLoadedAt = ref<number | null>(null);
/** Progress of the running refresh (`done / total`), drives the button label */
const latestProgress = ref({ done: 0, total: 0 });
/** `true` when the database has more metrics than {@link LIVE_METRIC_LIMIT}, so only the first page is live */
const latestCapped = computed(() => metrics.value.length > LIVE_METRIC_LIMIT);
/** Monotonic refresh id: a newer refresh (or a database switch) invalidates the in-flight one */
let latestRequestId = 0;

const hasPreview = computed(
  () => rawSeries.value !== null || aggregateWindows.value !== null || atPoints.value !== null,
);

/** Selected metric's stored span, offered as the "All" preset inside the range control */
const spanStart = computed(() => metrics.value.find((entry) => entry.metricName === selectedMetric.value)?.firstTs ?? null);
const spanEnd = computed(() => metrics.value.find((entry) => entry.metricName === selectedMetric.value)?.lastTs ?? null);

/** Distinct string values of the raw series in first-appearance order; a string series is plotted as state levels 1..N */
const stringLevels = computed<string[]>(() => {
  const current = rawSeries.value;
  if (current === null) return [];
  const levels: string[] = [];
  for (const point of current.points) {
    if (typeof point.v === 'string' && point.vt === RTDB_VALUE_TYPE.string && !levels.includes(point.v)) {
      levels.push(point.v);
    }
  }
  return levels;
});

const chartPoints = computed<{ t: number; value: number }[]>(() => {
  const points: { t: number; value: number }[] = [];
  if (atPoints.value !== null) {
    for (const point of atPoints.value) {
      if (point.v === null) continue;
      const value = RtdbAdminApiClient.toNumericValue({ t: point.t, v: point.v, vt: point.vt });
      if (value !== null) points.push({ t: point.t, value });
    }
    return points;
  }
  if (aggregateWindows.value !== null) {
    for (const window of aggregateWindows.value) {
      const value = RtdbAdminApiClient.toNumericValue({ t: window.start, v: window.v, vt: window.vt });
      if (value !== null) points.push({ t: window.start, value });
    }
    return points;
  }
  const current = rawSeries.value;
  if (current === null) return points;
  for (const point of current.points) {
    if (typeof point.v === 'string' && point.vt === RTDB_VALUE_TYPE.string) {
      points.push({ t: point.t, value: stringLevels.value.indexOf(point.v) + 1 });
      continue;
    }
    const value = RtdbAdminApiClient.toNumericValue(point);
    if (value !== null) points.push({ t: point.t, value });
  }
  return points;
});

const sampleCount = computed(() => {
  if (atPoints.value !== null) return atPoints.value.length;
  if (aggregateWindows.value !== null) return aggregateWindows.value.length;
  return rawSeries.value?.points.length ?? 0;
});

const skippedPointCount = computed(() => sampleCount.value - chartPoints.value.length);

/** Provenance breakdown of the interpolation preview (zeroed for the other two preview kinds) */
const atStateCounts = computed<Record<RtdbAtPoint['state'], number> | null>(() => {
  if (atPoints.value === null) return null;
  const counts: Record<RtdbAtPoint['state'], number> = {
    exact: 0,
    interpolated: 0,
    extrapolated: 0,
    'no-data': 0,
  };
  for (const point of atPoints.value) counts[point.state] += 1;
  return counts;
});

/** Median / largest sampling interval of the raw curve, used to explain gaps in the hint line */
const intervalStats = computed<{ medianMs: number; maxMs: number; gaps: number } | null>(() => {
  if (aggregateWindows.value !== null || atPoints.value !== null) return null;
  const points = chartPoints.value;
  if (points.length < 3) return null;
  const deltas: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    deltas.push(points[index].t - points[index - 1].t);
  }
  deltas.sort((left, right) => left - right);
  const medianMs = deltas[Math.floor(deltas.length / 2)];
  const maxMs = deltas[deltas.length - 1];
  const gaps = medianMs > 0 ? deltas.filter((delta) => delta > medianMs * GAP_FACTOR).length : 0;
  return { medianMs, maxMs, gaps };
});

/** Compact interval label (`850 ms` / `1.00 s` / `2.50 min`) */
function formatInterval(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2)} s`;
  return `${(milliseconds / 60_000).toFixed(2)} min`;
}

/** Compact query-elapsed label (`12 ms` / `0.85 s`) */
function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}

function resetRange(): void {
  const now = Date.now();
  endInput.value = toDateTimeLocalValue(now, true);
  startInput.value = toDateTimeLocalValue(now - DEFAULT_RANGE_MILLISECONDS, true);
}

function clearPreview(): void {
  rawSeries.value = null;
  aggregateWindows.value = null;
  atPoints.value = null;
}

/** Newest point of one metric (`undefined` = not loaded yet, `null` = metric has no point) */
function livePoint(metricName: string): RtdbJsonPoint | null | undefined {
  return latestByMetric.value[metricName];
}

/** Display form of a live point's value (`—` when the metric has no point) */
function formatLiveValue(point: RtdbJsonPoint | null | undefined): string {
  if (point === null || point === undefined || point.v === null) return '—';
  if (typeof point.v === 'number') return formatNumber(point.v);
  if (typeof point.v === 'boolean') return point.v ? 'true' : 'false';
  return point.v;
}

/** Timestamp of a live point's newest sample (`—` when the metric has no point) */
function liveUpdatedAt(metricName: string): string {
  const point = latestByMetric.value[metricName];
  return point === undefined || point === null ? '—' : formatDateTime(point.t);
}

/**
 * Load the newest point of every listed metric (`POST /api/v1/query/last`, one request per metric).
 *
 * Bounded on purpose: at most {@link LIVE_METRIC_LIMIT} metrics and {@link LIVE_CONCURRENCY} requests in flight, so a
 * database with thousands of metrics cannot flood the console. A failed single metric simply shows `—`; the rows
 * stay usable and the next refresh retries it.
 */
async function refreshLiveValues(): Promise<void> {
  const database = selectedDatabase.value;
  if (database.length === 0 || metrics.value.length === 0) {
    latestByMetric.value = {};
    latestLoadedAt.value = null;
    return;
  }
  const requestId = (latestRequestId += 1);
  const targets = metrics.value.slice(0, LIVE_METRIC_LIMIT);
  const snapshot: Record<string, RtdbJsonPoint | null> = {};
  latestProgress.value = { done: 0, total: targets.length };
  latestLoading.value = true;
  try {
    await mapWithLimit(targets, LIVE_CONCURRENCY, async (metric) => {
      try {
        snapshot[metric.metricName] = await props.client.queryLast(database, metric.metricName);
      } catch {
        snapshot[metric.metricName] = null;
      }
      if (requestId === latestRequestId) {
        latestProgress.value = { done: latestProgress.value.done + 1, total: targets.length };
      }
    });
    // Switching database / reloading while a refresh is in flight: drop the stale snapshot.
    if (requestId !== latestRequestId) return;
    latestByMetric.value = snapshot;
    latestLoadedAt.value = Date.now();
  } finally {
    if (requestId === latestRequestId) latestLoading.value = false;
  }
}

async function loadDatabases(): Promise<void> {
  const list = await run(() => props.client.listDatabases());
  if (list === undefined) return;
  databases.value = list;
  if (list.length === 0) {
    selectedDatabase.value = '';
    metrics.value = [];
    selectedMetric.value = '';
    latestByMetric.value = {};
    latestLoadedAt.value = null;
    return;
  }
  if (!list.includes(selectedDatabase.value)) {
    selectedDatabase.value = list[0];
    await loadMetrics();
  }
}

async function selectDatabase(): Promise<void> {
  clearPreview();
  latestByMetric.value = {};
  latestLoadedAt.value = null;
  await loadMetrics();
}

async function loadMetrics(): Promise<void> {
  const database = selectedDatabase.value;
  clearPreview();
  latestByMetric.value = {};
  latestLoadedAt.value = null;
  if (database.length === 0) {
    metrics.value = [];
    selectedMetric.value = '';
    return;
  }
  const list = await run(() => props.client.listMetrics(database));
  if (list === undefined) return;
  metrics.value = list;
  selectedMetric.value = list.length > 0 ? list[0].metricName : '';
  // Live values are NOT loaded automatically: one `query/last` per metric can take ~1.5 s on a busy database,
  // and occupying the browser's connections in the background is exactly what makes real queries feel slow.
}

function selectMetric(metricName: string): void {
  selectedMetric.value = metricName;
  // Picking a row means "show me this variable": switch to the preview tab and redraw it.
  activeTab.value = 'preview';
  clearPreview();
  void runQuery();
}

/** Combobox change in the preview: switch the variable and immediately redraw it */
function onMetricSelect(): void {
  clearPreview();
  void runQuery();
}

/** Window width in milliseconds from the value + unit inputs; `0` when the input is not a positive integer */
function resolveWindowMs(): number {
  const parsed = Number(windowValue.value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return parsed * WINDOW_UNITS[windowUnit.value] * 1_000;
}

/**
 * Evaluation grid for interpolation: a fixed stride equal to the window width, anchored at `start`
 * (`start, start + step, … ≤ end`). Aggregation windows and interpolation samples therefore share the
 * same time grid, and the sample count follows the window instead of the row limit.
 *
 * @throws when the window produces more than `MAX_QUERY_AT_TIMESTAMPS` samples (the caller reports it)
 */
function buildInterpolationGrid(start: number, end: number, stepMs: number): number[] {
  if (stepMs <= 0) return [start];
  const samples = Math.floor((end - start) / stepMs) + 1;
  if (samples > MAX_QUERY_AT_TIMESTAMPS) {
    throw new Error(
      t('metrics.error.tooManySamples', {
        samples: String(samples),
        max: String(MAX_QUERY_AT_TIMESTAMPS),
      }),
    );
  }
  const grid: number[] = [];
  for (let index = 0; index < samples; index += 1) grid.push(start + index * stepMs);
  return grid;
}

async function runQuery(): Promise<void> {
  const database = selectedDatabase.value;
  const metricName = selectedMetric.value;
  const start = fromDateTimeLocalValue(startInput.value);
  const end = fromDateTimeLocalValue(endInput.value);
  const parsedLimit = Number(limitInput.value);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT;
  const type = aggregateType.value;
  const mode = interpolationMode.value;
  const windowMs = resolveWindowMs();
  const startedAt = performance.now();

  const result = await run(async () => {
    if (database.length === 0) throw new Error(t('metrics.error.selectDatabase'));
    if (metricName.length === 0) throw new Error(t('metrics.error.selectMetric'));
    if (start <= 0 || end <= 0) throw new Error(t('metrics.error.invalidTime'));
    if (end < start) throw new Error(t('metrics.error.endBeforeStart'));
    if (mode !== 'none') {
      // Interpolation is window-driven as well: the window is the resampling stride.
      if (windowMs <= 0) throw new Error(t('metrics.error.invalidWindow'));
      const points = await props.client.queryAt(
        database,
        metricName,
        buildInterpolationGrid(start, end, windowMs),
        mode,
      );
      return { raw: null as RtdbJsonSeries | null, windows: null as RtdbAggregateWindow[] | null, at: points };
    }
    if (type === 'none') {
      const raw = await props.client.queryRange(database, metricName, start, end, limit);
      return { raw, windows: null as RtdbAggregateWindow[] | null, at: null as RtdbAtPoint[] | null };
    }
    if (windowMs <= 0) throw new Error(t('metrics.error.invalidWindow'));
    const windows = await props.client.queryAggregate(database, metricName, start, end, type, windowMs);
    return { raw: null as RtdbJsonSeries | null, windows, at: null as RtdbAtPoint[] | null };
  });
  if (result === undefined) return;
  queryElapsedMs.value = performance.now() - startedAt;
  rawSeries.value = result.raw;
  aggregateWindows.value = result.windows;
  atPoints.value = result.at;
}

/**
 * Export the metric inventory of the selected database as CSV (one row per metric).
 *
 * The CSV keeps both the human-readable local timestamp and the raw millisecond epoch, so the file is usable
 * in a spreadsheet and as machine input (join key = metric name + first/last ms).
 */
function exportMetricsCsv(): void {
  const database = selectedDatabase.value;
  if (database.length === 0 || metrics.value.length === 0) return;
  const columns = [
    t('metrics.csv.database'),
    t('metrics.csv.metric'),
    t('metrics.csv.type'),
    t('metrics.csv.firstPoint'),
    t('metrics.csv.firstMs'),
    t('metrics.csv.lastPoint'),
    t('metrics.csv.lastMs'),
  ];
  const rows = metrics.value.map((metric) => [
    database,
    metric.metricName,
    valueTypeName(metric.valueType),
    formatDateTimeWithOffset(metric.firstTs),
    metric.firstTs,
    formatDateTimeWithOffset(metric.lastTs),
    metric.lastTs,
  ]);
  const stamp = formatDateTime(Date.now()).replaceAll(/[: ]/g, '-');
  const safeDatabase = database.replaceAll(/[^A-Za-z0-9._-]+/g, '_');
  downloadCsv(`metrics-${safeDatabase}-${stamp}.csv`, columns, rows);
}

/** `range`/`aggregate` export of the current preview as an Excel-readable `*.xls` */
function exportCurrent(): void {
  const stamp = formatDateTime(Date.now()).replaceAll(/[: ]/g, '-');
  const fileName = `${selectedMetric.value.replaceAll(/[^A-Za-z0-9._-]+/g, '_')}-${stamp}`;

  if (rawSeries.value !== null) {
    const rows = rawSeries.value.points.map((point) => exportRow(point));
    downloadXlsWorkbook(`${fileName}-range.xls`, [
      {
        name: 'range',
        columns: [
          t('metrics.xls.timestamp'),
          t('metrics.xls.time'),
          t('metrics.xls.value'),
          t('metrics.xls.type'),
          t('metrics.xls.quality'),
        ],
        rows,
      },
    ]);
    return;
  }
  if (atPoints.value !== null) {
    const rows = atPoints.value.map((point) => [
      point.t,
      formatDateTime(point.t),
      point.v as XlsCellValue,
      point.state,
    ]);
    downloadXlsWorkbook(`${fileName}-at.xls`, [
      {
        name: 'at',
        columns: [
          t('metrics.xls.timestamp'),
          t('metrics.xls.time'),
          t('metrics.xls.value'),
          t('metrics.xls.state'),
        ],
        rows,
      },
    ]);
    return;
  }
  if (aggregateWindows.value !== null) {
    const rows = aggregateWindows.value.map((window) => [
      window.start,
      formatDateTime(window.start),
      window.end,
      formatDateTime(window.end),
      window.v as XlsCellValue,
      window.vt,
      window.count,
    ]);
    downloadXlsWorkbook(`${fileName}-aggregate.xls`, [
      {
        name: 'aggregate',
        columns: [
          t('metrics.xls.windowStartMs'),
          t('metrics.xls.windowStart'),
          t('metrics.xls.windowEndMs'),
          t('metrics.xls.windowEnd'),
          t('metrics.xls.value'),
          t('metrics.xls.type'),
          t('metrics.xls.count'),
        ],
        rows,
      },
    ]);
  }
}

function exportRow(point: RtdbJsonPoint): XlsCellValue[] {
  return [point.t, formatDateTime(point.t), point.v as XlsCellValue, point.vt, point.q ?? null];
}

onMounted(() => {
  resetRange();
  void loadDatabases();
});

watch(
  () => props.client,
  () => {
    resetRange();
    void loadDatabases();
  },
);
</script>

<template>
  <section class="panel">
    <div class="card">
      <div class="card-title">
        <span>{{ activeTab === 'inventory' ? t('metrics.inventoryTitle') : t('metrics.previewTitle') }}</span>
        <span class="card-title-note">
          {{ activeTab === 'inventory' ? 'GET /api/v1/metrics/{database}' : PREVIEW_ENDPOINTS }}
        </span>
      </div>

      <div class="panel-tabs">
        <button
          class="panel-tab"
          :class="{ active: activeTab === 'inventory' }"
          @click="activeTab = 'inventory'"
        >
          {{ t('metrics.tab.inventory') }}
        </button>
        <button class="panel-tab" :class="{ active: activeTab === 'preview' }" @click="activeTab = 'preview'">
          {{ t('metrics.tab.preview') }}
        </button>
      </div>

      <!-- Tab 1: metric inventory (catalogue + live values) -->
      <div v-if="activeTab === 'inventory'">
      <div class="toolbar">
        <div class="field">
          <label class="field-label">{{ t('metrics.database') }}</label>
          <select v-model="selectedDatabase" :disabled="busy" @change="selectDatabase">
            <option v-for="database in databases" :key="database" :value="database">{{ database }}</option>
          </select>
        </div>
        <button :disabled="busy || selectedDatabase.length === 0" @click="loadMetrics">
          {{ t('metrics.reload') }}
        </button>
        <button :disabled="busy || metrics.length === 0" @click="exportMetricsCsv">
          {{ t('metrics.exportCsv') }}
        </button>
        <button :disabled="busy || latestLoading || metrics.length === 0" @click="refreshLiveValues">
          {{
            latestLoading
              ? t('metrics.refreshingProgress', {
                  done: latestProgress.done,
                  total: latestProgress.total,
                })
              : t('metrics.refreshLive')
          }}
        </button>
        <span class="toolbar-note">{{ t('metrics.count', { count: metrics.length }) }}</span>
        <span v-if="latestLoadedAt !== null" class="toolbar-note">
          {{ t('metrics.liveLoadedAt', { time: formatDateTime(latestLoadedAt) }) }}
        </span>
      </div>

      <p v-if="!latestLoading && latestLoadedAt === null && metrics.length > 0" class="toolbar-note hint">
        {{ t('metrics.liveHint') }}
      </p>

      <p v-if="latestCapped" class="toolbar-note hint">
        {{ t('metrics.liveCapped', { count: LIVE_METRIC_LIMIT }) }}
      </p>

      <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>

      <div v-if="metrics.length > 0" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('metrics.column.metric') }}</th>
              <th>{{ t('metrics.column.type') }}</th>
              <th>{{ t('metrics.column.first') }}</th>
              <th>{{ t('metrics.column.last') }}</th>
              <th>{{ t('metrics.column.latest') }}</th>
              <th>{{ t('metrics.column.updated') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="metric in metrics"
              :key="metric.metricName"
              :class="{ selected: metric.metricName === selectedMetric }"
            >
              <td class="mono">{{ metric.metricName }}</td>
              <td class="mono">{{ valueTypeName(metric.valueType) }}</td>
              <td class="mono">{{ formatDateTime(metric.firstTs) }}</td>
              <td class="mono">{{ formatDateTime(metric.lastTs) }}</td>
              <td class="mono">{{ formatLiveValue(livePoint(metric.metricName)) }}</td>
              <td class="mono">{{ liveUpdatedAt(metric.metricName) }}</td>
              <td>
                <button class="small" :disabled="busy" @click="selectMetric(metric.metricName)">
                  {{ t('metrics.select') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty-hint">{{ t('metrics.empty') }}</p>
      </div>

      <!-- Tab 2: range preview (query + chart) -->
      <div v-else>
      <div class="toolbar">
        <div class="field">
          <label class="field-label">{{ t('metrics.column.metric') }}</label>
          <select
            v-model="selectedMetric"
            style="width: 260px"
            :disabled="busy || metrics.length === 0"
            @change="onMetricSelect"
          >
            <option value="">{{ t('metrics.notSelected') }}</option>
            <option v-for="metric in metrics" :key="metric.metricName" :value="metric.metricName">
              {{ metric.metricName }}
            </option>
          </select>
        </div>
        <TimeRangePicker
          v-model:start="startInput"
          v-model:end="endInput"
          :span-start="spanStart"
          :span-end="spanEnd"
          @apply="runQuery"
        />
        <div class="field">
          <label class="field-label">{{ t('metrics.limit') }}</label>
          <input
            v-model="limitInput"
            type="number"
            min="1"
            step="1"
            style="width: 110px"
            :disabled="busy || aggregateType !== 'none' || interpolationMode !== 'none'"
          />
        </div>
        <button class="primary" :disabled="busy" @click="runQuery">{{ t('metrics.query') }}</button>
        <button :disabled="busy" @click="resetRange">{{ t('metrics.reset') }}</button>
        <button :disabled="busy || !hasPreview" @click="exportCurrent">{{ t('metrics.exportXls') }}</button>
      </div>

      <div class="toolbar">
        <div class="field">
          <label class="field-label">{{ t('metrics.aggregate') }}</label>
          <select v-model="aggregateType" :disabled="busy || interpolationMode !== 'none'">
            <option value="none">{{ t('metrics.aggregate.none') }}</option>
            <option v-for="type in AGGREGATE_TYPES" :key="type" :value="type">{{ type }}</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label">{{ t('metrics.window') }}</label>
          <div class="control-row">
            <input
              v-model="windowValue"
              type="number"
              min="1"
              step="1"
              style="width: 90px"
              :disabled="busy || (aggregateType === 'none' && interpolationMode === 'none')"
            />
            <select v-model="windowUnit" :disabled="busy || (aggregateType === 'none' && interpolationMode === 'none')">
              <option value="s">{{ t('metrics.unit.s') }}</option>
              <option value="m">{{ t('metrics.unit.m') }}</option>
              <option value="h">{{ t('metrics.unit.h') }}</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label class="field-label">{{ t('metrics.interpolation') }}</label>
          <select v-model="interpolationMode" :disabled="busy || aggregateType !== 'none'">
            <option value="none">{{ t('metrics.interpolation.none') }}</option>
            <option v-for="mode in INTERPOLATION_MODES" :key="mode" :value="mode">{{ mode }}</option>
          </select>
        </div>
        <span class="toolbar-note">{{ t('metrics.limitNote') }}</span>
      </div>

      <p class="toolbar-note hint">
        {{
          interpolationMode !== 'none'
            ? t('metrics.hint.at')
            : aggregateType === 'none'
              ? t('metrics.hint.raw')
              : t('metrics.hint.aggregate')
        }}
      </p>
      <p v-if="intervalStats !== null" class="toolbar-note hint">
        {{
          t('metrics.hint.intervals', {
            median: formatInterval(intervalStats.medianMs),
            max: formatInterval(intervalStats.maxMs),
            gaps: intervalStats.gaps,
            factor: GAP_FACTOR,
          })
        }}
      </p>

      <template v-if="hasPreview">
        <p class="toolbar-note">
          {{
            atPoints !== null && atStateCounts !== null
              ? t('metrics.summaryAt', {
                  samples: atPoints.length,
                  plotted: chartPoints.length,
                  exact: atStateCounts.exact,
                  interpolated: atStateCounts.interpolated,
                  extrapolated: atStateCounts.extrapolated,
                  noData: atStateCounts['no-data'],
                })
              : aggregateWindows !== null
                ? t('metrics.summaryAggregated', {
                    windows: aggregateWindows.length,
                    plotted: chartPoints.length,
                    skipped: skippedPointCount,
                  })
                : t('metrics.summary', {
                    points: rawSeries === null ? 0 : rawSeries.points.length,
                    plotted: chartPoints.length,
                    skipped: skippedPointCount,
                  })
          }}
          <template v-if="queryElapsedMs !== null">
            {{ t('metrics.elapsed', { duration: formatDuration(queryElapsedMs) }) }}
          </template>
        </p>
        <p v-if="stringLevels.length > 0" class="toolbar-note hint">
          {{ t('metrics.hint.stringLevels', { levels: stringLevels.map((value, index) => `"${value}"→${index + 1}`).join(', ') }) }}
        </p>
        <LineChart :points="chartPoints" />
      </template>
      <p v-else class="empty-hint">{{ t('metrics.emptyPreview') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel-tabs {
  display: flex;
  gap: 4px;
  margin: 0 0 12px;
  border-bottom: 1px solid var(--border);
}

.panel-tab {
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  padding: 6px 12px;
  color: var(--text-muted);
  cursor: pointer;
}

.panel-tab:hover {
  color: var(--primary-strong);
}

.panel-tab.active {
  border-bottom-color: var(--primary);
  color: var(--primary-strong);
  font-weight: 600;
}

tr.selected {
  background: rgba(47, 124, 246, 0.08);
}

.hint {
  margin: 4px 0 8px;
  max-width: 980px;
  white-space: normal;
}
</style>
