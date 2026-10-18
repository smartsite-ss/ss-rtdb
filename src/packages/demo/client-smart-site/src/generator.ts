// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Deterministic Smart Site signal generator.
 *
 * Every tag is simulated the way a Smart Site collector would produce it: analog tags follow a slow
 * sine wave plus a bounded random walk clamped to the engineering range, counters accumulate from a
 * rate, booleans/strings/integer states switch with a configurable probability, and a small fraction
 * of samples can repeat the previous value to mimic a communication fault (stale sample).
 *
 * The generator is pure and deterministic for a given seed + timestamp sequence, so it can be tested
 * without a running server.
 */

import { DEMO_VALUE_TYPE, buildMetricName, selectDevices, valueTypeOf } from './catalog.ts';
import type { DemoValueType, DeviceDefinition, SmartSiteDataType, TagDefinition } from './catalog.ts';

export interface SimulatorOptions {
  /** RNG seed; the same seed always yields the same stream for the same timestamps */
  seed?: number;
  /** Per-tick probability that a tag enters a short communication fault (default 0) */
  glitchProbability?: number;
  /** Device subset; empty / undefined = every device in the catalog */
  deviceCodes?: readonly string[];
  /**
   * Target metric count (0 / undefined = the native catalog).
   *
   * Above the catalog size the tag list is replicated with a `#k` suffix on the metric name
   * (`hvac-chiller.supply-temp#2`), so a single process can simulate thousands of variables while every
   * replica keeps its own RNG stream, wave phase and state (a `counter.rateFrom` resolves inside its own
   * replica group). Below it the catalog is truncated to the first n tags.
   */
  metricTarget?: number;
}

/** One generated sample, shaped like a core `WritePoint` */
export interface SimulatedPoint {
  metricName: string;
  timestamp: number;
  value: number | bigint | boolean | string;
  /**
   * Local-only marker: the sample repeats the previous value because the tag is inside a simulated
   * communication fault. It never reaches the wire — rtdb v0.1.0 (M0) only accepts quality 0.
   */
  stale?: boolean;
}

/** Flat description of a metric, used by `--list` and by verification */
export interface MetricDescriptor {
  metricName: string;
  deviceCode: string;
  deviceName: string;
  variable: string;
  name: string;
  unit?: string;
  dataType: SmartSiteDataType;
  type: DemoValueType;
  min?: number;
  max?: number;
}

interface MetricState {
  /** Bounded random-walk offset of an analog signal */
  drift: number;
  /** Fractional carrier of a counter value */
  counterValue: number;
  boolValue: boolean;
  intStateIndex: number;
  stringIndex: number;
  glitchTicksLeft: number;
  lastTimestamp: number | null;
  lastValue: number | bigint | boolean | string | null;
}

interface MetricEntry {
  deviceCode: string;
  deviceName: string;
  tag: TagDefinition;
  metricName: string;
  type: DemoValueType;
  /** 1 = original catalog tag; k > 1 = the k-th replica of that tag (metric name carries `#k`) */
  replica: number;
  /** Metric name a `counter.rateFrom` reads, resolved inside this entry's replica group (`null` = none) */
  rateFromMetric: string | null;
  phase: number;
  random: () => number;
  state: MetricState;
}

/** One catalog tag before replication (the unit the metric count is scaled in) */
interface CatalogTag {
  device: DeviceDefinition;
  tag: TagDefinition;
  metricName: string;
  type: DemoValueType;
}

const DEFAULT_SEED = 20261017;
const DEFAULT_GLITCH_PROBABILITY = 0;
const STRING_CHANGE_PROBABILITY = 0.02;
const INT_STATE_CHANGE_PROBABILITY = 0.01;
const DRIFT_DECAY = 0.9;
const DRIFT_NOISE_RATIO = 0.0025;
/** Upper bound of `metricTarget`: beyond this the per-metric state stops being cheap to build */
const MAX_METRIC_TARGET = 100_000;
/** Separator of a replica metric name (`hvac-chiller.supply-temp#2` = the 2nd copy of that tag) */
const REPLICA_SEPARATOR = '#';

