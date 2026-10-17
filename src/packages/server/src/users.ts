// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Multi-user store (aligns with "Detailed Design v2.5" §3.2)
 *
 * A user is `{ username, role, passwordHash, enabled, createdAt, updatedAt }`: the role decides which scopes
 * (`query` / `write` / `admin`) the user's tokens may reach, and the password is stored only as a scrypt hash
 * (never in plaintext). Records live in one JSON file and are persisted atomically.
 *
 * Role → scope rights (the authoritative mapping also referenced by `auth.ts`):
 *   - `admin`    → query + write + admin (administers users and tokens)
 *   - `write`    → query + write
 *   - `readonly` → query
 */

import { hashPassword, verifyPasswordHash } from './auth.ts';
import { readJsonFile, writeJsonFileAtomic } from './json-file.ts';

/** User role constants (no enum; `as const` + literal union) */
export const USER_ROLE = {
  Admin: 'admin',
  Write: 'write',
  ReadOnly: 'readonly',
} as const;
export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE];

export function isUserRole(value: unknown): value is UserRole {
  return value === USER_ROLE.Admin || value === USER_ROLE.Write || value === USER_ROLE.ReadOnly;
}

/** One stored user record */
export interface UserRecord {
  username: string;
  role: UserRole;
  /** scrypt hash (`scrypt$N$r$p$salt$hash`); never exposed through the API */
  passwordHash: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
  /** Defaults to `true` (a newly created user is active) */
  enabled?: boolean;
}

export interface UpdateUserInput {
  role?: UserRole;
  password?: string;
  enabled?: boolean;
}

export interface UserStoreOptions {
  /** Absolute path of the JSON backing file */
  filePath: string;
}

/** In-memory user directory persisted to one JSON file (single process, synchronous IO like the rest of the server) */
export class UserStore {
  readonly filePath: string;
  private readonly records = new Map<string, UserRecord>();

  constructor(options: UserStoreOptions) {
    this.filePath = options.filePath;
  }

  /** Read the backing file into memory (a missing file starts empty); malformed entries are skipped, not fatal */
  load(): void {
    this.records.clear();
    for (const record of readUserRecordsFromJson(readJsonFile(this.filePath))) {
      this.records.set(record.username, record);
    }
  }

  /** All users, ascending by user name */
  list(): UserRecord[] {
    return [...this.records.values()].sort((left, right) => compareText(left.username, right.username));
  }

  get(username: string): UserRecord | null {
    return this.records.get(username) ?? null;
  }

  has(username: string): boolean {
    return this.records.has(username);
  }

  count(): number {
    return this.records.size;
  }

  /** Create a user (the caller must reject duplicates first); the password is hashed here and never retained */
  create(input: CreateUserInput): UserRecord {
    const now = Date.now();
    const record: UserRecord = {
      username: input.username,
      role: input.role,
      passwordHash: hashPassword(input.password),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.username, record);
    this.save();
    return record;
  }

  /** Apply a partial update (role / password / enabled); returns `null` when the user does not exist */
  update(username: string, patch: UpdateUserInput): UserRecord | null {
    const existing = this.records.get(username);
    if (existing === undefined) return null;
    const updated: UserRecord = {
      ...existing,
      role: patch.role ?? existing.role,
      passwordHash: patch.password === undefined ? existing.passwordHash : hashPassword(patch.password),
      enabled: patch.enabled ?? existing.enabled,
      updatedAt: Date.now(),
    };
    this.records.set(username, updated);
    this.save();
    return updated;
  }

  /** Remove a user; returns whether a record existed */
  remove(username: string): boolean {
    if (!this.records.delete(username)) return false;
    this.save();
    return true;
  }

  /**
   * Verify a user name + plaintext password: only an enabled user with a matching scrypt hash passes.
   * Returns the user record on success, `null` otherwise.
   */
  verify(username: string, password: string): UserRecord | null {
    const record = this.records.get(username);
    if (record === undefined || !record.enabled) return null;
    return verifyPasswordHash(password, record.passwordHash) ? record : null;
  }

  /** Persist the whole directory atomically */
  save(): void {
    writeJsonFileAtomic(this.filePath, { users: this.list() });
  }
}

/* ---------- Internal utilities ---------- */

function readUserRecordsFromJson(raw: unknown): UserRecord[] {
  if (!isPlainObject(raw)) return [];
  const users = raw.users;
  if (!Array.isArray(users)) return [];
  const records: UserRecord[] = [];
  for (const item of users) {
    const record = readUserRecord(item);
    if (record !== null) records.push(record);
  }
  return records;
}

/** Lenient single-record reader: structurally invalid entries are dropped rather than aborting the whole load */
function readUserRecord(value: unknown): UserRecord | null {
  if (!isPlainObject(value)) return null;
  const { username, role, passwordHash, enabled, createdAt, updatedAt } = value;
  if (typeof username !== 'string' || username.length === 0) return null;
  if (!isUserRole(role)) return null;
  if (typeof passwordHash !== 'string' || passwordHash.length === 0) return null;
  return {
    username,
    role,
    passwordHash,
    enabled: typeof enabled === 'boolean' ? enabled : true,
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
