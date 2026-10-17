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
 * The console only triggers the copy; restoring an archive stays a CLI operation (`rtdb-cli restore`)
 * because it requires exclusive access to the data directory.
 */

import { onMounted, ref, watch } from 'vue';
import type { RtdbAdminApiClient, RtdbBackupResult } from '../api';
import { useAsyncAction } from '../async';
import { formatBytes, formatNumber } from '../format';
import { t } from '../i18n';

const props = defineProps<{ client: RtdbAdminApiClient }>();

const { busy, errorMessage, successMessage, run } = useAsyncAction();
const databases = ref<string[]>([]);
const selectedDatabase = ref('');
const targetDirectory = ref('');
const backupResult = ref<RtdbBackupResult | null>(null);

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
    return props.client.backup(database, target);
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
        <button class="primary" :disabled="busy" @click="startBackup">{{ t('backup.start') }}</button>
        <button :disabled="busy" @click="loadDatabases">{{ t('backup.reload') }}</button>
      </div>

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
