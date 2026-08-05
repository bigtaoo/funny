// Regression coverage for cache/ObjectPool + cache/poolRegistry — previously zero tests despite
// drain() being the key teardown API that prevents pooled (detached) Graphics/Sprite objects from
// leaking their GPU resources (see client-memory-leak.md §4): pooled objects are removed from their
// parent container, so a parent's destroy({children:true}) never reaches them — only drain(dispose)
// does.
import { describe, it, expect, vi } from 'vitest';
import { ObjectPool } from '../src/cache/ObjectPool';
import { registerPool, snapshotPools } from '../src/cache/poolRegistry';

describe('ObjectPool', () => {
  it('acquire() reuses a released object instead of calling the factory again', () => {
    let built = 0;
    const pool = new ObjectPool(() => ({ id: built++ }), () => {});
    const a = pool.acquire();
    expect(built).toBe(1);
    pool.release(a);
    expect(pool.size).toBe(1);

    const b = pool.acquire();
    expect(b).toBe(a); // reused, not a new object
    expect(built).toBe(1); // factory not called again
    expect(pool.size).toBe(0);
  });

  it('release() resets the object before returning it to the pool', () => {
    const resetter = vi.fn((obj: { dirty: boolean }) => { obj.dirty = false; });
    const pool = new ObjectPool(() => ({ dirty: true }), resetter);
    const obj = pool.acquire();
    obj.dirty = true;
    pool.release(obj);
    expect(resetter).toHaveBeenCalledWith(obj);
    expect(obj.dirty).toBe(false);
  });

  it('prewarm builds the requested number of idle objects up front', () => {
    let built = 0;
    const pool = new ObjectPool(() => ({ id: built++ }), () => {}, 5);
    expect(built).toBe(5);
    expect(pool.size).toBe(5);
  });

  it('drain() empties the pool and calls dispose on every retained object (teardown-only path)', () => {
    const pool = new ObjectPool(() => ({ destroyed: false }), () => {});
    const a = pool.acquire();
    const b = pool.acquire();
    pool.release(a);
    pool.release(b);
    expect(pool.size).toBe(2);

    const disposed: unknown[] = [];
    pool.drain((obj) => { obj.destroyed = true; disposed.push(obj); });

    expect(pool.size).toBe(0);
    expect(disposed).toEqual([a, b]);
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
  });

  it('drain() without a dispose callback still empties the pool (no crash)', () => {
    const pool = new ObjectPool(() => ({}), () => {}, 3);
    pool.drain();
    expect(pool.size).toBe(0);
  });

  it('drain() unregisters the pool from the memory-monitor registry so it stops appearing in snapshots', () => {
    const pool = new ObjectPool(() => ({}), () => {}, 4, { label: 'test.pool.drain', bytesEach: 100 });
    expect(snapshotPools().rows.find((r) => r.label === 'test.pool.drain')?.idle).toBe(4);

    pool.drain();
    expect(snapshotPools().rows.find((r) => r.label === 'test.pool.drain')).toBeUndefined();
  });

  it('drain() is idempotent: calling it twice does not throw or double-unregister', () => {
    const pool = new ObjectPool(() => ({}), () => {}, 1, { label: 'test.pool.idempotent', bytesEach: 1 });
    pool.drain();
    expect(() => pool.drain()).not.toThrow();
  });
});

describe('poolRegistry.snapshotPools', () => {
  it('merges same-labelled sources (multiple same-type views per match) by summing idle + estBytes', () => {
    const un1 = registerPool({ label: 'merge.test', idle: () => 3, bytesEach: 10 });
    const un2 = registerPool({ label: 'merge.test', idle: () => 2, bytesEach: 10 });
    try {
      const snap = snapshotPools();
      const row = snap.rows.find((r) => r.label === 'merge.test');
      expect(row?.idle).toBe(5);
      expect(row?.estBytes).toBe(50);
    } finally {
      un1();
      un2();
    }
  });

  it('sorts rows by estimated bytes descending', () => {
    const unSmall = registerPool({ label: 'sort.small', idle: () => 1, bytesEach: 10 });
    const unBig = registerPool({ label: 'sort.big', idle: () => 100, bytesEach: 10 });
    try {
      const snap = snapshotPools();
      const iBig = snap.rows.findIndex((r) => r.label === 'sort.big');
      const iSmall = snap.rows.findIndex((r) => r.label === 'sort.small');
      expect(iBig).toBeGreaterThanOrEqual(0);
      expect(iSmall).toBeGreaterThanOrEqual(0);
      expect(iBig).toBeLessThan(iSmall);
    } finally {
      unSmall();
      unBig();
    }
  });

  it('clamps a negative idle() reading to 0 instead of letting totals go negative', () => {
    const un = registerPool({ label: 'negative.test', idle: () => -5, bytesEach: 10 });
    try {
      const row = snapshotPools().rows.find((r) => r.label === 'negative.test');
      expect(row?.idle).toBe(0);
      expect(row?.estBytes).toBe(0);
    } finally {
      un();
    }
  });

  it('unregister removes the source so it no longer contributes to future snapshots', () => {
    const un = registerPool({ label: 'unregister.test', idle: () => 7, bytesEach: 1 });
    expect(snapshotPools().rows.some((r) => r.label === 'unregister.test')).toBe(true);
    un();
    expect(snapshotPools().rows.some((r) => r.label === 'unregister.test')).toBe(false);
  });
});
