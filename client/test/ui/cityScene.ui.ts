// Regression coverage for the 2026-07-15 CityScene card-grid redesign
// (design/game/SLG_CITY_DESIGN.md §8.1).
//
// Covers two real bugs caught during visual verification of the redesign (not
// hypothetical — both reproduced in a headless render before the fix):
//
//   1. Building-grid viewport bug: `gridLayer.y` was set to only `-scrollY`,
//      forgetting the `viewY` base offset (the space taken by the header +
//      resource bar + build-queue strip above the grid). Cards rendered at the
//      top of the screen while the scroll mask started at `viewY`, clipping
//      every card out of the visible viewport.
//   2. Modal hit-leak bug: opening a building's detail modal left the
//      building-grid card hits (and the build-queue speedup hit) registered
//      underneath the dim overlay. Because they were pushed into `this.hits`
//      before the modal's full-screen "tap outside to close" catch-all, tapping
//      a dimmed card still fired that card's `fn` (switching to a different
//      building) instead of just closing the modal.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { sidebarNavW } from '../../src/ui/widgets/HubTabs';
import { teamSlotId, teamSlotName, TEAM_CAP } from '../../src/scenes/TeamsScene';
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

type Rect = { x: number; y: number; w: number; h: number };
type Hit = Rect & { fn: () => void };

