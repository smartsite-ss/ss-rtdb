// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Authentication (aligns with "Detailed Design v2.5" §3.2 / §6.2.4)
 *
 * `mode` ∈ `token` | `basic` | `both`: token uses `Authorization: Bearer <token>`,
 * basic uses `Authorization: Basic base64(username:password)`, both = either passes.
 * Passwords are stored only as scrypt hashes (`scrypt$N$r$p$salt$hash`), never in plaintext; when the token is missing it is generated automatically on first start and written to tokenFile (0600).
 * Write / query endpoints are controlled by the `write` / `query` switches respectively; `GET /status` is always exempt from authentication (scope = `none`).
 *
 * Multi-user extension (§3.2): a bearer token may also be an **API token** (minted through the admin API and
 * resolved from the injected `TokenStore`) instead of the single static `auth.token`. The resolved identity is
 * an `AuthPrincipal` carrying a **role** that maps to scopes: `admin` → query + write + admin, `write` →
 * query + write, `readonly` → query. The static `auth.token` and the basic credentials always act as `admin`
 * (backward compatible with the token / basic single-account modes).
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { IncomingHttpHeaders } from 'node:http';

import { ERROR_CODE, RtdbError } from '../../core/src/errors.ts';
import type { Logger } from './logger.ts';
import type { TokenStore } from './tokens.ts';
import type { UserRole } from './users.ts';

/** Authentication mode constants (no enum; use `as const` + literal union) */
export const AUTH_MODE = {
  Token: 'token',
  Basic: 'basic',
  Both: 'both',
} as const;
export type AuthMode = (typeof AUTH_MODE)[keyof typeof AUTH_MODE];

/** Authentication scope: `write` / `query` = data endpoints, `admin` = user / token management, `none` = always exempt */
export type AuthScope = 'write' | 'query' | 'admin' | 'none';

/** Where a verified principal came from (audit + diagnostics) */
export type AuthSource = 'config-token' | 'token' | 'basic';

/** A verified caller identity: the user name, its role, and the credential source */
export interface AuthPrincipal {
  username: string;
  role: UserRole;
  source: AuthSource;
}

/** Role → allowed scopes (the single source of truth for RBAC; kept in sync with `users.ts` `USER_ROLE`) */
const ROLE_SCOPE_RIGHTS: Readonly<Record<UserRole, readonly AuthScope[]>> = {
  admin: ['query', 'write', 'admin'],
  write: ['query', 'write'],
  readonly: ['query'],
};

export function isAuthMode(value: unknown): value is AuthMode {
  return value === 'token' || value === 'basic' || value === 'both';
}

/* ---------- Password hashing (scrypt) ---------- */

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_BYTES = 64;
/** scrypt memory cap: 128 * N * r ≈ 16MB, ample headroom */
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

