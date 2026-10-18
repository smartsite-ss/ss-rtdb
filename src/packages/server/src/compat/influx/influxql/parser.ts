// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxQL compatibility: read-only subset parser
 *
 * Supported (see the HTTP interface design §6.9):
 *   SELECT <fields|*|fn(field)> FROM <measurement>
 *     [WHERE time <op> <time> [AND tag = 'v']...] [GROUP BY time(<duration>)[, tag...] [fill(...)]]
 *     [ORDER BY time ASC|DESC] [LIMIT n] [OFFSET n]
 *   SHOW DATABASES | MEASUREMENTS [ON db] | TAG KEYS [FROM m] | TAG VALUES [FROM m] WITH KEY = "k"
 *        | FIELD KEYS [FROM m] | RETENTION POLICIES [ON db]
 *
 * Everything else (Flux-like transforms, multiple measurements, OR, regex, subqueries, INTO, DELETE/DROP)
 * is rejected with an explicit 4xx/501 instead of being silently ignored.
 */

import { InfluxCompatError } from '../errors.ts';
import { tokenize } from './lexer.ts';
import type { Token } from './lexer.ts';
import { durationToMs } from './lexer.ts';

export type AggregateFunction = 'mean' | 'sum' | 'count' | 'min' | 'max' | 'first' | 'last';

export interface FieldSpec {
  star: boolean;
  name: string | null;
  fn: AggregateFunction | null;
}

export interface TimePredicate {
  /** Lower bound in ms; null = resolved from the data (earliest point) */
  start: number | null;
  /** Upper bound in ms; null = now at execution time */
  end: number | null;
}

export interface TagFilter {
  key: string;
  value: string;
  negated: boolean;
}

export type FillMode = 'none' | 'null' | 'zero' | 'previous';

export interface GroupByClause {
  windowMs: number | null;
  tags: string[];
  fill: FillMode;
}

export interface SelectStatement {
  kind: 'select';
  fields: FieldSpec[];
  measurement: string;
  time: TimePredicate;
  tags: TagFilter[];
  group: GroupByClause;
  order: 'asc' | 'desc' | null;
  limit: number | null;
  offset: number | null;
}

export type ShowKind =
  | 'databases'
  | 'measurements'
  | 'tag-keys'
  | 'tag-values'
  | 'field-keys'
  | 'retention-policies';

export interface ShowStatement {
  kind: 'show';
  show: ShowKind;
  database: string | null;
  measurement: string | null;
  tagKey: string | null;
}

export type InfluxStatement = SelectStatement | ShowStatement;

const AGGREGATE_FUNCTIONS: readonly AggregateFunction[] = ['mean', 'sum', 'count', 'min', 'max', 'first', 'last'];

export function parseInfluxQL(text: string): InfluxStatement {
  const parser = new Parser(tokenize(text));
  const statement = parser.parseStatement();
  parser.expectEnd();
  return statement;
}

class Parser {
  private index = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  parseStatement(): InfluxStatement {
    const token = this.peek();
    if (token.type === 'ident' && !token.quoted) {
      const keyword = token.value.toLowerCase();
      if (keyword === 'select') return this.parseSelect();
      if (keyword === 'show') return this.parseShow();
    }
    throw unsupported(`Unsupported statement: ${token.value || token.type}`);
  }

  expectEnd(): void {
    const token = this.peek();
    if (token.type === 'punct' && token.value === ';') {
      this.next();
      if (this.peek().type === 'eof') return;
      throw unsupported('Multiple statements are not supported');
    }
    if (token.type !== 'eof') throw invalid(`Unexpected token: ${describe(token)}`);
  }

  /* ---------- SELECT ---------- */

