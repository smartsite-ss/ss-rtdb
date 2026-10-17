// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Public surface of the Smart Site demo client (catalog + generator + tiny HTTP client).
 *
 * The CLI lives in `main.ts`; everything here is side-effect free so tests can drive the generator
 * directly and reuse the HTTP client against an in-process server.
 */

export {
  DEMO_DATABASE,
  DEMO_VALUE_TYPE,
  SMART_SITE_DEMO_CATALOG,
  buildMetricName,
  resolveValueType,
  selectDevices,
  valueTypeOf,
} from './catalog.ts';
export type {
  AnalogSignal,
  CounterSpec,
  DemoValueType,
  DeviceDefinition,
  SmartSiteDataType,
  TagDefinition,
} from './catalog.ts';

export {
  DEFAULT_DEMO_CLIENT_CONFIG_PATH,
  applyDemoClientConfig,
  readDemoClientConfig,
} from './config.ts';
export type { DemoClientConfig, DemoClientConfigTarget } from './config.ts';

export { SmartSiteSimulator } from './generator.ts';
export type { MetricDescriptor, SimulatedPoint, SimulatorOptions } from './generator.ts';

export {
  DemoHttpError,
  DemoRtdbClient,
  WIRE_VALUE_TYPE,
  decodeWirePoint,
  decodeWireWindowValue,
  encodeWritePoint,
} from './client.ts';
export type {
  DecodedPoint,
  DemoClientOptions,
  MetricSummary,
  StatusSnapshot,
  WirePoint,
  WireSeries,
  WireValueType,
  WireWindow,
  WireWritePoint,
  WriteResult,
} from './client.ts';
