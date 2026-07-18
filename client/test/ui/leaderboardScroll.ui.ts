// Regression coverage for LeaderboardScene's drag-scroll jank fix (2026-07-18).
// LeaderboardScene.onPointerMove used to call this.render() directly on every raw
// pointermove — a full tearDownChildren + rebuild of every row (sketchPanel border +
// medal/text nodes) in the up-to-100-row list. Fixed with the same reposition-only
// fast path BattlePassScene uses: cache row hit-defs at render() time, then have
// onPointerMove just move the existing listContainer and redraw the scroll indicator
// (see updateScrollPosition()), with no render()/tearDownChildren call during drag.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { LeaderboardScene, type LeaderboardEntry } from '../../src/scenes/LeaderboardScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makeEntries(n: number): LeaderboardEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    rank: i + 1,
    displayName: `Player${i}`,
    publicId: `pub_${i}`,
    elo: 2000 - i,
    pvpRank: 'gold',
  }));
}

async function buildLeaderboard(input: InputManager, count = 100): Promise<LeaderboardScene> {
  const scene = new LeaderboardScene(createLayout(800, 1280), input, {
    onBack() {},
    onOpenProfile() {},
    loadLeaderboard: async () => ({ seasonNo: 1, entries: makeEntries(count), me: { rank: 1, elo: 2000, pvpRank: 'gold' } }),
  });
  // Flush the fetchData() microtask queued by the constructor so the full row list renders.
  await Promise.resolve();
  await Promise.resolve();
  return scene;
}

describe('LeaderboardScene — drag-scroll perf fast path', () => {
  it('has scrollable content with a 100-row leaderboard (scrollMax > 0)', async () => {
    const scene = await buildLeaderboard(new InputManager());
    const s = scene as unknown as { scrollMax: number };
    expect(s.scrollMax).toBeGreaterThan(0);
    scene.destroy();
  });

  it('drag-scroll never calls render() (reposition-only, not full rebuild)', async () => {
    const input = new InputManager();
    const scene = await buildLeaderboard(input);
    const renderSpy = vi.spyOn(scene as any, 'render');

    input._emitDown(400, 640);
    input._emitMove(400, 600);
    input._emitMove(400, 560);
    input._emitMove(400, 520);

    expect(renderSpy).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('reuses the same listContainer instance across a drag move (no full rebuild)', async () => {
    const input = new InputManager();
    const scene = await buildLeaderboard(input);
    const s = scene as unknown as { listContainer: unknown };
    const before = s.listContainer;
    expect(before).not.toBeNull();

    input._emitDown(400, 640);
    input._emitMove(400, 600);

    expect(s.listContainer).toBe(before);
    scene.destroy();
  });

  it("moves the listContainer's y by exactly -dy on drag, without touching listTop", async () => {
    const input = new InputManager();
    const scene = await buildLeaderboard(input);
    const s = scene as unknown as { listContainer: { y: number }; listTop: number };
    const y0 = s.listContainer.y;
    const listTop0 = s.listTop;

    input._emitDown(400, 640);
    input._emitMove(400, 600); // dy = -40

    expect(s.listContainer.y).toBe(y0 - 40);
    expect(s.listTop).toBe(listTop0);
    scene.destroy();
  });

  it('cached row hit-defs for rows beyond the initial viewport still fire onOpenProfile once scrolled into view', async () => {
    const input = new InputManager();
    const opened: string[] = [];
    const scene = new LeaderboardScene(createLayout(800, 1280), input, {
      onBack() {},
      onOpenProfile: (id) => opened.push(id),
      loadLeaderboard: async () => ({ seasonNo: 1, entries: makeEntries(100) }),
    });
    await Promise.resolve();
    await Promise.resolve();

    const s = scene as unknown as {
      scrollMax: number;
      rowDefs: Array<{ y: number; h: number; fn: () => void }>;
      listTop: number;
    };
    expect(s.scrollMax).toBeGreaterThan(0);
    const lastRowDef = s.rowDefs.reduce((a, b) => (b.y > a.y ? b : a));

    // Scroll all the way down (drag far past scrollMax, which clamps) so the last row is
    // now on-screen, then tap it directly via its recomputed absolute rect.
    input._emitDown(400, 640);
    input._emitMove(400, 640 - 1_000_000);
    input._emitUp(400, 640 - 1_000_000);

    const absY = s.listTop - s.scrollMax + lastRowDef.y;
    input._emitDown(400, absY + lastRowDef.h / 2);
    input._emitUp(400, absY + lastRowDef.h / 2);

    expect(opened).toEqual(['pub_99']);
    scene.destroy();
  });

  it('clamps scrollY to [0, scrollMax] across multiple accumulating drag moves', async () => {
    const input = new InputManager();
    const scene = await buildLeaderboard(input);
    const s = scene as unknown as { scrollY: number; scrollMax: number };

    // Drag far past the bottom in several steps — each move should re-clamp, not overshoot.
    input._emitDown(400, 640);
    input._emitMove(400, 400);
    input._emitMove(400, 100);
    input._emitMove(400, -1_000_000);
    expect(s.scrollY).toBe(s.scrollMax);
    input._emitUp(400, -1_000_000);

    // Drag back up past the top in several steps — should clamp to 0, not go negative.
    input._emitDown(400, -1_000_000);
    input._emitMove(400, -500_000);
    input._emitMove(400, 1_000_000);
    expect(s.scrollY).toBe(0);
    scene.destroy();
  });

  it('back-button hit rect (not one of rowDefs) still fires after a drag scroll', async () => {
    const input = new InputManager();
    let backed = false;
    const scene = new LeaderboardScene(createLayout(800, 1280), input, {
      onBack: () => { backed = true; },
      onOpenProfile() {},
      loadLeaderboard: async () => ({ seasonNo: 1, entries: makeEntries(100) }),
    });
    await Promise.resolve();
    await Promise.resolve();

    input._emitDown(400, 640);
    input._emitMove(400, 600);
    input._emitMove(400, 560);
    input._emitUp(400, 560);

    // render() pushes the header's back-button hit first, before any row hits; updateScrollPosition()
    // only filters/re-adds rowDefs-matching hits, so index 0 stays the back button throughout a drag.
    const s = scene as unknown as { hits: Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }> };
    const backHit = s.hits[0];
    input._emitDown(backHit.rect.x + 5, backHit.rect.y + 5);
    input._emitUp(backHit.rect.x + 5, backHit.rect.y + 5);

    expect(backed).toBe(true);
    scene.destroy();
  });

  it('a released drag (dragging=true on pointer-up) does not fire a row tap', async () => {
    const input = new InputManager();
    const opened: string[] = [];
    const scene = new LeaderboardScene(createLayout(800, 1280), input, {
      onBack() {},
      onOpenProfile: (id) => opened.push(id),
      loadLeaderboard: async () => ({ seasonNo: 1, entries: makeEntries(100) }),
    });
    await Promise.resolve();
    await Promise.resolve();

    // Press on a row, drag past the threshold, release — must not open that row's profile.
    input._emitDown(400, 640);
    input._emitMove(400, 600);
    input._emitMove(400, 560);
    input._emitUp(400, 560);

    expect(opened).toEqual([]);
    scene.destroy();
  });
});