  private parseSelect(): SelectStatement {
    this.expectKeyword('select');
    const fields = this.parseFieldList();
    this.expectKeyword('from');
    const measurement = this.expectIdentifier('measurement');
    if (this.peekPunct(',')) throw unsupported('Multiple measurements are not supported');

    const time: TimePredicate = { start: null, end: null };
    const tags: TagFilter[] = [];
    const group: GroupByClause = { windowMs: null, tags: [], fill: 'null' };
    let order: 'asc' | 'desc' | null = null;
    let limit: number | null = null;
    let offset: number | null = null;

    if (this.consumeKeyword('where')) this.parseWhere(time, tags);

    if (this.consumeKeyword('group')) {
      this.expectKeyword('by');
      this.parseGroupBy(group);
    }
    if (this.consumeKeyword('order')) {
      this.expectKeyword('by');
      const column = this.expectIdentifier('order column');
      if (column.toLowerCase() !== 'time') throw unsupported(`ORDER BY ${column} is not supported (only time)`);
      order = 'asc';
      if (this.consumeKeyword('desc')) order = 'desc';
      else this.consumeKeyword('asc');
    }
    while (true) {
      if (this.consumeKeyword('limit')) limit = this.expectInteger('limit');
      else if (this.consumeKeyword('offset')) offset = this.expectInteger('offset');
      else if (this.consumeKeyword('slimit') || this.consumeKeyword('soffset')) {
        throw unsupported('SLIMIT/SOFFSET are not supported');
      } else break;
    }
    if (limit !== null && limit <= 0) throw invalid('LIMIT must be a positive integer');
    if (offset !== null && offset < 0) throw invalid('OFFSET must be >= 0');

    return { kind: 'select', fields, measurement, time, tags, group, order, limit, offset };
  }

  private parseFieldList(): FieldSpec[] {
    const fields: FieldSpec[] = [];
    while (true) {
      const token = this.peek();
      if (token.type === 'punct' && token.value === '*') {
        this.next();
        fields.push({ star: true, name: null, fn: null });
      } else {
        const name = this.expectIdentifier('field');
        if (this.consumePunct('(')) {
          const fn = name.toLowerCase() as AggregateFunction;
          if (!AGGREGATE_FUNCTIONS.includes(fn)) {
            throw unsupported(`Unsupported function: ${name}`);
          }
          if (this.consumePunct('*')) {
            fields.push({ star: true, name: null, fn });
          } else {
            fields.push({ star: false, name: this.expectIdentifier('field'), fn });
          }
          this.expectPunct(')');
        } else {
          fields.push({ star: false, name, fn: null });
        }
      }
      if (!this.consumePunct(',')) break;
    }
    if (fields.length === 0) throw invalid('SELECT requires at least one field');
    return fields;
  }

  private parseWhere(time: TimePredicate, tags: TagFilter[]): void {
    while (true) {
      const name = this.expectIdentifier('condition column');
      const column = name.toLowerCase();
      if (this.peek().type === 'regex') throw unsupported('Regular expressions are not supported');
      if (this.peek().type === 'ident' && this.peek().value.toLowerCase() === 'in') {
        throw unsupported('IN conditions are not supported');
      }
      const operator = this.expectOperator();
      if (column === 'time') {
        const value = this.parseTimeOperand();
        if (operator === '>=') time.start = value;
        else if (operator === '>') time.start = value + 1;
        else if (operator === '<=') time.end = value;
        else if (operator === '<') time.end = value - 1;
        else if (operator === '=') {
          time.start = value;
          time.end = value;
        } else throw unsupported(`Unsupported time operator: ${operator}`);
      } else {
        if (operator !== '=' && operator !== '!=') {
          throw unsupported(`Unsupported tag operator: ${operator} (only = and !=)`);
        }
        const valueToken = this.next();
        if (valueToken.type !== 'string') throw invalid(`Tag filter for ${name} expects a quoted string`);
        tags.push({ key: name, value: valueToken.value, negated: operator === '!=' });
      }
      if (this.consumeKeyword('and')) continue;
      if (this.consumeKeyword('or')) throw unsupported('OR conditions are not supported');
      break;
    }
  }

