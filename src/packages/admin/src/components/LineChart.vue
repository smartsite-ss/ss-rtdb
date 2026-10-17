<!--
  Copyright (c) 2025 Smart Site Team
  SPDX-License-Identifier: Apache-2.0
  https://smartsite.top/
  Contact: zkxxa@qq.com, zcwebms@gmail.com
-->

<script setup lang="ts">
/**
 * ECharts-based line chart for the range preview.
 *
 * Renders numeric samples produced by `POST /api/v1/query/range` (non-numeric values are converted
 * by the caller before they get here). The x axis is a time axis with an ECharts `dataZoom`
 * (mouse wheel / pinch inside the plot plus a slider bar below), so a dense 1-hour series can be
 * zoomed into seconds and panned. A new dataset resets the zoom back to the full range.
 */

import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '../i18n';

// Tree-shaken ECharts: only the pieces this chart needs (v6 registers axes with the grid component)
echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomInsideComponent, DataZoomSliderComponent, CanvasRenderer]);

const props = withDefaults(
  defineProps<{
    points: { t: number; value: number }[];
    height?: number;
    color?: string;
  }>(),
  { height: 340, color: '#2f7cf6' },
);

const container = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;

function formatDateTime(milliseconds: number): string {
  const date = new Date(milliseconds);
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Full option; rebuilt (not merged) whenever the dataset changes, which also resets the zoom */
function buildOption(): echarts.EChartsCoreOption {
  const seriesData = props.points.map((point) => [point.t, point.value] as [number, number]);
  return {
    animation: false,
    grid: { left: 64, right: 20, top: 18, bottom: 56 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (parameters: unknown): string => {
        const list = Array.isArray(parameters) ? parameters : [parameters];
        const first = list[0] as { value?: [number, number] } | undefined;
        const value = first?.value?.[1];
        if (value === undefined) return '';
        const time = first?.value?.[0] ?? 0;
        return `${formatDateTime(time)}<br/><b>${Number.isFinite(value) ? value : String(value)}</b>`;
      },
    },
    xAxis: {
      type: 'time',
      axisLabel: { hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { formatter: (value: number): string => `${value}` },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
      { type: 'slider', xAxisIndex: 0, filterMode: 'none', height: 18, bottom: 10 },
    ],
    series: [
      {
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        data: seriesData,
        lineStyle: { color: props.color, width: 1.5 },
        itemStyle: { color: props.color },
      },
    ],
  };
}

function render(): void {
  if (chart === null) return;
  if (props.points.length === 0) {
    chart.clear();
    return;
  }
  // notMerge: a new query replaces everything and the zoom resets to the full range
  chart.setOption(buildOption(), true);
}

onMounted(() => {
  if (container.value === null) return;
  chart = echarts.init(container.value);
  resizeObserver = new ResizeObserver(() => chart?.resize());
  resizeObserver.observe(container.value);
  render();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  chart?.dispose();
  chart = null;
});

watch(() => props.points, render, { deep: true });
</script>

<template>
  <div class="line-chart" :style="{ height: `${props.height}px` }">
    <div ref="container" class="line-chart-canvas" />
    <div v-if="props.points.length === 0" class="line-chart-empty">{{ t('chart.empty') }}</div>
  </div>
</template>

<style scoped>
.line-chart {
  position: relative;
  width: 100%;
}

.line-chart-canvas {
  width: 100%;
  height: 100%;
}

.line-chart-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8a94a6;
  font-size: 13px;
}
</style>