/** `#k` suffix of a replica; the original catalog tags carry no suffix */
function replicaSuffix(replica: number): string {
  return replica <= 1 ? '' : `${REPLICA_SEPARATOR}${replica}`;
}

/**
 * Effective metric count: `0` / undefined keeps the native catalog, a larger target replicates it, a
 * smaller one truncates it.
 *
 * @throws when the target is not a positive integer or exceeds {@link MAX_METRIC_TARGET}
 */
function resolveMetricTotal(target: number | undefined, baseCount: number): number {
  if (target === undefined || target === 0) return baseCount;
  if (!Number.isInteger(target) || target < 1) {
    throw new Error(`metricTarget must be a positive integer or 0 (native catalog): ${String(target)}`);
  }
  if (target > MAX_METRIC_TARGET) {
    throw new Error(`metricTarget ${target} exceeds the ${MAX_METRIC_TARGET}-metric limit`);
  }
  return target;
}

/** FNV-1a 32-bit hash, used to derive independent per-metric RNG streams and wave phases */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small, fast, seedable PRNG (mulberry32) */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function initialStateIndex(states: readonly number[] | undefined): number {
  if (states === undefined || states.length === 0) return 0;
  const running = states.indexOf(1);
  return running >= 0 ? running : 0;
}

function descriptorOf(entry: MetricEntry): MetricDescriptor {
  const descriptor: MetricDescriptor = {
    metricName: entry.metricName,
    deviceCode: entry.deviceCode,
    deviceName: entry.deviceName,
    variable: entry.tag.variable,
    name: entry.tag.name,
    dataType: entry.tag.dataType,
    type: entry.type,
  };
  if (entry.tag.unit !== undefined) descriptor.unit = entry.tag.unit;
  if (entry.tag.min !== undefined) descriptor.min = entry.tag.min;
  if (entry.tag.max !== undefined) descriptor.max = entry.tag.max;
  return descriptor;
}

/** Reject catalog entries the generator cannot simulate, with the metric name in the message */
function validateTag(tag: TagDefinition, metricName: string): void {
  const type = valueTypeOf(tag);
  if (tag.min !== undefined && tag.max !== undefined && tag.min > tag.max) {
    throw new Error(`Catalog error: ${metricName} has min (${tag.min}) greater than max (${tag.max})`);
  }
  if (type === DEMO_VALUE_TYPE.String) {
    if (tag.sequence === undefined || tag.sequence.length === 0) {
      throw new Error(`Catalog error: ${metricName} is a string tag without a "sequence"`);
    }
    return;
  }
  if (type === DEMO_VALUE_TYPE.Bool) return;
  if (tag.counter !== undefined) {
    const spec = tag.counter;
    if (spec.perSecond === undefined && spec.rateFrom === undefined) {
      throw new Error(`Catalog error: ${metricName} counter needs "perSecond" or "rateFrom"`);
    }
    return;
  }
  if (tag.signal !== undefined) {
    if (tag.signal.periodMs <= 0) {
      throw new Error(`Catalog error: ${metricName} signal period must be positive`);
    }
    return;
  }
  if (type === DEMO_VALUE_TYPE.Int64 && tag.states !== undefined && tag.states.length > 0) return;
  throw new Error(`Catalog error: ${metricName} has no signal, counter or states definition`);
}

/**
 * Stateful Smart Site simulator. Call `tick(timestamp)` once per sampling instant to obtain one
 * sample per simulated metric.
 *
 * `metricTarget` scales the simulated variable count (see {@link SimulatorOptions}): the native catalog is
 * either truncated or replicated with a `#k` metric-name suffix, and every replica is an independent signal
 * stream of the same tag shape.
 */
