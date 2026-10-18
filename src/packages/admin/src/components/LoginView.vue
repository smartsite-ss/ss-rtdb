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
 *
 * Composition: one full-bleed branded backdrop (grid, glows, dimmed icon watermark) with a single centred
 * column — brand mark, tagline and the sign-in card — instead of a split screen. The card is the only
 * solid surface, which keeps the eye on the form at every viewport width.
 *
 * Branding comes from the shared Smart Site logo set (`src/assets/brand/`), so the console matches the
 * rest of the product family instead of drawing its own mark in CSS.
 */

import { ref } from 'vue';
import { t, toggleLocale } from '../i18n';
import { normalizeApiBaseUrl } from '../settings';
import brandLogoFull from '../assets/brand/logo-full.png';
import brandIcon from '../assets/brand/logo-icon-256.png';

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
const showPassword = ref(false);

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
    <div class="login-glow login-glow-a" aria-hidden="true"></div>
    <div class="login-glow login-glow-b" aria-hidden="true"></div>
    <img class="login-watermark" :src="brandIcon" alt="" aria-hidden="true" />

    <header class="login-top">
      <img class="login-top-logo" :src="brandLogoFull" alt="Smart Site" />
      <button class="small login-locale" :title="t('app.locale.switchTitle')" @click="toggleLocale">
        {{ t('app.locale.switch') }}
      </button>
    </header>

    <main class="login-stage">
      <div class="login-intro">
        <span class="login-eyebrow">ss-rtdb</span>
        <h1>{{ t('login.hero.title') }}</h1>
        <p class="login-hero-desc">{{ t('login.hero.desc') }}</p>
        <ul class="login-points">
          <li>
            <span class="login-point-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            {{ t('login.point.api') }}
          </li>
          <li>
            <span class="login-point-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            {{ t('login.point.static') }}
          </li>
          <li>
            <span class="login-point-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            {{ t('login.point.monitor') }}
          </li>
        </ul>
      </div>

      <form class="login-card" @submit.prevent="submit">
        <div class="login-card-head">
          <img class="login-card-icon" :src="brandIcon" alt="" />
          <div>
            <h2>{{ t('app.login.title') }}</h2>
            <p class="login-sub">{{ t('app.login.subtitle') }}</p>
          </div>
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
          <div class="login-input-wrap">
            <input
              id="login-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              :disabled="props.busy"
            />
            <button
              type="button"
              class="login-eye"
              :title="showPassword ? t('login.hidePassword') : t('login.showPassword')"
              :aria-label="showPassword ? t('login.hidePassword') : t('login.showPassword')"
              @click="showPassword = !showPassword"
            >
              <svg v-if="!showPassword" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                <circle cx="12" cy="12" r="3" />
                <path d="M4 20 20 4" />
              </svg>
            </button>
          </div>
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

        <p class="login-hint login-default-hint">{{ t('app.login.defaultHint') }}</p>
      </form>
    </main>

    <footer class="login-foot">
      <span class="login-version">ss-rtdb v0.1.0</span>
      <span aria-hidden="true">·</span>
      <a class="login-site" href="https://smartsite.top/" target="_blank" rel="noopener noreferrer">
        smartsite.top<span aria-hidden="true">↗</span>
      </a>
    </footer>
  </div>
</template>
