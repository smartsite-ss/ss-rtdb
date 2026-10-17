// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Line Protocol line parsing (aligns with "Detailed Design v2.0" §3.1 "Line Protocol compatibility")
 *
 * Syntax: `metric[,tag=value...] <value> [ts]`
 *   - The tag section is **parsed but ignored**, accumulating `tagsIgnored` by tag count;
 *   - Timestamps are in **nanoseconds**, truncated to milliseconds after parsing (default = current time);
 *   - Value type detection: `true/false` (including `t/f`) → bool; `"..."` → string;
 *     **an integer without a decimal point → i64** (S8 protocol decision); with an `i` suffix → i64; otherwise parsed as f64;
 *   - Field-set form `key=value` takes the right side of the equals sign; blank lines and `#` comment lines are skipped;
 *   - Any invalid line → the whole batch is rejected (`E_INVALID_POINT`, details carry line numbers).
 */

import { ERROR_CODE, RtdbError } from '../../core/src/errors.ts';
import type { Point, WritePoint } from '../../core/src/types.ts';

export interface LineProtocolResult {
  points: WritePoint[];
  /** Accumulated count of ignored tags */
  tagsIgnored: number;
}

export function parseLineProtocol(text: string, nowMs: number): LineProtocolResult {
  const points: WritePoint[] = [];
  const issues: string[] = [];
  const lineNumbers: number[] = [];
  let tagsIgnored = 0;

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].replace(/\r$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    try {
      const parsed = parseLine(line, nowMs);
      points.push(parsed.point);
      tagsIgnored += parsed.tagsIgnored;
    } catch (error) {
      issues.push(`Line ${lineNumber}: ${(error as Error).message}`);
      lineNumbers.push(lineNumber);
    }
  }

  if (issues.length > 0) {
    throw new RtdbError(ERROR_CODE.InvalidPoint, `Line Protocol contains invalid lines (${issues.join('; ')})`, ...lineNumbers);
  }
  return { points, tagsIgnored };
}

interface ParsedLine {
  point: WritePoint;
  tagsIgnored: number;
}

function parseLine(line: string, nowMs: number): ParsedLine {
  const firstSpace = line.indexOf(' ');
  if (firstSpace < 0) throw new Error('Missing field value');
  const head = line.slice(0, firstSpace);
  const remainder = line.slice(firstSpace + 1).trim();
  if (remainder.length === 0) throw new Error('Missing field value');

  const headParts = head.split(',');
  const metricName = headParts[0];
  if (metricName.length === 0) throw new Error('Missing metric name');
  const tagsIgnored = headParts.length - 1;

  const valueSection = stripFieldKey(remainder);
  let valueToken: string;
  let timestampToken: string;
  if (valueSection.startsWith('"')) {
    const endQuote = findClosingQuote(valueSection);
    if (endQuote < 0) throw new Error('String value is missing the closing quote');
    valueToken = valueSection.slice(0, endQuote + 1);
    timestampToken = valueSection.slice(endQuote + 1).trim();
  } else {
    const spaceIndex = valueSection.indexOf(' ');
    valueToken = spaceIndex < 0 ? valueSection : valueSection.slice(0, spaceIndex);
    timestampToken = spaceIndex < 0 ? '' : valueSection.slice(spaceIndex + 1).trim();
  }

  const value = decodeValueToken(valueToken);
  const timestamp = timestampToken.length === 0 ? nowMs : parseNanosecondTimestamp(timestampToken);
  return { point: { metricName, timestamp, value }, tagsIgnored };
}

/** Remove the leading field key `key=` (an equals sign after a space or quote is treated as part of the value and not stripped) */
function stripFieldKey(text: string): string {
  const equalsIndex = text.indexOf('=');
  if (equalsIndex < 0) return text;
  const spaceIndex = text.indexOf(' ');
  if (spaceIndex >= 0 && spaceIndex < equalsIndex) return text;
  const quoteIndex = text.indexOf('"');
  if (quoteIndex >= 0 && quoteIndex < equalsIndex) return text;
  return text.slice(equalsIndex + 1).trim();
}

function findClosingQuote(text: string): number {
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"') return index;
  }
  return -1;
}

function decodeValueToken(token: string): Point['value'] {
  if (token.length === 0) throw new Error('Field value is empty');

  const lowered = token.toLowerCase();
  if (lowered === 'true' || lowered === 't') return true;
  if (lowered === 'false' || lowered === 'f') return false;

  if (token.startsWith('"')) {
    if (token.length < 2 || !token.endsWith('"')) throw new Error('String value quotes are unbalanced');
    return unescapeString(token.slice(1, -1));
  }

  if (token.endsWith('i')) {
    return parseIntegerLiteral(token.slice(0, -1));
  }
  // S8 protocol decision: integer text without a decimal point → i64
  if (/^[+-]?\d+$/.test(token)) return parseIntegerLiteral(token);

  const asNumber = Number(token);
  if (!Number.isFinite(asNumber)) throw new Error(`Failed to parse field value: ${token}`);
  return asNumber;
}

function parseIntegerLiteral(token: string): bigint {
  if (!/^[+-]?\d+$/.test(token)) throw new Error(`Invalid integer literal: ${token}`);
  return BigInt(token);
}

function parseNanosecondTimestamp(token: string): number {
  if (!/^[+-]?\d+$/.test(token)) throw new Error(`Invalid timestamp: ${token}`);
  const milliseconds = BigInt(token) / 1_000_000n;
  const asNumber = Number(milliseconds);
  if (!Number.isSafeInteger(asNumber)) throw new Error(`Timestamp exceeds the safe integer range: ${token}`);
  return asNumber;
}

function unescapeString(text: string): string {
  return text.replace(/\\(["\\])/g, '$1');
}
