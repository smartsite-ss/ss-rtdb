// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * The admin console exports the metric inventory as CSV (see `packages/admin/src/csv.ts`). The writer is pure so
 * the RFC 4180 corner cases are verified here: quoting, CRLF endings, empty cells and typed values.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCsv, escapeCsvCell } from '../packages/admin/src/csv.ts';
import { formatDateTime, formatDateTimeWithOffset } from '../packages/admin/src/format.ts';

describe('admin: CSV 导出', () => {
  it('表头与数据行以 CRLF 分隔，并以 CRLF 结尾', () => {
    const csv = buildCsv(['metric', 'type'], [['plant.a', 'f64']]);
    assert.equal(csv, 'metric,type\r\nplant.a,f64\r\n');
  });

  it('按 RFC 4180 引用含逗号、引号、换行的字段', () => {
    assert.equal(escapeCsvCell('a,b'), '"a,b"');
    assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvCell('line1\nline2'), '"line1\nline2"');
    assert.equal(escapeCsvCell('plain'), 'plain');
  });

  it('空值与非有限数字写成空单元格，布尔值写成 true/false', () => {
    const csv = buildCsv(['a', 'b', 'c', 'd'], [[null, undefined, Number.NaN, true]]);
    assert.equal(csv, 'a,b,c,d\r\n,,,true\r\n');
    assert.equal(escapeCsvCell(Number.POSITIVE_INFINITY), '');
    assert.equal(escapeCsvCell(false), 'false');
    assert.equal(escapeCsvCell(0), '0');
  });

  it('指标名中的中文与竖线保持原样（仅引用规则生效）', () => {
    const csv = buildCsv(['指标'], [['站1|温度']]);
    assert.equal(csv, '指标\r\n站1|温度\r\n');
    assert.equal(escapeCsvCell('站1,温度'), '"站1,温度"');
  });

  it('没有数据行时仍输出表头', () => {
    assert.equal(buildCsv(['metric'], []), 'metric\r\n');
  });

  it('时间列带 UTC 偏移，Excel 不会当日期重排（秒不丢）', () => {
    const timestamp = new Date(2026, 2, 10, 8, 29, 23, 0).getTime();
    const text = formatDateTimeWithOffset(timestamp);
    assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/);
    assert.ok(text.startsWith('2026-03-10 08:29:23'));
    assert.ok(text.startsWith(formatDateTime(timestamp)));

    // The sub-second timestamp that exposed the bug keeps the same shape (timezone-agnostic assertion).
    const epochish = formatDateTimeWithOffset(1_768_003);
    assert.match(epochish, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/);
  });
});