export class SmartSiteSimulator {
  private readonly entries: readonly MetricEntry[];
  private readonly glitchProbability: number;
  /** Catalog tags before replication (after the `--devices` filter) */
  private readonly baseCount: number;
  /** Highest replica index (1 = native catalog, no replication) */
  private readonly replicas: number;

  constructor(options: SimulatorOptions = {}) {
    const seed = options.seed ?? DEFAULT_SEED;
    this.glitchProbability = clampProbability(options.glitchProbability ?? DEFAULT_GLITCH_PROBABILITY);
    const devices = selectDevices(options.deviceCodes);
    const known = new Set(devices.map((device) => device.deviceCode));
    for (const deviceCode of options.deviceCodes ?? []) {
      if (!known.has(deviceCode)) {
        throw new Error(`Unknown device code "${deviceCode}" (run with --list to see the catalog)`);
      }
    }

    const baseTags: CatalogTag[] = [];
    for (const device of devices) {
      for (const tag of device.tags) {
        const metricName = buildMetricName(device.deviceCode, tag.variable);
        validateTag(tag, metricName);
        baseTags.push({ device, tag, metricName, type: valueTypeOf(tag) });
      }
    }
    this.baseCount = baseTags.length;

    const metricTotal = resolveMetricTotal(options.metricTarget, baseTags.length);
    this.replicas = baseTags.length === 0 ? 0 : Math.ceil(metricTotal / baseTags.length);

    const entries: MetricEntry[] = [];
    for (let index = 0; index < metricTotal; index += 1) {
      const base = baseTags[index % baseTags.length] as CatalogTag;
      const replica = Math.floor(index / baseTags.length) + 1;
      const suffix = replicaSuffix(replica);
      const metricName = `${base.metricName}${suffix}`;
      const rateFrom = base.tag.counter?.rateFrom;
      entries.push({
        deviceCode: base.device.deviceCode,
        deviceName: base.device.deviceName,
        tag: base.tag,
        metricName,
        type: base.type,
        replica,
        // The driving variable lives in the same device (and therefore the same replica group); when the
        // catalog was truncated below it the lookup simply misses and the counter holds its initial value.
        rateFromMetric: rateFrom === undefined ? null : `${buildMetricName(base.device.deviceCode, rateFrom)}${suffix}`,
        phase: (hashString(metricName) % 6283) / 1000,
        random: mulberry32(hashString(`${seed}:${metricName}`)),
        state: {
          drift: 0,
          counterValue: base.tag.counter?.initial ?? 0,
          boolValue: base.tag.initial ?? true,
          intStateIndex: initialStateIndex(base.tag.states),
          stringIndex: 0,
          glitchTicksLeft: 0,
          lastTimestamp: null,
          lastValue: null,
        },
      });
    }
    this.entries = entries;
  }

  /** Number of simulated devices */
  get deviceCount(): number {
    return new Set(this.entries.map((entry) => entry.deviceCode)).size;
  }

  /** Number of simulated metrics (= tags), replicas included */
  get metricCount(): number {
    return this.entries.length;
  }

  /** Catalog tags before replication (`0` when the selected catalog is empty) */
  get baseMetricCount(): number {
    return this.baseCount;
  }

  /** Copies per catalog tag (`1` = native catalog, no replication) */
  get replicaCount(): number {
    return this.replicas;
  }

  /** Every metric name in catalog order */
  get metricNames(): readonly string[] {
    return this.entries.map((entry) => entry.metricName);
  }

  /** Flat catalog view (`--list`) */
  describe(): readonly MetricDescriptor[] {
    return this.entries.map(descriptorOf);
  }

  /** One representative metric per value type, used by `--verify` */
  representatives(): readonly MetricDescriptor[] {
    const seen = new Set<DemoValueType>();
    const result: MetricDescriptor[] = [];
    for (const entry of this.entries) {
      if (seen.has(entry.type)) continue;
      seen.add(entry.type);
      result.push(descriptorOf(entry));
    }
    return result;
  }

