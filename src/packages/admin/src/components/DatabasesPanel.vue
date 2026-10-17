<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Database inventory: a name filter plus two categories of information.
 *
 *   1. location / size / status of every database — `GET /api/v1/databases` lists the names, then
 *      `GET /api/v1/databases/{db}` supplies the directory, the on-disk footprint (with the segment /
 *      index / WAL split and the per-day detail) and the database-level retention override;
 *   2. a filter result table — the search box narrows the inventory by database name, and the matching
 *      rows are the result display.
 *
 * The retention policy is written through `PUT /api/v1/retention/{db}` and read back as part of the
 * per-database detail (`null` = the global default applies).
 */

import { computed, onMounted, ref, watch } from 'vue';
import type { RtdbAdminApiClient, RtdbDatabaseReport } from '../api';
import { describeError, useAsyncAction } from '../async';
import { formatBytes } from '../format';
import { t } from '../i18n';

const props = defineProps<{ client: RtdbAdminApiClient }>();

const { busy, errorMessage, successMessage, run } = useAsyncAction();
const databases = ref<string[]>([]);
/** Detail per database; a failed measurement stays absent instead of blanking the whole table */
const reports = ref<Record<string, RtdbDatabaseReport>>({});
const reportFailures = ref<Record<string, string>>({});
const filterText = ref('');
const retentionDraft = ref<Record<string, string>>({});
const expanded = ref<Record<string, boolean>>({});

interface DatabaseRow {
  database: string;
  /** `null` when the detail request failed; the row then shows the name plus a "unavailable" badge */
  report: RtdbDatabaseReport | null;
}

/** Filter result: the inventory narrowed by database name (the table itself is the result display) */
const rows = computed<DatabaseRow[]>(() => {
  const needle = filterText.value.trim().toLowerCase();
  return databases.value
    .filter((database) => needle.length === 0 || database.toLowerCase().includes(needle))
    .map((database) => ({ database, report: reports.value[database] ?? null }));
});

function retentionText(report: RtdbDatabaseReport): string {
  return report.retentionDays === null
    ? t('databases.statusDefault')
    : t('databases.statusRetention', { days: report.retentionDays });
}

function breakdownText(report: RtdbDatabaseReport): string {
  return t('databases.breakdown', {
    segments: formatBytes(report.breakdown.segmentBytes),
    index: formatBytes(report.breakdown.indexBytes),
    wal: formatBytes(report.breakdown.walBytes),
    other: formatBytes(report.breakdown.otherBytes),
  });
}

function toggleExpanded(database: string): void {
  expanded.value = { ...expanded.value, [database]: expanded.value[database] !== true };
}

async function loadDatabases(): Promise<void> {
  await run(async () => {
    const list = await props.client.listDatabases();
    databases.value = list;

    const nextReports: Record<string, RtdbDatabaseReport> = {};
    const nextFailures: Record<string, string> = {};
    await Promise.all(
      list.map(async (database) => {
        try {
          nextReports[database] = await props.client.getDatabaseReport(database);
        } catch (error) {
          nextFailures[database] = describeError(error);
        }
      }),
    );
    reports.value = nextReports;
    reportFailures.value = nextFailures;

    const nextDraft: Record<string, string> = {};
    for (const database of list) nextDraft[database] = retentionDraft.value[database] ?? '';
    retentionDraft.value = nextDraft;
  });
}

async function applyRetention(database: string): Promise<void> {
  const days = Number((retentionDraft.value[database] ?? '').trim());
  await run(async () => {
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error(t('databases.error.retentionPositive'));
    }
    await props.client.setRetentionDays(database, days);
  }, t('databases.success.retention', { database, days }));

  const report = reports.value[database];
  if (errorMessage.value.length === 0 && report !== undefined) {
    reports.value = { ...reports.value, [database]: { ...report, retentionDays: days } };
  }
}

onMounted(() => {
  void loadDatabases();
});

watch(
  () => props.client,
  () => {
    void loadDatabases();
  },
);
</script>

