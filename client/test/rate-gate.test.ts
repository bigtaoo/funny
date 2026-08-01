// Unit tests for the global outbound request throttle (ADR-058). Each test instantiates its own
// `RateGate` (not the shared `globalRequestGate` singleton) so state never leaks across cases;
// `vi.useFakeTimers()` is installed before each `new RateGate()` so its internal refill
// `setInterval` is captured as a fake timer, advanceable/discardable per test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateGate } from '../src/net/rateGate';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RateGate.tryAcquire', () => {
  it('grants up to capacity (5) tokens synchronously, then denies', () => {
    const gate = new RateGate();
    const grants = Array.from({ length: 6 }, () => gate.tryAcquire());
    expect(grants).toEqual([true, true, true, true, true, false]);
  });

  it('never refills beyond capacity even after a long idle gap', async () => {
    const gate = new RateGate();
    await vi.advanceTimersByTimeAsync(5000); // many refill ticks while nothing was acquired
    const grants = Array.from({ length: 6 }, () => gate.tryAcquire());
    expect(grants).toEqual([true, true, true, true, true, false]);
  });

  it('replenishes one token per 200ms once drained', async () => {
    const gate = new RateGate();
    for (let i = 0; i < 5; i++) gate.tryAcquire(); // drain the burst
    expect(gate.tryAcquire()).toBe(false);

    await vi.advanceTimersByTimeAsync(199);
    expect(gate.tryAcquire()).toBe(false); // not quite a full tick yet

    await vi.advanceTimersByTimeAsync(1);
    expect(gate.tryAcquire()).toBe(true); // exactly one refill tick elapsed
    expect(gate.tryAcquire()).toBe(false); // and it's spent again
  });
});

describe('RateGate.acquire', () => {
  it('resolves immediately (same microtask) while under budget', async () => {
    const gate = new RateGate();
    let resolved = false;
    void gate.acquire().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('queues once the burst is exhausted, resolving only after a refill tick', async () => {
    const gate = new RateGate();
    for (let i = 0; i < 5; i++) gate.tryAcquire();

    let resolved = false;
    void gate.acquire().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false); // no token available yet

    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(true);
  });

  it('serves queued waiters in FIFO order, one per refill tick', async () => {
    const gate = new RateGate();
    for (let i = 0; i < 5; i++) gate.tryAcquire();

    const order: number[] = [];
    void gate.acquire().then(() => order.push(1));
    void gate.acquire().then(() => order.push(2));
    void gate.acquire().then(() => order.push(3));

    await vi.advanceTimersByTimeAsync(200);
    expect(order).toEqual([1]);
    await vi.advanceTimersByTimeAsync(200);
    expect(order).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(200);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a refilled token goes to the queued waiter, not left over for a bystander tryAcquire()', async () => {
    const gate = new RateGate();
    for (let i = 0; i < 5; i++) gate.tryAcquire();

    let queuedResolved = false;
    void gate.acquire().then(() => { queuedResolved = true; });
    await Promise.resolve();
    expect(gate.tryAcquire()).toBe(false); // nothing queued for a bystander before the refill either

    await vi.advanceTimersByTimeAsync(200); // one refill tick — pump() drains it straight to the queue
    expect(queuedResolved).toBe(true);
    // The token that just refilled was handed to the queued waiter, not left sitting for the next caller.
    expect(gate.tryAcquire()).toBe(false);
  });
});
