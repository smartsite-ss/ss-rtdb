// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxQL compatibility: tokenizer for the read-only subset
 *
 * Hand-written and dependency-free. Quoted identifiers (`"cpu"`) and string literals (`'srv01'`) keep
 * their escapes; durations (`5m`, `1h30m`) stay one token and are converted to milliseconds by the parser.
 */

import { InfluxCompatError } from '../errors.ts';

export type TokenType = 'ident' | 'string' | 'number' | 'duration' | 'punct' | 'regex' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  /** 0-based offset in the source text (for error messages) */
  position: number;
  /** Identifier or literal was quoted (`"..."` / `'...'`) */
  quoted: boolean;
}

const DURATION_UNITS = ['ns', 'us', 'µs', 'µ', 'u', 'ms', 's', 'm', 'h', 'd', 'w'] as const;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      index += 1;
      continue;
    }
    const position = index;

    if (character === '-' && text[index + 1] === '-') {
      // `--` line comment (InfluxQL accepts it; harmless to skip)
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }

    if (character === '"') {
      const { value, next } = readQuoted(text, index, '"');
      tokens.push({ type: 'ident', value, position, quoted: true });
      index = next;
      continue;
    }
    if (character === "'") {
      const { value, next } = readQuoted(text, index, "'");
      tokens.push({ type: 'string', value, position, quoted: true });
      index = next;
      continue;
    }
    if (character === '/') {
      const { value, next } = readQuoted(text, index, '/');
      tokens.push({ type: 'regex', value, position, quoted: true });
      index = next;
      continue;
    }

    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(text[index + 1] ?? ''))) {
      const start = index;
      while (index < text.length && /[0-9]/.test(text[index])) index += 1;
      if (text[index] === '.') {
        index += 1;
        while (index < text.length && /[0-9]/.test(text[index])) index += 1;
      }
      const numberText = text.slice(start, index);
      const duration = readDurationUnits(text, index);
      if (duration !== null) {
        tokens.push({ type: 'duration', value: numberText + duration.text, position, quoted: false });
        index = duration.next;
        continue;
      }
      tokens.push({ type: 'number', value: numberText, position, quoted: false });
      continue;
    }

    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) index += 1;
      tokens.push({ type: 'ident', value: text.slice(start, index), position, quoted: false });
      continue;
    }

    const two = text.slice(index, index + 2);
    if (two === '!=' || two === '>=' || two === '<=' || two === '=~' || two === '!~' || two === '<>') {
      tokens.push({ type: 'punct', value: two === '<>' ? '!=' : two, position, quoted: false });
      index += 2;
      continue;
    }
    if ('(),*;=<>+-'.includes(character)) {
      tokens.push({ type: 'punct', value: character, position, quoted: false });
      index += 1;
      continue;
    }

    throw new InfluxCompatError({
      status: 400,
      code: 'invalid',
      message: `Unsupported character in InfluxQL at offset ${position}: ${character}`,
    });
  }
  tokens.push({ type: 'eof', value: '', position: text.length, quoted: false });
  return tokens;
}

/** Read a quoted literal (`"..."`, `'...'` or `/.../`) starting at the opening quote */
function readQuoted(text: string, start: number, quote: string): { value: string; next: number } {
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) {
      const next = text[index + 1];
      value += next === quote || next === '\\' ? next : `\\${next}`;
      index += 2;
      continue;
    }
    if (character === quote) return { value, next: index + 1 };
    value += character;
    index += 1;
  }
  throw new InfluxCompatError({
    status: 400,
    code: 'invalid',
    message: `Unterminated quoted literal at offset ${start}`,
  });
}

/** Convert an InfluxQL duration literal (`5m`, `1h30m`, `100ms`) to milliseconds */
export function durationToMs(text: string): number {
  let total = 0;
  let index = 0;
  const pattern = /^(\d+)(ns|us|µs|µ|u|ms|s|m|h|d|w)/;
  while (index < text.length) {
    const match = pattern.exec(text.slice(index));
    if (match === null) {
      throw new InfluxCompatError({ status: 400, code: 'invalid', message: `Invalid duration: ${text}` });
    }
    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * unitToMs(unit);
    index += match[0].length;
  }
  const rounded = Math.round(total);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw new InfluxCompatError({
      status: 400,
      code: 'invalid',
      message: `Duration is too small (must be at least 1ms): ${text}`,
    });
  }
  return rounded;
}

function unitToMs(unit: string): number {
  switch (unit) {
    case 'ns':
      return 1e-6;
    case 'us':
    case 'µ':
    case 'µs':
    case 'u':
      return 1e-3;
    case 'ms':
      return 1;
    case 's':
      return 1_000;
    case 'm':
      return 60_000;
    case 'h':
      return 3_600_000;
    case 'd':
      return 86_400_000;
    case 'w':
      return 604_800_000;
    default:
      throw new InfluxCompatError({ status: 400, code: 'invalid', message: `Unknown duration unit: ${unit}` });
  }
}

/** Read one or more `<digits><unit>` groups starting at `index`; returns null when no unit follows */
function readDurationUnits(text: string, index: number): { text: string; next: number } | null {
  let cursor = index;
  let consumed = '';
  while (cursor < text.length) {
    const unit = DURATION_UNITS.find((candidate) => text.startsWith(candidate, cursor));
    if (unit === undefined) break;
    // Reject identifier tails such as `5many` (unit match must not be followed by a letter)
    const after = text[cursor + unit.length] ?? '';
    if (/[A-Za-z]/.test(after)) break;
    consumed += unit;
    cursor += unit.length;
    // Optional next numeric group (`1h30m`)
    const digitsStart = cursor;
    while (cursor < text.length && /[0-9]/.test(text[cursor])) cursor += 1;
    if (cursor === digitsStart) break;
    consumed += text.slice(digitsStart, cursor);
  }
  if (consumed.length === 0) return null;
  return { text: consumed, next: cursor };
}
