// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * The admin console exports query previews as Excel 2003 SpreadsheetML (no third-party writer is available in a
 * dependency-free static bundle), so the XML shape is verified here: typed cells, escaping, empty values and the
 * 31-character sheet-name limit enforced by Excel.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildXlsWorkbook } from '../packages/admin/src/xls.ts';

function buildOneRow(values: (string | number | boolean | null)[]): string {
  return buildXlsWorkbook([{ name: 'sheet', columns: ['c1', 'c2', 'c3'], rows: [values] }]);
}

describe('admin: XLS (SpreadsheetML) 导出', () => {
  it('生成 Excel 可识别的 workbook 头与带样式的表头行', () => {
    const xml = buildOneRow(['a', 'b', 'c']);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>'));
    assert.match(xml, /<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"/);
    assert.match(xml, /<Style ss:ID="header">/);
    assert.match(
      xml,
      /<Row><Cell ss:StyleID="header"><Data ss:Type="String">c1<\/Data><\/Cell><Cell ss:StyleID="header"><Data ss:Type="String">c2<\/Data><\/Cell>/,
    );
  });

  it('按值类型写成 Number / Boolean / String，空值与非法浮点写成空单元格', () => {
    const xml = buildOneRow([42.5, true, null]);
    assert.match(xml, /<Cell><Data ss:Type="Number">42\.5<\/Data><\/Cell>/);
    assert.match(xml, /<Cell><Data ss:Type="Boolean">1<\/Data><\/Cell>/);
    assert.match(xml, /<Cell\/><\/Row>/);

    const invalid = buildOneRow([Number.NaN, Number.POSITIVE_INFINITY, 'text']);
    assert.equal((invalid.match(/<Cell\/>/g) ?? []).length, 2);
    assert.match(invalid, /<Data ss:Type="String">text<\/Data>/);
  });

  it('转义 XML 元字符并剔除 XML 1.0 非法控制字符', () => {
    const xml = buildOneRow(['a<b&c>"d"\'e', 'tab\tkept', '\u0001dropped', null]);
    assert.match(xml, /<Data ss:Type="String">a&lt;b&amp;c&gt;&quot;d&quot;&apos;e<\/Data>/);
    assert.match(xml, /<Data ss:Type="String">tab\tkept<\/Data>/);
    assert.ok(!xml.includes('\u0001'));
    assert.match(xml, /<Data ss:Type="String">dropped<\/Data>/);
  });

  it('工作表名截断到 31 个字符（Excel 限制）', () => {
    const xml = buildXlsWorkbook([{ name: 'x'.repeat(40), columns: ['c'], rows: [] }]);
    assert.match(xml, new RegExp(`<Worksheet ss:Name="${'x'.repeat(31)}">`));
  });

  it('多个工作表按顺序输出，每个工作表都带冻结首行的 WorksheetOptions', () => {
    const xml = buildXlsWorkbook([
      { name: 'range', columns: ['t'], rows: [[1]] },
      { name: 'aggregate', columns: ['t'], rows: [[2]] },
    ]);
    assert.ok(xml.indexOf('ss:Name="range"') < xml.indexOf('ss:Name="aggregate"'));
    assert.equal((xml.match(/<FreezePanes\/>/g) ?? []).length, 2);
  });
});
