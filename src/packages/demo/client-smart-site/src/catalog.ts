// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Smart Site demo catalog (mirrors the device / tag layout used by `ss-v7/ss-services`).
 *
 * Mapping to the rtdb data model (see `docs-o/zh/10-smart-site-demo.md`):
 *   - Smart Site project                              -> one rtdb database (`smartfactory_demo`)
 *   - `dev_devices.device_code` + `dev_data_tags.path` -> rtdb metric name (`<device>.<variable>`)
 *   - `dev_data_tags.dataType`                        -> rtdb value type (float32/float -> f64,
 *                                                        int/int32 -> i64, bool, string)
 *   - `dev_data_tags.unit`                            -> documentation only (`--list`)
 *   - stored `quality` (0-100)                        -> rtdb `q` (u8 flag; 0 = good, omitted)
 *
 * The tag paths below are copied from the `smartfactory-demo` project so the generated stream looks
 * exactly like the one produced by the Smart Site collectors.
 */

/** rtdb value types (the four types the engine locks per metric) */
export const DEMO_VALUE_TYPE = {
  Float64: 'f64',
  Int64: 'i64',
  Bool: 'bool',
  String: 'string',
} as const;
export type DemoValueType = (typeof DEMO_VALUE_TYPE)[keyof typeof DEMO_VALUE_TYPE];

/** `dev_data_tags.dataType` values used by Smart Site */
export type SmartSiteDataType = 'float' | 'float32' | 'int' | 'int32' | 'bool' | 'string';

/** Sine wave carrying an analog signal (the generator adds a small bounded random walk) */
export interface AnalogSignal {
  base: number;
  amplitude: number;
  periodMs: number;
}

export interface CounterSpec {
  /** Constant increment per second (e.g. 1/25 for one piece every 25 s) */
  perSecond?: number;
  /** Variable of the same device that drives the increment (e.g. `gong-l`) */
  rateFrom?: string;
  /** Multiplier applied to `rateFrom * seconds` (e.g. 1/3600 for kW -> kWh) */
  factor?: number;
  /** Starting value */
  initial?: number;
}

export interface TagDefinition {
  /** `dev_data_tags.path` variable segment (kebab-case, English) */
  variable: string;
  /** `dev_data_tags.name` (Chinese display name, exactly as stored by Smart Site) */
  name: string;
  unit?: string;
  dataType: SmartSiteDataType;
  /** rtdb value type; derived from `dataType` when omitted */
  type?: DemoValueType;
  min?: number;
  max?: number;
  decimals?: number;
  /** Analog signal definition (f64 / i64); mutually exclusive with `counter` */
  signal?: AnalogSignal;
  /** Counter definition (f64 / i64); mutually exclusive with `signal` */
  counter?: CounterSpec;
  /** Integer state candidates (i64), e.g. 0=stopped 1=running 2=fault */
  states?: readonly number[];
  /** Probability of moving to another integer state on a tick */
  changeProbability?: number;
  /** Initial boolean state (default `true`) */
  initial?: boolean;
  /** Probability of flipping a boolean on a tick */
  toggleProbability?: number;
  /** Candidate string values */
  sequence?: readonly string[];
}

export interface DeviceDefinition {
  /** `dev_devices.device_code` */
  deviceCode: string;
  /** `dev_devices.device_name` */
  deviceName: string;
  tags: readonly TagDefinition[];
}

/** Project isolation unit: one Smart Site project maps to one rtdb database */
export const DEMO_DATABASE = 'smartfactory_demo';

function wave(base: number, amplitude: number, periodMs: number): AnalogSignal {
  return { base, amplitude, periodMs };
}

/**
 * Device / tag catalog of the demo station (HVAC + sewage + workshop energy/PLC + MES gateway).
 * Tag order matters only for `counter.rateFrom`: the driving variable must appear earlier.
 */
