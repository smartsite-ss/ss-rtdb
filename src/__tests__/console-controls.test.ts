// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Console key mapping for the foreground rtdb-server: q / Ctrl+C quits gracefully, r reloads the
 * configuration; every other key (including Ctrl+letter shortcuts) must be ignored.
 */

import assert from 'node:assert/strict';
import type { Key } from 'node:readline';
import { describe, it } from 'node:test';

import { resolveConsoleCommand } from '../packages/server/src/console-controls.ts';

function controlKey(name: string): Key {
  return { name, ctrl: true };
}

describe('server: 控制台按键', () => {
  it('q / Q 触发安全退出', () => {
    assert.equal(resolveConsoleCommand('q', undefined), 'quit');
    assert.equal(resolveConsoleCommand('Q', undefined), 'quit');
  });

  it('r / R 触发重载', () => {
    assert.equal(resolveConsoleCommand('r', undefined), 'reload');
    assert.equal(resolveConsoleCommand('R', undefined), 'reload');
  });

  it('Ctrl+C / Ctrl+D 视为退出，其它组合键忽略', () => {
    assert.equal(resolveConsoleCommand(undefined, controlKey('c')), 'quit');
    assert.equal(resolveConsoleCommand(undefined, controlKey('d')), 'quit');
    assert.equal(resolveConsoleCommand(undefined, controlKey('r')), null);
    assert.equal(resolveConsoleCommand(undefined, controlKey('z')), null);
  });

  it('其它按键与回车不触发任何动作', () => {
    assert.equal(resolveConsoleCommand('x', undefined), null);
    assert.equal(resolveConsoleCommand('\r', { name: 'return' } as Key), null);
    assert.equal(resolveConsoleCommand(undefined, undefined), null);
  });
});
