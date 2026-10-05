import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { untilVisibleAndSettled, SETTLE_QUIET_MS, SETTLE_MAX_MS } from '../src/platform/web/visibleBoot';

// See src/platform/web/visibleBoot.ts: a CrazyGames boot in a hidden tab measured a portrait
// viewport and built the never-rebuilt tutorial match against it (2026-10-05 QA preview).

function fakeDom(initial: 'visible' | 'hidden') {
  const docL = new Set<() => void>();
  const winL = new Set<() => void>();
  const doc = {
    visibilityState: initial as string,
    addEventListener: (_: string, cb: () => void) => { docL.add(cb); },
    removeEventListener: (_: string, cb: () => void) => { docL.delete(cb); },
  };
  const win = {
    addEventListener: (_: string, cb: () => void) => { winL.add(cb); },
    removeEventListener: (_: string, cb: () => void) => { winL.delete(cb); },
  };
  return {
    doc, win,
    show() { doc.visibilityState = 'visible'; for (const cb of [...docL]) cb(); },
    resize() { for (const cb of [...winL]) cb(); },
    listeners: () => docL.size + winL.size,
  };
}

async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; });
  await Promise.resolve(); await Promise.resolve();
  return done;
}

describe('untilVisibleAndSettled', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves at once for a page that booted visible', async () => {
    const d = fakeDom('visible');
    expect(await settled(untilVisibleAndSettled(d.doc, d.win))).toBe(true);
  });

  it('resolves at once without a DOM', async () => {
    expect(await settled(untilVisibleAndSettled(undefined, undefined))).toBe(true);
  });

  it('waits while hidden, then for a quiet period after turning visible', async () => {
    const d = fakeDom('hidden');
    const p = untilVisibleAndSettled(d.doc, d.win);
    vi.advanceTimersByTime(60_000);
    expect(await settled(p)).toBe(false);

    d.show();
    vi.advanceTimersByTime(SETTLE_QUIET_MS - 50);
    d.resize(); // the host reshapes the frame as the tab comes forward — restart the quiet window
    vi.advanceTimersByTime(SETTLE_QUIET_MS - 50);
    expect(await settled(p)).toBe(false);
    vi.advanceTimersByTime(60);
    expect(await settled(p)).toBe(true);
    expect(d.listeners()).toBe(0);
  });

  it('gives up waiting for quiet after the cap', async () => {
    const d = fakeDom('hidden');
    const p = untilVisibleAndSettled(d.doc, d.win);
    d.show();
    for (let t = 0; t < SETTLE_MAX_MS; t += 100) { d.resize(); vi.advanceTimersByTime(100); }
    expect(await settled(p)).toBe(true);
  });
});
