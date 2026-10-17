// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Client-side spreadsheet export for the admin console.
 *
 * The console ships as a static bundle with no runtime dependencies, so instead of a zip-based `.xlsx` writer
 * this emits **Excel 2003 SpreadsheetML** (plain XML, `progid: Excel.Sheet`) and saves it as `*.xls`. Excel,
 * WPS and LibreOffice all open it natively, and typed cells (Number / Boolean / String) survive the import.
 */

/** One exported cell; `null` (also `NaN` / `Infinity`) becomes an empty cell */
export type XlsCellValue = string | number | boolean | null;

export interface XlsSheet {
  /** Sheet name shown on the tab; Excel limits it to 31 characters */
  name: string;
  columns: string[];
  rows: XlsCellValue[][];
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n';

const WORKBOOK_NAMESPACES =
  'xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
  'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ' +
  'xmlns:html="http://www.w3.org/TR/REC-html40"';

/** Bold header row plus a frozen top row, so long exports stay readable */
const WORKBOOK_STYLES =
  '<Styles>' +
  '<Style ss:ID="header"><Font ss:Bold="1"/><Interior ss:Color="#F2F4F7" ss:Pattern="Solid"/></Style>' +
  '</Styles>';

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    // Control characters are illegal in XML 1.0 and make Excel reject the whole file.
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function renderCell(value: XlsCellValue): string {
  if (value === null) return '<Cell/>';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `<Cell><Data ss:Type="Number">${value}</Data></Cell>` : '<Cell/>';
  }
  if (typeof value === 'boolean') {
    return `<Cell><Data ss:Type="Boolean">${value ? 1 : 0}</Data></Cell>`;
  }
  return `<Cell><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
}

function renderRow(values: XlsCellValue[], styleId?: string): string {
  const style = styleId === undefined ? '' : ` ss:StyleID="${styleId}"`;
  return `<Row>${values.map((value) => renderCell(value).replace('<Cell', `<Cell${style}`)).join('')}</Row>`;
}

/** Build the workbook XML; exported separately from the download so it can be inspected in tests */
export function buildXlsWorkbook(sheets: XlsSheet[]): string {
  const worksheets = sheets
    .map((sheet) => {
      const header = renderRow(sheet.columns, 'header');
      const rows = sheet.rows.map((row) => renderRow(row)).join('');
      return (
        `<Worksheet ss:Name="${escapeXml(sheet.name.slice(0, 31))}">` +
        `<Table>${header}${rows}</Table>` +
        '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">' +
        '<FreezePanes/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane>' +
        '</WorksheetOptions>' +
        '</Worksheet>'
      );
    })
    .join('');
  return `${XML_DECLARATION}<Workbook ${WORKBOOK_NAMESPACES}>${WORKBOOK_STYLES}${worksheets}</Workbook>`;
}
