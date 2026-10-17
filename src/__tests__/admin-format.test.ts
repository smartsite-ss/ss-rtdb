// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Admin console display formatters. The status panel shows MiB / ms measurements whose raw float
 * representation has up to 15 digits, so fractional values must be reduced to two decimals while integers
 * keep only the thousands grouping.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatBytes, formatNumber, formatPercent } from '../packages/admin/src/format.ts';

describe('admin: 显示格式化', () => {
  it('整数只做千分位分隔', () => {
    assert.equal(formatNumber(0), '0');
    assert.equal(formatNumber(45), '45');
    assert.equal(formatNumber(16369), '16,369');
    assert.equal(formatNumber(-1234567), '-1,234,567');
  });

  it('小数保留两位', () => {
    assert.equal(formatNumber(8.296104431152344), '8.30');
    assert.equal(formatNumber(11.055799931287766), '11.06');
    assert.equal(formatNumber(4.035600006580353), '4.04');
    assert.equal(formatNumber(0.005), '0.01');
    assert.equal(formatNumber(1234.5), '1,234.50');
    assert.equal(formatNumber(1.001), '1.00');
  });

  it('非有限值与其它格式保持不变', () => {
    assert.equal(formatNumber(Number.NaN), 'NaN');
    assert.equal(formatNumber(Number.POSITIVE_INFINITY), 'Infinity');
    assert.equal(formatBytes(60), '60 B');
    assert.equal(formatBytes(1024), '1.00 KiB');
    assert.equal(formatBytes(1007616), '984.00 KiB');
    assert.equal(formatPercent(0), '0.00%');
    assert.equal(formatPercent(0.5), '50.00%');
    assert.equal(formatPercent(0.9876), '98.76%');
  });
});
