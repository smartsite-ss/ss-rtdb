// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * API token store (aligns with "Detailed Design v2.5" §3.2)
 *
 * A token is issued once as plaintext and persisted only as a SHA-256 hash: `{ tokenId, user, role, tokenHash,
 * label, createdAt, expiresAt, revokedAt }`. The plaintext is returned to the caller exactly once (at issue time)
 * and is never written to disk, so a leaked store file cannot be replayed as a credential.
 *
 * `resolve(plaintext)` is the authentication hot path: it hashes the presented value, looks it up by index, and
 * rejects revoked or expired records.
 */

import { createHash, randomUUID } from 'node:crypto';

import { generateAuthToken } from './auth.ts';
import { readJsonFile, writeJsonFileAtomic } from './json-file.ts';
import { isUserRole } from './users.ts';
import type { UserRole } from './users.ts';

/** One stored token record (the hash is never exposed through the API) */
export interface TokenRecord {
  tokenId: string;
  /** Owner user name (for audit; the token's authority comes from `role`) */
  user: string;
  role: UserRole;
  /** SHA-256 hex of the plaintext token */
  tokenHash: string;
  label: string;
  createdAt: number;
  /** Absolute expiry timestamp (ms) or `null` for no expiry */
  expiresAt: number | null;
  /** Revocation timestamp (ms) or `null` when still valid */
  revokedAt: number | null;
}

export interface IssueTokenInput {
  user: string;
  role: UserRole;
  /** Free-form note (defaults to an empty string) */
  label?: string;
  /** Time to live in ms; omitted / `null` means the token never expires */
  ttlMs?: number | null;
}

/** Result of issuing a token: the plaintext (returned once) plus the persisted record */
export interface IssuedToken {
  token: string;
  record: TokenRecord;
}

export interface TokenStoreOptions {
  /** Absolute path of the JSON backing file */
  filePath: string;
}

/** In-memory token directory persisted to one JSON file */
export class TokenStore {
  readonly filePath: string;
  private readonly records = new Map<string, TokenRecord>();
  /** Hash → tokenId index for O(1) `resolve` */
  private readonly tokenIdByHash = new Map<string, string>();

  constructor(options: TokenStoreOptions) {
    this.filePath = options.filePath;
  }

  /** Read the backing file into memory (a missing file starts empty); malformed entries are skipped, not fatal */
  load(): void {
    this.records.clear();
    this.tokenIdByHash.clear();
    for (const record of readTokenRecordsFromJson(readJsonFile(this.filePath))) {
      this.records.set(record.tokenId, record);
      this.tokenIdByHash.set(record.tokenHash, record.tokenId);
    }
  }

  /**
   * Issue a new token: generate a random plaintext, persist only its hash, and return the plaintext **once**.
   * `ttlMs` (when a positive number) sets `expiresAt = now + ttlMs`; otherwise the token never expires.
   */
  issue(input: IssueTokenInput): IssuedToken {
    const token = generateAuthToken();
    const now = Date.now();
    const ttlMs = input.ttlMs === undefined || input.ttlMs === null ? null : input.ttlMs;
    const record: TokenRecord = {
      tokenId: randomUUID(),
      user: input.user,
      role: input.role,
      tokenHash: hashToken(token),
      label: input.label ?? '',
      createdAt: now,
      expiresAt: ttlMs === null ? null : now + ttlMs,
      revokedAt: null,
    };
    this.records.set(record.tokenId, record);
    this.tokenIdByHash.set(record.tokenHash, record.tokenId);
    this.save();
    return { token, record };
  }

  /** Revoke a token by id; returns whether the id existed (already-revoked tokens keep their first timestamp) */
  revoke(tokenId: string): boolean {
    const record = this.records.get(tokenId);
    if (record === undefined) return false;
    if (record.revokedAt === null) {
      record.revokedAt = Date.now();
      this.save();
    }
    return true;
  }

  /**
   * Revoke every still-active token of one user carrying the given label (used by the console sign-in to
   * enforce single-session semantics: a new login retires the previous `console login` tokens). Returns the
   * number of tokens revoked now (already-revoked ones keep their first timestamp and are not re-saved).
   */
  revokeActiveByLabel(user: string, label: string): number {
    const now = Date.now();
    let revokedCount = 0;
    for (const record of this.records.values()) {
      if (record.user !== user || record.label !== label || record.revokedAt !== null) continue;
      record.revokedAt = now;
      revokedCount += 1;
    }
    if (revokedCount > 0) this.save();
    return revokedCount;
  }

  /**
   * Resolve a presented plaintext token to its record; `null` when the token is unknown, revoked, or expired.
   * This is the authentication hot path and performs no allocation beyond one SHA-256 digest.
   */
  resolve(plaintext: string): TokenRecord | null {
    if (plaintext.length === 0) return null;
    const tokenId = this.tokenIdByHash.get(hashToken(plaintext));
    if (tokenId === undefined) return null;
    const record = this.records.get(tokenId);
    if (record === undefined || record.revokedAt !== null) return null;
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) return null;
    return record;
  }

  get(tokenId: string): TokenRecord | null {
    return this.records.get(tokenId) ?? null;
  }

  /** All tokens, ascending by creation time */
  list(): TokenRecord[] {
    return [...this.records.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  count(): number {
    return this.records.size;
  }

  /** Persist the whole directory atomically (token hashes only — plaintext is never written) */
  save(): void {
    writeJsonFileAtomic(this.filePath, { tokens: this.list() });
  }
}

/* ---------- Internal utilities ---------- */

/** SHA-256 hex of a plaintext token (the only representation ever persisted) */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

function readTokenRecordsFromJson(raw: unknown): TokenRecord[] {
  if (!isPlainObject(raw)) return [];
  const tokens = raw.tokens;
  if (!Array.isArray(tokens)) return [];
  const records: TokenRecord[] = [];
  for (const item of tokens) {
    const record = readTokenRecord(item);
    if (record !== null) records.push(record);
  }
  return records;
}

/** Lenient single-record reader: structurally invalid entries are dropped rather than aborting the whole load */
function readTokenRecord(value: unknown): TokenRecord | null {
  if (!isPlainObject(value)) return null;
  const { tokenId, user, role, tokenHash, label, createdAt, expiresAt, revokedAt } = value;
  if (typeof tokenId !== 'string' || tokenId.length === 0) return null;
  if (typeof tokenHash !== 'string' || tokenHash.length === 0) return null;
  if (!isUserRole(role)) return null;
  return {
    tokenId,
    user: typeof user === 'string' ? user : '',
    role,
    tokenHash,
    label: typeof label === 'string' ? label : '',
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
    revokedAt: typeof revokedAt === 'number' ? revokedAt : null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
