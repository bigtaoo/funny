// Regression coverage for CrazyGamesPlatform.showMidgameAd()'s timeout
// (client/src/platform/crazygames/CrazyGamesPlatform.ts).
//
// 2026-08-03 fix: nav/result.ts awaits showMidgameAd() unconditionally before showing the result
// screen after every match. Previously, if the CrazyGames ad SDK never invoked either adFinished or
// adError (ad blocked with no fill, or a transient SDK bug), the returned promise never settled and
// the player was stuck on the frozen last frame of gameplay until they reloaded. showMidgameAd() now
// races the SDK callback against an internal timeout that always resolves.
//
// Minimal DOM stub: the constructor only needs document.getElementById/createElement/body.appendChild
// to find-or-create its canvas element; no other DOM behavior is exercised by showMidgameAd() itself.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function stubMinimalDom(): void {
  const fakeCanvas = { id: '', style: {} } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => fakeCanvas,
    body: { appendChild: () => {}, style: {} },
  });
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 });
  vi.stubGlobal('localStorage', new Map<string, string>());
  vi.stubGlobal('navigator', { language: 'en' });
}

describe('CrazyGamesPlatform.showMidgameAd()', () => {
  beforeEach(() => {
    vi.resetModules();
    stubMinimalDom();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves via the SDK callback when it fires normally', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    let adFinished: (() => void) | undefined;
    (platform as unknown as { sdk: unknown }).sdk = {
      ad: { requestAd: (_type: string, cb: { adFinished?(): void }) => { adFinished = cb.adFinished; } },
    };

    const p = platform.showMidgameAd();
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    adFinished?.();
    await p;
    expect(settled).toBe(true);
  });

  it('regression: resolves on its own timeout when the SDK never calls back (ad-blocked / SDK bug)', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    (platform as unknown as { sdk: unknown }).sdk = {
      ad: { requestAd: () => { /* never calls adFinished or adError — simulates a stuck SDK */ } },
    };

    const p = platform.showMidgameAd();
    let settled = false;
    void p.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false); // must not resolve early

    await vi.advanceTimersByTimeAsync(5000); // past the internal timeout
    expect(settled).toBe(true); // must not hang forever
  });

  it('resolves immediately when no SDK is present at all', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    await expect(platform.showMidgameAd()).resolves.toBeUndefined();
  });
});
