// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Interactive console keys for the foreground `rtdb-server` process.
 *
 *   q (or Ctrl+C / Ctrl+D) - stop accepting requests, flush the engine and exit cleanly
 *   r                      - re-read the configuration file and restart the HTTP listener + engine in place
 *
 * Only attached when stdin is a terminal, so a service manager (systemd / Windows service / a redirected
 * stdin) is never affected. The raw-mode terminal is restored on process exit.
 */

import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';

export type ConsoleCommand = 'quit' | 'reload';

export interface ConsoleControlHandlers {
  quit: () => void;
  reload: () => void;
}

/**
 * Map one keypress to a command; `null` means "ignore this key". Ctrl+letter combinations other than
 * Ctrl+C / Ctrl+D are ignored on purpose so that a shell shortcut does not restart a production service.
 */
export function resolveConsoleCommand(input: string | undefined, key: Key | undefined): ConsoleCommand | null {
  if (key?.ctrl === true) {
    return key.name === 'c' || key.name === 'd' ? 'quit' : null;
  }
  const pressed = (input ?? '').toLowerCase();
  if (pressed === 'q') return 'quit';
  if (pressed === 'r') return 'reload';
  return null;
}

/**
 * Attach the console keys. Returns `false` when stdin is not a TTY (nothing is attached in that case).
 */
export function installConsoleControls(handlers: ConsoleControlHandlers): boolean {
  if (process.stdin.isTTY !== true) return false;

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (input: string | undefined, key: Key) => {
    const command = resolveConsoleCommand(input, key);
    if (command === 'quit') handlers.quit();
    else if (command === 'reload') handlers.reload();
  });

  process.on('exit', () => {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // stdin may already be gone (window closed / pipe torn down) - nothing to restore.
    }
  });

  return true;
}
