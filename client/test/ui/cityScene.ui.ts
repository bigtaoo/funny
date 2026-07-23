// Regression coverage for the CityScene card-grid + single-page layout
// (design/game/SLG_CITY_DESIGN.md §8.1 / §8.2).
//
// History:
//   - 2026-07-15 card-grid redesign caught two real bugs (both reproduced headless):
//       1. Building-grid viewport bug: `gridLayer.y` set to only `-scrollY`, forgetting the
//          `viewY` base offset, so cards rendered at the top while the mask started at viewY,
//          clipping every card out of view.
//       2. Modal hit-leak bug: opening a detail modal left the grid-card / build-queue-speedup
//          hits registered under the dim overlay, so a tap there fired the stale hit instead of
//          just closing the modal.
//   - 2026-07-23 single-page merge: the D-CITY-11 Domestic/Military tab split was removed. Base
//      durability moved into the header bar; the academy tech-tree became a normal grid card
//      again; the 5 team slots became one compact row pinned to the bottom. Tests updated to the
//      merged layout.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { marginLineX } from '../../src/render/sketchUi';
import { teamSlotId, teamSlotName, TEAM_CAP } from '../../src/game/meta/teamTroops';
import { formatDuration } from '../../src/scenes/worldmap/formatDuration';
import type { WorldApiClient, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const PORTRAIT: [number, number] = [800, 1280];
const LANDSCAPE: [number, number] = [1280, 800];

// The building grid holds every building (BUILDING_KEYS = 11, incl. academy) plus the synthetic
// "Train Troops" tile spliced after drillYard = 12 tiles; none scroll off-screen at the default
// (all-level-0) state, so all 12 register a hit.
const GRID_TILE_COUNT = 12;

type Rect = { x: number; y: number; w: number; h: number };
type Hit = Rect & { fn: () => void };

type CitySceneInternals = {
  w: number; h: number;
  hits: Hit[];
  selectedBuilding: string | null;
  contentX: number;
  scrollY: number;
  scrollMax: number;
  handleDown(x: number, y: number): void;
  handleUp(): void;
  render(): void;
};

function internals(scene: CityScene): CitySceneInternals {
  return scene as unknown as CitySceneInternals;
}

/**
 * Simulate a tap: press down then release. CityScene defers a cell's hit action to pointer-up
 * (ScrollTapGesture — so a drag starting on a card scrolls instead of opening it), so a test tap
 * must include the release, not just handleDown.
 */
function tap(inner: CitySceneInternals, x: number, y: number): void {
  inner.handleDown(x, y);
  inner.handleUp();
}

// hits[0] is always the header Back button (pushed first, unconditionally, in render()). All other
// hits sit right of the binding line (x >= contentX). The team row is pinned to the bottom band, so
// its hits split cleanly from the building-grid hits by y: grid tiles end well above the team row.
const TEAM_BAND_Y_THRESHOLD = 140;

function contentHits(inner: CitySceneInternals): Hit[] {
  return inner.hits.slice(1).filter((h) => h.x >= inner.contentX);
}
function gridHits(inner: CitySceneInternals): Hit[] {
  return contentHits(inner).filter((h) => h.y <= inner.h - TEAM_BAND_Y_THRESHOLD);
}
function teamHits(inner: CitySceneInternals): Hit[] {
  return contentHits(inner).filter((h) => h.y > inner.h - TEAM_BAND_Y_THRESHOLD);
}

/** All PIXI.Text content currently in the display tree, recursing sub-containers. */
function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

/** getMe() never resolves — enough for the grid/modal to sit in its default
 *  (all-buildings-level-0) state without a real network, which is all these
 *  structural/interaction tests need. */
function stubWorldApi(): WorldApiClient {
  return {
    getMe: () => new Promise<PlayerWorldView>(() => {}),
    upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
    speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
  } as unknown as WorldApiClient;
}

function buildScene(w: number, h: number): { scene: CityScene; input: InputManager; calls: { back: number } } {
  const calls = { back: 0 };
  const input = new InputManager();
  const cb: CitySceneCallbacks = {
    onBack: () => { calls.back++; },
    worldApi: stubWorldApi(),
    worldId: 'world:1:0',
  };
  const scene = new CityScene(createLayout(w, h), input, cb);
  return { scene, input, calls };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
  describe(`CityScene building grid — ${label} ${w}x${h}`, () => {
    it('all building grid tiles land fully within the screen and do not overlap each other', () => {
      const { scene } = buildScene(w, h);
      const inner = internals(scene);
      const cards = gridHits(inner);
      expect(cards.length).toBe(GRID_TILE_COUNT);

      for (const c of cards) {
        expect(c.x).toBeGreaterThanOrEqual(inner.contentX);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(inner.w + 1e-6);
        // Regression for the gridLayer viewY-offset bug: a card can never sit above the
        // build-queue strip (there's no legitimate content above the grid's own viewport).
        expect(c.y).toBeGreaterThan(100);
      }
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          expect(rectsOverlap(cards[i]!, cards[j]!)).toBe(false);
        }
      }
      scene.destroy();
    });

    it('content starts just right of the binding line (contentX = marginLineX, no sidebar rail)', () => {
      const { scene } = buildScene(w, h);
      const inner = internals(scene);
      expect(inner.contentX).toBe(marginLineX(inner.w));
      for (const c of contentHits(inner)) {
        expect(c.x).toBeGreaterThanOrEqual(inner.contentX);
      }
      scene.destroy();
    });

    it('tapping a building card opens its detail modal (selectedBuilding set)', () => {
      const { scene } = buildScene(w, h);
      const inner = internals(scene);
      const card = gridHits(inner)[0]!; // first building card ('desk')
      tap(inner, card.x + card.w / 2, card.y + card.h / 2);
      expect(inner.selectedBuilding).not.toBeNull();
      scene.destroy();
    });

    it('dragging on a building card scrolls the grid instead of opening its detail (tap-vs-drag)', () => {
      const { scene, input } = buildScene(w, h);
      const inner = internals(scene);
      const card = gridHits(inner)[0]!;
      const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
      // Press on the card, then drag up past the 6px threshold and release — a scroll, not a tap.
      input._emitDown(cx, cy);
      input._emitMove(cx, cy - 40);
      input._emitUp(cx, cy - 40);
      expect(inner.selectedBuilding).toBeNull(); // the card's detail must NOT have opened
      if (inner.scrollMax > 0) expect(inner.scrollY).toBe(Math.min(40, inner.scrollMax));
      scene.destroy();
    });
  });
}

