<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Single "time range" control: the toolbar shows one trigger with the current span, and the popover holds the
 * quick presets plus the exact start / end pickers. Presets apply immediately; the manual fields apply on
 * "Apply", so a half-typed date never fires a query.
 *
 * Values are `<input type="datetime-local">` strings (`YYYY-MM-DDTHH:mm:ss`) owned by the parent, which keeps the
 * query inputs and the URL-free state model of the console unchanged.
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import { formatDateTime, fromDateTimeLocalValue, toDateTimeLocalValue } from '../format';
import { t } from '../i18n';
import type { MessageKey } from '../locales/en';

const props = defineProps<{
  start: string;
  end: string;
  /** First / last timestamp of the selected metric, used by the "All" preset; `null` disables it */
  spanStart: number | null;
  spanEnd: number | null;
}>();

const emit = defineEmits<{
  'update:start': [value: string];
  'update:end': [value: string];
  /** The user picked a preset or pressed Apply: run the query with the new range */
  apply: [];
}>();

/** Quick presets; `null` = the metric's whole span */
const PRESETS: ReadonlyArray<{ key: MessageKey; milliseconds: number | null }> = [
  { key: 'metrics.quick5m', milliseconds: 5 * 60_000 },
  { key: 'metrics.quick15m', milliseconds: 15 * 60_000 },
  { key: 'metrics.quick1h', milliseconds: 3_600_000 },
  { key: 'metrics.quick6h', milliseconds: 6 * 3_600_000 },
  { key: 'metrics.quick24h', milliseconds: 24 * 3_600_000 },
  { key: 'metrics.quick7d', milliseconds: 7 * 24 * 3_600_000 },
  { key: 'metrics.quickAll', milliseconds: null },
];

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const draftStart = ref(props.start);
const draftEnd = ref(props.end);

const rangeLabel = computed(() => {
  const startMs = fromDateTimeLocalValue(props.start);
  const endMs = fromDateTimeLocalValue(props.end);
  if (startMs <= 0 || endMs <= 0) return t('metrics.range.label');
  const startText = formatDateTime(startMs);
  const endText = formatDateTime(endMs);
  // Same day → drop the repeated date, so the trigger stays compact.
  return `${startText} → ${startText.slice(0, 10) === endText.slice(0, 10) ? endText.slice(11) : endText}`;
});

const allPresetEnabled = computed(() => props.spanStart !== null && props.spanEnd !== null);

function toggle(): void {
  if (open.value) {
    close();
    return;
  }
  draftStart.value = props.start;
  draftEnd.value = props.end;
  open.value = true;
}

function close(): void {
  open.value = false;
}

function applyPreset(milliseconds: number | null): void {
  if (milliseconds === null) {
    if (props.spanStart === null || props.spanEnd === null) return;
    draftStart.value = toDateTimeLocalValue(props.spanStart, true);
    draftEnd.value = toDateTimeLocalValue(props.spanEnd, true);
  } else {
    const now = Date.now();
    draftStart.value = toDateTimeLocalValue(now - milliseconds, true);
    draftEnd.value = toDateTimeLocalValue(now, true);
  }
  emitValues();
  close();
}

function applyDraft(): void {
  const startMs = fromDateTimeLocalValue(draftStart.value);
  const endMs = fromDateTimeLocalValue(draftEnd.value);
  if (startMs <= 0 || endMs <= 0 || endMs < startMs) return;
  emitValues();
  close();
}

function emitValues(): void {
  emit('update:start', draftStart.value);
  emit('update:end', draftEnd.value);
  emit('apply');
}

/** Close when the click lands outside the control (standard popover behaviour) */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target !== null && root.value !== null && !root.value.contains(target)) close();
}

function onKeydown(event: KeyboardEvent): void {
  if (open.value && event.key === 'Escape') close();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="root" class="range-picker">
    <div class="field">
      <label class="field-label">{{ t('metrics.range.label') }}</label>
      <button class="range-trigger" :class="{ active: open }" @click="toggle">
        <span class="range-clock">◷</span>
        <span class="range-text">{{ rangeLabel }}</span>
        <span class="range-caret">▾</span>
      </button>
    </div>

    <div v-if="open" class="range-popover" @keydown.enter.stop>
      <div class="range-presets">
        <button
          v-for="preset in PRESETS"
          :key="preset.key"
          class="small"
          :disabled="preset.milliseconds === null && !allPresetEnabled"
          @click="applyPreset(preset.milliseconds)"
        >
          {{ t(preset.key) }}
        </button>
      </div>

      <div class="range-fields">
        <div class="field">
          <label class="field-label">{{ t('metrics.start') }}</label>
          <input v-model="draftStart" type="datetime-local" step="1" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('metrics.end') }}</label>
          <input v-model="draftEnd" type="datetime-local" step="1" />
        </div>
      </div>

      <p class="toolbar-note">{{ t('metrics.range.hint') }}</p>

      <div class="range-actions">
        <button class="primary small" @click="applyDraft">{{ t('metrics.range.apply') }}</button>
        <button class="small" @click="close">{{ t('metrics.range.cancel') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.range-picker {
  position: relative;
}

.range-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 300px;
  font-family: var(--mono);
  justify-content: flex-start;
}

.range-trigger.active {
  border-color: var(--primary);
  color: var(--primary-strong);
}

.range-clock,
.range-caret {
  color: var(--text-muted);
}

.range-text {
  flex: 1;
  text-align: left;
  white-space: nowrap;
}

.range-popover {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  left: 0;
  width: 420px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 10px 28px rgba(16, 24, 40, 0.16);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.range-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.range-fields {
  display: flex;
  gap: 10px;
}

.range-fields .field {
  flex: 1;
}

.range-actions {
  display: flex;
  gap: 8px;
}
</style>
