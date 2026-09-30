// Leaderboard row names follow the lobby header's rule (LeaderboardScene.fitRowName): shrink to 0.8
// and never under the legibility floor, then cut with "…". A 24-character CJK name — the most
// MAX_DISPLAY_NAME_LEN allows — used to be scaled to ~16 design px against a floor of 20 (2026-09-29).
//
// Runs under the headless PIXI adapter (7px per character, CJK included). Run: npm run test:ui
import { describe, it, expect, afterEach } from 'vitest';
import { txt } from '../../src/render/sketchUi';
import { setFontScale, resetFontScaleForTest } from '../../src/render/fontScale';
import { fitRowName } from '../../src/scenes/LeaderboardScene';

afterEach(() => resetFontScaleForTest());

describe('fitRowName', () => {
  it('leaves a name that fits', () => {
    setFontScale(1 / 3);
    const name = 'Mara';
    const l = txt(name, 42, 0);
    fitRowName(l, name, 42, 400);
    expect(l.text).toBe(name);
    expect(l.scale.x).toBe(1);
  });

  it('shrinks a slightly long name, like before', () => {
    setFontScale(1 / 3);
    const name = 'x'.repeat(60); // 420
    const l = txt(name, 42, 0);
    fitRowName(l, name, 42, 400);
    expect(l.text).toBe(name);
    expect(l.scale.x).toBeCloseTo(400 / 420, 6);
  });

  it('holds a 24-character CJK name at 0.8 and cuts the rest', () => {
    setFontScale(1 / 3);
    const name = '长'.repeat(24);
    const l = txt(name, 42, 0);
    fitRowName(l, name, 42, 100);
    expect(l.scale.x).toBeCloseTo(0.8, 6);
    expect(l.text.endsWith('…')).toBe(true);
    expect(l.text.length).toBeLessThan(name.length);
    expect(l.width).toBeLessThanOrEqual(100 + 0.01);
  });

  it('does not shrink a name already at the floor size at all', () => {
    setFontScale(1 / 3); // floor 20
    const name = 'y'.repeat(30);
    const l = txt(name, 20, 0);
    fitRowName(l, name, 20, 100);
    expect(l.scale.x).toBe(1);
    expect(l.text.endsWith('…')).toBe(true);
    expect(l.width).toBeLessThanOrEqual(100 + 0.01);
  });
});

describe('LeaderboardScene rows use it', () => {
  it('a name too wide for a 360-wide portrait row is cut, not shrunk under the floor', async () => {
    const { createLayout } = await import('../../src/layout/ScalingManager');
    const { InputManager } = await import('../../src/inputSystem/InputManager');
    const { LeaderboardScene } = await import('../../src/scenes/LeaderboardScene');
    const PIXI = await import('pixi.js-legacy');
    // What ScalingManager does for this layout on a real screen: 1080 design px at 1/3.
    setFontScale(1 / 3);
    // The headless adapter measures a CJK glyph at 7px like any other, so a real 24-character CJK
    // name (2x wide on a real font) fits here; 80 characters stands in for it.
    const long = '长'.repeat(80);
    const scene = new LeaderboardScene(createLayout(360, 640), new InputManager(), {
      onBack() {},
      onOpenProfile() {},
      loadLeaderboard: async () => ({
        seasonNo: 1,
        entries: [{ rank: 1, displayName: long, publicId: 'p1', elo: 2400, pvpRank: 'gold' }],
        me: { rank: 1, elo: 2400, pvpRank: 'gold' },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    const found: InstanceType<typeof PIXI.Text>[] = [];
    const walk = (n: InstanceType<typeof PIXI.Container>): void => {
      if (n instanceof PIXI.Text && n.text.startsWith('长长')) found.push(n);
      for (const c of n.children) walk(c as InstanceType<typeof PIXI.Container>);
    };
    walk(scene.container);
    expect(found.length).toBeGreaterThan(0);
    for (const l of found) {
      expect((l.style.fontSize as number) * l.scale.x).toBeGreaterThanOrEqual(20);
      expect(l.text.endsWith('…')).toBe(true);
    }
    scene.destroy();
  });
});
