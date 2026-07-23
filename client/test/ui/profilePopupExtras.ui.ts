// Regression for two ProfilePopup (render/ProfilePopup.ts) bugs found in the same session:
//
// 1. Layout: the family/sect line's `yBottom` was never advanced after being drawn, so whatever
//    came after it (the action row / Close button) was positioned as if that line didn't exist —
//    the button text rendered on top of the family/sect text (2026-07-23 bug report screenshot).
//
// 2. Consistency: every caller used to fetch (or not fetch) rank/ELO/family/sect by hand, so the
//    same popup showed a different subset of fields depending on which screen opened it. Fixed by
//    having ProfilePopup itself fetch these via an injected `fetchExtra(publicId)` and patch them
//    in once resolved — this covers that auto-fetch + the stale-fetch guard.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, setLocale, t } from '../../src/i18n';
import { ProfilePopup, type ProfileExtra } from '../../src/render/ProfilePopup';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type Box = { text: string; top: number; bottom: number; left: number; right: number };

function collectTextBoxes(container: PIXI.Container): Box[] {
  const out: Box[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text) {
      const b = node.getBounds();
      out.push({ text: node.text, top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width });
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

describe('ProfilePopup: family/sect line no longer overlaps what follows it', () => {
  it('Close button sits below the family/sect line, not on top of it', () => {
    setLocale('en');
    const popup = new ProfilePopup(1280, 720);
    popup.show({
      name: 'Playtester',
      publicId: '123456789',
      familyName: 'AlphaKnight',
      sectName: 'DragonSect',
    });

    const boxes = collectTextBoxes(popup.container);
    const orgLine = boxes.find((b) => b.text.includes('AlphaKnight'));
    const close = boxes.find((b) => b.text === t('profile.close'));
    expect(orgLine, 'family/sect line not rendered').toBeDefined();
    expect(close, 'Close button not rendered').toBeDefined();

    expect(close!.top).toBeGreaterThan(orgLine!.bottom);
    popup.destroy();
  });
});

describe('ProfilePopup: fetches rank/ELO/family/sect itself instead of callers threading them through', () => {
  it('shows the base card synchronously, then patches in the fetched extras', async () => {
    setLocale('en');
    let resolveExtra!: (v: ProfileExtra) => void;
    const fetchExtra = vi.fn(() => new Promise<ProfileExtra>((res) => { resolveExtra = res; }));
    const popup = new ProfilePopup(1280, 720, fetchExtra);

    popup.show({ name: 'Rival', publicId: '987654321' });
    expect(fetchExtra).toHaveBeenCalledWith('987654321');
    let boxes = collectTextBoxes(popup.container);
    expect(boxes.some((b) => b.text.includes('AlphaKnight'))).toBe(false);

    resolveExtra({ rank: 'diamond', elo: 1509, familyName: 'AlphaKnight', sectName: 'DragonSect' });
    await Promise.resolve(); await Promise.resolve(); // flush the .then() microtask

    boxes = collectTextBoxes(popup.container);
    expect(boxes.some((b) => b.text.includes('ELO 1509'))).toBe(true);
    expect(boxes.some((b) => b.text.includes('AlphaKnight'))).toBe(true);
    expect(boxes.some((b) => b.text.includes('DragonSect'))).toBe(true);
    popup.destroy();
  });

  it('a stale extras fetch for a closed/reopened card is ignored', async () => {
    setLocale('en');
    let resolveFirst!: (v: ProfileExtra) => void;
    const fetchExtra = vi.fn()
      .mockImplementationOnce(() => new Promise<ProfileExtra>((res) => { resolveFirst = res; }))
      .mockImplementationOnce(() => Promise.resolve({ familyName: 'BetaRaiders' } as ProfileExtra));
    const popup = new ProfilePopup(1280, 720, fetchExtra);

    popup.show({ name: 'First', publicId: '111111111' });
    popup.show({ name: 'Second', publicId: '222222222' }); // reopened before the first fetch resolved
    await Promise.resolve(); await Promise.resolve();

    resolveFirst({ familyName: 'AlphaKnight' }); // late reply for the card that's no longer showing
    await Promise.resolve(); await Promise.resolve();

    const boxes = collectTextBoxes(popup.container);
    expect(boxes.some((b) => b.text.includes('AlphaKnight'))).toBe(false);
    expect(boxes.some((b) => b.text.includes('BetaRaiders'))).toBe(true);
    popup.destroy();
  });
});
