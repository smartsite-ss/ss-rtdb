<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Backup entry point: `POST /api/v1/backup/{db}` with a mandatory target directory (§3.1).
 *
 * The optional time range is **day-granular** (`startDay`/`endDay`, inclusive, server local time) because the
 * storage unit itself is one directory per day: a range backup copies only those day directories and carries a
 * manifest, so restoring it merges those days into the database instead of replacing it. The range is edited with
 * the shared time-range control in day mode (`TimeRangePicker`), the same trigger the metrics panel uses.
 *
 * The console only triggers the copy; restoring an archive stays a CLI operation (`rtdb-cli restore`)
 * because it requires exclusive access to the data directory.
 */

import { computed, onMounted, ref, watch } from 'vue';
import type { RtdbAdminApiClient, RtdbBackupResult } from '../api';
import { useAsyncAction } from '../async';
import { dateTimeLocalDay, dayToDayEnd, dayToDayStart, formatBytes, formatNumber } from '../format';
import { t } from '../i18n';
import TimeRangePicker from './TimeRangePicker.vue';

const props = defineProps<{ client: RtdbAdminApiClient }>();

const { busy, errorMessage, successMessage, run } = useAsyncAction();
const databases = ref<string[]>([]);
const selectedDatabase = ref('');
const targetDirectory = ref('');
/** Inclusive day range (`yyyy-MM-dd`, empty = unbounded); both empty = whole-database backup */
const rangeStart = ref('');
const rangeEnd = ref('');
const backupResult = ref<RtdbBackupResult | null>(null);

/**
 * Bridge between the day-granular API and the shared time-range control, which owns `datetime-local` strings:
 * an empty day maps to an empty value (unbounded side), a set day maps to that day's first / last second.
 */
const rangeStartInput = computed({
  get: () => (rangeStart.value.length > 0 ? dayToDayStart(rangeStart.value) : ''),
  set: (value: string) => {
    rangeStart.value = dateTimeLocalDay(value);
  },
});

const rangeEndInput = computed({
  get: () => (rangeEnd.value.length > 0 ? dayToDayEnd(rangeEnd.value) : ''),
  set: (value: string) => {
    rangeEnd.value = dateTimeLocalDay(value);
  },
});

/** `yyyyMMdd` (server day number) → `yyyy-MM-dd` for display */
function formatDay(day: number): string {
  const text = String(day);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function rangeSummary(result: RtdbBackupResult): string {
  if (result.range === null) return t('backup.modeFull');
  return t('backup.rangeValue', {
    start: formatDay(result.range.startDay),
    end: formatDay(result.range.endDay),
    days: result.range.dayCount,
  });
}

async function loadDatabases(): Promise<void> {
  const list = await run(() => props.client.listDatabases());
  if (list === undefined) return;
  databases.value = list;
  if (list.length > 0 && !list.includes(selectedDatabase.value)) {
    selectedDatabase.value = list[0];
  }
}

async function startBackup(): Promise<void> {
  const database = selectedDatabase.value;
  const target = targetDirectory.value.trim();
  const result = await run(async () => {
    if (database.length === 0) throw new Error(t('backup.error.selectDatabase'));
    if (target.length === 0) throw new Error(t('backup.error.targetRequired'));
    // ISO date strings compare chronologically, so no Date parsing is needed here.
    if (rangeStart.value.length > 0 && rangeEnd.value.length > 0 && rangeStart.value > rangeEnd.value) {
      throw new Error(t('backup.error.rangeOrder'));
    }
    return props.client.backup(database, target, {
      startDay: rangeStart.value,
      endDay: rangeEnd.value,
    });
  }, t('backup.success.done'));
  if (result !== undefined) backupResult.value = result;
}

onMounted(() => {
  void loadDatabases();
});

watch(
  () => props.client,
  () => {
    backupResult.value = null;
    void loadDatabases();
  },
);
</script>

<template>
  <section class="panel">
    <div class="card">
      <div class="card-title">
        <span>{{ t('backup.title') }}</span>
        <span class="card-title-note">POST /api/v1/backup/{database}</span>
      </div>

      <div class="toolbar">
        <div class="field">
          <label class="field-label">{{ t('backup.database') }}</label>
          <select v-model="selectedDatabase" :disabled="busy">
            <option v-for="database in databases" :key="database" :value="database">{{ database }}</option>
          </select>
        </div>
        <div class="field field-wide">
          <label class="field-label">{{ t('backup.target') }}</label>
          <input
            v-model="targetDirectory"
            type="text"
            :placeholder="t('backup.targetPlaceholder')"
            :disabled="busy"
          />
        </div>
        <TimeRangePicker v-model:start="rangeStartInput" v-model:end="rangeEndInput" granularity="day" :disabled="busy" />
        <button class="primary" :disabled="busy" @click="startBackup">{{ t('backup.start') }}</button>
        <button :disabled="busy" @click="loadDatabases">{{ t('backup.reload') }}</button>
      </div>

      <p class="toolbar-note hint">{{ t('backup.rangeHint') }}</p>

      <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>
      <p v-if="successMessage.length > 0" class="alert success">{{ successMessage }}</p>
    </div>

    <div v-if="backupResult !== null" class="card">
      <div class="card-title">
        <span>{{ t('backup.lastResult') }}</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <tbody>
            <tr>
              <th>{{ t('backup.database') }}</th>
              <td class="mono">{{ backupResult.database }}</td>
            </tr>
            <tr>
              <th>{{ t('backup.column.target') }}</th>
              <td class="mono break-all">{{ backupResult.targetDirectory }}</td>
            </tr>
            <tr>
              <th>{{ t('backup.mode') }}</th>
              <td class="mono">{{ backupResult.partial ? t('backup.modeRange') : t('backup.modeFull') }}</td>
            </tr>
            <tr>
              <th>{{ t('backup.range') }}</th>
              <td class="mono">{{ rangeSummary(backupResult) }}</td>
            </tr>
            <tr>
              <th>{{ t('backup.files') }}</th>
              <td class="mono">{{ formatNumber(backupResult.fileCount) }}</td>
            </tr>
            <tr>
              <th>{{ t('backup.totalBytes') }}</th>
              <td class="mono">{{ formatBytes(backupResult.totalBytes) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
