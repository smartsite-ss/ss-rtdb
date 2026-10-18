// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Data quality flags (u8 bit field) — authoritative definition in
 * `docs-e/03-详细设计/存储结构详细设计.md` §3.1.
 *
 * ```
 * bit7-6 severity : 00 Good | 01 Uncertain | 10 Bad | 11 Reserved (read as Bad)
 * bit5-4 source   : 00 Process | 01 Substituted | 10 Interpolated | 11 Reserved
 * bit3-0 reason   : 0 None .. 15 Reserved
 * ```
 *
 * `0x00` is Good and is the only value with zero storage cost: a block carries a quality array only
 * when at least one of its points has a non-zero quality. The encoding is aligned with the industry
 * conventions (OPC UA severity, OPC DA / PI 8-bit quality codes, IEC 61850 validity/source/detailQual),
 * see the mapping table in the storage design doc.
 */

import { ERROR_CODE, RtdbError } from './errors.ts';

/** bit7-6: severity */
export const QUALITY_SEVERITY = {
  good: 0,
  uncertain: 1,
  bad: 2,
  reserved: 3,
} as const;
export type QualitySeverity = (typeof QUALITY_SEVERITY)[keyof typeof QUALITY_SEVERITY];

/** bit5-4: where the value came from */
export const QUALITY_SOURCE = {
  process: 0,
  substituted: 1,
  interpolated: 2,
  reserved: 3,
} as const;
export type QualitySource = (typeof QUALITY_SOURCE)[keyof typeof QUALITY_SOURCE];

/** bit3-0: why the value is not plain process data */
export const QUALITY_REASON = {
  none: 0,
  sensorFailure: 1,
  commFailure: 2,
  outOfRange: 3,
  overflow: 4,
  stale: 5,
  badReference: 6,
  configurationError: 7,
  maintenance: 8,
  test: 9,
  blocked: 10,
  calculationError: 11,
  inconsistent: 12,
  inaccurate: 13,
  oscillatory: 14,
  reserved: 15,
} as const;
export type QualityReason = (typeof QUALITY_REASON)[keyof typeof QUALITY_REASON];

/** Field masks inside the u8 quality flag */
export const QUALITY_SEVERITY_MASK = 0b1100_0000;
export const QUALITY_SOURCE_MASK = 0b0011_0000;
export const QUALITY_REASON_MASK = 0b0000_1111;

/** Frequently used complete flag values */
export const QUALITY = {
  /** Good · Process · None (default, not persisted) */
  good: 0x00,
  /** Good · Substituted (manual override) */
  substituted: 0x10,
  /** Good · Interpolated (computed by `queryAt linear`) */
  interpolated: 0x20,
  /** Uncertain · None */
  uncertain: 0x40,
  /** Uncertain · SensorFailure */
  uncertainSensorFailure: 0x51,
  /** Bad · None */
  bad: 0x80,
  /** Bad · CommFailure */
  badCommFailure: 0x82,
  /** Bad · Stale (timeout / old data) */
  badStale: 0x85,
  /** Bad · Test (simulation data) */
  badTest: 0x89,
} as const;

/** bit7-6 */
export function qualitySeverityOf(quality: number): QualitySeverity {
  return ((quality & QUALITY_SEVERITY_MASK) >> 6) as QualitySeverity;
}

/** bit5-4 */
export function qualitySourceOf(quality: number): QualitySource {
  return ((quality & QUALITY_SOURCE_MASK) >> 4) as QualitySource;
}

/** bit3-0 */
export function qualityReasonOf(quality: number): QualityReason {
  return (quality & QUALITY_REASON_MASK) as QualityReason;
}

/** Combine the three fields into one u8 flag (callers must pass in-range values) */
export function composeQuality(severity: QualitySeverity, source: QualitySource, reason: QualityReason): number {
  return ((severity << 6) | (source << 4) | reason) & 0xff;
}

/** Whether the value is a legal u8 quality flag (integer 0..255) */
export function isQualityValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xff;
}

/**
 * Validate a user-supplied quality value; `undefined` maps to `0x00` (Good).
 *
 * Throws `E_INVALID_POINT` with the point index so a bad batch is rejected as a whole (the message
 * mirrors the other write-path validators).
 */
export function requireQualityValue(value: unknown, index: number): number {
  if (value === undefined) return QUALITY.good;
  if (!isQualityValue(value)) {
    throw new RtdbError(
      ERROR_CODE.InvalidPoint,
      `Illegal quality flag: ${String(value)} (index=${index}; expected an integer 0..255)`,
    );
  }
  return value;
}

/** Which quality levels are allowed into the persistence chain */
export type QualityStorePolicy = 'all' | 'good-uncertain' | 'good';

/** What to do with a point below the store threshold */
export type QualityOnReject = 'reject' | 'drop';

export interface QualityPolicy {
  /** Default `all`: Good / Uncertain / Bad are all persisted */
  store: QualityStorePolicy;
  /** Default `reject`: a rejected batch returns `E_QUALITY_REJECTED` and nothing is written */
  onReject: QualityOnReject;
}

export const QUALITY_DEFAULTS: Readonly<QualityPolicy> = { store: 'all', onReject: 'reject' };

/** Severity threshold of a store policy (`all` accepts everything) */
export function qualityStoreMaxSeverity(store: QualityStorePolicy): QualitySeverity {
  if (store === 'good') return QUALITY_SEVERITY.good;
  if (store === 'good-uncertain') return QUALITY_SEVERITY.uncertain;
  return QUALITY_SEVERITY.reserved;
}

/** Whether a point's quality survives the store policy (`all` accepts every u8 value, incl. reserved) */
export function isQualityStored(quality: number, store: QualityStorePolicy): boolean {
  if (store === 'all') return true;
  // Reserved (bit7-6 = 11) is treated as Bad by readers, so it never passes a restricted policy.
  return qualitySeverityOf(quality) <= qualityStoreMaxSeverity(store);
}

/** Loose parser shared by the server config and the per-database `quality.json` (unknown values fall back) */
export function normalizeQualityPolicy(input: {
  store?: unknown;
  onReject?: unknown;
}): QualityPolicy {
  const store = input.store;
  const onReject = input.onReject;
  return {
    store:
      store === 'all' || store === 'good-uncertain' || store === 'good'
        ? store
        : QUALITY_DEFAULTS.store,
    onReject: onReject === 'reject' || onReject === 'drop' ? onReject : QUALITY_DEFAULTS.onReject,
  };
}
