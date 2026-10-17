<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Metric browser: pick a database, pick a metric, then preview the raw series of a time range.
 *
 * Uses `GET /api/v1/databases`, `GET /api/v1/metrics/{db}` and `POST /api/v1/query/range` only, so the
 * preview is exactly the data a client of the public REST API would receive.
 */

import { computed, onMounted, ref, watch } from 'vue';
import LineChart from './LineChart.vue';
import { RtdbAdminApiClient } from '../api';
import type { RtdbJsonSeries, RtdbMetricSummary } from '../api';
import { useAsyncAction } from '../async';
import { formatDateTime, fromDateTimeLocalValue, toDateTimeLocalValue } from '../format';
import { t } from '../i18n';

const props = defineProps<{ client: RtdbAdminApiClient }>();

const DEFAULT_RANGE_MILLISECONDS = 3_600_000;
const DEFAULT_LIMIT = 2_000;

const { busy, errorMessage, run } = useAsyncAction();
const databases = ref<string[]>([]);
const selectedDatabase = ref('');
const metrics = ref<RtdbMetricSummary[]>([]);
const selectedMetric = ref('');
const startInput = ref('');
const endInput = ref('');
const limitInput = ref(String(DEFAULT_LIMIT));
const series = ref<RtdbJsonSeries | null>(null);

const chartPoints = computed<{ t: number; value: number }[]>(() => {
  const current = series.value;
  if (current === null) return [];
  const points: { t: number; value: number }[] = [];
  for (const point of current.points) {
    const value = RtdbAdminApiClient.toNumericValue(point);
    if (value !== null) points.push({ t: point.t, value });
  }
  return points;
});

const skippedPointCount = computed(() => {
  const current = series.value;
  if (current === null) return 0;
  return current.points.length - chartPoints.value.length;
});

function resetRange(): void {
  const now = Date.now();
  endInput.value = toDateTimeLocalValue(now);
  startInput.value = toDateTimeLocalValue(now - DEFAULT_RANGE_MILLISECONDS);
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
  series.value = null;
  await loadMetrics();
}

async function loadMetrics(): Promise<void> {
  const database = selectedDatabase.value;
  series.value = null;
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

async function queryRange(): Promise<void> {
  const database = selectedDatabase.value;
  const metricName = selectedMetric.value;
  const start = fromDateTimeLocalValue(startInput.value);
  const end = fromDateTimeLocalValue(endInput.value);
  const parsedLimit = Number(limitInput.value);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT;

  const result = await run(async () => {
    if (database.length === 0) throw new Error(t('metrics.error.selectDatabase'));
    if (metricName.length === 0) throw new Error(t('metrics.error.selectMetric'));
    if (start <= 0 || end <= 0) throw new Error(t('metrics.error.invalidTime'));
    if (end < start) throw new Error(t('metrics.error.endBeforeStart'));
    return props.client.queryRange(database, metricName, start, end, limit);
  });
  if (result !== undefined) series.value = result;
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
        <span class="card-title-note">POST /api/v1/query/range</span>
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
        <div class="field">
          <label class="field-label">{{ t('metrics.start') }}</label>
          <input v-model="startInput" type="datetime-local" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('metrics.end') }}</label>
          <input v-model="endInput" type="datetime-local" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('metrics.limit') }}</label>
          <input v-model="limitInput" type="number" min="1" step="1" style="width: 110px" />
        </div>
        <button class="primary" :disabled="busy" @click="queryRange">{{ t('metrics.query') }}</button>
        <button :disabled="busy" @click="resetRange">{{ t('metrics.reset') }}</button>
      </div>

      <template v-if="series !== null">
        <p class="toolbar-note">
          {{
            t('metrics.summary', {
              points: series.points.length,
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
</style>
