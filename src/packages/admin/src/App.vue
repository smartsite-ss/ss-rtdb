<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Admin console shell: sign-in gate, session lifecycle and the persistent sidebar layout.
 *
 * The console renders nothing but the login page until a token is present and verified against
 * `GET /api/v1/auth/session`; only then the workspace (sidebar + top bar + panel) is mounted. The token is
 * the only credential persisted in `localStorage` (the password is dropped with the login form), so every
 * panel keeps calling the public REST API exactly as before.
 *
 * Navigation is still a plain `activeTab` state instead of a URL router on purpose — rtdb-server serves the
 * bundle through its SPA fallback, and keeping every route at `/admin` guarantees that the relative asset
 * URLs emitted by the `base: './'` build keep resolving correctly.
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RtdbAdminApiClient, RtdbAdminApiError } from './api';
import { loadAdminSettings, normalizeApiBaseUrl, saveAdminSettings } from './settings';
import type { AdminSettings } from './settings';
import { describeError } from './async';
import { t, toggleLocale } from './i18n';
import type { MessageKey } from './locales/en';
import brandIcon from './assets/brand/logo-icon-64.png';
import AccessPanel from './components/AccessPanel.vue';
import BackupPanel from './components/BackupPanel.vue';
import ConnectionDialog from './components/ConnectionDialog.vue';
import DatabasesPanel from './components/DatabasesPanel.vue';
import LoginView from './components/LoginView.vue';
import MetricsPanel from './components/MetricsPanel.vue';
import StatusPanel from './components/StatusPanel.vue';

type AdminTabId = 'status' | 'databases' | 'metrics' | 'backup' | 'access';

interface AdminTab {
  id: AdminTabId;
  labelKey: MessageKey;
}

/** Navigation order inside the sidebar; groups mirror the operator's mental model, not the HTTP routes */
interface NavGroup {
  labelKey: MessageKey;
  tabs: AdminTabId[];
}

const TABS: AdminTab[] = [
  { id: 'status', labelKey: 'tabs.status' },
  { id: 'databases', labelKey: 'tabs.databases' },
  { id: 'metrics', labelKey: 'tabs.metrics' },
  { id: 'backup', labelKey: 'tabs.backup' },
  { id: 'access', labelKey: 'tabs.access' },
];

const NAV_GROUPS: NavGroup[] = [
  { labelKey: 'nav.group.overview', tabs: ['status'] },
  { labelKey: 'nav.group.data', tabs: ['databases', 'metrics', 'backup'] },
  { labelKey: 'nav.group.security', tabs: ['access'] },
];

/** Single-path outline icons drawn with `currentColor`, so no icon font / dependency is needed */
const TAB_ICONS: Record<AdminTabId, string> = {
  status: 'M3 12h3.5l2.5-6 3.5 12 2.5-6H21',
  metrics: 'M4 19V5m0 14h16M7 15l3.5-4 3 2L18 8',
  databases:
    'M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3Zm0 0v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6',
  backup: 'M12 4v10m0 0-3-3m3 3 3-3M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2',
  access: 'M12 3l7 3v5c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6l7-3Zm-2.4 8.6 1.8 1.8 3.4-3.4',
};

/**
 * A rendered notice keeps its key + params instead of a finished string, so switching the locale
 * re-renders an already displayed note in the new language.
 */
interface Notice {
  key: MessageKey;
  params?: Record<string, string | number>;
  tone: 'success' | 'error';
}

/** Settings actually in use. The login form / connection dialog only propose new values. */
const appliedSettings = ref<AdminSettings>(loadAdminSettings());
/** Server address being typed on the login page (kept separate until the sign-in succeeds) */
const loginBaseUrl = ref(appliedSettings.value.apiBaseUrl);

const activeTab = ref<AdminTabId>('status');
const sessionUser = ref<{ username: string; role: string } | null>(null);
/**
 * Instance with `auth.enabled=false` answers `GET /api/v1/auth/session` without a token; the console then
 * runs in open-access mode instead of dead-ending on a sign-in page that can never succeed (no users).
 */
const openAccess = ref(false);
/** False only while the stored token is being verified, which prevents a login-page flash on reload */
const sessionChecked = ref(false);
const loginBusy = ref(false);
const authNotice = ref<Notice | null>(null);
const shellNotice = ref<Notice | null>(null);

const connectionOpen = ref(false);
const connectionBusy = ref(false);
const connectionNotice = ref<Notice | null>(null);

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

const isSignedIn = computed(() => openAccess.value || appliedSettings.value.accessToken.trim().length > 0);
const activeTabMeta = computed(() => TABS.find((tab) => tab.id === activeTab.value) ?? TABS[0]);
const userInitial = computed(() => (sessionUser.value?.username ?? '?').slice(0, 1).toUpperCase());

/**
 * Built-in API reference of the targeted server (`GET /api/docs`). It follows the *applied* base URL, so
 * the bundled form resolves relatively and a standalone console points at its remote instance.
 */
