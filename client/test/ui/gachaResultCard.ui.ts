// Regression coverage for the gacha result-reveal cards (2026-07-16): the plate under
// each drawn item showed the raw itemId string (e.g. "mat_scrap") instead of a
// translated name, and every duplicate carried a "Dup" badge that read as noise —
// only NEW pulls should get a badge at all.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles); we set
// GachaScene's private `reveal` state directly and re-render rather than driving a
// real draw() round-trip, since drawResultCard only depends on that field.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { GachaScene, type GachaSceneCallbacks } from '../../src/scenes/GachaScene';
import type { GachaResultEntry } from '../../src/net/ApiClient';
import { unitPortraitUrl, cardInstanceArtUrl } from '../../src/render/cardArt';
import { UnitType } from '../../src/game/types';

// Every export except cardInstanceArtUrl/unitPortraitUrl passes through untouched; wrapping just
// those two in vi.fn (keeping their real implementation) lets specs below inspect call arguments
// without disturbing the rendered art (headless PIXI stubs every binary asset to one identical PNG
// data URI, so asserting "which picture got drawn" by texture identity isn't possible).
vi.mock('../../src/render/cardArt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/cardArt')>();
  return {
    ...actual,
    cardInstanceArtUrl: vi.fn(actual.cardInstanceArtUrl),
    unitPortraitUrl: vi.fn(actual.unitPortraitUrl),
  };
});

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function buildGacha(cb: Partial<GachaSceneCallbacks> = {}): GachaScene {
  return new GachaScene(createLayout(1920, 1080), new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    getPity: () => 0,
    getFatePoints: () => 0,
    loadPools: async () => [],
    draw: async () => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } }),
    redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
    ...cb,
  });
}

/** Collect every rendered PIXI.Text string in the scene's tree. */
function allTexts(container: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text) out.push(node.text);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

/** Force the reveal overlay onto a built scene without a real draw() round-trip. */
function reveal(scene: GachaScene, results: GachaResultEntry[]): void {
  (scene as unknown as { reveal: GachaResultEntry[] | null }).reveal = results;
  (scene as unknown as { render(): void }).render();
}

describe('GachaScene — result card names + duplicate badge', () => {
  it('shows the translated display name, not the raw itemId', () => {
    const scene = buildGacha();
    reveal(scene, [{ itemId: 'mat_scrap', rarity: 'common', duplicate: true }]);
    const texts = allTexts(scene.container);
    expect(texts).toContain(t('material.scrap'));
    expect(texts).not.toContain('mat_scrap');
    scene.destroy();
  });

  it('does not show a "Dup" badge on duplicate pulls', () => {
    const scene = buildGacha();
    reveal(scene, [
      { itemId: 'mat_scrap', rarity: 'common', duplicate: true },
      { itemId: 'lichuang', rarity: 'rare', duplicate: true },
    ]);
    const texts = allTexts(scene.container);
    expect(texts).not.toContain(t('gacha.duplicate'));
    expect(texts).not.toContain(t('gacha.new'));
    scene.destroy();
  });

  it('still shows the NEW badge for a non-duplicate pull', () => {
    const scene = buildGacha();
    reveal(scene, [{ itemId: 'lichuang', rarity: 'rare', duplicate: false }]);
    const texts = allTexts(scene.container);
    expect(texts).toContain(t('gacha.new'));
    expect(texts).not.toContain(t('gacha.duplicate'));
    scene.destroy();
  });
});

// Regression coverage for the 2026-08-01 fix: skin_e1/skin_e2/skin_l1 (Lena/Mara/Max's gacha
// skins) had dedicated portrait art registered in cardArt.ts SKIN_PORTRAIT_ART, but
// GachaScene.drawEntryPicture never looked it up — every skin pull unconditionally drew the
// generic wardrobe brush glyph instead, so the result card never showed the actual skin art.
// Asserted on call arguments, not the rendered texture (see file-level note above).
describe('GachaScene — skin result card resolves its dedicated portrait, not the brush placeholder', () => {
  const spy = unitPortraitUrl as unknown as { mock: { calls: unknown[][] } };

  it.each([
    ['skin_e1', UnitType.Lena],
    ['skin_e2', UnitType.Mara],
    ['skin_l1', UnitType.Max],
  ])('resolves %s through unitPortraitUrl(%s, itemId)', (itemId, unitType) => {
    spy.mock.calls.length = 0;
    const scene = buildGacha();
    reveal(scene, [{ itemId, rarity: 'epic', duplicate: false }]);

    const skinCalls = spy.mock.calls.filter((call) => call[1] === itemId);
    expect(skinCalls.length).toBeGreaterThan(0);
    for (const call of skinCalls) expect(call[0]).toBe(unitType);
    scene.destroy();
  });

  // skin_placeholder isn't in SKIN_TARGET_UNIT (skinDefs.ts) — drawEntryPicture must not call
  // unitPortraitUrl for it at all (no unitType to resolve), and must still render the card without
  // throwing, falling back to the brush glyph instead.
  it('does not call unitPortraitUrl for a skin id with no SKIN_TARGET_UNIT mapping, and still renders', () => {
    spy.mock.calls.length = 0;
    const scene = buildGacha();
    expect(() => reveal(scene, [{ itemId: 'skin_placeholder', rarity: 'legendary', duplicate: false }])).not.toThrow();

    const skinCalls = spy.mock.calls.filter((call) => call[1] === 'skin_placeholder');
    expect(skinCalls.length).toBe(0);
    scene.destroy();
  });
});

