<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Metric browser: pick a database, pick a metric, then preview a time range either raw or window-aggregated.
 *
 * Uses `GET /api/v1/databases`, `GET /api/v1/metrics/{db}` plus `POST /api/v1/query/range` /
 * `POST /api/v1/query/aggregate` only, so the preview is exactly the data a client of the public REST API
 * would receive. The panel also states the interpolation / aggregation rules next to the controls, because a
 * raw curve connects stored samples directly (no interpolation) while an `avg` window is time-weighted.
 */

import { computed, onMounted, ref, watch } from 'vue';
import LineChart from './LineChart.vue';
import TimeRangePicker from './TimeRangePicker.vue';
import { RTDB_AGGREGATE_TYPE, RtdbAdminApiClient } from '../api';
import type { RtdbAggregateType, RtdbAggregateWindow, RtdbJsonPoint, RtdbJsonSeries, RtdbMetricSummary } from '../api';
import { useAsyncAction } from '../async';
import { formatDateTime, fromDateTimeLocalValue, toDateTimeLocalValue } from '../format';
import { t } from '../i18n';
import { downloadXlsWorkbook } from '../xls-download';
import type { XlsCellValue } from '../xls';

const props = defineProps<{ client: RtdbAdminApiClient }>();

const DEFAULT_RANGE_MILLISECONDS = 3_600_000;
const DEFAULT_LIMIT = 2_000;
const DEFAULT_WINDOW_SECONDS = 60;
/** A raw interval above this multiple of the median counts as a gap in the hint line */
const GAP_FACTOR = 3;

const AGGREGATE_TYPES: RtdbAggregateType[] = Object.values(RTDB_AGGREGATE_TYPE);

const WINDOW_UNITS = { s: 1, m: 60, h: 3_600 } as const;
type WindowUnit = keyof typeof WINDOW_UNITS;

const { busy, errorMessage, run } = useAsyncAction();
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
/** Exactly one of the two previews is non-null after a successful query */
const rawSeries = ref<RtdbJsonSeries | null>(null);
const aggregateWindows = ref<RtdbAggregateWindow[] | null>(null);

const hasPreview = computed(() => rawSeries.value !== null || aggregateWindows.value !== null);

/** Selected metric's stored span, offered as the "All" preset inside the range control */
const spanStart = computed(() => metrics.value.find((entry) => entry.metricName === selectedMetric.value)?.firstTs ?? null);
const spanEnd = computed(() => metrics.value.find((entry) => entry.metricName === selectedMetric.value)?.lastTs ?? null);

const chartPoints = computed<{ t: number; value: number }[]>(() => {
  const points: { t: number; value: number }[] = [];
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
    const value = RtdbAdminApiClient.toNumericValue(point);
    if (value !== null) points.push({ t: point.t, value });
  }
  return points;
});

const sampleCount = computed(() => {
  if (aggregateWindows.value !== null) return aggregateWindows.value.length;
  return rawSeries.value?.points.length ?? 0;
});

const skippedPointCount = computed(() => sampleCount.value - chartPoints.value.length);