  private parseTimeOperand(): number {
    const token = this.next();
    let value: number;
    if (token.type === 'string') {
      const parsed = Date.parse(token.value);
      if (!Number.isFinite(parsed)) throw invalid(`Invalid RFC3339 timestamp: ${token.value}`);
      value = parsed;
    } else if (token.type === 'number') {
      const numeric = Number(token.value);
      if (!Number.isFinite(numeric)) throw invalid(`Invalid timestamp literal: ${token.value}`);
      value = Math.floor(numeric / 1e6);
    } else if (token.type === 'ident' && !token.quoted) {
      if (token.value.toLowerCase() !== 'now') throw invalid(`Unsupported time expression: ${token.value}`);
      this.expectPunct('(');
      this.expectPunct(')');
      value = Date.now();
    } else {
      throw invalid(`Unsupported time operand: ${describe(token)}`);
    }
    // Optional `+ <duration>` / `- <duration>`
    while (this.peek().type === 'punct' && (this.peek().value === '+' || this.peek().value === '-')) {
      const sign = this.next().value === '-' ? -1 : 1;
      const duration = this.next();
      if (duration.type !== 'duration') throw invalid(`Duration expected after ${sign > 0 ? '+' : '-'}`);
      value += sign * durationToMs(duration.value);
    }
    return value;
  }

  private parseGroupBy(group: GroupByClause): void {
    while (true) {
      if (this.consumeKeyword('time')) {
        this.expectPunct('(');
        const duration = this.next();
        if (duration.type !== 'duration') throw invalid('GROUP BY time() expects a duration');
        this.expectPunct(')');
        group.windowMs = durationToMs(duration.value);
      } else if (this.consumeKeyword('fill')) {
        this.expectPunct('(');
        const mode = this.next();
        const normalized =
          mode.type === 'number' && mode.value === '0'
            ? 'zero'
            : mode.type === 'ident' && !mode.quoted
              ? mode.value.toLowerCase()
              : '';
        if (normalized !== 'none' && normalized !== 'null' && normalized !== 'zero' && normalized !== 'previous') {
          throw unsupported(`Unsupported fill mode: ${mode.value}`);
        }
        group.fill = normalized;
        this.expectPunct(')');
      } else {
        group.tags.push(this.expectIdentifier('tag'));
      }
      if (this.consumePunct(',')) continue;
      // `fill(...)` follows the time() item without a comma in InfluxQL
      const next = this.peek();
      if (next.type === 'ident' && !next.quoted && next.value.toLowerCase() === 'fill') continue;
      break;
    }
  }

  /* ---------- SHOW ---------- */

  private parseShow(): ShowStatement {
    this.expectKeyword('show');
    const keyword = this.expectKeywordValue();
    const statement: ShowStatement = {
      kind: 'show',
      show: 'databases',
      database: null,
      measurement: null,
      tagKey: null,
    };
    switch (keyword) {
      case 'databases':
        statement.show = 'databases';
        return statement;
      case 'measurements':
        statement.show = 'measurements';
        if (this.consumeKeyword('on')) statement.database = this.expectIdentifier('database');
        if (this.peek().type === 'ident' && this.peek().value.toLowerCase() === 'with') {
          throw unsupported('SHOW MEASUREMENTS WITH ... is not supported');
        }
        return statement;
      case 'tag': {
        const next = this.expectKeywordValue();
        if (next !== 'keys' && next !== 'values') throw unsupported(`SHOW TAG ${next} is not supported`);
        statement.show = next === 'keys' ? 'tag-keys' : 'tag-values';
        if (this.consumeKeyword('from')) statement.measurement = this.expectIdentifier('measurement');
        if (this.consumeKeyword('with')) {
          this.expectKeyword('key');
          this.expectOperator('=');
          // InfluxQL documents `WITH KEY = "host"` (double quotes); accept single-quoted literals too.
          const keyToken = this.next();
          if (keyToken.type !== 'string' && !(keyToken.type === 'ident' && keyToken.quoted)) {
            throw invalid(`Expected a quoted tag key but found ${describe(keyToken)}`);
          }
          statement.tagKey = keyToken.value;
        }
        if (statement.show === 'tag-values' && statement.tagKey === null) {
          throw invalid('SHOW TAG VALUES requires WITH KEY = "..."');
        }
        return statement;
      }
      case 'field': {
        const next = this.expectKeywordValue();
        if (next !== 'keys') throw unsupported(`SHOW FIELD ${next} is not supported`);
        statement.show = 'field-keys';
        if (this.consumeKeyword('from')) statement.measurement = this.expectIdentifier('measurement');
        return statement;
      }
      case 'retention': {
        const next = this.expectKeywordValue();
        if (next !== 'policies') throw unsupported(`SHOW RETENTION ${next} is not supported`);
        statement.show = 'retention-policies';
        if (this.consumeKeyword('on')) statement.database = this.expectIdentifier('database');
        return statement;
      }
      default:
        throw unsupported(`SHOW ${keyword} is not supported`);
    }
  }

