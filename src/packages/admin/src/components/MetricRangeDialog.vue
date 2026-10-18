<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Modal "query one metric" dialog, opened by the `Select` button of a metric-inventory row.
 *
 * The time range defaults to **today** (local midnight → now), because checking what a live tag recorded today
 * is the common case; the query itself is the same `POST /api/v1/query/range` call the preview tab issues, and
 * the returned points can be exported straight to CSV (raw ms epoch + local time with offset, one row per
 * point, exactly what was queried).
 *
 * The dialog owns its query state only: the inventory keeps its own selection highlight, and every open starts
 * from today again, so the last range of one metric never leaks into the next one.
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { RtdbAdminApiClient, RtdbJsonPoint, RtdbJsonSeries, RtdbMetricSummary } from '../api';
import { useAsyncAction } from '../async';
import {
  formatDateTime,
  formatDateTimeWithOffset,
  formatElapsed,
  formatPointValue,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
} from '../format';
import { t } from '../i18n';
import { downloadCsv } from '../csv-download';
import TimeRangePicker from './TimeRangePicker.vue';

const props = defineProps<{
  client: RtdbAdminApiClient;
  database: string;
  metric: RtdbMetricSummary;
}>();

const emit = defineEmits<{ close: [] }>();

const DEFAULT_LIMIT = 2_000;
/** Rows rendered in the preview table; the CSV export always contains every returned point */
const PREVIEW_ROW_LIMIT = 500;

const { busy, errorMessage, run } = useAsyncAction();

/** Default range: today 00:00:00 → now, local time */
const startInput = ref('');
const endInput = ref('');
const limitInput = ref(String(DEFAULT_LIMIT));
const series = ref<RtdbJsonSeries | null>(null);
/** Elapsed wall time of the last successful query (ms), shown in the summary line */
const queryElapsedMs = ref<number | null>(null);

function resetRange(): void {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  startInput.value = toDateTimeLocalValue(midnight.getTime(), true);
  endInput.value = toDateTimeLocalValue(now.getTime(), true);
}

resetRange();

const previewRows = computed<RtdbJsonPoint[]>(() => series.value?.points.slice(0, PREVIEW_ROW_LIMIT) ?? []);

/** Points beyond {@link PREVIEW_ROW_LIMIT}: exported but not rendered */
const hiddenRowCount = computed(() => Math.max(0, (series.value?.points.length ?? 0) - PREVIEW_ROW_LIMIT));

async function runQuery(): Promise<void> {
  const start = fromDateTimeLocalValue(startInput.value);
  const end = fromDateTimeLocalValue(endInput.value);
  const parsedLimit = Number(limitInput.value);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT;
  const startedAt = performance.now();

  const result = await run(async () => {
    if (start <= 0 || end <= 0) throw new Error(t('metrics.error.invalidTime'));
    if (end < start) throw new Error(t('metrics.error.endBeforeStart'));
    return props.client.queryRange(props.database, props.metric.metricName, start, end, limit);
  });
  if (result === undefined) return;
  queryElapsedMs.value = performance.now() - startedAt;
  series.value = result;
}

/**
 * Export the queried points as CSV.
 *
 * Both the human-readable local time (with the UTC offset, so spreadsheet apps keep the cell as text) and the
 * raw millisecond epoch are written, and the value keeps its stored form (`i64` arrives as a decimal string),
 * so the file is usable in a spreadsheet and as machine input.
 */
function exportCsv(): void {
  const current = series.value;
  if (current === null) return;
  const columns = [
    t('metrics.csv.timestampMs'),
    t('metrics.csv.time'),
    t('metrics.csv.value'),
    t('metrics.csv.typeVt'),
    t('metrics.csv.quality'),
  ];
  const rows = current.points.map((point) => [
    point.t,
    formatDateTimeWithOffset(point.t),
    point.v,
    point.vt,
    point.q ?? null,
  ]);
  const stamp = formatDateTime(Date.now()).replaceAll(/[: ]/g, '-');
  const safeMetric = props.metric.metricName.replaceAll(/[^A-Za-z0-9._-]+/g, '_');
  downloadCsv(`${safeMetric}-${stamp}.csv`, columns, rows);
}

/** Escape closes the dialog (same behaviour as the range popover) */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="card-title">
        <span class="mono break-all">{{ metric.metricName }}</span>
        <span class="card-title-note">POST /api/v1/query/range</span>
      </div>

      <div class="toolbar">
        <div class="field">
          <label class="field-label">{{ t('metrics.database') }}</label>
          <span class="mono dialog-static">{{ database }}</span>
        </div>
        <TimeRangePicker
          v-model:start="startInput"
          v-model:end="endInput"
          :span-start="metric.firstTs"
          :span-end="metric.lastTs"
        />
        <div class="field">
          <label class="field-label">{{ t('metrics.limit') }}</label>
          <input v-model="limitInput" type="number" min="1" step="1" class="dialog-limit" :disabled="busy" />
        </div>
        <button class="primary" :disabled="busy" @click="runQuery">{{ t('metrics.query') }}</button>
        <button :disabled="busy || series === null" @click="exportCsv">{{ t('metrics.exportCsv') }}</button>
        <button :disabled="busy" @click="emit('close')">{{ t('metrics.dialog.close') }}</button>
      </div>

      <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>

      <template v-if="series !== null">
        <p class="toolbar-note">
          {{
            t('metrics.dialog.summary', {
              points: series.points.length,
              duration: formatElapsed(queryElapsedMs ?? 0),
            })
          }}
        </p>
        <p v-if="series.points.length === 0" class="empty-hint">{{ t('metrics.dialog.empty') }}</p>
        <template v-else>
          <div class="table-wrap dialog-table">
            <table class="data-table">
              <thead>
                <tr>
                  <th>{{ t('metrics.csv.time') }}</th>
                  <th>{{ t('metrics.csv.timestampMs') }}</th>
                  <th>{{ t('metrics.csv.value') }}</th>
                  <th>{{ t('metrics.csv.typeVt') }}</th>
                  <th>{{ t('metrics.csv.quality') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="point in previewRows" :key="point.t">
                  <td class="mono">{{ formatDateTime(point.t) }}</td>
                  <td class="mono">{{ point.t }}</td>
                  <td class="mono">{{ formatPointValue(point.v) }}</td>
                  <td class="mono">{{ point.vt }}</td>
                  <td class="mono">{{ point.q ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="hiddenRowCount > 0" class="toolbar-note hint">
            {{ t('metrics.dialog.truncated', { shown: PREVIEW_ROW_LIMIT, total: series.points.length }) }}
          </p>
        </template>
      </template>
      <p v-else class="empty-hint">{{ t('metrics.dialog.prompt') }}</p>
    </div>
  </div>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 16px;
  overflow-y: auto;
  background: rgba(16, 24, 40, 0.45);
}

.dialog {
  width: 100%;
  max-width: 880px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 18px 48px rgba(16, 24, 40, 0.24);
}

.dialog-static {
  display: flex;
  align-items: center;
  height: 32px;
  font-size: 13px;
}

.dialog-limit {
  width: 110px;
}

.dialog-table {
  max-height: 420px;
  overflow-y: auto;
}
</style>