<template>
  <section class="panel">
    <div class="card">
      <div class="card-title">
        <span>{{ t('databases.title') }}</span>
        <span class="card-title-note">{{ t('databases.note') }}</span>
      </div>

      <div class="toolbar">
        <div class="field">
          <label class="field-label">{{ t('databases.filterLabel') }}</label>
          <input
            v-model="filterText"
            type="text"
            :placeholder="t('databases.filterPlaceholder')"
            style="width: 220px"
          />
        </div>
        <button :disabled="busy" @click="loadDatabases">{{ t('databases.reload') }}</button>
        <span class="toolbar-note">
          {{ t('databases.filterSummary', { matched: rows.length, total: databases.length }) }}
        </span>
        <span class="toolbar-note">{{ t('databases.retentionHint') }}</span>
      </div>

      <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>
      <p v-if="successMessage.length > 0" class="alert success">{{ successMessage }}</p>

      <div v-if="rows.length > 0" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('databases.column.database') }}</th>
              <th>{{ t('databases.column.location') }}</th>
              <th>{{ t('databases.column.size') }}</th>
              <th>{{ t('databases.column.status') }}</th>
              <th>{{ t('databases.column.retention') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <template v-for="row in rows" :key="row.database">
              <tr>
                <td class="mono">{{ row.database }}</td>
                <td class="mono break-all">
                  <template v-if="row.report !== null">{{ row.report.directory }}</template>
                  <span v-else :title="reportFailures[row.database] ?? ''">
                    {{ t('databases.detailFailed') }}
                  </span>
                </td>
                <td class="mono">
                  <template v-if="row.report !== null">
                    {{ formatBytes(row.report.totalBytes) }}
                    <div class="toolbar-note">
                      {{ t('databases.sizeFiles', { files: row.report.fileCount }) }}
                    </div>
                  </template>
                  <span v-else>—</span>
                </td>
                <td>
                  <span
                    v-if="row.report !== null"
                    class="badge"
                    :class="row.report.retentionDays === null ? '' : 'warning'"
                  >
                    {{ retentionText(row.report) }}
                  </span>
                  <span v-else class="badge danger" :title="reportFailures[row.database] ?? ''">
                    {{ t('databases.detailFailed') }}
                  </span>
                </td>
                <td>
                  <input
                    v-model="retentionDraft[row.database]"
                    type="number"
                    min="1"
                    step="1"
                    :placeholder="t('databases.retentionPlaceholder')"
                    style="width: 120px"
                    :disabled="busy"
                  />
                </td>
                <td>
                  <div class="row-actions">
                    <button class="small" :disabled="busy" @click="applyRetention(row.database)">
                      {{ t('databases.apply') }}
                    </button>
                    <button
                      class="small"
                      :disabled="busy || row.report === null"
                      @click="toggleExpanded(row.database)"
                    >
                      {{ t('databases.detailToggle') }}
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="row.report !== null && expanded[row.database] === true" class="detail-row">
                <td colspan="6">
                  <div class="toolbar-note">{{ breakdownText(row.report) }}</div>
                  <div v-if="row.report.days.length > 0" class="table-wrap">
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>{{ t('databases.column.day') }}</th>
                          <th>{{ t('databases.column.files') }}</th>
                          <th>{{ t('databases.column.bytes') }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="day in row.report.days" :key="day.dateNumber">
                          <td class="mono">{{ day.dayLabel }}</td>
                          <td class="mono">{{ day.fileCount }}</td>
                          <td class="mono">{{ formatBytes(day.totalBytes) }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p v-else class="empty-hint">{{ t('databases.dayEmpty') }}</p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p v-else-if="databases.length === 0" class="empty-hint">{{ t('databases.empty') }}</p>
      <p v-else class="empty-hint">{{ t('databases.emptyFiltered') }}</p>
    </div>
  </section>
</template>

<style scoped>
.row-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.detail-row > td {
  background: rgba(47, 124, 246, 0.04);
}
</style>
