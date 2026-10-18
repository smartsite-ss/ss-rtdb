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
 * The dialog **opens with the query already run** over **today** (local midnight → now), so the common "what did
 * this tag record today" question needs no extra click; the query itself is the same
 * `POST /api/v1/query/range` call the preview tab issues.
 *
 * The result is a **paged list**: 20 rows on open, with a page bar (50 / 100 / 200 rows available), because a day
 * of one-second samples is 86 400 points and rendering them all would freeze the dialog. The **CSV export always
 * contains every returned point**, independent of the page size.
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
/** Point-list page sizes: the dialog opens on a 20-row list; the CSV export always carries every point */
const PAGE_SIZES = [20, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 20;

const { busy, errorMessage, run } = useAsyncAction();

/** Default range: today 00:00:00 → now, local time */
const startInput = ref('');
const endInput = ref('');
const limitInput = ref(String(DEFAULT_LIMIT));
const series = ref<RtdbJsonSeries | null>(null);
/** Elapsed wall time of the last successful query (ms), shown in the summary line */
const queryElapsedMs = ref<number | null>(null);
/** Point-list page (1-based) and its size; every query starts again on page 1 */
const currentPage = ref(1);
const pageSize = ref<number>(DEFAULT_PAGE_SIZE);
const pageCount = computed(() => Math.max(1, Math.ceil((series.value?.points.length ?? 0) / pageSize.value)));
const pagePoints = computed<RtdbJsonPoint[]>(() => {
  const offset = (currentPage.value - 1) * pageSize.value;
  return series.value?.points.slice(offset, offset + pageSize.value) ?? [];
});
/** 1-based range of the rendered rows for the "showing a–b of n" note (`0–0` when empty) */
const pageFirstRow = computed(() => (pagePoints.value.length === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1));
const pageLastRow = computed(() => (currentPage.value - 1) * pageSize.value + pagePoints.value.length);

function goToPage(page: number): void {
  currentPage.value = Math.min(Math.max(1, Math.trunc(page)), pageCount.value);
}

/** Page-size change: back to page 1 (the visible slice changes completely) */
function onPageSizeChange(): void {
  currentPage.value = 1;
}

function resetRange(): void {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  startInput.value = toDateTimeLocalValue(midnight.getTime(), true);
  endInput.value = toDateTimeLocalValue(now.getTime(), true);
}

resetRange();

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
  // A new result set always starts on the first page.
  currentPage.value = 1;
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
  // Open with today's list already loaded: the dialog exists to answer "what did this tag record today".
  void runQuery();
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
                <tr v-for="point in pagePoints" :key="point.t">
                  <td class="mono">{{ formatDateTime(point.t) }}</td>
                  <td class="mono">{{ point.t }}</td>
                  <td class="mono">{{ formatPointValue(point.v) }}</td>
                  <td class="mono">{{ point.vt }}</td>
                  <td class="mono">{{ point.q ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="toolbar pagination">
            <div class="pagination-nav">
              <button class="small" :title="t('metrics.pageFirst')" :disabled="currentPage <= 1" @click="goToPage(1)">
                «
              </button>
              <button
                class="small"
                :title="t('metrics.pagePrev')"
                :disabled="currentPage <= 1"
                @click="goToPage(currentPage - 1)"
              >
                {{ t('metrics.pagePrev') }}
              </button>
              <span class="page-status">{{ t('metrics.pageStatus', { page: currentPage, pages: pageCount }) }}</span>
              <button
                class="small"
                :title="t('metrics.pageNext')"
                :disabled="currentPage >= pageCount"
                @click="goToPage(currentPage + 1)"
              >
                {{ t('metrics.pageNext') }}
              </button>
              <button
                class="small"
                :title="t('metrics.pageLast')"
                :disabled="currentPage >= pageCount"
                @click="goToPage(pageCount)"
              >
                »
              </button>
            </div>
            <div class="pagination-meta">
              <span class="toolbar-note page-range">
                {{ t('metrics.pageRange', { from: pageFirstRow, to: pageLastRow, total: series.points.length }) }}
              </span>
              <label class="page-size">
                <span class="page-size-label">{{ t('metrics.pageSize') }}</span>
                <select v-model.number="pageSize" @change="onPageSizeChange">
                  <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
                </select>
              </label>
              <span class="toolbar-note hint">
                {{ t('metrics.dialog.exportHint', { total: series.points.length }) }}
              </span>
            </div>
          </div>
        </template>
      </template>
      <p v-else-if="busy" class="empty-hint">{{ t('metrics.dialog.loading') }}</p>
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
  max-height: 60vh;
  overflow-y: auto;
}
</style>