  /** Generate one sample per metric for `timestamp` (ms epoch) */
  tick(timestamp: number): SimulatedPoint[] {
    if (!Number.isInteger(timestamp)) {
      throw new Error(`tick() needs an integer millisecond timestamp, received ${String(timestamp)}`);
    }
    const points: SimulatedPoint[] = [];
    const currentTick = new Map<string, number | bigint | boolean | string>();
    for (const entry of this.entries) {
      const point = this.nextPoint(entry, timestamp, currentTick);
      currentTick.set(entry.metricName, point.value);
      points.push(point);
    }
    return points;
  }

  /**
   * Generate exactly `pointCount` samples whose timestamps are spread evenly over
   * `[endTimestamp - windowMs, endTimestamp]` (used by the performance modes
   * `--points-per-tick` / `--rate`).
   *
   * The batch size is decoupled from the catalog size, so one HTTP request can carry thousands of
   * points. Samples of the same metric always receive **distinct** millisecond timestamps (the write
   * path treats `(metric, timestamp)` as a duplicate and silently drops the later one), therefore the
   * caller must keep `pointCount <= metricCount * windowMs`.
   *
   * `pointCount <= 0`, or exactly one sample per metric, degenerates to `tick(endTimestamp)`.
   */
  tickBatch(endTimestamp: number, windowMs: number, pointCount: number): SimulatedPoint[] {
    if (!Number.isInteger(endTimestamp)) {
      throw new Error(`tickBatch() needs an integer millisecond timestamp, received ${String(endTimestamp)}`);
    }
    const metricTotal = this.entries.length;
    if (metricTotal === 0) return [];
    if (!Number.isInteger(pointCount) || pointCount <= 0 || pointCount === metricTotal) {
      return this.tick(endTimestamp);
    }
    if (!Number.isFinite(windowMs) || windowMs < 1) {
      throw new Error(`tickBatch() needs a positive window in milliseconds, received ${String(windowMs)}`);
    }
    const window = Math.max(1, Math.floor(windowMs));

    // Round-robin allocation: the first `remainder` metrics get one extra sample, so the batch size is
    // exactly `pointCount` and the per-metric load differs by at most one sample.
    const base = Math.floor(pointCount / metricTotal);
    const remainder = pointCount % metricTotal;
    const samplesPerMetric = this.entries.map((_entry, index) => base + (index < remainder ? 1 : 0));
    const maxSamples = base + (remainder > 0 ? 1 : 0);
    if (maxSamples > window) {
      throw new Error(
        `tickBatch() cannot place ${maxSamples} samples of one metric inside a ${window} ms window ` +
          'without repeating a timestamp; widen the window or lower the point count',
      );
    }

    const points: SimulatedPoint[] = [];
    const currentValues = new Map<string, number | bigint | boolean | string>();
    // Sample-major order: every layer covers all metrics at nearly the same instant, which keeps the
    // derived counters (`counter.rateFrom`) reading values from the same layer.
    for (let sample = 0; sample < maxSamples; sample += 1) {
      for (let index = 0; index < metricTotal; index += 1) {
        const count = samplesPerMetric[index] ?? 0;
        if (sample >= count) continue;
        const entry = this.entries[index] as MetricEntry;
        // Strictly increasing inside the window because `count <= window`.
        const timestamp = endTimestamp - window + Math.floor(((sample + 1) * window) / count);
        const point = this.nextPoint(entry, timestamp, currentValues);
        currentValues.set(entry.metricName, point.value);
        points.push(point);
      }
    }
    return points;
  }

