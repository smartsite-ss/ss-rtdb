// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * CSV writer for the admin console exports (dependency-free, like the rest of the static bundle).
 *
 * Rules kept deliberately small and predictable:
 * - RFC 4180 quoting: a field containing `,`, `"`, CR or LF is wrapped in double quotes and `"` is doubled
 * - CRLF line endings with a trailing CRLF (Excel / WPS / LibreOffice friendly)
 * - `null` / `undefined` / `NaN` / `Infinity` become empty cells
 * - the UTF-8 BOM is added by the download glue (`csv-download.ts`), so this builder stays pure and testable
 *   under the Node tsconfig
 */

/** One exported cell; `null`/`undefined` (also `NaN` / `Infinity`) becomes an empty cell */
export type CsvCellValue = string | number | boolean | null | undefined;

const NEEDS_QUOTING = /[",\r\n]/;

/** Escape one cell according to RFC 4180 */
export function escapeCsvCell(value: CsvCellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return NEEDS_QUOTING.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Build the CSV text: a header row followed by the data rows (no BOM; see `downloadCsv`) */
export function buildCsv(
  columns: readonly string[],
  rows: readonly (readonly CsvCellValue[])[],
): string {
  const lines = [columns.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