const apiDocsUrl = computed(() => `${normalizeApiBaseUrl(appliedSettings.value.apiBaseUrl)}/api/docs`);

const loginNoticeText = computed(() =>
  authNotice.value === null ? '' : t(authNotice.value.key, authNotice.value.params),
);
const loginNoticeTone = computed(() => authNotice.value?.tone ?? 'error');
const connectionNoticeText = computed(() =>
  connectionNotice.value === null ? '' : t(connectionNotice.value.key, connectionNotice.value.params),
);
const connectionNoticeTone = computed(() => connectionNotice.value?.tone ?? 'error');
const signInBusy = computed(() => loginBusy.value || connectionBusy.value);

let shellNoticeTimer: ReturnType<typeof setTimeout> | null = null;

/** Apply + persist a connection pair (base URL and token) without touching the notes. */
function applyConnection(apiBaseUrl: string, accessToken: string): void {
  const next: AdminSettings = {
    apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
    accessToken: accessToken.trim(),
  };
  appliedSettings.value = next;
  loginBaseUrl.value = next.apiBaseUrl;
  saveAdminSettings(next);
  if (next.accessToken.length > 0) openAccess.value = false;
}

/** Transient confirmation in the workspace; authentication notices stay on the login page instead */
function notifyShell(key: MessageKey, params?: Record<string, string | number>): void {
  shellNotice.value = { key, params, tone: 'success' };
  if (shellNoticeTimer !== null) clearTimeout(shellNoticeTimer);
  shellNoticeTimer = setTimeout(() => {
    shellNotice.value = null;
    shellNoticeTimer = null;
  }, 4_000);
}

function openConnectionDialog(): void {
  connectionNotice.value = null;
  connectionOpen.value = true;
}

/** Confirm the stored token and resolve who it belongs to; a rejected token is forgotten. */
async function verifySession(): Promise<void> {
  try {
    sessionUser.value = (await client.value.getSession()).user;
  } catch (error) {
    sessionUser.value = null;
    if (error instanceof RtdbAdminApiError && error.status === 401) {
      applyConnection(appliedSettings.value.apiBaseUrl, '');
      authNotice.value = { key: 'app.tokenRejected', tone: 'error' };
    }
  }
}

/** Exchange the credentials for an API token and enter the workspace (the password is never stored). */
async function signIn(credentials: { username: string; password: string }): Promise<void> {
  loginBusy.value = true;
  authNotice.value = null;
  try {
    const anonymous = new RtdbAdminApiClient({
      apiBaseUrl: normalizeApiBaseUrl(loginBaseUrl.value),
      accessToken: '',
    });
    const result = await anonymous.login(credentials.username, credentials.password);
    sessionUser.value = result.user;
    applyConnection(loginBaseUrl.value, result.token);
    sessionChecked.value = true;
    notifyShell('app.signedInNote', { user: result.user.username, role: result.user.role });
  } catch (error) {
    authNotice.value = {
      key: 'app.signInFailed',
      params: { message: describeError(error) },
      tone: 'error',
    };
  } finally {
    loginBusy.value = false;
  }
}

/** Alternative to the password: verify a token issued elsewhere before adopting it. */
async function signInWithToken(token: string): Promise<void> {
  if (token.length === 0) {
    authNotice.value = { key: 'app.login.tokenEmpty', tone: 'error' };
    return;
  }
  loginBusy.value = true;
  authNotice.value = null;
  try {
    const candidate = new RtdbAdminApiClient({
      apiBaseUrl: normalizeApiBaseUrl(loginBaseUrl.value),
      accessToken: token,
    });
    const session = await candidate.getSession();
    sessionUser.value = session.user;
    applyConnection(loginBaseUrl.value, token);
    sessionChecked.value = true;
    notifyShell('app.signedInNote', { user: session.user.username, role: session.user.role });
  } catch (error) {
    authNotice.value = {
      key: 'app.tokenRejectedHint',
      params: { message: describeError(error) },
      tone: 'error',
    };
  } finally {
    loginBusy.value = false;
  }
}

/** Health probe of the server address currently being typed (login page) or entered in the dialog. */
async function testConnection(baseUrl: string, onLoginPage: boolean): Promise<void> {
  connectionBusy.value = true;
  const notice: Notice = { key: 'app.connectFailed', tone: 'error' };
  try {
    const probe = new RtdbAdminApiClient({ apiBaseUrl: normalizeApiBaseUrl(baseUrl), accessToken: '' });
    const health = await probe.getHealth();
    notice.key = 'app.connected';
    notice.params = { status: health.status };
    notice.tone = 'success';
  } catch (error) {
    notice.params = { message: describeError(error) };
  }
  connectionBusy.value = false;
  if (onLoginPage) authNotice.value = notice;
  else connectionNotice.value = notice;
}

