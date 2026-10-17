<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Admin console shell: runtime connection settings, sign-in, plus in-page tab navigation.
 *
 * Sign-in exchanges a user name + password for an API token (`POST /api/v1/auth/login`) and keeps only the
 * token in `localStorage`, so every panel keeps calling the public REST API exactly as before; the token
 * field stays available for pasting a token issued elsewhere.
 *
 * Navigation is a plain `activeTab` state instead of a URL router on purpose — rtdb-server serves the
 * bundle through its SPA fallback, and keeping every route at `/admin` guarantees that the relative
 * asset URLs emitted by the `base: './'` build keep resolving correctly.
 */

import { computed, onMounted, ref } from 'vue';
import { RtdbAdminApiClient, RtdbAdminApiError } from './api';
import { loadAdminSettings, normalizeApiBaseUrl, saveAdminSettings } from './settings';
import type { AdminSettings } from './settings';
import { describeError } from './async';
import { t, toggleLocale } from './i18n';
import type { MessageKey } from './locales/en';
import AccessPanel from './components/AccessPanel.vue';
import BackupPanel from './components/BackupPanel.vue';
import DatabasesPanel from './components/DatabasesPanel.vue';
import MetricsPanel from './components/MetricsPanel.vue';
import StatusPanel from './components/StatusPanel.vue';

type AdminTabId = 'status' | 'databases' | 'metrics' | 'backup' | 'access';

interface AdminTab {
  id: AdminTabId;
  labelKey: MessageKey;
}

const TABS: AdminTab[] = [
  { id: 'status', labelKey: 'tabs.status' },
  { id: 'databases', labelKey: 'tabs.databases' },
  { id: 'metrics', labelKey: 'tabs.metrics' },
  { id: 'backup', labelKey: 'tabs.backup' },
  { id: 'access', labelKey: 'tabs.access' },
];

/**
 * A rendered notice keeps its key + params instead of a finished string, so switching the locale
 * re-renders an already displayed note in the new language.
 */
interface Notice {
  key: MessageKey;
  params?: Record<string, string | number>;
  tone: 'success' | 'error';
}

/** Settings actually in use. Edited through the form refs below and only applied on "Save". */
const appliedSettings = ref<AdminSettings>(loadAdminSettings());
const apiBaseUrlInput = ref(appliedSettings.value.apiBaseUrl);
const accessTokenInput = ref(appliedSettings.value.accessToken);

const activeTab = ref<AdminTabId>('status');
const savedNote = ref<Notice | null>(null);
const connectionBusy = ref(false);
const connectionNotice = ref<Notice | null>(null);

/** Sign-in state: the credential is exchanged for a token, which is the only thing the REST API needs. */
const loginUsername = ref('admin');
/** Pre-filled with the documented bootstrap password, so a first sign-in is one click */
const loginPassword = ref('ss-rtdb');
const loginBusy = ref(false);
const loginNotice = ref<Notice | null>(null);
const sessionUser = ref<{ username: string; role: string } | null>(null);
const showTokenInput = ref(false);

/** DOM handles for the header "Sign in" button (jump to the form and focus the password field) */
const loginCard = ref<HTMLElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);

function focusLogin(): void {
  loginCard.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  passwordInput.value?.focus();
}

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
const isSignedIn = computed(() => appliedSettings.value.accessToken.trim().length > 0);

/** Apply + persist a connection pair (base URL and token) without touching the notes. */
function applyConnection(apiBaseUrl: string, accessToken: string): void {
  const next: AdminSettings = {
    apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
    accessToken: accessToken.trim(),
  };
  appliedSettings.value = next;
  apiBaseUrlInput.value = next.apiBaseUrl;
  accessTokenInput.value = next.accessToken;
  saveAdminSettings(next);
}

function persistSettings(): void {
  applyConnection(apiBaseUrlInput.value, accessTokenInput.value);
  connectionNotice.value = null;
  savedNote.value = { key: 'app.savedNote', tone: 'success' };
}

async function testConnection(): Promise<void> {
  connectionBusy.value = true;
  connectionNotice.value = null;
  try {
    const health = await client.value.getHealth();
    connectionNotice.value = {
      key: 'app.connected',
      params: { status: health.status },
      tone: 'success',
    };
  } catch (error) {
    connectionNotice.value = {
      key: 'app.connectFailed',
      params: { message: describeError(error) },
      tone: 'error',
    };
  } finally {
    connectionBusy.value = false;
  }
}

/** Exchange the credentials for an API token and start using it (the password is never stored). */
async function signIn(): Promise<void> {
  loginBusy.value = true;
  loginNotice.value = null;
  try {
    const anonymous = new RtdbAdminApiClient({
      apiBaseUrl: normalizeApiBaseUrl(apiBaseUrlInput.value),
      accessToken: '',
    });
    const result = await anonymous.login(loginUsername.value.trim(), loginPassword.value);
    loginPassword.value = '';
    sessionUser.value = result.user;
    connectionNotice.value = null;
    savedNote.value = {
      key: 'app.signedInNote',
      params: { user: result.user.username, role: result.user.role },
      tone: 'success',
    };
    applyConnection(apiBaseUrlInput.value, result.token);
  } catch (error) {
    loginNotice.value = {
      key: 'app.signInFailed',
      params: { message: describeError(error) },
      tone: 'error',
    };
  } finally {
    loginBusy.value = false;
  }
}