type CitySceneInternals = {
  w: number; h: number;
  hits: Hit[];
  selectedBuilding: string | null;
  page: 'domestic' | 'military';
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

// The Domestic/Military switch moved from a horizontal strip above the body (2026-07-16
// D-CITY-11) to a vertical rail LEFT of the binding line (2026-07-16 rework), reusing the
// Roster/Equipment sidebar-nav convention (HubTabs.drawSidebarTabs/sidebarNavW). That widget
// only registers a hit for the INACTIVE tab (tapping the already-active tab is a no-op), so
// the hit list no longer has a fixed "Back + 2 tabs + N cards" shape — it's "Back + 1 tab hit
// (whichever page isn't current) + N content hits". Content hits always land at
// x >= inner.contentX (the rail's width); the tab hit is the sole remaining entry left of it.
// hits[0] is always the header Back button (pushed first, unconditionally, in render()).
function tabHit(inner: CitySceneInternals): Hit {
  const candidates = inner.hits.slice(1).filter((h) => h.x < inner.contentX);
  expect(candidates.length).toBe(1);
  return candidates[0]!;
}

function contentHits(inner: CitySceneInternals): Hit[] {
  return inner.hits.slice(1).filter((h) => h.x >= inner.contentX);
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
    it('all 11 building cards land fully within the screen and do not overlap each other', () => {
      const { scene } = buildScene(w, h);
      const inner = internals(scene);
      // hits[0] is the header Back button; contentHits() are the grid cards — BUILDING_KEYS.length
      // (11, incl. satchel/D-CITY-9) minus academy, which D-CITY-12 moved to its own
      // military-page panel. (The Domestic/Military rail's own hit is excluded — it lives left
      // of contentX, see tabHit()/contentHits() above.)
      const cards = contentHits(inner);
      expect(cards.length).toBe(10);

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

    it('tapping a building card opens its detail modal (selectedBuilding set)', () => {
      const { scene } = buildScene(w, h);
      const inner = internals(scene);
      const card = contentHits(inner)[0]!; // first building card ('desk')
      tap(inner, card.x + card.w / 2, card.y + card.h / 2);
      expect(inner.selectedBuilding).not.toBeNull();
      scene.destroy();
    });

    it('dragging on a building card scrolls the grid instead of opening its detail (tap-vs-drag)', () => {
      const { scene, input } = buildScene(w, h);
      const inner = internals(scene);
      const card = contentHits(inner)[0]!;
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

    const firstCard = contentHits(inner)[0]!; // 'desk'
    const secondCard = contentHits(inner)[1]!; // 'inkPot' — distinct coordinates from the first
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

    const card = contentHits(inner)[0]!;
    tap(inner, card.x + card.w / 2, card.y + card.h / 2);
    expect(inner.selectedBuilding).not.toBeNull();

    tap(inner, backHit.x + backHit.w / 2, backHit.y + backHit.h / 2);
    expect(calls.back).toBe(1);
    scene.destroy();
  });

  it('tapping far outside the (centered, narrower) modal panel closes it', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    const card = contentHits(inner)[0]!;
    tap(inner, card.x + card.w / 2, card.y + card.h / 2);
    expect(inner.selectedBuilding).not.toBeNull();

    tap(inner, inner.w - 2, inner.h - 2);
    expect(inner.selectedBuilding).toBeNull();
    scene.destroy();
  });
});

describe('CityScene page tabs (D-CITY-11 dual-screen split; left rail rework 2026-07-16)', () => {
  it('starts on the domestic page and switches to the military page via the rail tab hit', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    expect(inner.page).toBe('domestic');

    const militaryTab = tabHit(inner);
    tap(inner, militaryTab.x + militaryTab.w / 2, militaryTab.y + militaryTab.h / 2);
    expect(inner.page).toBe('military');
    // Building-grid card hits must not leak into the military page's hit list — only the
    // D-CITY-12 tech-tree panel (academy) remains as a content hit there.
    expect(contentHits(inner).length).toBe(1);
    expect(inner.hits.length).toBe(3); // back + rail tab + tech-tree panel

    const domesticTab = tabHit(inner);
    tap(inner, domesticTab.x + domesticTab.w / 2, domesticTab.y + domesticTab.h / 2);
    expect(inner.page).toBe('domestic');
    scene.destroy();
  });

  it('the Back button stays reachable on the military page', () => {
    const { scene, calls } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    const militaryTab = tabHit(inner);
    tap(inner, militaryTab.x + militaryTab.w / 2, militaryTab.y + militaryTab.h / 2);
    expect(inner.page).toBe('military');

    const backHit = inner.hits[0]!;
    tap(inner, backHit.x + backHit.w / 2, backHit.y + backHit.h / 2);
    expect(calls.back).toBe(1);
    scene.destroy();
  });

  for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`the rail sits left of contentX (= sidebarNavW) and content never overlaps it — ${label}`, () => {
      const { scene } = buildScene(w, h);
      const inner = internals(scene);
      const landscape = h < w;
      // sidebarNavW reads off the scene's own (design-resolution) w/h, not the raw viewport
      // dims passed to createLayout() — ILayout maps those to a fixed design resolution.
      expect(inner.contentX).toBe(sidebarNavW(inner.w, inner.h, landscape));

      const rail = tabHit(inner);
      expect(rail.x).toBeGreaterThanOrEqual(0);
      expect(rail.x + rail.w).toBeLessThanOrEqual(inner.contentX + 1e-6);

      for (const c of contentHits(inner)) {
        expect(c.x).toBeGreaterThanOrEqual(inner.contentX);
      }
      scene.destroy();
    });
  }
});

function gotoMilitary(inner: CitySceneInternals): void {
  const militaryTab = tabHit(inner);
  tap(inner, militaryTab.x + militaryTab.w / 2, militaryTab.y + militaryTab.h / 2);
}

