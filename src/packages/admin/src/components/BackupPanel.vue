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
    if (database.length === 0) throw new Error('Select a database first.');
    if (target.length === 0) throw new Error('Enter a target directory; the server requires a non-empty targetDir.');
    return props.client.backup(database, target);
  }, 'Backup finished.');
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
        <span>Backup</span>
        <span class="card-title-note">POST /api/v1/backup/{database}</span>
      </div>

      <div class="toolbar">
        <div class="field">
          <label class="field-label">Database</label>
          <select v-model="selectedDatabase" :disabled="busy">
            <option v-for="database in databases" :key="database" :value="database">{{ database }}</option>
          </select>
        </div>
        <div class="field field-wide">
          <label class="field-label">Target directory (server-side path)</label>
          <input v-model="targetDirectory" type="text" placeholder="/var/backups/ss-rtdb" :disabled="busy" />
        </div>
        <button class="primary" :disabled="busy" @click="startBackup">Start backup</button>
        <button :disabled="busy" @click="loadDatabases">Reload databases</button>
      </div>

      <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>
      <p v-if="successMessage.length > 0" class="alert success">{{ successMessage }}</p>
    </div>

    <div v-if="backupResult !== null" class="card">
      <div class="card-title">
        <span>Last backup result</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <tbody>
            <tr>
              <th>Database</th>
              <td class="mono">{{ backupResult.database }}</td>
            </tr>
            <tr>
              <th>Target directory</th>
              <td class="mono break-all">{{ backupResult.targetDirectory }}</td>
            </tr>
            <tr>
              <th>Files</th>
              <td class="mono">{{ formatNumber(backupResult.fileCount) }}</td>
            </tr>
            <tr>
              <th>Total bytes</th>
              <td class="mono">{{ formatBytes(backupResult.totalBytes) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
