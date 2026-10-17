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

import { onMounted, ref, watch } from 'vue';
import type { RtdbAdminApiClient, RtdbPublicToken, RtdbPublicUser } from '../api';
import { useAsyncAction } from '../async';
import { formatDateTime } from '../format';

const props = defineProps<{ client: RtdbAdminApiClient }>();

/** Mirrors the server-side `USER_ROLE` constants (roles are plain strings, never an enum) */
const ROLE_OPTIONS = ['admin', 'write', 'readonly'] as const;
const HOURS_TO_MILLISECONDS = 3_600_000;

const { busy, errorMessage, successMessage, run } = useAsyncAction();
const users = ref<RtdbPublicUser[]>([]);
const tokens = ref<RtdbPublicToken[]>([]);

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
  const list = await run(() => props.client.listTokens());
  if (list !== undefined) tokens.value = list;
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
    if (user.length === 0) throw new Error('Enter the owner username.');
    const ttlMs = ttlHoursText.length === 0 ? null : Math.round(Number(ttlHoursText) * HOURS_TO_MILLISECONDS);
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error('TTL hours must be a positive number.');
    }
    return props.client.issueToken(user, role.length === 0 ? null : role, label, ttlMs);
  });

  if (result !== undefined) {
    issuedTokenPlaintext.value = result.token;
    await loadTokens();
    if (errorMessage.value.length === 0) successMessage.value = 'Token issued. The plaintext is shown once below.';
  }
}

async function revokeToken(tokenId: string): Promise<void> {
  if (!window.confirm(`Revoke token "${tokenId}"? This cannot be undone.`)) return;
  const revoked = await run(() => props.client.revokeToken(tokenId));
  await loadTokens();
  if (revoked !== undefined && errorMessage.value.length === 0) {
    successMessage.value = `Token "${tokenId}" revoked.`;
  }
}

function dismissPlaintext(): void {
  issuedTokenPlaintext.value = '';
}

onMounted(() => {
  void reloadBoth();
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
        <span>Issue token</span>
        <span class="card-title-note">POST /api/v1/admin/tokens (scope: admin)</span>
      </div>

      <div class="toolbar">
        <div class="field">
          <label class="field-label">Owner</label>
          <input v-model="issueUser" list="admin-owner-candidates" type="text" placeholder="username" :disabled="busy" />
          <datalist id="admin-owner-candidates">
            <option v-for="user in users" :key="user.username" :value="user.username" />
          </datalist>
        </div>
        <div class="field">
          <label class="field-label">Role (empty = owner role)</label>
          <select v-model="issueRole" :disabled="busy">
            <option value="">(default)</option>
            <option v-for="role in ROLE_OPTIONS" :key="role" :value="role">{{ role }}</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label">Label</label>
          <input v-model="issueLabel" type="text" placeholder="e.g. collector-01" :disabled="busy" />
        </div>
        <div class="field">
          <label class="field-label">TTL hours (empty = never expires)</label>
          <input v-model="issueTtlHours" type="number" min="1" step="1" style="width: 150px" :disabled="busy" />
        </div>
        <button class="primary" :disabled="busy" @click="issueToken">Issue</button>
      </div>

      <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>
      <p v-if="successMessage.length > 0" class="alert success">{{ successMessage }}</p>

      <div v-if="issuedTokenPlaintext.length > 0" class="alert">
        <p>Plaintext token (shown once, copy it now):</p>
        <p class="mono break-all">{{ issuedTokenPlaintext }}</p>
        <button class="small danger" @click="dismissPlaintext">Hide</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>Users</span>
        <span class="card-title-note">GET /api/v1/admin/users</span>
      </div>
      <div v-if="users.length > 0" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Enabled</th>
              <th>Created</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.username">
              <td class="mono">{{ user.username }}</td>
              <td><span class="badge">{{ user.role }}</span></td>
              <td>
                <span :class="['badge', user.enabled ? 'success' : 'danger']">
                  {{ user.enabled ? 'enabled' : 'disabled' }}
                </span>
              </td>
              <td class="mono">{{ formatDateTime(user.createdAt) }}</td>
              <td class="mono">{{ formatDateTime(user.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty-hint">No user defined. User management requires the CLI (`rtdb-cli user add`).</p>
    </div>

    <div class="card">
      <div class="card-title">
        <span>Tokens</span>
        <span class="card-title-note">GET /api/v1/admin/tokens · DELETE /api/v1/admin/tokens/{tokenId}</span>
      </div>
      <div v-if="tokens.length > 0" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Token id</th>
              <th>Owner</th>
              <th>Role</th>
              <th>Label</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="token in tokens" :key="token.tokenId">
              <td class="mono">{{ token.tokenId }}</td>
              <td class="mono">{{ token.user }}</td>
              <td><span class="badge">{{ token.role }}</span></td>
              <td>{{ token.label }}</td>
              <td class="mono">{{ formatDateTime(token.createdAt) }}</td>
              <td class="mono">{{ token.expiresAt === null ? 'never' : formatDateTime(token.expiresAt) }}</td>
              <td>
                <span :class="['badge', token.revokedAt === null ? 'success' : 'danger']">
                  {{ token.revokedAt === null ? 'active' : `revoked ${formatDateTime(token.revokedAt)}` }}
                </span>
              </td>
              <td>
                <button
                  class="small danger"
                  :disabled="busy || token.revokedAt !== null"
                  @click="revokeToken(token.tokenId)"
                >
                  Revoke
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty-hint">No token issued yet.</p>
    </div>
  </section>
</template>