  /* ---------- token helpers ---------- */

  private peek(): Token {
    return this.tokens[Math.min(this.index, this.tokens.length - 1)];
  }

  private next(): Token {
    const token = this.peek();
    if (token.type !== 'eof') this.index += 1;
    return token;
  }

  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token.type === 'punct' && token.value === value;
  }

  private consumePunct(value: string): boolean {
    if (!this.peekPunct(value)) return false;
    this.next();
    return true;
  }

  private expectPunct(value: string): void {
    if (!this.consumePunct(value)) throw invalid(`Expected "${value}" but found ${describe(this.peek())}`);
  }

  private consumeKeyword(value: string): boolean {
    const token = this.peek();
    if (token.type !== 'ident' || token.quoted || token.value.toLowerCase() !== value) return false;
    this.next();
    return true;
  }

  private expectKeyword(value: string): void {
    if (!this.consumeKeyword(value)) throw invalid(`Expected "${value}" but found ${describe(this.peek())}`);
  }

  private expectKeywordValue(): string {
    const token = this.next();
    if (token.type !== 'ident' || token.quoted) throw invalid(`Keyword expected but found ${describe(token)}`);
    return token.value.toLowerCase();
  }

  private expectIdentifier(label: string): string {
    const token = this.next();
    if (token.type !== 'ident') throw invalid(`Expected ${label} but found ${describe(token)}`);
    if (token.value.length === 0) throw invalid(`Empty ${label}`);
    return token.value;
  }

  private expectInteger(label: string): number {
    const token = this.next();
    if (token.type !== 'number' || !/^\d+$/.test(token.value)) {
      throw invalid(`Expected integer for ${label} but found ${describe(token)}`);
    }
    return Number(token.value);
  }

  private expectOperator(only?: string): string {
    const token = this.next();
    if (only !== undefined) {
      if (token.type !== 'punct' || token.value !== only) throw invalid(`Expected "${only}"`);
      return only;
    }
    if (token.type !== 'punct' || !['=', '!=', '>', '>=', '<', '<='].includes(token.value)) {
      throw unsupported(`Unsupported operator: ${describe(token)}`);
    }
    return token.value;
  }
}

function describe(token: Token): string {
  if (token.type === 'eof') return 'end of query';
  return `"${token.value}"`;
}

function invalid(message: string): InfluxCompatError {
  return new InfluxCompatError({ status: 400, code: 'invalid', message });
}

function unsupported(message: string): InfluxCompatError {
  return new InfluxCompatError({
    status: 501,
    code: 'not implemented',
    message,
    hint: 'Supported subset: SELECT ... FROM <measurement> [WHERE time ...] [GROUP BY time(...)] [LIMIT/OFFSET], SHOW DATABASES/MEASUREMENTS/TAG KEYS/TAG VALUES/FIELD KEYS/RETENTION POLICIES',
  });
}
