<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Server-connection dialog: API base URL plus an optional bearer token.
 *
 * Both values are runtime settings of the static console (bundled form targets its own origin, standalone
 * form targets a remote server), so they live in a dialog instead of a permanent bar on the dashboard.
 * Saving an empty token signs the operator out — that is stated in the hint, not silently done.
 */

import { computed, onUnmounted, ref, watch } from 'vue';
import { t } from '../i18n';
import { normalizeApiBaseUrl } from '../settings';

const props = defineProps<{
  open: boolean;
  apiBaseUrl: string;
  accessToken: string;
  busy: boolean;
  noticeText: string;
  noticeTone: 'success' | 'error';
}>();

const emit = defineEmits<{
  close: [];
  save: [connection: { apiBaseUrl: string; accessToken: string }];
  test: [apiBaseUrl: string];
}>();

const baseUrlInput = ref(props.apiBaseUrl);
const tokenInput = ref(props.accessToken);

/** Re-seed the fields every time the dialog opens, so a cancelled edit leaves no residue */
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    baseUrlInput.value = props.apiBaseUrl;
    tokenInput.value = props.accessToken;
  },
);

/** Escape has to close the dialog like the Cancel button does (it is the only modal of the console) */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onKeydown);
    else window.removeEventListener('keydown', onKeydown);
  },
);

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});

const targetHint = computed(() =>
  normalizeApiBaseUrl(baseUrlInput.value).length === 0
    ? t('app.settings.bundledHint')
    : t('app.settings.remoteHint'),
);

function save(): void {
  emit('save', { apiBaseUrl: baseUrlInput.value, accessToken: tokenInput.value });
}
</script>

<template>
  <div v-if="props.open" class="modal-backdrop" @click.self="emit('close')">
    <form class="modal" role="dialog" aria-modal="true" @submit.prevent="save">
      <h2>{{ t('connection.title') }}</h2>

      <div class="login-field">
        <label for="connection-base-url">{{ t('app.settings.baseUrl') }}</label>
        <input
          id="connection-base-url"
          v-model="baseUrlInput"
          type="text"
          placeholder="http://127.0.0.1:6180"
          autocomplete="off"
        />
        <span class="login-hint">{{ targetHint }}</span>
      </div>

      <div class="login-field">
        <label for="connection-token">{{ t('connection.tokenLabel') }}</label>
        <input
          id="connection-token"
          v-model="tokenInput"
          type="password"
          autocomplete="off"
          :placeholder="t('connection.tokenPlaceholder')"
        />
        <span class="login-hint">{{ t('connection.tokenHint') }}</span>
      </div>

      <p v-if="props.noticeText.length > 0" class="alert" :class="props.noticeTone">{{ props.noticeText }}</p>

      <div class="modal-actions">
        <button type="button" :disabled="props.busy" @click="emit('test', baseUrlInput)">
          {{ props.busy ? t('app.settings.testing') : t('app.settings.test') }}
        </button>
        <button type="button" @click="emit('close')">{{ t('connection.cancel') }}</button>
        <button class="primary" type="submit" :disabled="props.busy">{{ t('app.settings.save') }}</button>
      </div>
    </form>
  </div>
</template>
