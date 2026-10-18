// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Browser download glue for the CSV writer.
 *
 * Kept apart from `csv.ts` on purpose (same split as `xls.ts` / `xls-download.ts`): the builder is pure and
 * unit-tested under the Node tsconfig, while this module touches `Blob` / `document`.
 *
 * A UTF-8 BOM is prepended: without it Excel (especially on a Chinese/Japanese Windows locale) decodes the file
 * as the ANSI code page and mangles non-ASCII metric names.
 */

import { buildCsv } from './csv';
import type { CsvCellValue } from './csv';

/** Trigger a browser download of a UTF-8 CSV (`text/csv`) */
export function downloadCsv(
  fileName: string,
  columns: readonly string[],
  rows: readonly (readonly CsvCellValue[])[],
): void {
  const blob = new Blob([`\uFEFF${buildCsv(columns, rows)}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName.toLowerCase().endsWith('.csv') ? fileName : `${fileName}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Give the browser a tick to start the download before the object URL is released.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