describe('GachaScene — legendary card border trail', () => {
  const fxOf = (s: GachaScene): Array<{ phase: number; dots: PIXI.Sprite[] }> =>
    (s as unknown as { revealFx: Array<{ phase: number; dots: PIXI.Sprite[] }> }).revealFx;
  const tick = (s: GachaScene, dt: number): void =>
    (s as unknown as { update(dt: number): void }).update(dt);
  /** (b - a) mod 1, normalised to [0, 1) — perimeter-fraction gap between two comet heads. */
  const phaseGap = (a: number, b: number): number => (((b - a) % 1) + 1) % 1;

  it('spawns two clockwise-looping border trails for a legendary (orange) card only, not for a rare one', () => {
    const scene = buildGacha();
    reveal(scene, [
      { itemId: 'lichuang', rarity: 'rare', duplicate: false },
      { itemId: 'skin_placeholder', rarity: 'legendary', duplicate: false },
    ]);
    const fx = fxOf(scene);
    expect(fx.length).toBe(2); // one legendary card -> a diagonally-paired trail, not one per card and none for the rare card

    const before = fx.map((f) => f.phase);
    tick(scene, 0.5);
    // Positive phase delta = clockwise (screen y-down); both trails must advance while revealing.
    fx.forEach((f, i) => expect(f.phase).toBeGreaterThan(before[i]));
    scene.destroy();
  });

  // Regression coverage for the 2026-08-02 request: a single trail read as "one light chasing
  // itself"; the ask was two trails starting from diagonally opposite corners (e.g. bottom-left +
  // top-right) so they run the border together. The pair is built a half-lap (TRAIL_PAIR_OFFSET =
  // 0.5) apart, which for the reveal grid's portrait card ratio (cellH = cellW*1.3) lands the two
  // heads on opposite corners (see manual perimeter-math check during implementation). The two must
  // stay exactly half a lap apart forever, not just at spawn, or they'd visibly drift into each other.
  it('pairs the legendary trail a half-lap apart, and keeps that gap while both advance', () => {
    const scene = buildGacha();
    reveal(scene, [{ itemId: 'skin_placeholder', rarity: 'legendary', duplicate: false }]);
    const [a, b] = fxOf(scene);
    expect(phaseGap(a.phase, b.phase)).toBeCloseTo(0.5, 5);
    // The two comet heads (dots[0], see buildTrailDots) must not sit on top of each other.
    expect(a.dots[0].position.x).not.toBeCloseTo(b.dots[0].position.x, 1);

    tick(scene, 0.5);
    tick(scene, 0.3);
    expect(phaseGap(a.phase, b.phase)).toBeCloseTo(0.5, 5);
    scene.destroy();
  });

  it('clears both trails when the reveal is dismissed', () => {
    const scene = buildGacha();
    reveal(scene, [{ itemId: 'skin_placeholder', rarity: 'legendary', duplicate: false }]);
    expect(fxOf(scene).length).toBe(2);
    (scene as unknown as { dismissReveal(): void }).dismissReveal();
    expect(fxOf(scene).length).toBe(0);
    tick(scene, 0.5); // no-op, must not throw with an empty fx list
    scene.destroy();
  });
});

// Regression coverage for the 2026-08-01 scoping decision (UI_DESIGN.md §27 addendum): a hero-card
// pull's reveal picture must always be the base portrait, never whichever skin the account has
// equipped for that unit type — showing the equipped skin here misread "I pulled a plain card" as
// "I pulled a skin". GachaScene has no equipped-skin data source at all any more (the earlier
// `getEquippedSkins` callback was removed), so this locks in that the reveal keeps resolving through
// `cardInstanceArtUrl(card)` with no second (equipped) argument — reintroducing that argument would
// silently bring back the misread. Asserted on call arguments, not the rendered texture, because
// headless PIXI stubs every binary asset to the same 1×1 PNG data URI (see file-level note above).
describe('GachaScene — hero card reveal always calls cardInstanceArtUrl with no equipped-skin arg', () => {
  const spy = cardInstanceArtUrl as unknown as { mock: { calls: unknown[][] } };

  it('passes only the card, never an equipped-skin map, for a hero card pull', () => {
    spy.mock.calls.length = 0;
    const scene = buildGacha();
    reveal(scene, [{ itemId: 'lichuang', rarity: 'rare', duplicate: false }]);

    const cardCalls = spy.mock.calls.filter((call) => (call[0] as { defId?: string } | undefined)?.defId === 'lichuang');
    expect(cardCalls.length).toBeGreaterThan(0);
    for (const call of cardCalls) expect(call.length === 1 || call[1] === undefined).toBe(true);
    scene.destroy();
  });
});
