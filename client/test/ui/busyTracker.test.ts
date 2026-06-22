import { describe, it, expect } from 'vitest';
import { BusyTracker, withTimeout, TimeoutError } from '../../src/ui/busyTracker';

// ── BusyTracker ───────────────────────────────────────────────────────────────

describe('BusyTracker', () => {
  it('is idle by default; tick returns false when not busy', () => {
    const bt = new BusyTracker();
    expect(bt.busy).toBe(false);
    expect(bt.tick(1.0)).toBe(false);
  });

  it('start sets busy; stop clears it', () => {
    const bt = new BusyTracker();
    bt.start();
    expect(bt.busy).toBe(true);
    expect(bt.loadingVisible).toBe(false);
    bt.stop();
    expect(bt.busy).toBe(false);
    expect(bt.loadingVisible).toBe(false);
  });

  it('loadingVisible stays false before 1 s', () => {
    const bt = new BusyTracker();
    bt.start();
    expect(bt.tick(0.9)).toBe(false);
    expect(bt.loadingVisible).toBe(false);
  });

  it('loadingVisible becomes true at 1 s and tick returns dirty', () => {
    const bt = new BusyTracker();
    bt.start();
    bt.tick(0.9);
    const dirty = bt.tick(0.1); // total = 1.0
    expect(dirty).toBe(true);
    expect(bt.loadingVisible).toBe(true);
  });

  it('dot does not advance before loading shows', () => {
    const bt = new BusyTracker();
    bt.start();
    bt.tick(0.3);
    expect(bt.loadingVisible).toBe(false);
    expect(bt.dots).toBe(0);
    bt.tick(0.3); // total 0.6 — still not visible
    expect(bt.dots).toBe(0);
  });

  it('dot advances every 0.4 s after loading shows', () => {
    const bt = new BusyTracker();
    bt.start();
    // Cross threshold with a tiny step so dotTimer stays below 0.4 in the same tick.
    bt.tick(0.99);
    bt.tick(0.02); // elapsed = 1.01 → visible; dotTimer = 0.02
    expect(bt.loadingVisible).toBe(true);
    expect(bt.dots).toBe(0);

    bt.tick(0.4); expect(bt.dots).toBe(1);
    bt.tick(0.4); expect(bt.dots).toBe(2);
    bt.tick(0.4); expect(bt.dots).toBe(0); // wraps at 3
  });

  it('stop resets loadingVisible mid-flight', () => {
    const bt = new BusyTracker();
    bt.start();
    bt.tick(1.5);
    expect(bt.loadingVisible).toBe(true);
    bt.stop();
    expect(bt.loadingVisible).toBe(false);
    expect(bt.busy).toBe(false);
  });

  it('second start resets all accumulated state', () => {
    const bt = new BusyTracker();
    bt.start();
    bt.tick(1.5);
    expect(bt.loadingVisible).toBe(true);
    bt.start();
    expect(bt.elapsed).toBe(0);
    expect(bt.loadingVisible).toBe(false);
    expect(bt.dots).toBe(0);
  });
});

// ── withTimeout ───────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves with the original value', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when deadline exceeded', async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('TimeoutError has message "timeout"', async () => {
    let caught: unknown;
    try { await withTimeout(new Promise(() => {}), 10); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TimeoutError);
    expect((caught as Error).message).toBe('timeout');
  });

  it('timer is cleared after fast resolve — no late rejection', async () => {
    const fast = await withTimeout(Promise.resolve('ok'), 50);
    expect(fast).toBe('ok');
    // Wait longer than the deadline — if the timer wasn't cleared this would reject.
    await new Promise((r) => setTimeout(r, 80));
  });

  it('propagates non-timeout rejections unchanged', async () => {
    const boom = new Error('boom');
    await expect(withTimeout(Promise.reject(boom), 1000)).rejects.toBe(boom);
  });
});