describe('CityScene detail modal — hit gating (2026-07-15 modal-hit-leak fix)', () => {
  it('while a modal is open, tapping where a DIFFERENT building card used to sit closes the modal instead of switching buildings', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);

    const firstCard = gridHits(inner)[0]!; // 'desk'
    const secondCard = gridHits(inner)[1]!; // 'inkPot' — distinct coordinates from the first
    expect(rectsOverlap(firstCard, secondCard)).toBe(false);

    tap(inner, firstCard.x + firstCard.w / 2, firstCard.y + firstCard.h / 2);
    const openedAs = inner.selectedBuilding;
    expect(openedAs).not.toBeNull();

    // Tap the second card's old screen coordinates. Before the fix, this hit the stale grid
    // hit (which fires first in array order) and silently reassigned selectedBuilding.
    tap(inner, secondCard.x + secondCard.w / 2, secondCard.y + secondCard.h / 2);

    expect(inner.selectedBuilding).not.toBe('inkPot');
    scene.destroy();
  });

  it('the header Back button stays reachable while the modal is open', () => {
    const { scene, calls } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    const backHit = inner.hits[0]!;

    const card = gridHits(inner)[0]!;
    tap(inner, card.x + card.w / 2, card.y + card.h / 2);
    expect(inner.selectedBuilding).not.toBeNull();

    tap(inner, backHit.x + backHit.w / 2, backHit.y + backHit.h / 2);
    expect(calls.back).toBe(1);
    scene.destroy();
  });

  it('tapping far outside the (centered, narrower) modal panel closes it', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    const card = gridHits(inner)[0]!;
    tap(inner, card.x + card.w / 2, card.y + card.h / 2);
    expect(inner.selectedBuilding).not.toBeNull();

    tap(inner, inner.w - 2, inner.h - 2);
    expect(inner.selectedBuilding).toBeNull();
    scene.destroy();
  });

  it('academy is a normal grid card again (single-page merge) — tapping it opens the academy detail modal', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    // Find the academy tile by opening each grid card until selectedBuilding === 'academy'.
    let opened: string | null = null;
    for (const card of gridHits(inner)) {
      tap(inner, card.x + card.w / 2, card.y + card.h / 2);
      if (inner.selectedBuilding === 'academy') { opened = 'academy'; break; }
      // close and try the next
      tap(inner, inner.w - 2, inner.h - 2);
    }
    expect(opened).toBe('academy');
    scene.destroy();
  });
});

