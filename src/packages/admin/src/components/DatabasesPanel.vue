<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Database inventory and retention policy.
 *
 * `GET /api/v1/databases` lists the databases; the retention policy itself has no read endpoint in
 * §3.1 (only `PUT /api/v1/retention/{db}`), so this panel can set a policy but never displays the
 * previously stored one.
 */

import { onMounted, ref, watch } from 'vue';
import type { RtdbAdminApiClient } from '../api';
import { useAsyncAction } from '../async';

const props = defineProps<{ client: RtdbAdminApiClient }>();

const { busy, errorMessage, successMessage, run } = useAsyncAction();
const databases = ref<string[]>([]);
const retentionDraft = ref<Record<string, string>>({});

async function loadDatabases(): Promise<void> {
  const list = await run(() => props.client.listDatabases());
  if (list === undefined) return;
  databases.value = list;
  const nextDraft: Record<string, string> = {};
  for (const database of list) {
    nextDraft[database] = retentionDraft.value[database] ?? '';
  }
  retentionDraft.value = nextDraft;
}

async function applyRetention(database: string): Promise<void> {
  const days = Number((retentionDraft.value[database] ?? '').trim());
  await run(async () => {
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error('Retention days must be a positive integer.');
    }
    await props.client.setRetentionDays(database, days);
  }, `Retention of "${database}" is now ${days} day(s).`);
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
        <span>Databases</span>
        <span class="card-title-note">GET /api/v1/databases · PUT /api/v1/retention/{database}</span>
      </div>

      <div class="toolbar">
        <button :disabled="busy" @click="loadDatabases">Reload</button>
        <span class="toolbar-note">The retention policy cannot be read back: the protocol only exposes a write.</span>
      </div>

      <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>
      <p v-if="successMessage.length > 0" class="alert success">{{ successMessage }}</p>

      <div v-if="databases.length > 0" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Database</th>
              <th>Retention days (write-only)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="database in databases" :key="database">
              <td class="mono">{{ database }}</td>
              <td>
                <input
                  v-model="retentionDraft[database]"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="e.g. 30"
                  style="width: 120px"
                  :disabled="busy"
                />
              </td>
              <td>
                <button class="small" :disabled="busy" @click="applyRetention(database)">Apply</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty-hint">No database reported. Create one by writing at least one point.</p>
    </div>
  </section>
</template>