describe('CityScene tech-tree panel (D-CITY-12, 2026-07-16)', () => {
  it('tapping the military page tech-tree panel opens the academy detail modal', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    gotoMilitary(inner);
    expect(inner.page).toBe('military');

    const techTreeHit = contentHits(inner)[0]!;
    tap(inner, techTreeHit.x + techTreeHit.w / 2, techTreeHit.y + techTreeHit.h / 2);
    expect(inner.selectedBuilding).toBe('academy');
    scene.destroy();
  });

  it('academy no longer appears as a card in the domestic building grid', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    // 10 cards now (11 BUILDING_KEYS minus academy).
    expect(contentHits(inner).length).toBe(10);
    scene.destroy();
  });

  for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`the tech-tree panel hit lands fully within the screen, right of the rail — ${label}`, () => {
      const { scene } = buildScene(w, h);
      const inner = internals(scene);
      gotoMilitary(inner);
      const techTreeHit = contentHits(inner)[0]!;

      expect(techTreeHit.x).toBeGreaterThanOrEqual(inner.contentX);
      expect(techTreeHit.x + techTreeHit.w).toBeLessThanOrEqual(inner.w + 1e-6);
      expect(techTreeHit.y + techTreeHit.h).toBeLessThanOrEqual(inner.h + 1e-6);
      scene.destroy();
    });
  }

  it('opening the academy modal from the military page drops the rail-tab hit underneath the dim overlay (same modal-hit-gating invariant as the domestic page)', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    gotoMilitary(inner);
    const railTab = tabHit(inner); // position to re-tap once the modal is open

    const techTreeHit = contentHits(inner)[0]!;
    tap(inner, techTreeHit.x + techTreeHit.w / 2, techTreeHit.y + techTreeHit.h / 2);
    expect(inner.selectedBuilding).toBe('academy');

    // Before the D-CITY-11 fix this class of bug came from, a stale page-tab hit sitting
    // underneath the dim overlay would still fire and switch pages instead of just closing
    // the modal. Tapping the old rail-tab coordinates must close the modal, not switch pages.
    tap(inner, railTab.x + railTab.w / 2, railTab.y + railTab.h / 2);
    expect(inner.selectedBuilding).toBeNull();
    expect(inner.page).toBe('military');
    scene.destroy();
  });

  it('tapping far outside the modal opened from the military page closes it and stays on the military page', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    gotoMilitary(inner);
    const techTreeHit = contentHits(inner)[0]!;
    tap(inner, techTreeHit.x + techTreeHit.w / 2, techTreeHit.y + techTreeHit.h / 2);
    expect(inner.selectedBuilding).toBe('academy');

    tap(inner, inner.w - 2, inner.h - 2);
    expect(inner.selectedBuilding).toBeNull();
    expect(inner.page).toBe('military');
    scene.destroy();
  });

  it('the header Back button stays reachable while the academy modal (opened from the military page) is open', () => {
    const { scene, calls } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    gotoMilitary(inner);
    const techTreeHit = contentHits(inner)[0]!;
    tap(inner, techTreeHit.x + techTreeHit.w / 2, techTreeHit.y + techTreeHit.h / 2);
    expect(inner.selectedBuilding).toBe('academy');

    const backHit = inner.hits[0]!;
    tap(inner, backHit.x + backHit.w / 2, backHit.y + backHit.h / 2);
    expect(calls.back).toBe(1);
    scene.destroy();
  });
});

describe('CityScene military page durability panel (D-CITY-8, 2026-07-16)', () => {
  /** Resolves getMe with an explicit hp/maxHp pair so the panel has real data to render. */
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

  async function buildOnMilitaryPageWithDurability(hp: number, maxHp: number): Promise<{ scene: CityScene; inner: CitySceneInternals }> {
    const input = new InputManager();
    const cb: CitySceneCallbacks = {
      onBack: () => {},
      worldApi: stubWorldApiWithDurability(hp, maxHp),
      worldId: 'world:1:0',
    };
    const scene = new CityScene(createLayout(...PORTRAIT), input, cb);
    await new Promise((r) => setTimeout(r, 0));
    const inner = internals(scene);
    const militaryTab = tabHit(inner);
    tap(inner, militaryTab.x + militaryTab.w / 2, militaryTab.y + militaryTab.h / 2);
    expect(inner.page).toBe('military');
    return { scene, inner };
  }

  it('renders the durability title and current/max value from PlayerWorldView.hp/maxHp', async () => {
    const { scene, inner } = await buildOnMilitaryPageWithDurability(3200, 8000);
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('city.military.durability'));
    // fmtNum floors to the nearest 'k' — 3200/8000 renders as "3k / 8k".
    expect(texts).toContain('3k / 8k');
    // Panel doesn't register a hit (display-only) — back + rail tab + tech-tree panel only.
    expect(inner.hits.length).toBe(3);
    expect(contentHits(inner)[0]!.y).toBeGreaterThan(0);
    scene.destroy();
  });

  it('falls back to a full bar derived from the wall level when hp/maxHp is absent (no resolved anchor yet)', async () => {
    const { scene } = await buildOnMilitaryPageWithDurability(undefined as unknown as number, undefined as unknown as number);
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('city.military.durability'));
    scene.destroy();
  });
});

