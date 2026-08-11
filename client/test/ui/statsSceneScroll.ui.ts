// Regression coverage for StatsScene's portrait single-column layout not being
// scrollable — the four stacked sections (ranked/campaign/collection/match history)
// can exceed one screen (esp. with a full match-history feed), but the constructor
// only subscribed to `input.onDown` and render() never masked/clipped the content,
// so anything past the first screen was permanently unreachable in portrait. Fix:
// wire onMove/onUp/onWheel + a masked drag/wheel-scroll body, mirroring
// TitlesScene/CardCodexScene's pattern (same bug class as BattlePassScene's reward
// track — see battlePassScroll.ui.ts).
//
// Landscape's two-column layout fits one screen and must stay on its old immediate
// tap-on-down path unchanged — covered here by asserting scrollMax stays 0 there.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { StatsScene, type StatsCallbacks } from '../../src/scenes/StatsScene';
import type { MatchHistoryEntry } from '../../src/net/ApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const FULL_HISTORY: MatchHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
  roomId: `r${i}`,
  mode: 'ranked',
  result: 'win' as const,
  opponentName: `Opp${i}`,
  eloDelta: 1,
  ts: i,
}));

function buildStats(input: InputManager, w: number, h: number, cb: Partial<StatsCallbacks> = {}): StatsScene {
  return new StatsScene(createLayout(w, h), input, {
    onBack() {},
    getStats: () => ({
      pvp: { rank: 'bronze', elo: 1000, wins: 12, losses: 5, streak: 3 },
      cleared: 2,
      totalLevels: 4,
      stars: 5,
      skinsOwned: 1,
      materials: { scrap: 30, lead: 10, binding: 4 },
    }),
    // A full match-history feed is what pushes the portrait column past one screen.
    loadHistory: async () => FULL_HISTORY,
    getMyRank: async () => 3,
    onOpenLeaderboard() {},
    season: { seasonNo: 1, endAt: Date.now() + 86400000 },
    // Career hub peer strip — reserves bottom-nav height out of the portrait viewport.
    onOpenTitles() {}, onOpenAchievements() {}, onOpenCodex() {},
    ...cb,
  });
}

/** Let fetchHistory/fetchMyRank microtasks + their re-render settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('StatsScene — portrait scroll', () => {
  it('portrait: a full page overflows one screen (scrollMax > 0)', async () => {
    const scene = buildStats(new InputManager(), 800, 1280);
    await flush();
    expect((scene as unknown as { scrollMax: number }).scrollMax).toBeGreaterThan(0);
    scene.destroy();
  });

  it('landscape: the two-column layout fits one screen (scrollMax stays 0, unaffected by the portrait fix)', async () => {
    const scene = buildStats(new InputManager(), 1280, 800);
    await flush();
    expect((scene as unknown as { scrollMax: number }).scrollMax).toBe(0);
    scene.destroy();
  });

  it('portrait: dragging up moves scrollY forward, clamped to scrollMax', async () => {
    const input = new InputManager();
    const scene = buildStats(input, 800, 1280);
    await flush();
    const s = scene as unknown as { scrollY: number; scrollMax: number };
    expect(s.scrollY).toBe(0);

    // Start well clear of any row hit rect (leaderboard link / replay rows), drag up
    // past the >6px move threshold.
    input._emitDown(700, 50);
    input._emitMove(700, 50 - 40);
    expect(s.scrollY).toBe(40);

    // Continuing well past scrollMax must clamp, not overshoot.
    input._emitMove(700, 50 - 100000);
    expect(s.scrollY).toBe(s.scrollMax);

    input._emitUp(700, 50 - 100000);
    scene.destroy();
  });

  it('portrait: a small drag (<=6px) still fires a tap instead of starting a scroll', async () => {
    const input = new InputManager();
    let backCount = 0;
    // No peer-tab callbacks here — drawCareer() then no-ops, so it doesn't unshift
    // extra hits in front of the header's, keeping hits[0] the back button rect.
    const scene = buildStats(input, 800, 1280, {
      onBack: () => { backCount++; },
      onOpenTitles: undefined, onOpenAchievements: undefined, onOpenCodex: undefined,
    });
    await flush();
    const hdrBack = (scene as unknown as { hits: Array<{ rect: { x: number; y: number; w: number; h: number } }> }).hits[0]!.rect;

    input._emitDown(hdrBack.x + 2, hdrBack.y + 2);
    input._emitMove(hdrBack.x + 4, hdrBack.y + 2); // 2px jitter, under the 6px drag threshold
    input._emitUp(hdrBack.x + 2, hdrBack.y + 2);
    expect(backCount).toBe(1);
    scene.destroy();
  });

  it('landscape: tap still dispatches immediately on down (old behavior preserved)', async () => {
    const input = new InputManager();
    let backCount = 0;
    const scene = buildStats(input, 1280, 800, {
      onBack: () => { backCount++; },
      onOpenTitles: undefined, onOpenAchievements: undefined, onOpenCodex: undefined,
    });
    await flush();
    const hdrBack = (scene as unknown as { hits: Array<{ rect: { x: number; y: number; w: number; h: number } }> }).hits[0]!.rect;
    input._emitDown(hdrBack.x + 2, hdrBack.y + 2);
    expect(backCount).toBe(1); // fires on down, no onUp needed
    scene.destroy();
  });
});
