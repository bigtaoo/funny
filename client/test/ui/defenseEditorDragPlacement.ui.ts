// Coverage for DefenseEditorScene's roster-to-grid drag-placement pointer path
// (handleDown/handleMove/handleUp in input.ts) — the 2026-08-05 client-test-audit flagged this as
// completely untested: every existing placement test (defenseEditorAttackCards.ui.ts) sets
// `this.tool` directly and calls `onGridTap()` straight, bypassing the pointer layer entirely —
// tap-vs-scroll-vs-drag classification (candidate armed on roster-down, promoted to an active drag
// only once the pointer crosses left of the roster into the grid) had zero coverage of any kind.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree, real
// render() (so rosterX/rosterY/rosterCardHits/gridX/gridY/cellW/cellH are populated the same way a
// live scene would), no renderer/screenshot needed. Mirrors defenseEditorAttackCards.ui.ts's harness.

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { DefenseEditorScene, type DefenseEditorCallbacks } from '../../src/scenes/DefenseEditorScene';
import { makeNewSave, type SaveData } from '../../src/game/meta/SaveData';
import type { WorldApiClient, TeamTemplate, CardSLGState, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const WORLD_ID = 'world:1:0';

function buildSave(cardCount: number): SaveData {
  const save = makeNewSave('acc_test');
  for (let i = 0; i < cardCount; i++) {
    save.cardInv![`c${i}`] = { id: `c${i}`, defId: 'lichuang', level: 1, gear: {}, locked: false };
  }
  return save;
}

function buildHarness(opts: { cardCount?: number; cardState?: Record<string, CardSLGState>; teams?: TeamTemplate[] } = {}) {
  const save = buildSave(opts.cardCount ?? 2);
  const setTeams = vi.fn().mockResolvedValue(undefined);
  const getTeams = vi.fn().mockResolvedValue(opts.teams ?? [{ id: 't1', name: 'Team 1', army: [] }]);
  const getMe = vi.fn().mockResolvedValue({ cardState: opts.cardState ?? {} } as PlayerWorldView);
  const worldApi = { getTeams, setTeams, getMe } as unknown as WorldApiClient;

  const cb: DefenseEditorCallbacks = {
    onBack: vi.fn(),
    getSave: () => save,
    worldApi,
    worldId: WORLD_ID,
    target: { mode: 'attack', teamId: 't1', teamName: 'Team 1' },
  };
  const scene = new DefenseEditorScene(createLayout(800, 1280), new InputManager(), cb);
  return { scene, cb, save, setTeams, getTeams, getMe };
}

async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

/** Reads back the private roster/grid/drag fields the pointer path touches — TS privacy is
 *  compile-time only, same reasoning as defenseEditorAttackCards.ui.ts's cellCenter helper.
 *  2026-08-11: DefenseEditorScene converted from a mixin-chain `extends` to composition (see
 *  claudedocs/client-modules.md's split-form priority note) — these all live on the composed
 *  `core` field now, and handleDown/handleMove/handleUp live on the composed `input` field
 *  (see inputOf below). */
function fields(scene: DefenseEditorScene): {
  rosterX: number; rosterY: number; rosterW: number; rosterH: number;
  rosterCardHits: { rect: { x: number; y: number; w: number; h: number }; cardId: string; unitType: string }[];
  gridX: number; gridY: number; cellW: number; cellH: number;
  dragCardId: string | null; dragUnitType: string | null; dragging: boolean;
  garrison: Map<string, { cardInstanceId?: string }>;
  scrollY: number;
} {
  return (scene as unknown as { core: unknown }).core as ReturnType<typeof fields>;
}

function inputOf(scene: DefenseEditorScene): {
  handleDown(x: number, y: number): void;
  handleMove(x: number, y: number): void;
  handleUp(x: number, y: number): void;
} {
  return (scene as unknown as { input: unknown }).input as ReturnType<typeof inputOf>;
}

function cellCenter(scene: DefenseEditorScene, col: number, dr: number): [number, number] {
  const s = fields(scene);
  return [s.gridX + col * s.cellW + s.cellW / 2, s.gridY + dr * s.cellH + s.cellH / 2];
}

/** First roster row's center point (the palette card `handleDown` needs to land on to arm a drag). */
function firstRosterCardCenter(scene: DefenseEditorScene): [number, number] {
  const hit = fields(scene).rosterCardHits[0]!;
  return [hit.rect.x + hit.rect.w / 2, hit.rect.y + hit.rect.h / 2];
}

describe('DefenseEditorScene — roster-to-grid drag placement (pointer path)', () => {
  it('pressing down on a roster card arms a drag candidate without placing anything yet', async () => {
    const { scene } = buildHarness({ cardCount: 1, cardState: { c0: { currentTroops: 100 } } });
    await flush();
    const [rx, ry] = firstRosterCardCenter(scene);

    inputOf(scene).handleDown(rx, ry);

    const s = fields(scene);
    expect(s.dragCardId).toBe('c0');
    expect(s.dragging).toBe(false); // armed, not yet promoted — hasn't crossed into the grid
    expect(s.garrison.size).toBe(0);
  });

  it('moving from the roster into the grid promotes the candidate to an active drag', async () => {
    const { scene } = buildHarness({ cardCount: 1, cardState: { c0: { currentTroops: 100 } } });
    await flush();
    const [rx, ry] = firstRosterCardCenter(scene);
    const [gx, gy] = cellCenter(scene, 0, 0);
    const handle = inputOf(scene);

    handle.handleDown(rx, ry);
    handle.handleMove(gx, gy); // crosses left of rosterX → promotes to an active drag

    expect(fields(scene).dragging).toBe(true);
  });

  it('releasing over a valid grid cell commits the placement (same rules as a tap)', async () => {
    const { scene } = buildHarness({ cardCount: 1, cardState: { c0: { currentTroops: 200 } } });
    await flush();
    const [rx, ry] = firstRosterCardCenter(scene);
    const [gx, gy] = cellCenter(scene, 0, 0);
    const handle = inputOf(scene);

    handle.handleDown(rx, ry);
    handle.handleMove(gx, gy);
    handle.handleUp(gx, gy);

    const s = fields(scene);
    expect(s.garrison.get('0:8')).toMatchObject({ cardInstanceId: 'c0' });
    // Drag state fully released after the drop.
    expect(s.dragging).toBe(false);
    expect(s.dragCardId).toBeNull();
  });

  it('releasing over an invalid (non-lane) column drops nothing but still clears drag state', async () => {
    const { scene } = buildHarness({ cardCount: 1, cardState: { c0: { currentTroops: 200 } } });
    await flush();
    const [rx, ry] = firstRosterCardCenter(scene);
    // Column 5 is not in ATTACK_LANES (server/engine/src/config.ts) — a valid-looking grid coordinate
    // whose col index still fails onGridTap's lane check.
    const [gx, gy] = cellCenter(scene, 5, 0);
    const handle = inputOf(scene);

    handle.handleDown(rx, ry);
    handle.handleMove(gx, gy);
    handle.handleUp(gx, gy);

    const s = fields(scene);
    expect(s.garrison.size).toBe(0);
    expect(s.dragging).toBe(false);
    expect(s.dragCardId).toBeNull();
  });

  it('dropping a card that is already placed elsewhere moves it (old cell clears) — real drop path, not onGridTap called directly', async () => {
    const { scene } = buildHarness({ cardCount: 1, cardState: { c0: { currentTroops: 200 } } });
    await flush();
    const handle = inputOf(scene);

    // First drop at (0,0).
    let [rx, ry] = firstRosterCardCenter(scene);
    let [gx, gy] = cellCenter(scene, 0, 0);
    handle.handleDown(rx, ry); handle.handleMove(gx, gy); handle.handleUp(gx, gy);
    expect(fields(scene).garrison.has('0:8')).toBe(true);

    // Second drop of the SAME card at (1,0) — moves it; the old cell must clear.
    [rx, ry] = firstRosterCardCenter(scene);
    [gx, gy] = cellCenter(scene, 1, 0);
    handle.handleDown(rx, ry); handle.handleMove(gx, gy); handle.handleUp(gx, gy);

    const s = fields(scene);
    expect(s.garrison.has('0:8')).toBe(false);
    expect(s.garrison.get('1:8')).toMatchObject({ cardInstanceId: 'c0' });
  });

  it('a vertical drag that never crosses into the grid scrolls the roster instead of arming a drag', async () => {
    const { scene } = buildHarness({ cardCount: 6 });
    await flush();
    const [rx, ry] = firstRosterCardCenter(scene);
    const handle = inputOf(scene);

    handle.handleDown(rx, ry);
    handle.handleMove(rx, ry + 80); // moves, but stays inside the roster column (x unchanged)
    handle.handleUp(rx, ry + 80);

    // Never promoted to a drag, so nothing was placed and dragging never flipped true.
    expect(fields(scene).garrison.size).toBe(0);
    expect(fields(scene).dragging).toBe(false);
  });
});
