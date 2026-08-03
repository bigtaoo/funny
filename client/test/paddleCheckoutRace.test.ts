// Regression coverage for WebPlatform.openPaddleCheckout()'s shared event-sink race
// (client/src/platform/web/WebPlatform.ts).
//
// 2026-08-03 fix: `paddleEvent` is a single instance field that Paddle's one global eventCallback
// routes through. A second openPaddleCheckout() call before the first one's checkout.closed event
// ever fires (e.g. a fast double-tap on a recharge tier before the overlay actually mounts) used to
// silently overwrite `paddleEvent`, permanently stranding the first call's `resolve` — the caller
// (nav/shop.ts's doRechargeCoins/doBuySubscription) would `await` that promise forever. Now the
// prior pending call is settled as `{completed:false}` before the sink is overwritten.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakePaddleCheckoutEvent { name?: string }
type FakeEventCallback = (ev: FakePaddleCheckoutEvent) => void;

function stubMinimalDom(): void {
  const fakeCanvas = { id: '', style: {} } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => fakeCanvas,
    body: { appendChild: () => {}, style: {} },
    head: { appendChild: () => {} },
    querySelector: () => null,
  });
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 });
  vi.stubGlobal('localStorage', new Map<string, string>());
  vi.stubGlobal('navigator', { language: 'en' });
}

/** openPaddleCheckout() has one internal `await this.loadPaddle(...)` before it touches paddleEvent/
 * paddlePendingResolve — flush a few microtask ticks so that prelude has actually run before we poke
 * at the fake Paddle's captured eventCallback or assert on the pending-resolve side effects. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('WebPlatform.openPaddleCheckout() — shared event-sink race', () => {
  let eventCallback: FakeEventCallback | undefined;

  beforeEach(() => {
    vi.resetModules();
    stubMinimalDom();
    eventCallback = undefined;
    // Pre-install a fake Paddle global so loadPaddle() skips the script-injection branch entirely
    // (it only Initialize()s once per distinct client token, capturing our eventCallback).
    (globalThis as unknown as { window: { Paddle?: unknown } }).window.Paddle = {
      Environment: { set: () => {} },
      Initialize: (opts: { eventCallback?: FakeEventCallback }) => { eventCallback = opts.eventCallback; },
      Checkout: { open: () => { /* real Paddle would show its overlay; test drives events manually */ } },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a normal single checkout resolves once checkout.closed fires', async () => {
    const { WebPlatform } = await import('../src/platform/web/WebPlatform');
    const platform = new WebPlatform();

    const p = platform.openPaddleCheckout('tx1', 'test_token');
    await flush();
    eventCallback?.({ name: 'checkout.completed' });
    eventCallback?.({ name: 'checkout.closed' });
    await expect(p).resolves.toEqual({ completed: true });
  });

  it('regression: a second call before the first resolves settles the first as {completed:false} instead of stranding it', async () => {
    const { WebPlatform } = await import('../src/platform/web/WebPlatform');
    const platform = new WebPlatform();

    const first = platform.openPaddleCheckout('tx1', 'test_token');
    await flush(); // first call's paddleEvent sink is now installed
    let firstSettled: { completed: boolean } | null = null;
    void first.then((r) => { firstSettled = r; });

    // Second call arrives before the first ever got a checkout.closed — simulates the fast
    // double-tap race (first overlay hasn't visually mounted / closed yet).
    const second = platform.openPaddleCheckout('tx2', 'test_token');
    await flush();

    expect(firstSettled).toEqual({ completed: false }); // settled, not stranded — the actual fix

    // The second call is still the live one and can complete normally.
    eventCallback?.({ name: 'checkout.completed' });
    eventCallback?.({ name: 'checkout.closed' });
    await expect(second).resolves.toEqual({ completed: true });
  });
});