  private nextPoint(
    entry: MetricEntry,
    timestamp: number,
    currentTick: ReadonlyMap<string, number | bigint | boolean | string>,
  ): SimulatedPoint {
    const state = entry.state;
    const seconds = state.lastTimestamp === null ? 0 : Math.max(0, (timestamp - state.lastTimestamp) / 1000);
    state.lastTimestamp = timestamp;

    let faulty = false;
    if (state.glitchTicksLeft > 0) {
      state.glitchTicksLeft -= 1;
      faulty = true;
    } else if (this.glitchProbability > 0 && entry.random() < this.glitchProbability) {
      state.glitchTicksLeft = 2 + Math.floor(entry.random() * 3);
      faulty = true;
    }

    // A fault repeats the previous value (stale sample) instead of advancing the signal. The quality
    // flag stays at 0 because rtdb v0.1.0 (M0) rejects any non-zero quality with E_INVALID_POINT.
    if (faulty && state.lastValue !== null) {
      return { metricName: entry.metricName, timestamp, value: state.lastValue, stale: true };
    }

    const value = this.computeValue(entry, timestamp, seconds, currentTick);
    state.lastValue = value;
    return { metricName: entry.metricName, timestamp, value };
  }

  private computeValue(
    entry: MetricEntry,
    timestamp: number,
    seconds: number,
    currentTick: ReadonlyMap<string, number | bigint | boolean | string>,
  ): number | bigint | boolean | string {
    const tag = entry.tag;
    const state = entry.state;

    if (entry.type === DEMO_VALUE_TYPE.Bool) {
      const probability = tag.toggleProbability ?? 0;
      if (probability > 0 && entry.random() < probability) state.boolValue = !state.boolValue;
      return state.boolValue;
    }

    if (entry.type === DEMO_VALUE_TYPE.String) {
      const sequence = tag.sequence ?? [];
      const probability = tag.changeProbability ?? STRING_CHANGE_PROBABILITY;
      if (sequence.length > 1 && entry.random() < probability) {
        state.stringIndex = Math.floor(entry.random() * sequence.length);
      }
      state.stringIndex %= sequence.length;
      return sequence[state.stringIndex] ?? '';
    }

    if (entry.type === DEMO_VALUE_TYPE.Int64 && tag.states !== undefined && tag.states.length > 0) {
      const states = tag.states;
      const probability = tag.changeProbability ?? INT_STATE_CHANGE_PROBABILITY;
      if (states.length > 1 && entry.random() < probability) {
        const offset = 1 + Math.floor(entry.random() * (states.length - 1));
        state.intStateIndex = (state.intStateIndex + offset) % states.length;
      }
      return BigInt(states[state.intStateIndex] ?? 0);
    }

    if (tag.counter !== undefined) {
      const spec = tag.counter;
      let increment = 0;
      if (spec.perSecond !== undefined) {
        increment = spec.perSecond * seconds;
      } else if (spec.rateFrom !== undefined) {
        // Resolved inside this entry's replica group, so a replica integrates its own driving signal.
        const rawRate = entry.rateFromMetric === null ? undefined : currentTick.get(entry.rateFromMetric);
        const rate = typeof rawRate === 'number' ? rawRate : 0;
        increment = rate * seconds * (spec.factor ?? 1);
      }
      state.counterValue += increment;
      if (entry.type === DEMO_VALUE_TYPE.Int64) return BigInt(Math.trunc(state.counterValue));
      return roundTo(state.counterValue, tag.decimals ?? 2);
    }

    const signal = tag.signal ?? { base: tag.min ?? 0, amplitude: 0, periodMs: 600_000 };
    const min = tag.min ?? signal.base - signal.amplitude;
    const max = tag.max ?? signal.base + signal.amplitude;
    const noise = (max - min) * DRIFT_NOISE_RATIO;
    state.drift = state.drift * DRIFT_DECAY + (entry.random() * 2 - 1) * noise;
    const wave = Math.sin((2 * Math.PI * timestamp) / signal.periodMs + entry.phase) * signal.amplitude;
    const raw = clamp(signal.base + wave + state.drift, min, max);
    if (entry.type === DEMO_VALUE_TYPE.Int64) return BigInt(Math.round(raw));
    return roundTo(raw, tag.decimals ?? 1);
  }
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