describe('CityScene military page team panel (D-CITY-10, 2026-07-16)', () => {
  type TeamsFixture = {
    me?: Partial<PlayerWorldView>;
    teams?: { id: string; name: string; army: { cardInstanceId?: string; initialHp?: number }[] }[];
    marches?: { marchId: string; mine?: boolean; teamId: string; arriveAt: number }[];
    occupations?: { teamId: string; dueAt: number }[];
  };

  /** Unlike stubWorldApi(), resolves getMe/getTeams/getMarches/getOccupations so the team
   *  panel has real data to render. */
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

  /** Builds a scene, waits for the async load() to resolve, and switches to the military page.
   *  Pass onEditTeam to wire the team-card tap-through (D-CITY-10). */
  async function buildOnMilitaryPage(
    fx: TeamsFixture,
    onEditTeam?: (teamId: string, teamName: string) => void,
  ): Promise<{ scene: CityScene; inner: CitySceneInternals }> {
    const input = new InputManager();
    const cb: CitySceneCallbacks = {
      onBack: () => {},
      worldApi: stubWorldApiWithTeams(fx),
      worldId: 'world:1:0',
      onEditTeam,
    };
    const scene = new CityScene(createLayout(...PORTRAIT), input, cb);
    await new Promise((r) => setTimeout(r, 0));
    const inner = internals(scene);
    const militaryTab = tabHit(inner);
    tap(inner, militaryTab.x + militaryTab.w / 2, militaryTab.y + militaryTab.h / 2);
    expect(inner.page).toBe('military');
    return { scene, inner };
  }

  it('registers no team-card hits when no onEditTeam handler is wired (display-only fallback)', async () => {
    const { scene, inner } = await buildOnMilitaryPage({
      teams: [
        { id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] },
        { id: 't2', name: 'Bravo', army: [{ cardInstanceId: 'c1' }] },
      ],
      marches: [{ marchId: 'm1', mine: true, teamId: 't1', arriveAt: Date.now() + 30_000 }],
      me: { cardState: { c1: { currentTroops: 400 } }, teamState: { t2: { injuredUntil: Date.now() + 60_000 } } },
    });
    // Back + the rail tab + the D-CITY-12 tech-tree panel — the team cards
    // themselves are display-only, no card hits pushed.
    expect(inner.hits.length).toBe(3);
    scene.destroy();
  });

  it('shows the section header and, for a filled idle team, garrison + committed troops and the idle tag', async () => {
    const { scene, inner } = await buildOnMilitaryPage({
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
    const { scene } = await buildOnMilitaryPage({
      teams: [{ id: 't1', name: 'Alpha', army: [{ initialHp: 240 }, { initialHp: 290 }] }],
      me: { cardState: {} },
    });
    const texts = collectTexts(scene.container);
    // Two entries in the garrison, but 0 committed (legacy initialHp is not counted as carried troops).
    const sub = `${t('world.defense.garrison').replace('{n}', '2')}   ${t('world.team.committed').replace('{n}', '0')}`;
    expect(texts).toContain(sub);
    scene.destroy();
  });

  it('shows the marching tag for a team with an active march', async () => {
    const { scene, inner } = await buildOnMilitaryPage({
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
      marches: [{ marchId: 'm1', mine: true, teamId: 't1', arriveAt: Date.now() + 30_000 }],
      me: { cardState: { c1: { currentTroops: 400 } } },
    });
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('world.team.marching'));
    scene.destroy();
  });

  it('shows the occupying tag for a team holding an occupation', async () => {
    const { scene, inner } = await buildOnMilitaryPage({
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
      occupations: [{ teamId: 't1', dueAt: Date.now() + 90_000 }],
      me: { cardState: { c1: { currentTroops: 400 } } },
    });
    const texts = collectTexts(scene.container);
    expect(texts.some(s => s.includes(t('world.team.occupying').split('{time}')[0]!))).toBe(true);
    scene.destroy();
  });

  it('an injured team shows the injured tag, not the marching tag, even while also on an active march', async () => {
    const { scene, inner } = await buildOnMilitaryPage({
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
    const { scene, inner } = await buildOnMilitaryPage({ teams: [] });
    const texts = collectTexts(scene.container);
    // TEAM_CAP=5, all unfilled — the empty tag should appear once per slot.
    expect(texts.filter(s => s === t('world.team.empty')).length).toBe(5);
    scene.destroy();
  });

  // ── Tap-to-edit (D-CITY-10 team card → formation editor, 2026-07-16) ──────────
  // The team cards used to be inert (the bug: tapping a card did nothing). They now
  // register a hit that opens that team's formation editor via the onEditTeam callback.

  it('registers one hit per visible team slot when onEditTeam is wired', async () => {
    const { scene, inner } = await buildOnMilitaryPage({ teams: [] }, () => {});
    // Back + the rail tab hit + tech-tree panel + one hit for each of the TEAM_CAP slots.
    expect(inner.hits.length).toBe(3 + TEAM_CAP);
    scene.destroy();
  });

  it('tapping a filled team card opens that team via onEditTeam with its id and name', async () => {
    const opened: Array<{ teamId: string; teamName: string }> = [];
    const { scene, inner } = await buildOnMilitaryPage(
      { teams: [{ id: teamSlotId(0), name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }], me: { cardState: { c1: { currentTroops: 400 } } } },
      (teamId, teamName) => { opened.push({ teamId, teamName }); },
    );
    const teamHit = inner.hits[3]!; // first team card, past Back + rail tab + tech-tree panel
    tap(inner, teamHit.x + teamHit.w / 2, teamHit.y + teamHit.h / 2);
    expect(opened).toEqual([{ teamId: teamSlotId(0), teamName: 'Alpha' }]);
    scene.destroy();
  });

  it('tapping an empty team slot still opens the editor, with the default slot id and name', async () => {
    const opened: Array<{ teamId: string; teamName: string }> = [];
    const { scene, inner } = await buildOnMilitaryPage(
      { teams: [] },
      (teamId, teamName) => { opened.push({ teamId, teamName }); },
    );
    const firstSlotHit = inner.hits[3]!;
    tap(inner, firstSlotHit.x + firstSlotHit.w / 2, firstSlotHit.y + firstSlotHit.h / 2);
    expect(opened).toEqual([{ teamId: teamSlotId(0), teamName: teamSlotName(0) }]);
    scene.destroy();
  });

  it('team-card hits land within the screen, below the page tabs, and do not overlap each other', async () => {
    const { scene, inner } = await buildOnMilitaryPage({ teams: [] }, () => {});
    const tabsHit = inner.hits[1]!; // rail tab hit — y-reference for "below the tabs"
    const teamHits = inner.hits.slice(3);
    expect(teamHits.length).toBe(TEAM_CAP);
    for (const th of teamHits) {
      expect(th.x).toBeGreaterThanOrEqual(0);
      expect(th.y).toBeGreaterThan(tabsHit.y + tabsHit.h);
      expect(th.x + th.w).toBeLessThanOrEqual(inner.w + 1e-6);
      expect(th.y + th.h).toBeLessThanOrEqual(inner.h + 1e-6);
    }
    for (let i = 0; i < teamHits.length; i++) {
      for (let j = i + 1; j < teamHits.length; j++) {
        expect(rectsOverlap(teamHits[i]!, teamHits[j]!)).toBe(false);
      }
    }
    scene.destroy();
  });

  it('switching back to the domestic page drops the team-card hits (no leak across pages)', async () => {
    const { scene, inner } = await buildOnMilitaryPage({ teams: [] }, () => {});
    expect(inner.hits.length).toBe(3 + TEAM_CAP);
    const domesticTab = inner.hits[1]!;
    tap(inner, domesticTab.x + domesticTab.w / 2, domesticTab.y + domesticTab.h / 2);
    expect(inner.page).toBe('domestic');
    // Back + the rail tab hit + 10 building cards — no team hits survive on the domestic
    // page, so the id-based tap-through can't misfire there.
    expect(inner.hits.length).toBe(12);
    scene.destroy();
  });
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
