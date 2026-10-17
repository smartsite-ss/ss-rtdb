// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Display formatters for the rtdb-admin console.
 *
 * All formatters are locale-independent on purpose: the console must render identical text on every
 * operator workstation, so no `toLocaleString`-style API is used anywhere.
 */

/** Insert thousands separators into the integer part, keeping any fraction untouched */
function groupThousands(text: string): string {
  const dotIndex = text.indexOf('.');
  const integerPart = dotIndex === -1 ? text : text.slice(0, dotIndex);
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dotIndex === -1 ? grouped : `${grouped}${text.slice(dotIndex)}`;
}

/**
 * Thousands-separated number: integers stay integer, fractional values are kept to **two decimals**
 * (`8.30`, not `8.29610443115234`). The status panel displays MiB / ms measurements whose raw float
 * representation is unreadable at full precision.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return groupThousands(Number.isInteger(value) ? String(value) : value.toFixed(2));
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? String(value) : value.toFixed(2)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return String(ratio);
  return `${(ratio * 100).toFixed(2)}%`;
}

/** Compact `1d 2h 3m 4s` form of an elapsed duration */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return String(milliseconds);
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const segments: string[] = [];
  if (days > 0) segments.push(`${days}d`);
  if (days > 0 || hours > 0) segments.push(`${hours}h`);
  if (days > 0 || hours > 0 || minutes > 0) segments.push(`${minutes}m`);
  segments.push(`${seconds}s`);
  return segments.join(' ');
}

const padTwoDigits = (input: number): string => String(input).padStart(2, '0');

/** Local `YYYY-MM-DD HH:mm:ss` (never locale-formatted) */
export function formatDateTime(milliseconds: number): string {
  const date = new Date(milliseconds);
  return (
    `${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())} ` +
    `${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}:${padTwoDigits(date.getSeconds())}`
  );
}

/** `YYYY-MM-DDTHH:mm` value accepted by `<input type="datetime-local">` */
export function toDateTimeLocalValue(milliseconds: number): string {
  const date = new Date(milliseconds);
  return (
    `${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())}` +
    `T${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}`
  );
}

export function fromDateTimeLocalValue(value: string): number {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}