export const SMART_SITE_DEMO_CATALOG: readonly DeviceDefinition[] = [
  {
    deviceCode: 'hvac-chiller',
    deviceName: '冷水机组',
    tags: [
      { variable: 'supply-temp', name: '供水温度', unit: '℃', dataType: 'float32', min: 5, max: 15, signal: wave(8.5, 1.2, 600_000) },
      { variable: 'return-temp', name: '回水温度', unit: '℃', dataType: 'float32', min: 10, max: 18, signal: wave(12.4, 1.0, 720_000) },
      { variable: 'flow', name: '流量', unit: 'm³/h', dataType: 'float32', min: 40, max: 120, signal: wave(78, 12, 900_000) },
      { variable: 'flow-dev', name: '流量偏差', unit: '%', dataType: 'float32', min: -5, max: 5, signal: wave(0, 1.5, 480_000) },
      { variable: 'power1', name: '功率1', unit: 'kW', dataType: 'float32', min: 0, max: 60, signal: wave(24, 6, 600_000) },
      { variable: 'power2', name: '功率2', unit: 'kW', dataType: 'float32', min: 0, max: 60, signal: wave(22, 5, 600_000) },
      { variable: 'cop', name: 'COP', unit: '', dataType: 'float32', min: 3, max: 7, signal: wave(5.1, 0.4, 1_800_000), decimals: 2 },
      { variable: 'eer', name: 'EER', unit: '', dataType: 'float32', min: 3, max: 7, signal: wave(5.0, 0.35, 1_800_000), decimals: 2 },
      { variable: 'eer-dev', name: 'EER偏差', unit: '%', dataType: 'float32', min: -5, max: 5, signal: wave(0, 1.2, 900_000), decimals: 2 },
      { variable: 'load-kw', name: '负荷', unit: 'kW', dataType: 'float32', min: 40, max: 130, signal: wave(85, 15, 1_200_000) },
      { variable: 'status', name: '运行状态', dataType: 'bool', initial: true, toggleProbability: 0.001 },
    ],
  },
  {
    deviceCode: 'hvac-chw-pump',
    deviceName: '冷冻水泵',
    tags: [
      { variable: 'flow', name: '流量', unit: 'm³/h', dataType: 'float32', min: 30, max: 90, signal: wave(55, 8, 900_000) },
      { variable: 'inlet-temp', name: '入口温度', unit: '℃', dataType: 'float32', min: 5, max: 12, signal: wave(8, 0.8, 720_000) },
      { variable: 'power', name: '功率', unit: 'kW', dataType: 'float32', min: 5, max: 30, signal: wave(14, 3, 600_000) },
      { variable: 'status', name: '运行状态', dataType: 'bool', initial: true, toggleProbability: 0.002 },
    ],
  },
  {
    deviceCode: 'hvac-tower',
    deviceName: '冷却塔',
    tags: [
      { variable: 'flow', name: '流量', unit: 'm³/h', dataType: 'float32', min: 40, max: 110, signal: wave(70, 10, 840_000) },
      { variable: 'inlet-temp', name: '入口温度', unit: '℃', dataType: 'float32', min: 20, max: 35, signal: wave(28, 2, 1_200_000) },
      { variable: 'power', name: '功率', unit: 'kW', dataType: 'float32', min: 3, max: 20, signal: wave(9, 2, 660_000) },
      { variable: 'status', name: '运行状态', dataType: 'bool', initial: true, toggleProbability: 0.002 },
    ],
  },
  {
    deviceCode: 'sewage-in',
    deviceName: '入水口',
    tags: [
      { variable: 'cod', name: 'COD', unit: 'mg/L', dataType: 'float32', min: 80, max: 400, signal: wave(220, 40, 1_800_000) },
      { variable: 'an-dan', name: '氨氮', unit: 'mg/L', dataType: 'float32', min: 10, max: 60, signal: wave(28, 6, 1_800_000) },
      { variable: 'p-h-zhi', name: 'PH值', unit: '', dataType: 'float32', min: 6.5, max: 8, signal: wave(7.2, 0.2, 2_400_000), decimals: 2 },
      { variable: 'zhuo-du', name: '浊度', unit: 'NTU', dataType: 'float32', min: 20, max: 120, signal: wave(60, 12, 1_500_000) },
    ],
  },
  {
    deviceCode: 'sewage-aerobic',
    deviceName: '好氧池',
    tags: [
      { variable: 'orp', name: 'ORP', unit: 'mV', dataType: 'int', type: 'i64', min: -200, max: -40, signal: wave(-120, 25, 1_200_000) },
      { variable: 'rong-jie-yang', name: '溶解氧', unit: 'mg/L', dataType: 'float32', min: 1.5, max: 6, signal: wave(3.2, 0.6, 900_000) },
      { variable: 'wen-du', name: '温度', unit: '℃', dataType: 'float32', min: 18, max: 32, signal: wave(24, 1.5, 2_400_000) },
      { variable: 'wu-ni-nong-du', name: '污泥浓度', unit: 'mg/L', dataType: 'float32', min: 2000, max: 5000, signal: wave(3400, 300, 3_600_000), decimals: 0 },
      { variable: 'ye-wei', name: '液位', unit: 'm', dataType: 'float32', min: 1.2, max: 4.8, signal: wave(3, 0.4, 1_800_000), decimals: 2 },
    ],
  },
  {
    deviceCode: 'sewage-pump-lift',
    deviceName: '提升泵',
    tags: [
      { variable: 'dian-liu', name: '电流', unit: 'A', dataType: 'float32', min: 5, max: 45, signal: wave(22, 4, 720_000) },
      { variable: 'pin-l', name: '频率', unit: 'Hz', dataType: 'float32', min: 30, max: 50, signal: wave(42, 3, 600_000) },
      { variable: 'yun-xing-zhuang-tai', name: '运行状态', dataType: 'int', type: 'i64', states: [0, 1, 2], changeProbability: 0.01 },
    ],
  },
  {
    deviceCode: 'ws-a-meter-01',
    deviceName: '车间A能耗表',
    tags: [
      { variable: 'dian-ya', name: '电压', unit: 'V', dataType: 'float32', min: 215, max: 245, signal: wave(228, 4, 600_000) },
      { variable: 'dian-liu', name: '电流', unit: 'A', dataType: 'float32', min: 5, max: 40, signal: wave(18, 5, 720_000) },
      { variable: 'gong-l', name: '功率', unit: 'kW', dataType: 'float32', min: 60, max: 130, signal: wave(92, 14, 900_000) },
      {
        variable: 'yong-dian-liang',
        name: '用电量',
        unit: 'kWh',
        dataType: 'float32',
        counter: { rateFrom: 'gong-l', factor: 1 / 3600, initial: 38_210.5 },
        decimals: 2,
      },
    ],
  },
  {
    deviceCode: 'ws-a-plc-01',
    deviceName: '车间A产线1主站',
    tags: [
      { variable: 'gong-l', name: '功率', unit: 'kW', dataType: 'float32', min: 60, max: 130, signal: wave(92, 14, 900_000) },
      { variable: 'jie-pai-shi-jian', name: '节拍时间', unit: 's', dataType: 'float32', min: 18, max: 32, signal: wave(24, 3, 420_000) },
      { variable: 'lei-ji-chan-liang', name: '累计产量', unit: '件', dataType: 'int32', type: 'i64', counter: { perSecond: 1 / 25, initial: 1240 } },
      { variable: 'o-e-e-shi-shi', name: 'OEE实时', unit: '%', dataType: 'float32', min: 55, max: 98, signal: wave(82, 6, 1_200_000) },
      { variable: 'yun-xing-shi-jian', name: '运行时间', unit: 's', dataType: 'int32', type: 'i64', counter: { perSecond: 1, initial: 27_640 } },
      { variable: 'yun-xing-zhuang-tai', name: '运行状态', dataType: 'bool', initial: true, toggleProbability: 0.001 },
      { variable: 'zhu-zhou-wen-du', name: '主轴温度', unit: '℃', dataType: 'float32', min: 55, max: 85, signal: wave(68, 4, 1_500_000) },
    ],
  },
  {
    deviceCode: 'ws-mes-gw-01',
    deviceName: 'MES对接网关',
    tags: [
      {
        variable: 'dang-qian-pai-chan-gong-dan',
        name: '当前排产工单',
        dataType: 'string',
        sequence: ['WO-20261017-001', 'WO-20261017-002', 'WO-20261018-001'],
      },
      {
        variable: 'm-e-s-hui-xie',
        name: 'MES回写',
        dataType: 'string',
        sequence: ['ok', 'ok', 'ok', 'retry', 'timeout'],
        changeProbability: 0.05,
      },
    ],
  },
];

