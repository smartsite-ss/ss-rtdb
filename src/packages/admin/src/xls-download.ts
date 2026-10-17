// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Browser download glue for the SpreadsheetML writer.
 *
 * Kept apart from `xls.ts` on purpose: the workbook builder is pure and unit-tested under the Node tsconfig
 * (which has no DOM library), while this module touches `Blob` / `document` and is only bundled for the browser.
 */

import { buildXlsWorkbook } from './xls';
import type { XlsSheet } from './xls';

/** Trigger a browser download of the workbook (`*.xls`, `application/vnd.ms-excel`) */
export function downloadXlsWorkbook(fileName: string, sheets: XlsSheet[]): void {
  const blob = new Blob([buildXlsWorkbook(sheets)], {
    type: 'application/vnd.ms-excel;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName.toLowerCase().endsWith('.xls') ? fileName : `${fileName}.xls`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Give the browser a tick to start the download before the object URL is released.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
