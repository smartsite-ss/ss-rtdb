// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Minimal bounded-concurrency helper for the console (no dependency by design).
 *
 * The metric inventory needs one `query/last` request per metric; firing hundreds at once would exhaust the
 * browser's connection pool and starve the rest of the page, so the refresh runs through this worker pool.
 */

/**
 * Run `worker` over every item with at most `limit` calls in flight.
 *
 * Order is not preserved: the caller writes into a result map keyed by the item (which is what the panel needs).
 * A rejected worker rejects the whole run — wrap it in the caller when per-item failures should be tolerated.
 */
export async function mapWithLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const effectiveLimit = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let index = 0; index < effectiveLimit; index += 1) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const item = items[cursor];
          cursor += 1;
          await worker(item);
        }
      })(),
    );
  }
  await Promise.all(runners);
}
