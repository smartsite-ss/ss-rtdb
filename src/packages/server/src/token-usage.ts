// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Per-token usage statistics for `GET /api/v1/admin/tokens`.
 *
 * A token is a server-side credential, not a session: closing the client cannot notify the server, so the
 * token stays valid until it is revoked or expires. What the console *can* show is whether the token is still
 * being used — the last authenticated request, the last database it touched, and a short write-rate window
 * (points/s + payload bytes/s). All of it is process-local: a restart resets the numbers, and nothing is
 * written into the token store (which keeps hashes and lifecycle timestamps only).
 */

/** Rolling window used for the write rates */
const RATE_WINDOW_SECONDS = 10;

interface RateBucket {
  points: number;
  bytes: number;
}

interface UsageEntry {
  lastUsedAt: number | null;
  lastDatabase: string | null;
  /** Epoch second → write counters inside the rolling window */
  buckets: Map<number, RateBucket>;
}

/** What the admin API adds to each token record */
export interface TokenUsageSnapshot {
  /** Timestamp (ms) of the last authenticated request, `null` when the token has never been used */
  lastUsedAt: number | null;
  /** Database of the last request that carried one, `null` when only admin endpoints were used */
  lastDatabase: string | null;
  /** Accepted points per second over the rolling window */
  pointsPerSec: number;
  /** Request payload bytes per second over the rolling window */
  bytesPerSec: number;
}

function emptySnapshot(): TokenUsageSnapshot {
  return { lastUsedAt: null, lastDatabase: null, pointsPerSec: 0, bytesPerSec: 0 };
}

export class TokenUsageTracker {
  private readonly entries = new Map<string, UsageEntry>();

  /**
   * Record an authenticated request. `database` is `null` for endpoints that do not address one (token /
   * user administration); such a request still refreshes `lastUsedAt` but keeps the previous database.
   */
  touch(tokenId: string | undefined, database: string | null, now: number = Date.now()): void {
    if (tokenId === undefined || tokenId.length === 0) return;
    const entry = this.entryOf(tokenId);
    entry.lastUsedAt = now;
    if (database !== null && database.length > 0) entry.lastDatabase = database;
  }

  /** Record an accepted write; `bytes` is the request payload size */
  recordWrite(
    tokenId: string | undefined,
    points: number,
    bytes: number,
    database: string | null,
    now: number = Date.now(),
  ): void {
    if (tokenId === undefined || tokenId.length === 0) return;
    const entry = this.entryOf(tokenId);
    entry.lastUsedAt = now;
    if (database !== null && database.length > 0) entry.lastDatabase = database;

    const second = Math.floor(now / 1000);
    const bucket = entry.buckets.get(second) ?? { points: 0, bytes: 0 };
    bucket.points += points;
    bucket.bytes += bytes;
    entry.buckets.set(second, bucket);
    this.trim(entry, second);
  }

  /** Current snapshot; unknown tokens report zeros */
  snapshot(tokenId: string, now: number = Date.now()): TokenUsageSnapshot {
    const entry = this.entries.get(tokenId);
    if (entry === undefined) return emptySnapshot();

    const second = Math.floor(now / 1000);
    this.trim(entry, second);

    let points = 0;
    let bytes = 0;
    let oldestSecond = second;
    for (const [bucketSecond, bucket] of entry.buckets) {
      points += bucket.points;
      bytes += bucket.bytes;
      if (bucketSecond < oldestSecond) oldestSecond = bucketSecond;
    }
    // Divide by the seconds actually covered so a burst seen in a single second is not diluted by the
    // full window length; a quiet token decays back to zero within one window.
    const coveredSeconds = Math.max(1, second - oldestSecond + 1);
    return {
      lastUsedAt: entry.lastUsedAt,
      lastDatabase: entry.lastDatabase,
      pointsPerSec: points / coveredSeconds,
      bytesPerSec: bytes / coveredSeconds,
    };
  }

  private entryOf(tokenId: string): UsageEntry {
    const existing = this.entries.get(tokenId);
    if (existing !== undefined) return existing;
    const created: UsageEntry = { lastUsedAt: null, lastDatabase: null, buckets: new Map() };
    this.entries.set(tokenId, created);
    return created;
  }

  private trim(entry: UsageEntry, currentSecond: number): void {
    const oldestAllowed = currentSecond - RATE_WINDOW_SECONDS + 1;
    for (const bucketSecond of entry.buckets.keys()) {
      if (bucketSecond < oldestAllowed) entry.buckets.delete(bucketSecond);
    }
  }
}
