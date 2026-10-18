<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Single "time range" control: the toolbar shows one trigger with the current span, and the popover holds the
 * quick presets, the **day range** and the exact start / end pickers. Presets apply immediately; the manual fields
 * apply on "Apply", so a half-typed date never fires a query.
 *
 * Two levels of granularity share one state: the day pickers (`From day` / `To day`, local time, both ends
 * inclusive) write `00:00:00` / `23:59:59` into the exact fields, and editing the exact time moves the day
 * pickers back accordingly — there is no second copy of the range to keep in sync.
 *
 * `granularity` selects how much of that machinery is exposed: `datetime` (default) is the exact query range of
 * the metrics panel; `day` drops the second-precision fields and swaps the presets for whole-day ones, which is
 * what day-granular consumers (the backup panel) need. In `day` mode an empty side means "unbounded".
 *
 * Values are `<input type="datetime-local">` strings (`YYYY-MM-DDTHH:mm:ss`) owned by the parent, which keeps the
 * query inputs and the URL-free state model of the console unchanged.
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  dayToDayEnd,
  dayToDayStart,
  dateTimeLocalDay,
  formatDateTime,
  fromDateTimeLocalValue,
  localDayString,
  toDateTimeLocalValue,
} from '../format';
import { t } from '../i18n';
import type { MessageKey } from '../locales/en';

const props = defineProps<{
  start: string;
  end: string;
  /** First / last timestamp of the selected metric, used by the "All" preset; absent disables it */
  spanStart?: number | null;
  spanEnd?: number | null;
  /** `datetime` = exact second-precision range; `day` = whole local days with an optional unbounded side */
  granularity?: 'datetime' | 'day';
  /** Disables the trigger while the parent runs an action */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:start': [value: string];
  'update:end': [value: string];
  /** The user picked a preset or pressed Apply: run the query with the new range */
  apply: [];
}>();

const isDay = computed(() => props.granularity === 'day');

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

/** Day-mode presets, counted in whole local days ending today; `null` = clear both ends (unbounded) */
const DAY_PRESETS: ReadonlyArray<{ key: MessageKey; days: number | null }> = [
  { key: 'metrics.quickToday', days: 1 },
  { key: 'metrics.quick3d', days: 3 },
  { key: 'metrics.quick7d', days: 7 },
  { key: 'metrics.quick30d', days: 30 },
  { key: 'metrics.range.clear', days: null },
];

/** The preset row of the active granularity, each entry carrying its own apply action */
const activePresets = computed<ReadonlyArray<{ key: MessageKey; run: () => void }>>(() =>
  isDay.value
    ? DAY_PRESETS.map((preset) => ({ key: preset.key, run: () => applyDayPreset(preset.days) }))
    : PRESETS.map((preset) => ({ key: preset.key, run: () => applyDatetimePreset(preset.milliseconds) })),
);

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const draftStart = ref(props.start);
const draftEnd = ref(props.end);

/**
 * Day pickers derived from the exact fields (no duplicated state).
 *
 * Picking a start day snaps the time to `00:00:00`, picking an end day snaps it to `23:59:59`, so the range always
 * covers whole local days. Typing an exact time moves the day pickers instead.
 */
const draftStartDay = computed<string>({
  get: () => dateTimeLocalDay(draftStart.value),
  set: (day: string) => {
    draftStart.value = dayToDayStart(day);
    // Picking a single day must still produce a valid range on a fresh picker.
    if (draftEnd.value.length === 0) draftEnd.value = dayToDayEnd(day);
  },
});

const draftEndDay = computed<string>({
  get: () => dateTimeLocalDay(draftEnd.value),
  set: (day: string) => {
    draftEnd.value = dayToDayEnd(day);
    if (draftStart.value.length === 0) draftStart.value = dayToDayStart(day);
  },
});

/** Shown inside the popover when Apply is pressed on an empty or inverted range */
const invalidRange = ref(false);

const rangeLabel = computed(() => {
  if (isDay.value) {
    const startDay = dateTimeLocalDay(props.start);
    const endDay = dateTimeLocalDay(props.end);
    // Both ends empty = unbounded, which reads as "no range" rather than as a broken trigger.
    if (startDay.length === 0 && endDay.length === 0) return t('metrics.range.label');
    return `${startDay.length > 0 ? startDay : '…'} → ${endDay.length > 0 ? endDay : '…'}`;
  }
  const startMs = fromDateTimeLocalValue(props.start);
  const endMs = fromDateTimeLocalValue(props.end);
  if (startMs <= 0 || endMs <= 0) return t('metrics.range.label');
  const startText = formatDateTime(startMs);
  const endText = formatDateTime(endMs);
  // Same day → drop the repeated date, so the trigger stays compact.
  return `${startText} → ${startText.slice(0, 10) === endText.slice(0, 10) ? endText.slice(11) : endText}`;
});

const allPresetEnabled = computed(() => props.spanStart != null && props.spanEnd != null);

function toggle(): void {
  if (open.value) {
    close();
    return;
  }
  draftStart.value = props.start;
  draftEnd.value = props.end;
  invalidRange.value = false;
  open.value = true;
}

function close(): void {
  open.value = false;
}

function applyDatetimePreset(milliseconds: number | null): void {
  if (milliseconds === null) {
    if (props.spanStart == null || props.spanEnd == null) return;
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

/** `days` whole local days ending today; `null` clears both ends (an unbounded range) */
function applyDayPreset(days: number | null): void {
  if (days === null) {
    draftStart.value = '';
    draftEnd.value = '';
  } else {
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    draftStart.value = dayToDayStart(localDayString(first.getTime()));
    draftEnd.value = dayToDayEnd(localDayString(today.getTime()));
  }
  emitValues();
  close();
}

function applyDraft(): void {
  const startMs = fromDateTimeLocalValue(draftStart.value);
  const endMs = fromDateTimeLocalValue(draftEnd.value);
  // An exact range must be complete; a day range may stay open on either side, but never inverted.
  const complete = !isDay.value && (startMs <= 0 || endMs <= 0);
  const inverted = startMs > 0 && endMs > 0 && endMs < startMs;
  if (complete || inverted) {
    invalidRange.value = true;
    return;
  }
  invalidRange.value = false;
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
      <button class="range-trigger" :class="{ active: open }" :disabled="disabled" @click="toggle">
        <span class="range-clock">◷</span>
        <span class="range-text">{{ rangeLabel }}</span>
        <span class="range-caret">▾</span>
      </button>
    </div>

    <div v-if="open" class="range-popover" @keydown.enter.stop>
      <div class="range-presets">
        <button
          v-for="preset in activePresets"
          :key="preset.key"
          class="small"
          :disabled="preset.key === 'metrics.quickAll' && !allPresetEnabled"
          @click="preset.run()"
        >
          {{ t(preset.key) }}
        </button>
      </div>

      <div class="range-fields">
        <div class="field">
          <label class="field-label">{{ t('metrics.range.fromDay') }}</label>
          <input v-model="draftStartDay" type="date" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('metrics.range.toDay') }}</label>
          <input v-model="draftEndDay" type="date" />
        </div>
      </div>

      <p v-if="!isDay" class="toolbar-note">{{ t('metrics.range.dayHint') }}</p>

      <template v-if="!isDay">
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
      </template>
      <p v-else class="toolbar-note">{{ t('metrics.range.dayOnlyHint') }}</p>
      <p v-if="invalidRange" class="alert error">{{ t('metrics.range.invalid') }}</p>

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