/** Persist the dialog values; an empty token signs out, and a new token is verified before use. */
function saveConnection(connection: { apiBaseUrl: string; accessToken: string }): void {
  applyConnection(connection.apiBaseUrl, connection.accessToken);
  connectionOpen.value = false;
  connectionNotice.value = null;
  if (!isSignedIn.value) {
    sessionUser.value = null;
    authNotice.value = { key: 'app.signedOut', tone: 'success' };
    return;
  }
  notifyShell('app.savedNote');
  void verifySession();
}

/** Revoke the token server-side (best effort) and forget it in this browser. */
async function signOut(): Promise<void> {
  try {
    await client.value.logout();
  } catch {
    // An expired / already revoked token still has to be dropped locally.
  }
  sessionUser.value = null;
  applyConnection(appliedSettings.value.apiBaseUrl, '');
  authNotice.value = { key: 'app.signedOut', tone: 'success' };
}

onMounted(async () => {
  try {
    if (!isSignedIn.value) {
      // Anonymous requests only succeed when the instance disables authentication; then there is no
      // credential to ask for, so the console opens directly instead of showing an unusable sign-in page.
      try {
        const session = await client.value.getSession();
        sessionUser.value = session.user;
        openAccess.value = true;
      } catch {
        // Authentication is required: the sign-in page is the correct destination.
      }
      return;
    }
    await verifySession();
  } finally {
    sessionChecked.value = true;
  }
});

onUnmounted(() => {
  if (shellNoticeTimer !== null) clearTimeout(shellNoticeTimer);
});
</script>

<template>
  <div v-if="!sessionChecked" class="boot-splash">
    <span class="boot-spinner" aria-hidden="true"></span>
    <span>{{ t('app.login.sessionChecking') }}</span>
  </div>

  <LoginView
    v-else-if="!isSignedIn"
    v-model:base-url="loginBaseUrl"
    :busy="signInBusy"
    :notice-text="loginNoticeText"
    :notice-tone="loginNoticeTone"
    @submit="signIn"
    @token="signInWithToken"
    @test="testConnection(loginBaseUrl, true)"
  />

  <div v-else class="admin-shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <img class="brand-mark" :src="brandIcon" alt="" />
        <div class="sidebar-brand-text">
          <strong>ss-rtdb</strong>
          <small>{{ t('app.brandNote') }}</small>
        </div>
      </div>

      <nav class="sidebar-nav">
        <div v-for="group in NAV_GROUPS" :key="group.labelKey" class="nav-group">
          <div class="nav-group-label">{{ t(group.labelKey) }}</div>
          <button
            v-for="tabId in group.tabs"
            :key="tabId"
            class="nav-item"
            :class="{ active: tabId === activeTab }"
            :aria-current="tabId === activeTab ? 'page' : undefined"
            @click="activeTab = tabId"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path :d="TAB_ICONS[tabId]" />
            </svg>
            <span>{{ t((TABS.find((tab) => tab.id === tabId) ?? TABS[0]).labelKey) }}</span>
          </button>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-user">
          <span class="avatar" aria-hidden="true">{{ userInitial }}</span>
          <div class="sidebar-user-meta">
            <div class="sidebar-user-name">{{ sessionUser?.username ?? t('app.signedIn') }}</div>
            <div class="sidebar-user-role">
              {{ openAccess ? t('app.openAccess') : (sessionUser?.role ?? '') }}
            </div>
          </div>
        </div>
        <button class="sidebar-button" @click="openConnectionDialog">{{ t('nav.connection') }}</button>
        <button v-if="!openAccess" class="sidebar-button" @click="signOut">{{ t('app.signOut') }}</button>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="topbar-title">
          <h1>{{ t(activeTabMeta.labelKey) }}</h1>
          <p>{{ t('app.subtitle') }}</p>
        </div>
        <div class="topbar-tools">
          <a class="link-button" :href="apiDocsUrl" target="_blank" rel="noopener noreferrer">
            {{ t('tabs.apiDocs') }}<span aria-hidden="true">↗</span>
          </a>
          <button class="small" :title="t('app.locale.switchTitle')" @click="toggleLocale">
            {{ t('app.locale.switch') }}
          </button>
        </div>
      </header>

      <main class="content">
        <p v-if="shellNotice !== null" class="alert shell-notice" :class="shellNotice.tone">
          {{ t(shellNotice.key, shellNotice.params) }}
        </p>

        <StatusPanel v-if="activeTab === 'status'" :client="client" />
        <MetricsPanel v-else-if="activeTab === 'metrics'" :client="client" />
        <DatabasesPanel v-else-if="activeTab === 'databases'" :client="client" />
        <BackupPanel v-else-if="activeTab === 'backup'" :client="client" />
        <AccessPanel v-else :client="client" />
      </main>
    </div>
  </div>

  <ConnectionDialog
    :open="connectionOpen"
    :api-base-url="appliedSettings.apiBaseUrl"
    :access-token="appliedSettings.accessToken"
    :busy="connectionBusy"
    :notice-text="connectionNoticeText"
    :notice-tone="connectionNoticeTone"
    @close="connectionOpen = false"
    @save="saveConnection"
    @test="(baseUrl) => testConnection(baseUrl, false)"
  />
</template>
