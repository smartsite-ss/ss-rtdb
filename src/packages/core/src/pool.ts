// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Buffer pool: reuses `ArrayBuffer` in power-of-two size classes (aligned with Detailed Design v1.8 §2.3, §2.6)
 *
 * Motivation (TS Weakness Analysis and Mitigation W7): Node off-heap memory (`ArrayBuffer`) is not
 * reclaimed promptly by the GC; on the hot path (block encoding → segment append), allocating once per
 * block would keep raising the `external` watermark. This module replaces "allocate once per block" with
 * "reuse by size class" and provides an **explicit lifecycle** (`acquire` / `release` / `dispose`).
 *
 * Size class scope: capacity = the requested length rounded up to a power of two, falling within
 *   `[minClassBytes, maxClassBytes]`; any request larger than `maxClassBytes` is **never pooled** (direct
 *   allocation, discarded on return), preventing the pool from holding huge buffers for long.
 *
 * Return scope (to prevent dangling references):
 *   - Only an `ArrayBuffer` **lent out by this pool** can be returned — lent-out objects are registered in
 *     a `WeakSet`, and `release` unregisters first, then pools; foreign objects and duplicate returns are
 *     rejected in place (returns false, throws nothing, changes no stats)
 *   - The returned view may be **any subview** of the lent view (the underlying `ArrayBuffer` is still
 *     whole; the pool reclaims by capacity class only)
 *   - After return, the same `ArrayBuffer` may be lent out again, so the caller **must not use the view
 *     after release**
 *   - The number of cached buffers per class is bounded by `maxBuffersPerClass`; when full, they are
 *     discarded (does not block the caller)
 */

import { ERROR_CODE, RtdbError } from './errors.ts';

/* ---------- Defaults and clamps ---------- */

/** Buffer pool defaults (internal module, not part of the engine config table §6.2) */
export const BUFFER_POOL_DEFAULTS = {
  minClassBytes: 4_096,
  maxClassBytes: 4_194_304,
  maxBuffersPerClass: 64,
} as const;

/** Buffer pool container-level clamps (out-of-range clamped to boundary, startup not blocked; same scope as `clampEngineOption`) */
export const BUFFER_POOL_CLAMPS = {
  minClassBytes: { min: 256, max: 67_108_864 },
  maxClassBytes: { min: 256, max: 67_108_864 },
  maxBuffersPerClass: { min: 1, max: 4_096 },
} as const;

/* ---------- Public types ---------- */

export interface BufferPoolOptions {
  /** Minimum size-class capacity (bytes), default 4096, clamped 256 ~ `maxClassBytes`; small blocks are all allocated in this class */
  minClassBytes?: number;
  /** Maximum size-class capacity (bytes), default 4MB, clamped `minClassBytes` ~ 64MB; larger ones are not pooled */
  maxClassBytes?: number;
  /** Max cached buffers per class, default 64, clamped 1~4096 */
  maxBuffersPerClass?: number;
}

export interface BufferPoolStats {
  /** Net allocations that missed the pool (including over-limit direct allocations) */
  allocatedBuffers: number;
  /** Reuse count that hit the pool */
  reusedBuffers: number;
  /** Number of returns successfully pooled */
  releasedBuffers: number;
  /** Number of returns discarded (over-limit direct allocation / class full / pool disposed) */
  discardedBuffers: number;
  /** Number of buffers lent out but not yet returned */
  outstandingBuffers: number;
  /** Current number of cached buffers in the pool */
  pooledBuffers: number;
  /** Current number of cached bytes in the pool */
  pooledBytes: number;
  /** Whether the pool is disposed (no further acquire after disposal) */
  disposed: boolean;
}

/* ---------- Buffer pool ---------- */

export class BufferPool {
  /** Effective minimum size-class capacity (clamped) */
  readonly minClassBytes: number;
  /** Effective maximum size-class capacity (clamped, and not less than `minClassBytes`) */
  readonly maxClassBytes: number;
  /** Effective max cached buffers per class (clamped) */
  readonly maxBuffersPerClass: number;

  /** Free buffers per size class (key = size-class capacity in bytes) */
  private readonly freeByClass = new Map<number, ArrayBuffer[]>();
  /** Lent-out registry: only a registered `ArrayBuffer` may be returned (weak references, does not prevent collection) */
  private readonly handedOutBuffers = new WeakSet<ArrayBuffer>();

  private allocatedBuffers = 0;
  private reusedBuffers = 0;
  private releasedBuffers = 0;
  private discardedBuffers = 0;
  private outstandingBuffers = 0;
  private pooledBuffers = 0;
  private pooledBytes = 0;
  private disposed = false;

  constructor(options: BufferPoolOptions = {}) {
    const maxClassBytes = clampPoolOption(
      'maxClassBytes',
      options.maxClassBytes ?? BUFFER_POOL_DEFAULTS.maxClassBytes,
    );
    this.maxClassBytes = maxClassBytes;
    this.minClassBytes = Math.min(
      clampPoolOption('minClassBytes', options.minClassBytes ?? BUFFER_POOL_DEFAULTS.minClassBytes),
      maxClassBytes,
    );
    this.maxBuffersPerClass = clampPoolOption(
      'maxBuffersPerClass',
      options.maxBuffersPerClass ?? BUFFER_POOL_DEFAULTS.maxBuffersPerClass,
    );
  }

  /* ---------- Lifecycle ---------- */