/** Revoke the token server-side (best effort) and forget it in this browser. */
async function signOut(): Promise<void> {
  try {
    await client.value.logout();
  } catch {
    // An expired / already revoked token still has to be dropped locally.
  }
  sessionUser.value = null;
  loginNotice.value = null;
  applyConnection(apiBaseUrlInput.value, '');
  savedNote.value = { key: 'app.signedOut', tone: 'success' };
}

/** Confirm the stored token and resolve who it belongs to; a rejected token is forgotten. */
async function refreshSession(): Promise<void> {
  if (!isSignedIn.value) {
    sessionUser.value = null;
    return;
  }
  try {
    const session = await client.value.getSession();
    sessionUser.value = session.user;
  } catch (error) {
    sessionUser.value = null;
    if (error instanceof RtdbAdminApiError && error.status === 401) {
      applyConnection(apiBaseUrlInput.value, '');
      savedNote.value = { key: 'app.tokenRejected', tone: 'error' };
    }
  }
}

onMounted(refreshSession);
</script>

<template>
  <div class="admin-app">
    <header class="admin-header">
      <div class="admin-title">
        <span>ss-rtdb</span>
        <small>{{ t('app.subtitle') }}</small>
      </div>
      <div class="admin-header-tools">
        <span v-if="isSignedIn" class="badge">
          {{ sessionUser === null ? t('app.signedIn') : `${sessionUser.username} · ${sessionUser.role}` }}
        </span>
        <span v-else class="badge">{{ t('app.anonymous') }}</span>
        <button v-if="!isSignedIn" class="primary" @click="focusLogin">{{ t('app.signIn') }}</button>
        <button v-else @click="signOut">{{ t('app.signOut') }}</button>
        <button class="small" :title="t('app.locale.switchTitle')" @click="toggleLocale">
          {{ t('app.locale.switch') }}
        </button>
        <span class="badge">v0.1.0</span>
      </div>
    </header>

    <main class="admin-main">
      <section v-if="!isSignedIn" ref="loginCard" class="card">
        <h2 class="card-title">
          <span>{{ t('app.login.title') }}</span>
          <span class="card-title-note">POST /api/v1/auth/login</span>
        </h2>
        <div class="toolbar">
          <div class="field">
            <label class="field-label">{{ t('app.login.username') }}</label>
            <input v-model="loginUsername" type="text" autocomplete="username" placeholder="admin" />
          </div>
          <div class="field">
            <label class="field-label">{{ t('app.login.password') }}</label>
            <input
              ref="passwordInput"
              v-model="loginPassword"
              type="password"
              autocomplete="current-password"
              placeholder="ss-rtdb"
              @keyup.enter="signIn"
            />
          </div>
          <button class="primary" :disabled="loginBusy" @click="signIn">
            {{ loginBusy ? t('app.login.busy') : t('app.login.submit') }}
          </button>
          <button @click="showTokenInput = !showTokenInput">
            {{ showTokenInput ? t('app.login.hideToken') : t('app.login.useExisting') }}
          </button>
          <span class="toolbar-note">{{ t('app.login.defaultHint') }}</span>
        </div>
        <div v-if="showTokenInput" class="toolbar" style="margin-top: 12px">
          <div class="field field-wide">
            <label class="field-label">{{ t('app.login.tokenLabel') }}</label>
            <input v-model="accessTokenInput" type="password" placeholder="issued via Access control" />
          </div>
          <button class="primary" @click="persistSettings">{{ t('app.login.useToken') }}</button>
          <span class="toolbar-note">{{ t('app.login.tokenHint') }}</span>
        </div>
        <p v-if="loginNotice !== null" class="alert" :class="loginNotice.tone" style="margin-top: 12px">
          {{ t(loginNotice.key, loginNotice.params) }}
        </p>
      </section>

      <div class="settings-bar">
        <div class="field field-wide">
          <label class="field-label">{{ t('app.settings.baseUrl') }}</label>
          <input v-model="apiBaseUrlInput" type="text" placeholder="http://127.0.0.1:6180" />
        </div>
        <button class="primary" @click="persistSettings">{{ t('app.settings.save') }}</button>
        <button :disabled="connectionBusy" @click="testConnection">
          {{ connectionBusy ? t('app.settings.testing') : t('app.settings.test') }}
        </button>
        <span class="toolbar-note">
          {{ isBundledForm ? t('app.settings.bundledHint') : t('app.settings.remoteHint') }}
        </span>
      </div>

      <p v-if="savedNote !== null" class="alert" :class="savedNote.tone">
        {{ t(savedNote.key, savedNote.params) }}
      </p>
      <p v-if="connectionNotice !== null" class="alert" :class="connectionNotice.tone">
        {{ t(connectionNotice.key, connectionNotice.params) }}
      </p>

      <nav class="tab-nav">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="tab-button"
          :class="{ active: tab.id === activeTab }"
          @click="activeTab = tab.id"
        >
          {{ t(tab.labelKey) }}
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
