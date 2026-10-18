// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Day-granular half of the console time-range picker (`packages/admin/src/format.ts`).
 *
 * The pickers share one state with the exact `datetime-local` fields: a start day must snap to `00:00:00` and an end
 * day to `23:59:59`, and a half-typed date must never produce a bogus timestamp.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dayToDayEnd,
  dayToDayStart,
  dateTimeLocalDay,
  formatDateTime,
  fromDateTimeLocalValue,
} from '../packages/admin/src/format.ts';

describe('admin: 时间段日期控件', () => {
  it('从 datetime-local 值取日期部分，输入不完整时返回空串', () => {
    assert.equal(dateTimeLocalDay('2026-03-10T08:29:23'), '2026-03-10');
    assert.equal(dateTimeLocalDay('2026-03-10'), '2026-03-10');
    assert.equal(dateTimeLocalDay('2026-03'), '');
    assert.equal(dateTimeLocalDay(''), '');
  });

  it('起始日填 00:00:00，结束日填 23:59:59（含首末整天）', () => {
    assert.equal(dayToDayStart('2026-09-01'), '2026-09-01T00:00:00');
    assert.equal(dayToDayEnd('2026-09-30'), '2026-09-30T23:59:59');
  });

  it('不完整的日期原样返回，不会造出非法时间戳', () => {
    assert.equal(dayToDayStart('2026-09-0'), '2026-09-0');
    assert.equal(dayToDayEnd(''), '');
    assert.equal(fromDateTimeLocalValue(dayToDayStart('')), 0);
  });

  it('转换后的值与时间戳互相一致', () => {
    const start = dayToDayStart('2026-09-01');
    const end = dayToDayEnd('2026-09-30');
    assert.equal(formatDateTime(fromDateTimeLocalValue(start)), '2026-09-01 00:00:00');
    assert.equal(formatDateTime(fromDateTimeLocalValue(end)), '2026-09-30 23:59:59');
    assert.ok(fromDateTimeLocalValue(end) > fromDateTimeLocalValue(start));
    // Same day spans 23h59m59s in a fixed-offset zone; allow a DST shift so the test stays timezone-agnostic.
    const sameDay = fromDateTimeLocalValue(dayToDayEnd('2026-09-01')) - fromDateTimeLocalValue(dayToDayStart('2026-09-01'));
    assert.ok(sameDay >= 82_799_000 && sameDay <= 90_000_000);
  });
});
