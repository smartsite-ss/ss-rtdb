<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * Dependency-free line chart.
 *
 * The console intentionally ships without a charting library: the series rendered here are plain
 * numeric samples produced by `POST /api/v1/query/range`, so a normalised `<svg>` plus two HTML
 * overlay labels is enough. Non-numeric values are filtered out by the caller before they get here.
 */

import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    points: { t: number; value: number }[];
    height?: number;
    color?: string;
  }>(),
  { height: 240, color: '#2f7cf6' },
);

/** Both axes are mapped into a fixed 0..1000 space so a single `viewBox` fits any rendered size */
const VIEW_SIZE = 1000;
const CHART_INSET = 24;

interface ChartGeometry {
  polyline: string;
  lastPoint: { x: number; y: number };
  minValue: number;
  maxValue: number;
  minTime: number;
  maxTime: number;
}

const geometry = computed<ChartGeometry | null>(() => {
  const points = props.points;
  if (points.length === 0) return null;

  let minTime = points[0].t;
  let maxTime = points[0].t;
  let minValue = points[0].value;
  let maxValue = points[0].value;
  for (const point of points) {
    if (point.t < minTime) minTime = point.t;
    if (point.t > maxTime) maxTime = point.t;
    if (point.value < minValue) minValue = point.value;
    if (point.value > maxValue) maxValue = point.value;
  }

  const timeSpan = maxTime - minTime;
  let valueSpan = maxValue - minValue;
  if (valueSpan === 0) {
    const padding = Math.abs(maxValue) > 0 ? Math.abs(maxValue) * 0.05 : 1;
    minValue -= padding;
    maxValue += padding;
    valueSpan = maxValue - minValue;
  }

  const usableSpan = VIEW_SIZE - CHART_INSET * 2;
  const coordinates = points.map((point) => {
    const xRatio = timeSpan === 0 ? 0.5 : (point.t - minTime) / timeSpan;
    const yRatio = (maxValue - point.value) / valueSpan;
    return { x: CHART_INSET + xRatio * usableSpan, y: CHART_INSET + yRatio * usableSpan };
  });

  return {
    polyline: coordinates.map((coordinate) => `${coordinate.x.toFixed(2)},${coordinate.y.toFixed(2)}`).join(' '),
    lastPoint: coordinates[coordinates.length - 1],
    minValue,
    maxValue,
    minTime,
    maxTime,
  };
});

const lastMarkerStyle = computed(() => {
  const point = geometry.value?.lastPoint;
  if (point === undefined) return {};
  return {
    left: `${point.x / 10}%`,
    top: `${point.y / 10}%`,
    background: props.color,
  };
});

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatDateTime(milliseconds: number): string {
  const date = new Date(milliseconds);
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
</script>

<template>
  <div class="line-chart" :style="{ height: `${props.height}px` }">
    <svg v-if="geometry !== null" :viewBox="`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`" preserveAspectRatio="none">
      <polyline
        :points="geometry.polyline"
        fill="none"
        :stroke="props.color"
        stroke-width="2"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <template v-if="geometry !== null">
      <span class="line-chart-axis-label top-left">{{ formatValue(geometry.maxValue) }}</span>
      <span class="line-chart-axis-label bottom-left">{{ formatValue(geometry.minValue) }}</span>
      <span class="line-chart-axis-label bottom-right">
        {{ formatDateTime(geometry.minTime) }} - {{ formatDateTime(geometry.maxTime) }}
      </span>
      <span class="line-chart-marker" :style="lastMarkerStyle" />
    </template>
    <div v-else class="line-chart-empty">No numeric data in the selected range</div>
  </div>
</template>

<style scoped>
.line-chart-marker {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
</style>
