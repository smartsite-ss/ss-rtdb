<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Access control: the `admin` scope surface of §3.1 (`/api/v1/admin/users`, `/api/v1/admin/tokens`).
 *
 * The plaintext of a freshly issued token is displayed exactly once, because the server persists only
 * its hash; this panel keeps it in memory until the operator switches tab or reloads.
 */

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { RtdbAdminApiClient, RtdbConfigTokenUsage, RtdbPublicToken, RtdbPublicUser } from '../api';
import { useAsyncAction } from '../async';
import { formatBytes, formatDateTime, formatNumber } from '../format';
import { t } from '../i18n';

const props = defineProps<{ client: RtdbAdminApiClient }>();

/** Mirrors the server-side `USER_ROLE` constants (roles are plain strings, never an enum) */
const ROLE_OPTIONS = ['admin', 'write', 'readonly'] as const;
const HOURS_TO_MILLISECONDS = 3_600_000;
/** Write rates are a rolling 10 s window, so the table polls while it is open instead of freezing a stale value */
const AUTO_REFRESH_MS = 5_000;
/** Token id the server uses for the static `auth.token` / `rtdb.token` (no token-store record) */
const STATIC_TOKEN_ID = 'config-token';
/** Label of the console sign-in sessions; a new login revokes the previous ones (single-session semantics) */
const SIGN_IN_LABEL = 'console login';

/** Retired sign-in sessions are audit noise: hidden by default, revealed by the operator on demand */
const showRetiredSessions = ref(false);

const { busy, errorMessage, successMessage, run } = useAsyncAction();
const users = ref<RtdbPublicUser[]>([]);
const tokens = ref<RtdbPublicToken[]>([]);
/** Usage of the static token; `null` when the server does not report it */
const configToken = ref<RtdbConfigTokenUsage | null>(null);

const issueUser = ref('');
const issueRole = ref('');
const issueLabel = ref('');
const issueTtlHours = ref('');
const issuedTokenPlaintext = ref('');

async function loadUsers(): Promise<void> {
  const list = await run(() => props.client.listUsers());
  if (list !== undefined) users.value = list;
}

async function loadTokens(): Promise<void> {
  const report = await run(() => props.client.listTokens());
  if (report !== undefined) applyTokenReport(report);
}

/**
 * Background poll: refresh the usage numbers without touching the busy state, so the toolbar does not blink and a
 * transient failure keeps the last snapshot instead of replacing the table with an error banner.
 */
async function pollTokens(): Promise<void> {
  try {
    applyTokenReport(await props.client.listTokens());
  } catch {
    // Keep the previous snapshot; the explicit Refresh button surfaces errors.
  }
}

function applyTokenReport(report: { tokens: RtdbPublicToken[]; configToken?: RtdbConfigTokenUsage }): void {
  tokens.value = report.tokens;
  configToken.value = report.configToken ?? null;
}

async function reloadBoth(): Promise<void> {
  await loadUsers();
  await loadTokens();
}

async function issueToken(): Promise<void> {
  const user = issueUser.value.trim();
  const role = issueRole.value;
  const label = issueLabel.value.trim();
  const ttlHoursText = issueTtlHours.value.trim();

  const result = await run(async () => {
    if (user.length === 0) throw new Error(t('access.error.ownerRequired'));
    const ttlMs = ttlHoursText.length === 0 ? null : Math.round(Number(ttlHoursText) * HOURS_TO_MILLISECONDS);
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error(t('access.error.ttlPositive'));
    }
    return props.client.issueToken(user, role.length === 0 ? null : role, label, ttlMs);
  });

  if (result !== undefined) {
    issuedTokenPlaintext.value = result.token;
    await loadTokens();
    if (errorMessage.value.length === 0) successMessage.value = t('access.success.issued');
  }
}

async function revokeToken(tokenId: string): Promise<void> {
  if (!window.confirm(t('access.confirm.revoke', { tokenId }))) return;
  const revoked = await run(() => props.client.revokeToken(tokenId));
  await loadTokens();
  if (revoked !== undefined && errorMessage.value.length === 0) {
    successMessage.value = t('access.success.revoked', { tokenId });
  }
}

/** A `console login` token retired by a later sign-in — kept server-side for audit, hidden from the table */
function isRetiredSession(token: RtdbPublicToken): boolean {
  return token.label === SIGN_IN_LABEL && token.revokedAt !== null;
}

/** Retired sessions the server still returns (the counter is always the full list, the table is filtered) */
const retiredSessionCount = computed(() => tokens.value.filter(isRetiredSession).length);
const visibleTokens = computed(() =>
  showRetiredSessions.value ? tokens.value : tokens.value.filter((token) => !isRetiredSession(token)),
);

