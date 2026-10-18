<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Status dashboard: renders every field of `GET /api/v1/status` (§3.4).
 *
 * The flat field list is grouped into operator-facing sections (overview → write/WAL → storage → runtime →
 * query) so the first row answers "is it healthy and how fast" and the rest can be read top-down while
 * diagnosing. Section titles live in the language packs.
 */

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { RtdbAdminApiClient, RtdbStatusReport } from '../api';
import { useAsyncAction } from '../async';
import { formatBytes, formatDateTime, formatDuration, formatNumber, formatPercent } from '../format';
import { t } from '../i18n';
import type { MessageKey } from '../locales/en';

const props = defineProps<{ client: RtdbAdminApiClient }>();

const REFRESH_INTERVAL_MILLISECONDS = 5_000;

const { busy, errorMessage, run } = useAsyncAction();
const statusReport = ref<RtdbStatusReport | null>(null);
const sampledAt = ref(0);
const autoRefresh = ref(true);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

interface StatEntry {
  label: string;
  value: string;
  unit?: string;
}

interface StatGroup {
  titleKey: MessageKey;
  /** The first group is rendered with larger values as the at-a-glance row */
  kpi?: boolean;
  entries: StatEntry[];
}

const groups = computed<StatGroup[]>(() => {
  const report = statusReport.value;
  if (report === null) return [];
  return [
    {
      titleKey: 'status.group.overview',
      kpi: true,
      entries: [
        { label: t('status.label.uptime'), value: formatDuration(report.uptimeMs) },
        {
          label: t('status.label.writeThroughput'),
          value: formatNumber(report.write.pointsPerSec),
          unit: t('status.unit.pointsPerSecond'),
        },
        { label: t('status.label.databases'), value: formatNumber(report.databases) },
        { label: t('status.label.metrics'), value: formatNumber(report.metrics) },
        { label: t('status.label.bufferedPoints'), value: formatNumber(report.write.buffered) },
      ],
    },
    {
      titleKey: 'status.group.write',
      entries: [
        { label: t('status.label.duplicatePoints'), value: formatNumber(report.write.duplicates) },
        { label: t('status.label.qualityDropped'), value: formatNumber(report.write.qualityDropped ?? 0) },
        { label: t('status.label.tagsIgnored'), value: formatNumber(report.write.tagsIgnored) },
        {
          label: t('status.label.walPendingBytes'),
          value: formatNumber(report.wal.pendingBytes),
          unit: t('status.unit.bytes'),
        },
        { label: t('status.label.walOutstandingBatches'), value: formatNumber(report.wal.outstandingBatches) },
        { label: t('status.label.walPendingPoints'), value: formatNumber(report.wal.pendingPoints) },
        {
          label: t('status.label.lastFsync'),
          value: report.wal.lastFsyncMs === 0 ? t('status.notYet') : formatDateTime(report.wal.lastFsyncMs),
        },
      ],
    },
    {
      titleKey: 'status.group.storage',
      entries: [
        { label: t('status.label.bytesToday'), value: formatBytes(report.segments.bytesToday) },
        { label: t('status.label.openSegments'), value: formatNumber(report.segments.openFiles) },
        { label: t('status.label.cacheBlocks'), value: formatNumber(report.cache.blocks) },
        { label: t('status.label.cacheHitRate'), value: formatPercent(report.cache.blockHitRate) },
        { label: t('status.label.heapUsed'), value: formatNumber(report.cache.heapUsedMb), unit: t('status.unit.mib') },
        {
          label: t('status.label.externalMemory'),
          value: formatNumber(report.cache.externalMb),
          unit: t('status.unit.mib'),
        },
      ],
    },
    {
      titleKey: 'status.group.runtime',
      entries: [
        { label: t('status.label.cpuUsage'), value: formatNumber(report.cpu.percent), unit: t('status.unit.percent') },
        {
          label: t('status.label.machineCpuShare'),
          value: formatNumber(report.cpu.systemPercent),
          unit: t('status.unit.percent'),
        },
        { label: t('status.label.rssMemory'), value: formatNumber(report.memory.rssMb), unit: t('status.unit.mib') },
        {
          label: t('status.label.memoryUsage'),
          value: formatNumber(report.memory.systemPercent),
          unit: t('status.unit.percent'),
        },
        {
          label: t('status.label.heapUsage'),
          value: formatNumber(report.memory.heapPercent),
          unit: t('status.unit.percent'),
        },
        { label: t('status.label.gcCycles'), value: formatNumber(report.gc.count) },
        { label: t('status.label.gcPauseTotal'), value: formatNumber(report.gc.totalMs), unit: t('status.unit.ms') },
        { label: t('status.label.gcPauseMax'), value: formatNumber(report.gc.maxMs), unit: t('status.unit.ms') },
      ],
    },
    {
      titleKey: 'status.group.query',
      entries: [
        { label: t('status.label.queryCount'), value: formatNumber(report.query.count) },
        { label: t('status.label.queryP50'), value: formatNumber(report.query.p50Ms), unit: t('status.unit.ms') },
        { label: t('status.label.queryP95'), value: formatNumber(report.query.p95Ms), unit: t('status.unit.ms') },
        { label: t('status.label.queryP99'), value: formatNumber(report.query.p99Ms), unit: t('status.unit.ms') },
        { label: t('status.label.queryMax'), value: formatNumber(report.query.maxMs), unit: t('status.unit.ms') },
      ],
    },
  ];
});

async function refresh(): Promise<void> {
  const report = await run(() => props.client.getStatus());
  if (report !== undefined) {
    statusReport.value = report;
    sampledAt.value = Date.now();
  }
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
    <div class="panel-head">
      <p class="panel-meta">
        {{ t('status.note', { state: busy ? t('status.refreshing') : t('status.idle') }) }}
        <template v-if="sampledAt > 0"> · {{ t('status.lastSampled', { time: formatDateTime(sampledAt) }) }}</template>
      </p>
      <div class="panel-actions">
        <label class="toolbar-note">
          <input v-model="autoRefresh" type="checkbox" />
          {{ t('status.autoRefresh') }}
        </label>
        <button :disabled="busy" @click="refresh">{{ t('status.refresh') }}</button>
      </div>
    </div>

    <p v-if="errorMessage.length > 0" class="alert error">{{ errorMessage }}</p>

    <template v-if="groups.length > 0">
      <section v-for="group in groups" :key="group.titleKey" class="stat-section">
        <h3 class="stat-section-title">{{ t(group.titleKey) }}</h3>
        <div class="stat-grid" :class="{ kpi: group.kpi === true }">
          <div v-for="entry in group.entries" :key="entry.label" class="stat">
            <div class="stat-label">{{ entry.label }}</div>
            <div class="stat-value">
              {{ entry.value }}<span v-if="entry.unit !== undefined" class="stat-unit">{{ entry.unit }}</span>
            </div>
          </div>
        </div>
      </section>
    </template>
    <p v-else class="empty-hint">{{ t('status.waiting') }}</p>
  </section>
</template>
