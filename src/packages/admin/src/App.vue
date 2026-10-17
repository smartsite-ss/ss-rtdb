<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Admin console shell: runtime connection settings plus in-page tab navigation.
 *
 * Navigation is a plain `activeTab` state instead of a URL router on purpose — rtdb-server serves the
 * bundle through its SPA fallback, and keeping every route at `/admin` guarantees that the relative
 * asset URLs emitted by the `base: './'` build keep resolving correctly.
 */

import { computed, ref } from 'vue';
import { RtdbAdminApiClient } from './api';
import { loadAdminSettings, normalizeApiBaseUrl, saveAdminSettings } from './settings';
import type { AdminSettings } from './settings';
import { describeError } from './async';
import AccessPanel from './components/AccessPanel.vue';
import BackupPanel from './components/BackupPanel.vue';
import DatabasesPanel from './components/DatabasesPanel.vue';
import MetricsPanel from './components/MetricsPanel.vue';
import StatusPanel from './components/StatusPanel.vue';

type AdminTabId = 'status' | 'databases' | 'metrics' | 'backup' | 'access';

interface AdminTab {
  id: AdminTabId;
  label: string;
}

const TABS: AdminTab[] = [
  { id: 'status', label: 'Status' },
  { id: 'databases', label: 'Databases' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'backup', label: 'Backup' },
  { id: 'access', label: 'Access control' },
];

/** Settings actually in use. Edited through the form refs below and only applied on "Save". */
const appliedSettings = ref<AdminSettings>(loadAdminSettings());
const apiBaseUrlInput = ref(appliedSettings.value.apiBaseUrl);
const accessTokenInput = ref(appliedSettings.value.accessToken);

const activeTab = ref<AdminTabId>('status');
const savedNote = ref('');
const connectionBusy = ref(false);
const connectionMessage = ref('');

/**
 * Recreated only when `appliedSettings` is replaced, never while the operator is typing: every panel
 * watches this instance and reloads its data when it changes.
 */
const client = computed(
  () =>
    new RtdbAdminApiClient({
      apiBaseUrl: normalizeApiBaseUrl(appliedSettings.value.apiBaseUrl),
      accessToken: appliedSettings.value.accessToken,
    }),
);

const isBundledForm = computed(() => normalizeApiBaseUrl(apiBaseUrlInput.value).length === 0);

function persistSettings(): void {
  const next: AdminSettings = {
    apiBaseUrl: normalizeApiBaseUrl(apiBaseUrlInput.value),
    accessToken: accessTokenInput.value.trim(),
  };
  appliedSettings.value = next;
  saveAdminSettings(next);
  connectionMessage.value = '';
  savedNote.value = 'Saved to this browser.';
}

async function testConnection(): Promise<void> {
  connectionBusy.value = true;
  connectionMessage.value = '';
  try {
    const health = await client.value.getHealth();
    connectionMessage.value = `Connected: GET /healthz responded "${health.status}".`;
  } catch (error) {
    connectionMessage.value = `Connection failed — ${describeError(error)}`;
  } finally {
    connectionBusy.value = false;
  }
}
</script>

<template>
  <div class="admin-app">
    <header class="admin-header">
      <div class="admin-title">
        <span>ss-rtdb</span>
        <small>admin console · static site over the public REST API</small>
      </div>
      <div class="admin-header-tools">
        <span class="badge">v0.1.0</span>
      </div>
    </header>

    <main class="admin-main">
      <div class="settings-bar">
        <div class="field field-wide">
          <label class="field-label">API base URL (empty = same origin, bundled form)</label>
          <input v-model="apiBaseUrlInput" type="text" placeholder="http://127.0.0.1:6180" />
        </div>
        <div class="field field-wide">
          <label class="field-label">Bearer token (empty = anonymous; write/query/admin scopes)</label>
          <input v-model="accessTokenInput" type="password" placeholder="issued via Access control" />
        </div>
        <button class="primary" @click="persistSettings">Save</button>
        <button :disabled="connectionBusy" @click="testConnection">
          {{ connectionBusy ? 'Testing…' : 'Test connection' }}
        </button>
        <span class="toolbar-note">
          {{ isBundledForm ? 'Targeting the origin that served this page.' : 'Targeting the remote server above.' }}
        </span>
      </div>

      <p v-if="savedNote.length > 0" class="alert success">{{ savedNote }}</p>
      <p
        v-if="connectionMessage.length > 0"
        class="alert"
        :class="connectionMessage.startsWith('Connected') ? 'success' : 'error'"
      >
        {{ connectionMessage }}
      </p>

      <nav class="tab-nav">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="tab-button"
          :class="{ active: tab.id === activeTab }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>

      <StatusPanel v-if="activeTab === 'status'" :client="client" />
      <DatabasesPanel v-else-if="activeTab === 'databases'" :client="client" />
      <MetricsPanel v-else-if="activeTab === 'metrics'" :client="client" />
      <BackupPanel v-else-if="activeTab === 'backup'" :client="client" />
      <AccessPanel v-else :client="client" />
    </main>
  </div>
</template>