/** Median / largest sampling interval of the raw curve, used to explain gaps in the hint line */
const intervalStats = computed<{ medianMs: number; maxMs: number; gaps: number } | null>(() => {
  if (aggregateWindows.value !== null) return null;
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

function resetRange(): void {
  const now = Date.now();
  endInput.value = toDateTimeLocalValue(now, true);
  startInput.value = toDateTimeLocalValue(now - DEFAULT_RANGE_MILLISECONDS, true);
}

function clearPreview(): void {
  rawSeries.value = null;
  aggregateWindows.value = null;
}

async function loadDatabases(): Promise<void> {
  const list = await run(() => props.client.listDatabases());
  if (list === undefined) return;
  databases.value = list;
  if (list.length === 0) {
    selectedDatabase.value = '';
    metrics.value = [];
    selectedMetric.value = '';
    return;
  }
  if (!list.includes(selectedDatabase.value)) {
    selectedDatabase.value = list[0];
    await loadMetrics();
  }
}

async function selectDatabase(): Promise<void> {
  clearPreview();
  await loadMetrics();
}

async function loadMetrics(): Promise<void> {
  const database = selectedDatabase.value;
  clearPreview();
  if (database.length === 0) {
    metrics.value = [];
    selectedMetric.value = '';
    return;
  }
  const list = await run(() => props.client.listMetrics(database));
  if (list === undefined) return;
  metrics.value = list;
  selectedMetric.value = list.length > 0 ? list[0].metricName : '';
}

function selectMetric(metricName: string): void {
  selectedMetric.value = metricName;
}

/** Window width in milliseconds from the value + unit inputs; `0` when the input is not a positive integer */
function resolveWindowMs(): number {
  const parsed = Number(windowValue.value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return parsed * WINDOW_UNITS[windowUnit.value] * 1_000;
}

async function runQuery(): Promise<void> {
  const database = selectedDatabase.value;
  const metricName = selectedMetric.value;
  const start = fromDateTimeLocalValue(startInput.value);
  const end = fromDateTimeLocalValue(endInput.value);
  const parsedLimit = Number(limitInput.value);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT;
  const type = aggregateType.value;
  const windowMs = resolveWindowMs();

  const result = await run(async () => {
    if (database.length === 0) throw new Error(t('metrics.error.selectDatabase'));
    if (metricName.length === 0) throw new Error(t('metrics.error.selectMetric'));
    if (start <= 0 || end <= 0) throw new Error(t('metrics.error.invalidTime'));
    if (end < start) throw new Error(t('metrics.error.endBeforeStart'));
    if (type === 'none') {
      const raw = await props.client.queryRange(database, metricName, start, end, limit);
      return { raw, windows: null as RtdbAggregateWindow[] | null };
    }
    if (windowMs <= 0) throw new Error(t('metrics.error.invalidWindow'));
    const windows = await props.client.queryAggregate(database, metricName, start, end, type, windowMs);
    return { raw: null as RtdbJsonSeries | null, windows };
  });
  if (result === undefined) return;
  rawSeries.value = result.raw;
  aggregateWindows.value = result.windows;
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
        <span>{{ t('metrics.inventoryTitle') }}</span>
        <span class="card-title-note">{{ t('metrics.note') }}</span>
      </div>

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
        <span class="toolbar-note">{{ t('metrics.count', { count: metrics.length }) }}</span>
      </div>

      <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>

      <div v-if="metrics.length > 0" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('metrics.column.metric') }}</th>
              <th>{{ t('metrics.column.first') }}</th>
              <th>{{ t('metrics.column.last') }}</th>
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
              <td class="mono">{{ formatDateTime(metric.firstTs) }}</td>
              <td class="mono">{{ formatDateTime(metric.lastTs) }}</td>
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

    <div class="card">
      <div class="card-title">
        <span>{{ t('metrics.previewTitle') }}</span>
        <span class="card-title-note">POST /api/v1/query/range · POST /api/v1/query/aggregate</span>
      </div>

      <div class="toolbar">
        <div class="field">
          <label class="field-label">{{ t('metrics.column.metric') }}</label>
          <input
            :value="selectedMetric"
            type="text"
            readonly
            style="width: 220px"
            :placeholder="t('metrics.notSelected')"
          />
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
            :disabled="busy || aggregateType !== 'none'"
          />
        </div>
        <button class="primary" :disabled="busy" @click="runQuery">{{ t('metrics.query') }}</button>
        <button :disabled="busy" @click="resetRange">{{ t('metrics.reset') }}</button>
        <button :disabled="busy || !hasPreview" @click="exportCurrent">{{ t('metrics.exportXls') }}</button>
      </div>

      <div class="toolbar">
        <div class="field">
          <label class="field-label">{{ t('metrics.aggregate') }}</label>
          <select v-model="aggregateType" :disabled="busy">
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
              :disabled="busy || aggregateType === 'none'"
            />
            <select v-model="windowUnit" :disabled="busy || aggregateType === 'none'">
              <option value="s">{{ t('metrics.unit.s') }}</option>
              <option value="m">{{ t('metrics.unit.m') }}</option>
              <option value="h">{{ t('metrics.unit.h') }}</option>
            </select>
          </div>
        </div>
        <span class="toolbar-note">{{ t('metrics.limitNote') }}</span>
      </div>

      <p class="toolbar-note hint">
        {{ aggregateType === 'none' ? t('metrics.hint.raw') : t('metrics.hint.aggregate') }}
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
            aggregateWindows !== null
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
        </p>
        <LineChart :points="chartPoints" />
      </template>
      <p v-else class="empty-hint">{{ t('metrics.emptyPreview') }}</p>
    </div>
  </section>
</template>

<style scoped>
tr.selected {
  background: rgba(47, 124, 246, 0.08);
}

.hint {
  margin: 4px 0 8px;
  max-width: 980px;
  white-space: normal;
}
</style>
