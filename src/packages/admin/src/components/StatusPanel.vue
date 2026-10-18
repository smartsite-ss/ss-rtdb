<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/** Status dashboard: renders every field of `GET /api/v1/status` (§3.4). */

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { RtdbAdminApiClient, RtdbStatusReport } from '../api';
import { useAsyncAction } from '../async';
import { formatBytes, formatDateTime, formatDuration, formatNumber, formatPercent } from '../format';
import { t } from '../i18n';

const props = defineProps<{ client: RtdbAdminApiClient }>();

const REFRESH_INTERVAL_MILLISECONDS = 5_000;

const { busy, errorMessage, run } = useAsyncAction();
const statusReport = ref<RtdbStatusReport | null>(null);
const autoRefresh = ref(true);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

interface StatEntry {
  label: string;
  value: string;
  unit?: string;
}

const stats = computed<StatEntry[]>(() => {
  const report = statusReport.value;
  if (report === null) return [];
  return [
    { label: t('status.label.uptime'), value: formatDuration(report.uptimeMs) },
    { label: t('status.label.cpuUsage'), value: formatNumber(report.cpu.percent), unit: t('status.unit.percent') },
    { label: t('status.label.machineCpuShare'), value: formatNumber(report.cpu.systemPercent), unit: t('status.unit.percent') },
    { label: t('status.label.rssMemory'), value: formatNumber(report.memory.rssMb), unit: t('status.unit.mib') },
    { label: t('status.label.memoryUsage'), value: formatNumber(report.memory.systemPercent), unit: t('status.unit.percent') },
    { label: t('status.label.heapUsage'), value: formatNumber(report.memory.heapPercent), unit: t('status.unit.percent') },
    { label: t('status.label.databases'), value: formatNumber(report.databases) },
    { label: t('status.label.metrics'), value: formatNumber(report.metrics) },
    {
      label: t('status.label.writeThroughput'),
      value: formatNumber(report.write.pointsPerSec),
      unit: t('status.unit.pointsPerSecond'),
    },
    { label: t('status.label.bufferedPoints'), value: formatNumber(report.write.buffered) },
    { label: t('status.label.duplicatePoints'), value: formatNumber(report.write.duplicates) },
    { label: t('status.label.tagsIgnored'), value: formatNumber(report.write.tagsIgnored) },
    { label: t('status.label.walPendingBytes'), value: formatNumber(report.wal.pendingBytes), unit: t('status.unit.bytes') },
    { label: t('status.label.walOutstandingBatches'), value: formatNumber(report.wal.outstandingBatches) },
    { label: t('status.label.walPendingPoints'), value: formatNumber(report.wal.pendingPoints) },
    {
      label: t('status.label.lastFsync'),
      value: report.wal.lastFsyncMs === 0 ? t('status.notYet') : formatDateTime(report.wal.lastFsyncMs),
    },
    { label: t('status.label.openSegments'), value: formatNumber(report.segments.openFiles) },
    { label: t('status.label.bytesToday'), value: formatBytes(report.segments.bytesToday) },
    { label: t('status.label.cacheBlocks'), value: formatNumber(report.cache.blocks) },
    { label: t('status.label.cacheHitRate'), value: formatPercent(report.cache.blockHitRate) },
    { label: t('status.label.heapUsed'), value: formatNumber(report.cache.heapUsedMb), unit: t('status.unit.mib') },
    {
      label: t('status.label.externalMemory'),
      value: formatNumber(report.cache.externalMb),
      unit: t('status.unit.mib'),
    },
    { label: t('status.label.gcCycles'), value: formatNumber(report.gc.count) },
    { label: t('status.label.gcPauseTotal'), value: formatNumber(report.gc.totalMs), unit: t('status.unit.ms') },
    { label: t('status.label.gcPauseMax'), value: formatNumber(report.gc.maxMs), unit: t('status.unit.ms') },
    { label: t('status.label.queryCount'), value: formatNumber(report.query.count) },
    { label: t('status.label.queryP50'), value: formatNumber(report.query.p50Ms), unit: t('status.unit.ms') },
    { label: t('status.label.queryP95'), value: formatNumber(report.query.p95Ms), unit: t('status.unit.ms') },
    { label: t('status.label.queryP99'), value: formatNumber(report.query.p99Ms), unit: t('status.unit.ms') },
    { label: t('status.label.queryMax'), value: formatNumber(report.query.maxMs), unit: t('status.unit.ms') },
  ];
});

async function refresh(): Promise<void> {
  const report = await run(() => props.client.getStatus());
  if (report !== undefined) statusReport.value = report;
}

function startTimer(): void {
  stopTimer();
  refreshTimer = setInterval(() => {
    void refresh();
  }, REFRESH_INTERVAL_MILLISECONDS);
}

function stopTimer(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

onMounted(() => {
  void refresh();
  startTimer();
});

onUnmounted(() => {
  stopTimer();
});

watch(autoRefresh, (enabled) => {
  if (enabled) startTimer();
  else stopTimer();
});

watch(
  () => props.client,
  () => {
    void refresh();
  },
);
</script>

<template>
  <section class="panel">
    <div class="card-title">
      <span>{{ t('status.title') }}</span>
      <span class="card-title-note">
        {{ t('status.note', { state: busy ? t('status.refreshing') : t('status.idle') }) }}
      </span>
    </div>

    <div class="toolbar">
      <button :disabled="busy" @click="refresh">{{ t('status.refresh') }}</button>
      <label class="toolbar-note">
        <input v-model="autoRefresh" type="checkbox" />
        {{ t('status.autoRefresh') }}
      </label>
      <span v-if="statusReport !== null" class="toolbar-note">
        {{ t('status.lastSampled', { time: formatDateTime(Date.now()) }) }}
      </span>
    </div>

    <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>

    <div v-if="stats.length > 0" class="stat-grid">
      <div v-for="entry in stats" :key="entry.label" class="stat">
        <div class="stat-label">{{ entry.label }}</div>
        <div class="stat-value">
          {{ entry.value }}<span v-if="entry.unit !== undefined" class="stat-unit">{{ entry.unit }}</span>
        </div>
      </div>
    </div>
    <p v-else class="empty-hint">{{ t('status.waiting') }}</p>
  </section>
</template>
