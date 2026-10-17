// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Minimal leveled logger (aligns with "Detailed Design v2.0" §6.2.5 `log.level`)
 *
 * Only performs level filtering + prefixing; no third-party logging library is introduced (server keeps minimal dependencies); semantics match the ss-v7 platform `LOG_LEVEL`.
 * Output goes to console: `debug` / `info` → stdout, `warn` / `error` → stderr.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Level weight (higher is more severe; only entries at or above the current level are emitted) */
export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVEL_RANK, value);
}

export class Logger {
  readonly level: LogLevel;
  private readonly scope: string;

  constructor(level: LogLevel, scope = 'rtdb-server') {
    this.level = level;
    this.scope = scope;
  }

  debug(message: string, ...details: readonly unknown[]): void {
    this.write('debug', message, details);
  }

  info(message: string, ...details: readonly unknown[]): void {
    this.write('info', message, details);
  }

  warn(message: string, ...details: readonly unknown[]): void {
    this.write('warn', message, details);
  }

  error(message: string, ...details: readonly unknown[]): void {
    this.write('error', message, details);
  }

  private write(level: LogLevel, message: string, details: readonly unknown[]): void {
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[this.level]) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${this.scope}] ${message}`;
    const sink = level === 'debug' || level === 'info' ? console.log : console.error;
    if (details.length === 0) sink(line);
    else sink(line, ...details);
  }
}