describe('CityScene header base-durability (D-CITY-8; moved into the header 2026-07-23)', () => {
  /** Resolves getMe with an explicit hp/maxHp pair so the header bar has real data to render. */
  function stubWorldApiWithDurability(hp: number, maxHp: number): WorldApiClient {
    const me = {
      resources: {}, buildings: {}, buildQueue: [], cardState: {}, teamState: {}, hp, maxHp,
    } as unknown as PlayerWorldView;
    return {
      getMe: () => Promise.resolve(me),
      getTeams: () => Promise.resolve([]),
      getMarches: () => Promise.resolve([]),
      getOccupations: () => Promise.resolve([]),
      upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
      speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
    } as unknown as WorldApiClient;
  }

  async function buildLoadedWithDurability(hp: number, maxHp: number): Promise<{ scene: CityScene; inner: CitySceneInternals }> {
    const input = new InputManager();
    const cb: CitySceneCallbacks = {
      onBack: () => {},
      worldApi: stubWorldApiWithDurability(hp, maxHp),
      worldId: 'world:1:0',
    };
    const scene = new CityScene(createLayout(...PORTRAIT), input, cb);
    await new Promise((r) => setTimeout(r, 0));
    return { scene, inner: internals(scene) };
  }

  it('renders the current/max durability value from PlayerWorldView.hp/maxHp in the header', async () => {
    const { scene, inner } = await buildLoadedWithDurability(3200, 8000);
    const texts = collectTexts(scene.container);
    // fmtNum floors to the nearest 'k' — 3200/8000 renders as "3k / 8k".
    expect(texts).toContain('3k / 8k');
    // The durability readout registers no hit (display-only) — only Back + the 12 grid tiles.
    expect(inner.hits.length).toBe(1 + GRID_TILE_COUNT);
    scene.destroy();
  });

  it('falls back to a full bar derived from the wall level when hp/maxHp is absent (no resolved anchor yet)', async () => {
    const { scene } = await buildLoadedWithDurability(undefined as unknown as number, undefined as unknown as number);
    const texts = collectTexts(scene.container);
    // Wall Lv.0 baseDurabilityMax renders as "N / N" (a value pair), not a crash.
    expect(texts.some((s) => / \/ /.test(s))).toBe(true);
    scene.destroy();
  });
});