/** Generate a password hash in the format `scrypt$N$r$p$saltHex$hashHex` (§6.2.4 `auth.passwordHash`) */
export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const derived = scryptSync(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return [
    'scrypt',
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/** Verify that a plaintext password matches the hash (constant-time comparison) */
export function verifyPasswordHash(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelization)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = scryptSync(password, salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ---------- Token generation and loading ---------- */

/** Generate a 32-byte (64 hex digits) random token; §6.2.4 requires ≥16 characters */
export function generateAuthToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Read or generate a token on first start: return `auth.token` directly if non-empty; otherwise read `tokenFile`;
 * otherwise generate one and write it to `tokenFile` (the parent directory is created if missing; 0600 is attempted, and failures are ignored on Windows where POSIX permission bits are unavailable).
 */
export function loadOrCreateAuthToken(tokenFile: string, logger: Logger): string {
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const generated = generateAuthToken();
  try {
    const parentDirectory = dirname(tokenFile);
    if (parentDirectory.length > 0 && !existsSync(parentDirectory)) {
      mkdirSync(parentDirectory, { recursive: true });
    }
    writeFileSync(tokenFile, `${generated}\n`, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
  } catch (error) {
    throw new RtdbError(
      ERROR_CODE.Auth,
      `Failed to write token file: ${tokenFile} (${(error as Error).message})`,
    );
  }
  logger.warn(`Authentication is enabled but no token is configured; one was generated automatically and written to ${tokenFile} (store it safely, permissions 0600)`);
  return generated;
}

/* ---------- Verifiers ---------- */

export interface AuthVerifierOptions {
  enabled: boolean;
  mode: AuthMode;
  /** Resolved token (may come from auth.token or tokenFile) */
  token: string;
  username: string;
  /** scrypt hash; an empty string means not configured (basic unavailable) */
  passwordHash: string;
  /** Whether write endpoints require authentication */
  write: boolean;
  /** Whether read endpoints require authentication */
  query: boolean;
  /** API token directory (multi-user mode); `null` disables dynamic-token resolution */
  tokenStore?: TokenStore | null;
}

export class AuthVerifier {
  readonly enabled: boolean;
  readonly mode: AuthMode;
  readonly writeProtected: boolean;
  readonly queryProtected: boolean;

  private readonly token: string;
  private readonly username: string;
  private readonly passwordHash: string;
  private readonly tokenStore: TokenStore | null;

  constructor(options: AuthVerifierOptions) {
    this.enabled = options.enabled;
    this.mode = options.mode;
    this.writeProtected = options.write;
    this.queryProtected = options.query;
    this.token = options.token;
    this.username = options.username;
    this.passwordHash = options.passwordHash;
    this.tokenStore = options.tokenStore ?? null;
  }

  /**
   * Whether a scope requires a credential at all: `none` and a disabled authenticator never do; `write` /
   * `query` follow their switches; `admin` is **always** protected once authentication is enabled.
   */
  isScopeProtected(scope: AuthScope): boolean {
    if (scope === 'none' || !this.enabled) return false;
    if (scope === 'admin') return true;
    if (scope === 'write') return this.writeProtected;
    return this.queryProtected;
  }

  /** Whether a role is granted a scope (RBAC lookup) */
  roleAllows(role: UserRole, scope: AuthScope): boolean {
    if (scope === 'none') return true;
    return ROLE_SCOPE_RIGHTS[role].includes(scope);
  }

  /**
   * Resolve the caller identity from the `Authorization` header.
   *
   * Returns `null` when the credential is missing / unrecognized; when authentication is disabled it returns the
   * disabled-mode principal (role `admin`) so callers always have a principal to log. The static `auth.token` and
   * the basic credentials resolve to role `admin`; a dynamic API token resolves to its stored `{ user, role }`.
   */
  authenticate(headers: IncomingHttpHeaders): AuthPrincipal | null {
    if (!this.enabled) return { username: this.username, role: 'admin', source: 'config-token' };

    const header = readAuthorizationHeader(headers);
    if (header === null) return null;
    const { scheme, credentials } = splitAuthorization(header);

    if ((this.mode === 'token' || this.mode === 'both') && scheme === 'bearer' && credentials.length > 0) {
      if (this.token.length > 0 && constantTimeEquals(credentials, this.token)) {
        return { username: this.username, role: 'admin', source: 'config-token' };
      }
      const resolved = this.tokenStore === null ? null : this.tokenStore.resolve(credentials);
      if (resolved !== null) {
        return { username: resolved.user, role: resolved.role, source: 'token' };
      }
    }
    if ((this.mode === 'basic' || this.mode === 'both') && scheme === 'basic' && this.matchesCredentials(credentials)) {
      return { username: this.username, role: 'admin', source: 'basic' };
    }
    return null;
  }

  /**
   * Whether to allow: `scope=none` or an unprotected scope always passes; otherwise the caller must present an
   * accepted credential whose role grants the scope.
   */
  authorize(headers: IncomingHttpHeaders, scope: AuthScope): boolean {
    if (!this.isScopeProtected(scope)) return true;
    const principal = this.authenticate(headers);
    return principal !== null && this.roleAllows(principal.role, scope);
  }

  private matchesCredentials(encoded: string): boolean {
    if (this.passwordHash.length === 0) return false;
    const decoded = decodeBase64(encoded);
    if (decoded === null) return false;
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (!constantTimeEquals(username, this.username)) return false;
    return verifyPasswordHash(password, this.passwordHash);
  }
}

/* ---------- Internal utilities ---------- */

function readAuthorizationHeader(headers: IncomingHttpHeaders): string | null {
  const raw = headers.authorization;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

function splitAuthorization(header: string): { scheme: string; credentials: string } {
  const spaceIndex = header.indexOf(' ');
  if (spaceIndex < 0) return { scheme: header.trim().toLowerCase(), credentials: '' };
  return {
    scheme: header.slice(0, spaceIndex).trim().toLowerCase(),
    credentials: header.slice(spaceIndex + 1).trim(),
  };
}

function decodeBase64(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return decoded.length === 0 ? null : decoded;
  } catch {
    return null;
  }
}

/** Constant-time string comparison (returns false immediately on length mismatch to avoid `timingSafeEqual` throwing) */
function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