  /**
   * Acquire a view whose length is exactly `byteLength` (the underlying capacity is a power-of-two size
   * class, ≥ `byteLength`)
   *
   * The returned view's `byteLength` is exactly the requested length (can be used directly as a write
   * length); an empty request returns an empty view and is not counted in stats.
   */
  acquire(byteLength: number): Uint8Array {
    if (this.disposed) {
      throw new RtdbError(ERROR_CODE.Internal, 'Buffer pool is disposed; no further buffers can be acquired');
    }
    if (!Number.isInteger(byteLength) || byteLength < 0) {
      throw new RtdbError(ERROR_CODE.Internal, `Illegal buffer acquire length: ${String(byteLength)}`);
    }
    if (byteLength === 0) return new Uint8Array(0);

    // Over-limit request: direct allocation, not pooled (treated as discarded on return)
    if (byteLength > this.maxClassBytes) {
      const directBuffer = new ArrayBuffer(byteLength);
      this.handedOutBuffers.add(directBuffer);
      this.allocatedBuffers += 1;
      this.outstandingBuffers += 1;
      return new Uint8Array(directBuffer);
    }

    const classBytes = nextPowerOfTwo(byteLength, this.minClassBytes);
    const freeList = this.freeByClass.get(classBytes);
    let buffer: ArrayBuffer;
    if (freeList !== undefined && freeList.length > 0) {
      buffer = freeList[freeList.length - 1];
      freeList.pop();
      this.reusedBuffers += 1;
      this.pooledBuffers -= 1;
      this.pooledBytes -= classBytes;
    } else {
      buffer = new ArrayBuffer(classBytes);
      this.allocatedBuffers += 1;
    }
    this.handedOutBuffers.add(buffer);
    this.outstandingBuffers += 1;
    return new Uint8Array(buffer, 0, byteLength);
  }

  /**
   * Return a buffer: returns true if successfully pooled, false in the following cases (rejected in place,
   * throws nothing)
   *   - An object not lent out by this pool (or a duplicate return)
   *   - The size class is already full
   *   - A buffer from an over-limit direct allocation (never pooled anyway)
   *   - The pool is disposed
   */
  release(bytes: Uint8Array): boolean {
    if (bytes.byteLength === 0) return false;

    // The underlying buffer must be an `ArrayBuffer` lent out by this pool (foreign forms like `SharedArrayBuffer` are rejected in place)
    const heldBuffer = asBackingArrayBuffer(bytes);
    if (heldBuffer === null) return false;
    if (!this.handedOutBuffers.delete(heldBuffer)) return false;
    this.outstandingBuffers -= 1;

    if (this.disposed) {
      this.discardedBuffers += 1;
      return false;
    }
    const classBytes = heldBuffer.byteLength;
    if (classBytes < this.minClassBytes || classBytes > this.maxClassBytes) {
      this.discardedBuffers += 1;
      return false;
    }

    let freeList = this.freeByClass.get(classBytes);
    if (freeList === undefined) {
      freeList = [];
      this.freeByClass.set(classBytes, freeList);
    }
    if (freeList.length >= this.maxBuffersPerClass) {
      this.discardedBuffers += 1;
      return false;
    }
    freeList.push(heldBuffer);
    this.pooledBuffers += 1;
    this.pooledBytes += classBytes;
    this.releasedBuffers += 1;
    return true;
  }

  /** Stats snapshot (for status output) */
  stats(): BufferPoolStats {
    return {
      allocatedBuffers: this.allocatedBuffers,
      reusedBuffers: this.reusedBuffers,
      releasedBuffers: this.releasedBuffers,
      discardedBuffers: this.discardedBuffers,
      outstandingBuffers: this.outstandingBuffers,
      pooledBuffers: this.pooledBuffers,
      pooledBytes: this.pooledBytes,
      disposed: this.disposed,
    };
  }

  /** Dispose the pool: clears the cache and makes subsequent `acquire` throw `E_INTERNAL`; idempotent (repeated calls return false) */
  dispose(): boolean {
    if (this.disposed) return false;
    this.disposed = true;
    this.freeByClass.clear();
    this.pooledBuffers = 0;
    this.pooledBytes = 0;
    return true;
  }
}

/* ---------- Internal utilities ---------- */

/** Pool config clamp (out-of-range clamped to boundary, non-finite throws `E_INTERNAL`, same scope as `clampEngineOption`) */
function clampPoolOption(
  name: keyof typeof BUFFER_POOL_CLAMPS,
  value: number,
): number {
  const range = BUFFER_POOL_CLAMPS[name];
  const rounded = Math.trunc(value);
  if (!Number.isFinite(rounded)) {
    throw new RtdbError(ERROR_CODE.Internal, `Buffer pool config ${name} is not a finite number: ${String(value)}`);
  }
  if (rounded < range.min) return range.min;
  if (rounded > range.max) return range.max;
  return rounded;
}

/** Round up to a power of two (not less than `atLeast`) */
function nextPowerOfTwo(byteLength: number, atLeast: number): number {
  let capacity = atLeast;
  while (capacity < byteLength) capacity *= 2;
  return capacity;
}

/** Get the underlying `ArrayBuffer` of a `Uint8Array`; other forms like `SharedArrayBuffer` return null (cannot be pooled) */
function asBackingArrayBuffer(bytes: Uint8Array): ArrayBuffer | null {
  const buffer = bytes.buffer;
  return buffer instanceof ArrayBuffer ? buffer : null;
}
