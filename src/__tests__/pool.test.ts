// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Buffer 池单测（对齐《详细设计 v1.8》§2.3）：
 * 2 的幂分档、复用与跨档、超限直分配、每档上限、归还归属校验、子视图归还、统计与显式生命周期
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ERROR_CODE, isRtdbError } from '../packages/core/src/errors.ts';
import { BUFFER_POOL_CLAMPS, BUFFER_POOL_DEFAULTS, BufferPool } from '../packages/core/src/pool.ts';

/** 断言同步抛出指定错误码 */
function expectInternalError(action: () => unknown, pattern: RegExp): void {
  assert.throws(
    action,
    (error) => {
      assert.ok(isRtdbError(error), `期望 RtdbError，实际 ${String(error)}`);
      assert.equal(error.code, ERROR_CODE.Internal);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe('pool: 分档与复用', () => {
  it('默认按 4096 起档、视图长度精确等于请求长度，归还后可复用同一底层缓冲', () => {
    const pool = new BufferPool();
    assert.equal(pool.minClassBytes, BUFFER_POOL_DEFAULTS.minClassBytes);
    assert.equal(pool.maxClassBytes, BUFFER_POOL_DEFAULTS.maxClassBytes);
    assert.equal(pool.maxBuffersPerClass, BUFFER_POOL_DEFAULTS.maxBuffersPerClass);

    const first = pool.acquire(1000);
    assert.equal(first.length, 1000, '视图长度必须精确等于请求长度（可直接作为写入长度）');
    assert.equal(first.buffer.byteLength, 4096, '底层容量应取 4096 档');
    assert.equal(pool.stats().allocatedBuffers, 1);
    assert.equal(pool.stats().outstandingBuffers, 1);

    const firstBackingBuffer = first.buffer;
    assert.equal(pool.release(first), true);
    assert.equal(pool.stats().releasedBuffers, 1);
    assert.equal(pool.stats().pooledBuffers, 1);
    assert.equal(pool.stats().pooledBytes, 4096);
    assert.equal(pool.stats().outstandingBuffers, 0);

    const second = pool.acquire(4000);
    assert.equal(second.buffer, firstBackingBuffer, '同档请求应复用同一底层缓冲');
    assert.equal(second.length, 4000);
    assert.equal(pool.stats().reusedBuffers, 1);
    assert.equal(pool.stats().allocatedBuffers, 1, '复用不应再分配');
  });

  it('不同分档互不复用，容量为 2 的幂', () => {
    const pool = new BufferPool({ minClassBytes: 256, maxClassBytes: 65536 });
    const small = pool.acquire(300);
    const large = pool.acquire(5000);
    const huge = pool.acquire(60000);
    assert.equal(small.buffer.byteLength, 512);
    assert.equal(large.buffer.byteLength, 8192);
    assert.equal(huge.buffer.byteLength, 65536);
    assert.equal(pool.stats().allocatedBuffers, 3);

    pool.release(small);
    pool.release(large);
    pool.release(huge);
    assert.equal(pool.stats().pooledBuffers, 3);
    assert.equal(pool.stats().pooledBytes, 512 + 8192 + 65536);
  });

  it('超过 maxClassBytes 的请求直分配且不入池', () => {
    const pool = new BufferPool({ minClassBytes: 256, maxClassBytes: 1024 });
    const oversized = pool.acquire(1025);
    assert.equal(oversized.length, 1025);
    assert.equal(pool.stats().allocatedBuffers, 1, '直分配计入净分配');

    assert.equal(pool.release(oversized), false);
    assert.equal(pool.stats().discardedBuffers, 1);
    assert.equal(pool.stats().pooledBuffers, 0);
    assert.equal(pool.stats().outstandingBuffers, 0);

    const fit = pool.acquire(1024);
    assert.equal(fit.buffer.byteLength, 1024);
    assert.equal(pool.release(fit), true);
  });

  it('每档缓存条数受 maxBuffersPerClass 约束，超出即丢弃', () => {
    const pool = new BufferPool({ minClassBytes: 256, maxClassBytes: 256, maxBuffersPerClass: 2 });
    const first = pool.acquire(32);
    const second = pool.acquire(32);
    const third = pool.acquire(32);
    assert.equal(pool.stats().allocatedBuffers, 3);

    assert.equal(pool.release(first), true);
    assert.equal(pool.release(second), true);
    assert.equal(pool.release(third), false, '该档已满应丢弃');
    assert.equal(pool.stats().pooledBuffers, 2);
    assert.equal(pool.stats().discardedBuffers, 1);
    assert.equal(pool.stats().outstandingBuffers, 0);
  });
});

describe('pool: 归还归属校验', () => {
  it('外来对象与重复归还原地拒绝且不改统计', () => {
    const pool = new BufferPool();
    const foreign = new Uint8Array(4096);
    assert.equal(pool.release(foreign), false);
    assert.equal(pool.stats().discardedBuffers, 0, '外来对象不应影响统计');
    assert.equal(pool.stats().pooledBuffers, 0);

    const borrowed = pool.acquire(4096);
    assert.equal(pool.release(borrowed), true);
    assert.equal(pool.release(borrowed), false, '重复归还应被拒（WeakSet 登记已摘除）');
    assert.equal(pool.stats().pooledBuffers, 1);
    assert.equal(pool.stats().outstandingBuffers, 0, '重复归还不得二次扣减借出计数');
  });

  it('归还借出视图的子视图：底层缓冲完整，按分档整块回收', () => {
    const pool = new BufferPool({ minClassBytes: 256, maxClassBytes: 4096 });
    const borrowed = pool.acquire(4096);
    assert.equal(pool.release(borrowed.subarray(0, 128)), true);
    assert.equal(pool.stats().pooledBytes, 4096, '回收的是整块容量而非子视图长度');

    const again = pool.acquire(4096);
    assert.equal(again.length, 4096);
  });

  it('空视图：借用不计入统计，归还原地拒绝', () => {
    const pool = new BufferPool();
    const empty = pool.acquire(0);
    assert.equal(empty.length, 0);
    assert.equal(pool.stats().allocatedBuffers, 0);
    assert.equal(pool.stats().outstandingBuffers, 0);
    assert.equal(pool.release(empty), false);
    assert.equal(pool.stats().discardedBuffers, 0);
  });

  it('借用长度非法抛 E_INTERNAL', () => {
    const pool = new BufferPool();
    expectInternalError(() => pool.acquire(-1), /Illegal buffer acquire length/);
    expectInternalError(() => pool.acquire(1.5), /Illegal buffer acquire length/);
    expectInternalError(() => pool.acquire(Number.NaN), /Illegal buffer acquire length/);
  });
});

describe('pool: 生命周期与钳位', () => {
  it('dispose 清空缓存并使后续借用抛 E_INTERNAL；幂等', () => {
    const pool = new BufferPool({ minClassBytes: 256, maxClassBytes: 256 });
    const borrowed = pool.acquire(64);
    assert.equal(pool.release(borrowed), true);
    assert.equal(pool.stats().pooledBuffers, 1);

    assert.equal(pool.dispose(), true);
    assert.equal(pool.dispose(), false, '重复释放应为幂等');
    assert.equal(pool.stats().disposed, true);
    assert.equal(pool.stats().pooledBuffers, 0);
    assert.equal(pool.stats().pooledBytes, 0);
    expectInternalError(() => pool.acquire(16), /Buffer pool is disposed/);
  });

  it('释放前借出、释放后归还：丢弃并结清借出计数', () => {
    const pool = new BufferPool();
    const borrowed = pool.acquire(100);
    assert.equal(pool.stats().outstandingBuffers, 1);
    pool.dispose();
    assert.equal(pool.release(borrowed), false);
    assert.equal(pool.stats().outstandingBuffers, 0);
    assert.equal(pool.stats().discardedBuffers, 1);
  });

  it('配置越界一律钳位（非有限值抛 E_INTERNAL）', () => {
    const low = new BufferPool({ minClassBytes: 1, maxClassBytes: 1, maxBuffersPerClass: 0 });
    assert.equal(low.minClassBytes, BUFFER_POOL_CLAMPS.minClassBytes.min);
    assert.equal(low.maxClassBytes, BUFFER_POOL_CLAMPS.maxClassBytes.min);
    assert.equal(low.maxBuffersPerClass, BUFFER_POOL_CLAMPS.maxBuffersPerClass.min);

    const high = new BufferPool({ minClassBytes: 1e12, maxClassBytes: 1e12, maxBuffersPerClass: 1e12 });
    assert.equal(high.maxClassBytes, BUFFER_POOL_CLAMPS.maxClassBytes.max);
    assert.equal(high.minClassBytes, BUFFER_POOL_CLAMPS.maxClassBytes.max, 'min 不得超过 max');
    assert.equal(high.maxBuffersPerClass, BUFFER_POOL_CLAMPS.maxBuffersPerClass.max);

    expectInternalError(
      () => new BufferPool({ minClassBytes: Number.NaN }),
      /Buffer pool config minClassBytes is not a finite number/,
    );
  });
});
