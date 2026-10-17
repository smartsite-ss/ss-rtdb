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
    { label: 'Uptime', value: formatDuration(report.uptimeMs) },
    { label: 'Databases', value: formatNumber(report.databases) },
    { label: 'Metrics', value: formatNumber(report.metrics) },
    { label: 'Write throughput', value: formatNumber(report.write.pointsPerSec), unit: 'points/s' },
    { label: 'Buffered points', value: formatNumber(report.write.buffered) },
    { label: 'Duplicate points', value: formatNumber(report.write.duplicates) },
    { label: 'Ignored line-protocol tags', value: formatNumber(report.write.tagsIgnored) },
    { label: 'WAL pending bytes', value: formatNumber(report.wal.pendingBytes), unit: 'B' },
    { label: 'WAL outstanding batches', value: formatNumber(report.wal.outstandingBatches) },
    { label: 'WAL pending points', value: formatNumber(report.wal.pendingPoints) },
    {
      label: 'Last fsync',
      value: report.wal.lastFsyncMs === 0 ? 'not yet' : formatDateTime(report.wal.lastFsyncMs),
    },
    { label: 'Open segment files', value: formatNumber(report.segments.openFiles) },
    { label: 'Bytes written today', value: formatBytes(report.segments.bytesToday) },
    { label: 'Decoded cache blocks', value: formatNumber(report.cache.blocks) },
    { label: 'Cache hit rate', value: formatPercent(report.cache.blockHitRate) },
    { label: 'Heap used', value: formatNumber(report.cache.heapUsedMb), unit: 'MiB' },
    { label: 'External memory', value: formatNumber(report.cache.externalMb), unit: 'MiB' },
    { label: 'GC cycles', value: formatNumber(report.gc.count) },
    { label: 'GC pause total', value: formatNumber(report.gc.totalMs), unit: 'ms' },
    { label: 'GC longest pause', value: formatNumber(report.gc.maxMs), unit: 'ms' },
    { label: 'Successful queries', value: formatNumber(report.query.count) },
    { label: 'Query latency p50', value: formatNumber(report.query.p50Ms), unit: 'ms' },
    { label: 'Query latency p95', value: formatNumber(report.query.p95Ms), unit: 'ms' },
    { label: 'Query latency p99', value: formatNumber(report.query.p99Ms), unit: 'ms' },
    { label: 'Query latency max', value: formatNumber(report.query.maxMs), unit: 'ms' },
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
      <span>Status</span>
      <span class="card-title-note">GET /api/v1/status · {{ busy ? 'refreshing…' : 'idle' }}</span>
    </div>

    <div class="toolbar">
      <button :disabled="busy" @click="refresh">Refresh now</button>
      <label class="toolbar-note">
        <input v-model="autoRefresh" type="checkbox" />
        Auto refresh every 5s
      </label>
      <span v-if="statusReport !== null" class="toolbar-note">
        Last sampled: {{ formatDateTime(Date.now()) }}
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
    <p v-else class="empty-hint">Waiting for the first status sample…</p>
  </section>
</template>
