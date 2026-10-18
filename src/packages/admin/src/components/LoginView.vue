<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Full-screen sign-in gate of the console.
 *
 * The component is presentational on purpose: it owns the form state (user name, password, token) while
 * the credential exchange, session verification and persistence stay in `App.vue`. Nothing is rendered
 * until a valid token exists, so the console shell never flashes for an anonymous visitor.
 */

import { ref } from 'vue';
import { t, toggleLocale } from '../i18n';
import { normalizeApiBaseUrl } from '../settings';

const baseUrl = defineModel<string>('baseUrl', { required: true });

const props = defineProps<{
  /** A sign-in, token verification or connection test is in flight */
  busy: boolean;
  /** Already translated notice (kept as text so App.vue can re-render it on a locale switch) */
  noticeText: string;
  noticeTone: 'success' | 'error';
}>();

const emit = defineEmits<{
  submit: [credentials: { username: string; password: string }];
  token: [token: string];
  test: [];
}>();

/** Pre-filled with the documented bootstrap administrator, so the first sign-in is one click */
const username = ref('admin');
const password = ref('ss-rtdb');
const token = ref('');

function submit(): void {
  emit('submit', { username: username.value.trim(), password: password.value });
}

function useToken(): void {
  emit('token', token.value.trim());
}

const isBundledForm = (): boolean => normalizeApiBaseUrl(baseUrl.value).length === 0;
</script>

<template>
  <div class="login-page">
    <aside class="login-brand">
      <div class="login-brand-inner">
        <span class="brand-mark large" aria-hidden="true">ss</span>
        <h1>ss-rtdb</h1>
        <p>{{ t('app.subtitle') }}</p>
        <ul class="login-points">
          <li>{{ t('login.point.api') }}</li>
          <li>{{ t('login.point.static') }}</li>
          <li>{{ t('login.point.monitor') }}</li>
        </ul>
        <span class="login-version">v0.1.0</span>
      </div>
    </aside>

    <div class="login-pane">
      <button class="small login-locale" :title="t('app.locale.switchTitle')" @click="toggleLocale">
        {{ t('app.locale.switch') }}
      </button>

      <form class="login-card" @submit.prevent="submit">
        <div class="login-heading">
          <h2>{{ t('app.login.title') }}</h2>
          <p class="login-sub">{{ t('app.login.subtitle') }}</p>
        </div>

        <div class="login-field">
          <label for="login-username">{{ t('app.login.username') }}</label>
          <input
            id="login-username"
            v-model="username"
            type="text"
            autocomplete="username"
            autofocus
            :disabled="props.busy"
          />
        </div>

        <div class="login-field">
          <label for="login-password">{{ t('app.login.password') }}</label>
          <input
            id="login-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            :disabled="props.busy"
          />
        </div>

        <div class="login-field">
          <label for="login-server">{{ t('app.login.server') }}</label>
          <input
            id="login-server"
            v-model="baseUrl"
            type="text"
            placeholder="http://127.0.0.1:6180"
            autocomplete="off"
            :disabled="props.busy"
          />
          <span class="login-hint">
            {{ isBundledForm() ? t('app.settings.bundledHint') : t('app.settings.remoteHint') }}
          </span>
        </div>

        <button class="primary login-submit" type="submit" :disabled="props.busy">
          {{ props.busy ? t('app.login.busy') : t('app.login.submit') }}
        </button>

        <p v-if="props.noticeText.length > 0" class="alert login-notice" :class="props.noticeTone">
          {{ props.noticeText }}
        </p>

        <details class="login-advanced">
          <summary>{{ t('app.login.useExisting') }}</summary>
          <div class="login-field">
            <label for="login-token">{{ t('login.token') }}</label>
            <input
              id="login-token"
              v-model="token"
              type="password"
              placeholder="rtdb_…"
              autocomplete="off"
              :disabled="props.busy"
            />
          </div>
          <div class="login-advanced-actions">
            <button type="button" :disabled="props.busy" @click="useToken">{{ t('app.login.useToken') }}</button>
            <button type="button" :disabled="props.busy" @click="emit('test')">
              {{ props.busy ? t('app.settings.testing') : t('app.settings.test') }}
            </button>
          </div>
          <p class="login-hint">{{ t('app.login.tokenHint') }}</p>
        </details>

        <p class="login-hint">{{ t('app.login.defaultHint') }}</p>
      </form>
    </div>
  </div>
</template>
