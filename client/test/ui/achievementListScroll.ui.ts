// AchievementScene card list scroll (UI_DESIGN_LOG_2026-09 §67).
//
// The cards used to be drawn straight onto the page: no clip, no reserve for the portrait Career
// bottom bar, no scroll. With the three pvp achievements the third card ran under the bar, and its
// claim buttons were drawn (and hit-registered) behind it. Card heights are fractions of the design
// height, not text measurements, so unlike most layout gates this one reproduces under the headless
// text stub at the real portrait sizes.
//
// Driven through the real InputManager. What must hold:
//  * no claim hit ever sits under the bottom bar or outside the list viewport;
//  * the last card's claim is reachable by scrolling;
//  * a drag that starts on a claim button scrolls instead of claiming;
//  * a list that fits keeps firing on press, as before.
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { AchievementScene } from '../../src/scenes/AchievementScene';
import { bottomNavH } from '../../src/ui/widgets/HubTabs';
import type { AchievementsView } from '../../src/net/ApiClient';
import type { Rect } from '../../src/layout/ILayout';

initI18n('en');

/** Real pvp ids (their i18n keys exist); `n` cards, each with tier I claimable. */
const PVP_IDS = ['ach.kill.archer', 'ach.kill.guard', 'ach.pvp.wins'];
function view(n: number): AchievementsView {
  const defs = Array.from({ length: n }, (_, i) => ({
    id: PVP_IDS[i % PVP_IDS.length]!, statKey: `stat.${i}`, category: 'pvp',
    countsReplay: false,
    tiers: [{ threshold: 1, coins: 50 }, { threshold: 5, coins: 150 }, { threshold: 9, coins: 300 }],
  }));
  const stats: Record<string, number> = {};
  defs.forEach((d) => { stats[d.statKey] = 1; });
  return { defs, stats, achievements: {} } as unknown as AchievementsView;
}

type Hit = { rect: Rect; sound?: string };
type Internals = { hits: Hit[]; scrollY: number; scrollMax: number; scrollView: Rect };
const internals = (s: AchievementScene): Internals => s as unknown as Internals;
const rewardHits = (s: AchievementScene): Hit[] => internals(s).hits.filter((h) => h.sound === 'sfx.ui.reward');
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(size: [number, number], n: number): Promise<{
  s: AchievementScene; input: InputManager; claims: string[]; h: number;
}> {
  const layout = createLayout(size[0], size[1]);
  const input = new InputManager();
  const claims: string[] = [];
  const s = new AchievementScene(layout, input, {
    onBack() {},
    // The Career peer callbacks are what put the portrait bottom bar on screen.
    onOpenStats() {}, onOpenTitles() {}, onOpenCodex() {},
    loadAchievements: () => Promise.resolve(view(n)),
    onClaim: (id: string) => { claims.push(id); return Promise.resolve(50); },
  });
  await flush();
  return { s, input, claims, h: layout.designHeight };
}

const centre = (r: Rect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];

describe('AchievementScene — the card list scrolls above the Career bar', () => {
  for (const size of [[390, 844], [360, 640]] as [number, number][]) {
    it(`portrait ${size.join('x')}: three pvp cards overflow, and no claim hit is under the bar`, async () => {
      const { s, h } = await mount(size, 3);
      const barTop = h - bottomNavH(h);
      const v = internals(s).scrollView;
      expect(internals(s).scrollMax, 'the real pvp category no longer fits above the bar').toBeGreaterThan(0);
      expect(v.y + v.h).toBeLessThanOrEqual(barTop);
      for (const hit of rewardHits(s)) {
        expect(hit.rect.y).toBeGreaterThanOrEqual(v.y);
        expect(hit.rect.y + hit.rect.h).toBeLessThanOrEqual(v.y + v.h);
      }
      s.destroy();
    });
  }

  it('the last card is reachable: wheel to the end, then its claim sits above the bar and fires', async () => {
    const { s, input, claims, h } = await mount([390, 844], 5);
    const v = internals(s).scrollView;
    // Before scrolling, the lower cards' claims are below the fold: they must not be live there.
    expect(rewardHits(s).length, 'precondition: some claims are out of view').toBeLessThan(5);
    for (const hit of rewardHits(s)) expect(hit.rect.y + hit.rect.h).toBeLessThanOrEqual(v.y + v.h);
    input._emitWheel(v.x + v.w / 2, v.y + v.h / 2, 1e6);
    expect(internals(s).scrollY).toBe(internals(s).scrollMax);
    const lowest = rewardHits(s).reduce((a, b) => (b.rect.y > a.rect.y ? b : a));
    expect(lowest.rect.y + lowest.rect.h).toBeLessThanOrEqual(h - bottomNavH(h));
    const [x, y] = centre(lowest.rect);
    input._emitDown(x, y);
    expect(claims, 'a scrollable list defers the tap to release').toEqual([]);
    input._emitUp(x, y);
    expect(claims).toEqual([PVP_IDS[4 % PVP_IDS.length]]);
    s.destroy();
  });

  it('a drag that starts on a claim button scrolls the list and claims nothing', async () => {
    const { s, input, claims } = await mount([390, 844], 5);
    const [x, y] = centre(rewardHits(s)[0]!.rect);
    input._emitDown(x, y);
    input._emitMove(x, y - 40);
    input._emitMove(x, y - 160);
    input._emitUp(x, y - 160);
    expect(claims).toEqual([]);
    expect(internals(s).scrollY).toBeGreaterThan(0);
    s.destroy();
  });

  it('a list that fits does not scroll, and a press still claims on down', async () => {
    const { s, input, claims } = await mount([390, 844], 1);
    expect(internals(s).scrollMax).toBe(0);
    input._emitDown(...centre(rewardHits(s)[0]!.rect));
    expect(claims).toEqual([PVP_IDS[0]]);
    s.destroy();
  });

  it('landscape 844x390: every claim hit stays inside the list viewport', async () => {
    const { s } = await mount([844, 390], 8);
    const v = internals(s).scrollView;
    expect(internals(s).scrollMax).toBeGreaterThan(0);
    for (const hit of rewardHits(s)) {
      expect(hit.rect.y).toBeGreaterThanOrEqual(v.y);
      expect(hit.rect.y + hit.rect.h).toBeLessThanOrEqual(v.y + v.h);
    }
    s.destroy();
  });
});
