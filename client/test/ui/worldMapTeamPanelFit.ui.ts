// Team-panel row legibility (2026-08-30) — nothing in a row may run past the panel, and the status
// text may never collide with the action button beside it.
//
// The row packs four things onto 320px across two lines (icon + team name + carried troops; status +
// one action button), and the widest single element is the instant-return button, whose label carries
// a coin count. That label had to be SHORTENED for this layout (world.instantReturn, was "花{coins}
// 金币立即回城" / "Instant return ({coins} coins)"), which is exactly the kind of thing that silently
// regresses the next time someone rewords it — in German especially. Checked in all three locales.

import { describe, it, expect, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { SLG_TEAM_STAMINA_COST, SLG_TEAM_STAMINA_MAX } from '@nw/shared';
import { initI18n, setLocale } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { MarchView, StationedView, TeamTemplate } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1920, 1080];
const TOP_INSET = 86;
const WORLD_ID = 'w1';
const BASE = { x: 30, y: 40 };
const LOCALES = ['zh', 'en', 'de'] as const;
// A cross-the-whole-1500x1500-map return leg — the widest realistic coin count the instant-return
// button ever has to hold. (An unbounded arriveAt would only prove the clamp, not the layout.)
const NOW = Date.now();
const TWELVE_HOURS = 12 * 3600 * 1000;

function tmpl(id: string): TeamTemplate {
  return { id, name: '', army: [{ cardInstanceId: `card-${id}` }] } as TeamTemplate;
}

/** One team per status the panel can render, so a single renderHud covers every row shape at once.
 *
 * `t1RestingStamina` (2026-09-04, team stamina / SLG_DESIGN §4.6) switches t1's home row between its two
 * status strings, both of which now carry a number: "at home · stamina N" when the team can still be
 * given an order, and the longer "resting · stamina N" when it cannot. Both are checked, because the
 * whole point of this file is that a reworded status line must not silently overflow — and this change
 * made the home row, previously the SHORTEST one here, a contender for the longest in German. */
function buildHarness(t1RestingStamina = false) {
  const teams = ['t1', 't2', 't3', 't4', 't5'].map(tmpl);
  const cardState: Record<string, { currentTroops: number }> = {};
  for (const t of teams) cardState[`card-${t.id}`] = { currentTroops: 99_999 }; // worst-case digit count
  const marches: MarchView[] = [
    { marchId: 'm1', kind: 'attack', fromTile: `${WORLD_ID}:${BASE.x}:${BASE.y}`, toTile: `${WORLD_ID}:1400:1400`, troops: 500, departAt: 0, arriveAt: NOW + TWELVE_HOURS, status: 'marching', mine: true, teamId: 't2' },
    { marchId: 'm2', kind: 'return', fromTile: `${WORLD_ID}:1400:1400`, toTile: `${WORLD_ID}:${BASE.x}:${BASE.y}`, troops: 500, departAt: 0, arriveAt: NOW + TWELVE_HOURS, status: 'marching', mine: true, teamId: 't3' },
  ];
  const stationed: StationedView[] = [
    { tile: `${WORLD_ID}:1400:1400`, x: 1400, y: 1400, teamId: 't4', troops: 500, sinceAt: 0, mode: 'garrison', mine: true },
  ];
  const ctx = {
    w: W, h: H,
    topInset: TOP_INSET,
    backRect: { x: 0, y: 0, w: 160, h: TOP_INSET },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: {
      joined: true, mainBaseTile: `${WORLD_ID}:${BASE.x}:${BASE.y}`,
      troops: 10, troopCap: 100, territoryCount: 1, resources: {}, yieldRate: {}, cardState,
      teamState: {
        t5: { injuredUntil: NOW + TWELVE_HOURS },
        // Worst-case digit count on both sides of the branch: 100 is the widest stamina figure, and
        // SLG_TEAM_STAMINA_COST - 1 is the largest value that still reads as resting.
        t1: t1RestingStamina
          ? { stamina: SLG_TEAM_STAMINA_COST - 1, staminaAt: NOW }
          : { stamina: SLG_TEAM_STAMINA_MAX, staminaAt: NOW },
      },
    },
    marches, occupations: [], stationed,
    teams, teamsLoaded: true, teamPanelExpanded: true,
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[p.length - 2]), Number(p[p.length - 1])]; },
    cb: { accountId: 'me', getCoins: () => 0, worldId: WORLD_ID },
  } as unknown as WorldMapContext;
  return { ctx, panels: new WorldMapPanels(ctx) };
}

function allTexts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const child of c.children) {
      if (child instanceof PIXI.Text) out.push(child);
      if (child instanceof PIXI.Container) walk(child);
    }
  };
  walk(root);
  return out;
}

beforeEach(() => { setLocale('en'); });

describe('team panel rows fit their 320px column', () => {
  for (const lang of LOCALES) {
  for (const resting of [false, true]) {
    const tag = `${lang}${resting ? ', resting' : ''}`;
    it(`[${tag}] no row text runs past the panel's right edge`, () => {
      setLocale(lang);
      const { ctx, panels } = buildHarness(resting);
      panels.renderHud();
      expect(ctx.teamRowRects.length).toBe(5);
      const panelRight = ctx.teamBadgeRect.x + ctx.teamBadgeRect.w;
      const rowsTop = ctx.teamRowRects[0]!.rowRect.y;
      for (const label of allTexts(ctx.hudLayer)) {
        if (label.y < rowsTop) continue; // header/badge/status-card text is another test's business
        const right = label.x + label.width * (1 - label.anchor.x);
        expect(right, `"${label.text}" overflows`).toBeLessThanOrEqual(panelRight + 1);
      }
    });

    it(`[${tag}] every action button label stays inside its own button`, () => {
      setLocale(lang);
      const { ctx, panels } = buildHarness(resting);
      panels.renderHud();
      const buttons = ctx.teamRowRects
        .map((r) => r.recallRect ?? r.instantReturnRect ?? r.recallStationRect)
        .filter((r): r is NonNullable<typeof r> => r !== null);
      expect(buttons.length).toBe(3); // attack → recall, return → instant-return, garrison → recall station
      for (const b of buttons) {
        const label = allTexts(ctx.hudLayer).find(
          (l) => Math.abs(l.x - (b.x + b.w / 2)) < 1 && Math.abs(l.y - (b.y + b.h / 2)) < 1,
        );
        expect(label, 'button has a centred label').toBeTruthy();
        expect(label!.width * label!.scale.x, `"${label!.text}" is wider than its button`).toBeLessThanOrEqual(b.w - 8);
      }
    });

    it(`[${tag}] a status line never reaches under its row's action button`, () => {
      setLocale(lang);
      const { ctx, panels } = buildHarness(resting);
      panels.renderHud();
      for (const row of ctx.teamRowRects) {
        const action = row.recallRect ?? row.instantReturnRect ?? row.recallStationRect;
        if (!action) continue;
        const status = allTexts(ctx.hudLayer).find(
          (l) => l.anchor.x === 0 && l.y > row.rowRect.y + 20 && l.y < row.rowRect.y + row.rowRect.h,
        );
        expect(status, 'row has a status line').toBeTruthy();
        expect(status!.x + status!.width).toBeLessThanOrEqual(action.x);
      }
    });
  }
  }
});