describe('CityScene bottom team row (D-CITY-10; pinned single row 2026-07-23)', () => {
  type TeamsFixture = {
    me?: Partial<PlayerWorldView>;
    teams?: { id: string; name: string; army: { cardInstanceId?: string; initialHp?: number }[] }[];
    marches?: { marchId: string; mine?: boolean; teamId: string; arriveAt: number }[];
    occupations?: { teamId: string; dueAt: number }[];
  };

  /** Unlike stubWorldApi(), resolves getMe/getTeams/getMarches/getOccupations so the team
   *  row has real data to render. */
  function stubWorldApiWithTeams(fx: TeamsFixture): WorldApiClient {
    const me = {
      resources: {}, buildings: {}, buildQueue: [],
      cardState: {}, teamState: {},
      ...fx.me,
    } as unknown as PlayerWorldView;
    return {
      getMe: () => Promise.resolve(me),
      getTeams: () => Promise.resolve(fx.teams ?? []),
      getMarches: () => Promise.resolve(fx.marches ?? []),
      getOccupations: () => Promise.resolve(fx.occupations ?? []),
      upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
      speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
    } as unknown as WorldApiClient;
  }

  /** Builds a scene and waits for the async load() to resolve. Pass onEditTeam to wire the
   *  team-card tap-through (D-CITY-10). */
  async function buildLoaded(
    fx: TeamsFixture,
    onEditTeam?: (teamId: string, teamName: string) => void,
    dims: [number, number] = PORTRAIT,
  ): Promise<{ scene: CityScene; inner: CitySceneInternals }> {
    const input = new InputManager();
    const cb: CitySceneCallbacks = {
      onBack: () => {},
      worldApi: stubWorldApiWithTeams(fx),
      worldId: 'world:1:0',
      onEditTeam,
    };
    const scene = new CityScene(createLayout(...dims), input, cb);
    await new Promise((r) => setTimeout(r, 0));
    return { scene, inner: internals(scene) };
  }

  it('registers no team-card hits when no onEditTeam handler is wired (display-only fallback)', async () => {
    const { scene, inner } = await buildLoaded({
      teams: [
        { id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] },
        { id: 't2', name: 'Bravo', army: [{ cardInstanceId: 'c1' }] },
      ],
      marches: [{ marchId: 'm1', mine: true, teamId: 't1', arriveAt: Date.now() + 30_000 }],
      me: { cardState: { c1: { currentTroops: 400 } }, teamState: { t2: { injuredUntil: Date.now() + 60_000 } } },
    });
    expect(teamHits(inner).length).toBe(0);
    // Only Back + the 12 grid tiles register hits.
    expect(inner.hits.length).toBe(1 + GRID_TILE_COUNT);
    scene.destroy();
  });

  it('shows the section header and, for a filled idle team, garrison + committed troops and the idle tag', async () => {
    const { scene } = await buildLoaded({
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
      me: { cardState: { c1: { currentTroops: 400 } } },
    });
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('city.military.teams'));
    expect(texts).toContain(t('city.military.teamIdle'));
    // Garrison count + committed troops render as one combined sub-label, not separate nodes.
    const sub = `${t('world.defense.garrison').replace('{n}', '1')}   ${t('world.team.committed').replace('{n}', '400')}`;
    expect(texts).toContain(sub);
    scene.destroy();
  });

  it('a legacy unit-type team (pre-card-migration, no cards) shows committed 0 — its old initialHp entries carry nothing', async () => {
    const { scene } = await buildLoaded({
      teams: [{ id: 't1', name: 'Alpha', army: [{ initialHp: 240 }, { initialHp: 290 }] }],
      me: { cardState: {} },
    });
    const texts = collectTexts(scene.container);
    const sub = `${t('world.defense.garrison').replace('{n}', '2')}   ${t('world.team.committed').replace('{n}', '0')}`;
    expect(texts).toContain(sub);
    scene.destroy();
  });

  it('shows the marching tag for a team with an active march', async () => {
    const { scene } = await buildLoaded({
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
      marches: [{ marchId: 'm1', mine: true, teamId: 't1', arriveAt: Date.now() + 30_000 }],
      me: { cardState: { c1: { currentTroops: 400 } } },
    });
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('world.team.marching'));
    scene.destroy();
  });

  it('shows the occupying tag for a team holding an occupation', async () => {
    const { scene } = await buildLoaded({
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
      occupations: [{ teamId: 't1', dueAt: Date.now() + 90_000 }],
      me: { cardState: { c1: { currentTroops: 400 } } },
    });
    const texts = collectTexts(scene.container);
    expect(texts.some(s => s.includes(t('world.team.occupying').split('{time}')[0]!))).toBe(true);
    scene.destroy();
  });

  it('an injured team shows the injured tag, not the marching tag, even while also on an active march', async () => {
    const { scene } = await buildLoaded({
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
      marches: [{ marchId: 'm1', mine: true, teamId: 't1', arriveAt: Date.now() + 30_000 }],
      me: {
        cardState: { c1: { currentTroops: 400 } },
        teamState: { t1: { injuredUntil: Date.now() + 60_000 } },
      },
    });
    const texts = collectTexts(scene.container);
    expect(texts.some(s => s.includes(t('roster.injured').split('{time}')[0]!))).toBe(true);
    expect(texts).not.toContain(t('world.team.marching'));
    scene.destroy();
  });

  it('shows the empty-slot tag for unfilled team slots', async () => {
    const { scene } = await buildLoaded({ teams: [] });
    const texts = collectTexts(scene.container);
    // TEAM_CAP=5, all unfilled — the empty tag should appear once per slot.
    expect(texts.filter(s => s === t('world.team.empty')).length).toBe(TEAM_CAP);
    scene.destroy();
  });

  // ── Tap-to-edit (D-CITY-10 team card → formation editor) ──────────────────────

  it('registers one hit per team slot when onEditTeam is wired', async () => {
    const { scene, inner } = await buildLoaded({ teams: [] }, () => {});
    expect(teamHits(inner).length).toBe(TEAM_CAP);
    // Back + the 12 grid tiles + one hit per team slot.
    expect(inner.hits.length).toBe(1 + GRID_TILE_COUNT + TEAM_CAP);
    scene.destroy();
  });

  it('tapping a filled team card opens that team via onEditTeam with its id and name', async () => {
    const opened: Array<{ teamId: string; teamName: string }> = [];
    const { scene, inner } = await buildLoaded(
      { teams: [{ id: teamSlotId(0), name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }], me: { cardState: { c1: { currentTroops: 400 } } } },
      (teamId, teamName) => { opened.push({ teamId, teamName }); },
    );
    // Team hits are laid out left→right in slot order; slot 0 is the left-most.
    const teams = teamHits(inner).sort((a, b) => a.x - b.x);
    const firstSlot = teams[0]!;
    tap(inner, firstSlot.x + firstSlot.w / 2, firstSlot.y + firstSlot.h / 2);
    expect(opened).toEqual([{ teamId: teamSlotId(0), teamName: 'Alpha' }]);
    scene.destroy();
  });

  it('tapping an empty team slot still opens the editor, with the default slot id and name', async () => {
    const opened: Array<{ teamId: string; teamName: string }> = [];
    const { scene, inner } = await buildLoaded(
      { teams: [] },
      (teamId, teamName) => { opened.push({ teamId, teamName }); },
    );
    const teams = teamHits(inner).sort((a, b) => a.x - b.x);
    const firstSlot = teams[0]!;
    tap(inner, firstSlot.x + firstSlot.w / 2, firstSlot.y + firstSlot.h / 2);
    expect(opened).toEqual([{ teamId: teamSlotId(0), teamName: teamSlotName(0) }]);
    scene.destroy();
  });

  for (const [label, dims] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`the 5 team cards sit side-by-side in one bottom row — within screen, no overlap, no grid overlap — ${label}`, async () => {
      const { scene, inner } = await buildLoaded({ teams: [] }, () => {}, dims);
      const teams = teamHits(inner);
      expect(teams.length).toBe(TEAM_CAP);
      // All in a single row: identical y, ascending x.
      const sorted = [...teams].sort((a, b) => a.x - b.x);
      for (const th of sorted) {
        expect(th.x).toBeGreaterThanOrEqual(inner.contentX);
        expect(th.x + th.w).toBeLessThanOrEqual(inner.w + 1e-6);
        expect(th.y + th.h).toBeLessThanOrEqual(inner.h + 1e-6);
        expect(th.y).toBe(sorted[0]!.y); // one row
      }
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          expect(rectsOverlap(sorted[i]!, sorted[j]!)).toBe(false);
        }
      }
      // Team row never overlaps the building grid above it.
      for (const g of gridHits(inner)) {
        for (const th of teams) {
          expect(rectsOverlap(g, th)).toBe(false);
        }
      }
      scene.destroy();
    });
  }
});

describe('CityScene build-queue countdown label (2026-07-15 formatDuration fix)', () => {
  it('formats as mm:ss, not a raw-seconds count with a stray trailing "s"', () => {
    const secsLeft = 95; // 1:35
    const label = t('city.queueEntry')
      .replace('{name}', t('city.bld.graphiteMill'))
      .replace('{to}', '2')
      .replace('{sec}', formatDuration(secsLeft));

    expect(label).toContain('1:35');
    // The old template appended a literal "s" after what used to be a raw integer
    // (e.g. "95s left"); formatDuration's "1:35" must not get an "s" glued onto it.
    expect(label).not.toMatch(/\ds\b/);
  });

  it('formats hour-scale countdowns as h:mm:ss', () => {
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});