/** Map a Smart Site `dataType` onto the rtdb value type */
export function resolveValueType(dataType: SmartSiteDataType): DemoValueType {
  switch (dataType) {
    case 'float':
    case 'float32':
      return DEMO_VALUE_TYPE.Float64;
    case 'int':
    case 'int32':
      return DEMO_VALUE_TYPE.Int64;
    case 'bool':
      return DEMO_VALUE_TYPE.Bool;
    case 'string':
      return DEMO_VALUE_TYPE.String;
  }
}

/** Effective rtdb value type of a tag (an explicit `type` wins over the `dataType` mapping) */
export function valueTypeOf(tag: TagDefinition): DemoValueType {
  return tag.type ?? resolveValueType(tag.dataType);
}

/** Smart Site tag path == rtdb metric name: `<device_code>.<variable>` */
export function buildMetricName(deviceCode: string, variable: string): string {
  return `${deviceCode}.${variable}`;
}

/** Filter the catalog by device codes; an empty / undefined filter means "all devices" */
export function selectDevices(deviceCodes?: readonly string[]): readonly DeviceDefinition[] {
  if (deviceCodes === undefined || deviceCodes.length === 0) return SMART_SITE_DEMO_CATALOG;
  const wanted = new Set(deviceCodes);
  return SMART_SITE_DEMO_CATALOG.filter((device) => wanted.has(device.deviceCode));
}