/** Older servers do not report the usage fields at all; show "not reported" instead of a misleading 0 */
function hasUsage(entry: { pointsPerSec?: number; bytesPerSec?: number }): boolean {
  return typeof entry.pointsPerSec === 'number' && typeof entry.bytesPerSec === 'number';
}

/** Token ids are UUIDs; keep the column narrow (prefix + suffix) and expose the full id through `title` */
function shortTokenId(tokenId: string): string {
  return tokenId.length <= 20 ? tokenId : `${tokenId.slice(0, 8)}…${tokenId.slice(-4)}`;
}

function dismissPlaintext(): void {
  issuedTokenPlaintext.value = '';
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void reloadBoth();
  refreshTimer = setInterval(() => {
    void pollTokens();
  }, AUTO_REFRESH_MS);
});

onUnmounted(() => {
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = null;
});

watch(
  () => props.client,
  () => {
    issuedTokenPlaintext.value = '';
    void reloadBoth();
  },
);
</script>

<template>
  <section class="panel">
    <div class="card">
      <div class="card-title">
        <span>{{ t('access.issueTitle') }}</span>
        <span class="card-title-note">POST /api/v1/admin/tokens (scope: admin)</span>
      </div>

      <div class="toolbar">
        <div class="field">
          <label class="field-label">{{ t('access.owner') }}</label>
          <input
            v-model="issueUser"
            list="admin-owner-candidates"
            type="text"
            :placeholder="t('access.ownerPlaceholder')"
            :disabled="busy"
          />
          <datalist id="admin-owner-candidates">
            <option v-for="user in users" :key="user.username" :value="user.username" />
          </datalist>
        </div>
        <div class="field">
          <label class="field-label">{{ t('access.role') }}</label>
          <select v-model="issueRole" :disabled="busy">
            <option value="">{{ t('access.roleDefault') }}</option>
            <option v-for="role in ROLE_OPTIONS" :key="role" :value="role">{{ role }}</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label">{{ t('access.label') }}</label>
          <input
            v-model="issueLabel"
            type="text"
            :placeholder="t('access.labelPlaceholder')"
            :disabled="busy"
          />
        </div>
        <div class="field">
          <label class="field-label">{{ t('access.ttl') }}</label>
          <input v-model="issueTtlHours" type="number" min="1" step="1" style="width: 150px" :disabled="busy" />
        </div>
        <button class="primary" :disabled="busy" @click="issueToken">{{ t('access.issue') }}</button>
      </div>

      <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>
      <p v-if="successMessage.length > 0" class="alert success">{{ successMessage }}</p>

      <div v-if="issuedTokenPlaintext.length > 0" class="alert">
        <p>{{ t('access.plaintextHint') }}</p>
        <p class="mono break-all">{{ issuedTokenPlaintext }}</p>
        <button class="small danger" @click="dismissPlaintext">{{ t('access.hide') }}</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>{{ t('access.usersTitle') }}</span>
        <span class="card-title-note">GET /api/v1/admin/users</span>
      </div>
      <div v-if="users.length > 0" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('access.column.username') }}</th>
              <th>{{ t('access.column.role') }}</th>
              <th>{{ t('access.column.enabled') }}</th>
              <th>{{ t('access.column.created') }}</th>
              <th>{{ t('access.column.updated') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.username">
              <td class="mono">{{ user.username }}</td>
              <td><span class="badge">{{ user.role }}</span></td>
              <td>
                <span :class="['badge', user.enabled ? 'success' : 'danger']">
                  {{ user.enabled ? t('access.enabledYes') : t('access.enabledNo') }}
                </span>
              </td>
              <td class="mono">{{ formatDateTime(user.createdAt) }}</td>
              <td class="mono">{{ formatDateTime(user.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty-hint">{{ t('access.usersEmpty') }}</p>
    </div>

    <div class="card">
      <div class="card-title">
        <span>{{ t('access.tokensTitle') }}</span>
        <span class="card-title-note">GET /api/v1/admin/tokens · DELETE /api/v1/admin/tokens/{tokenId}</span>
      </div>

      <div class="toolbar">
        <button :disabled="busy" @click="loadTokens">{{ t('access.refreshTokens') }}</button>
        <label class="toolbar-note">
          <input v-model="showRetiredSessions" type="checkbox" />
          {{ t('access.showRetiredSessions') }}
        </label>
        <span class="toolbar-note">{{ t('access.tokensCount', { count: visibleTokens.length }) }}</span>
        <span v-if="retiredSessionCount > 0" class="toolbar-note">
          {{ t('access.tokensRetired', { count: retiredSessionCount }) }}
        </span>
        <span class="toolbar-note">{{ t('access.tokensHint') }}</span>
        <span class="toolbar-note">{{ t('access.autoRefresh', { seconds: AUTO_REFRESH_MS / 1000 }) }}</span>
      </div>

      <div v-if="visibleTokens.length > 0 || configToken !== null" class="table-wrap">
        <table class="data-table token-table">
          <thead>
            <tr>
              <th>{{ t('access.column.tokenId') }}</th>
              <th>{{ t('access.column.rate') }}</th>
              <th>{{ t('access.column.owner') }}</th>
              <th>{{ t('access.column.label') }}</th>
              <th>{{ t('access.column.validity') }}</th>
              <th>{{ t('access.column.lastAccess') }}</th>
              <th>{{ t('access.column.status') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="configToken !== null" class="static-token-row">
              <td class="mono">{{ STATIC_TOKEN_ID }}</td>
              <td class="mono">
                <template v-if="hasUsage(configToken)">
                  <div>{{ t('access.ratePoints', { points: formatNumber(configToken.pointsPerSec) }) }}</div>
                  <div class="toolbar-note">
                    {{ t('access.rateBytes', { bytes: formatBytes(configToken.bytesPerSec) }) }}
                  </div>
                </template>
                <span v-else class="toolbar-note">{{ t('access.rateUnavailable') }}</span>
              </td>
              <td class="mono">
                <div>{{ configToken.user }}</div>
                <div><span class="badge">admin</span></div>
              </td>
              <td class="wrap-cell">
                <div>{{ t('access.staticTokenLabel') }}</div>
                <div class="toolbar-note token-hint">{{ t('access.staticTokenHint') }}</div>
              </td>
              <td>
                <div class="mono">—</div>
                <div class="toolbar-note">{{ t('access.never') }}</div>
              </td>
              <td>
                <div class="mono">{{ configToken.lastDatabase ?? '—' }}</div>
                <div class="toolbar-note">
                  {{
                    configToken.lastUsedAt === null
                      ? t('access.neverUsed')
                      : formatDateTime(configToken.lastUsedAt)
                  }}
                </div>
              </td>
              <td><span class="badge success">{{ t('access.staticTokenBadge') }}</span></td>
            </tr>
            <tr v-for="token in visibleTokens" :key="token.tokenId">
              <td class="mono" :title="token.tokenId">{{ shortTokenId(token.tokenId) }}</td>
              <td class="mono">
                <template v-if="hasUsage(token)">
                  <div>{{ t('access.ratePoints', { points: formatNumber(token.pointsPerSec) }) }}</div>
                  <div class="toolbar-note">
                    {{ t('access.rateBytes', { bytes: formatBytes(token.bytesPerSec) }) }}
                  </div>
                </template>
                <span v-else class="toolbar-note">{{ t('access.rateUnavailable') }}</span>
              </td>
              <td class="mono">
                <div>{{ token.user }}</div>
                <div><span class="badge">{{ token.role }}</span></div>
              </td>
              <td class="wrap-cell">{{ token.label }}</td>
              <td>
                <div class="mono">{{ formatDateTime(token.createdAt) }}</div>
                <div class="toolbar-note">
                  {{ token.expiresAt === null ? t('access.never') : formatDateTime(token.expiresAt) }}
                </div>
              </td>
              <td>
                <div class="mono">{{ token.lastDatabase ?? '—' }}</div>
                <div class="toolbar-note">
                  <template v-if="token.lastUsedAt === undefined">—</template>
                  <template v-else>
                    {{ token.lastUsedAt ? formatDateTime(token.lastUsedAt) : t('access.neverUsed') }}
                  </template>
                </div>
              </td>
              <td>
                <div>
                  <span :class="['badge', token.revokedAt === null ? 'success' : 'danger']">
                    {{
                      token.revokedAt === null
                        ? t('access.active')
                        : t('access.revokedAt', { time: formatDateTime(token.revokedAt) })
                    }}
                  </span>
                </div>
                <div>
                  <button
                    class="small danger"
                    :disabled="busy || token.revokedAt !== null"
                    @click="revokeToken(token.tokenId)"
                  >
                    {{ t('access.revoke') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="retiredSessionCount > 0" class="empty-hint">{{ t('access.tokensEmptyRetired') }}</p>
      <p v-else class="empty-hint">{{ t('access.tokensEmpty') }}</p>
    </div>
  </section>
</template>
