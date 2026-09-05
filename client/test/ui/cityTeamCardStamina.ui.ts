// The city scene's team-card status line (CityScene/teamRow.ts renderTeamCard).
//
// Added for team stamina (2026-09-04, SLG_DESIGN §4.6), which inserted a new branch into a status
// chain that had none of its own coverage. The chain is a strict priority order — injured > parked in
// the field > march/occupation in flight > orders-not-loaded > TOO TIRED > idle > empty — and the new
// branch sits in the one spot that is easy to get wrong: below every real order (where a team IS
// matters more than what its budget says) but above plain 闲置, which would otherwise promise an
// action the world map's picker then refuses to offer. Nothing but the ordering is asserted here;
// the number itself comes from teamStamina(), pinned in teamTroops.test.ts.
//
// Real PIXI (the ui suite's headless adapter), a hand-built CitySceneCore stand-in — renderTeamCard
// only reads a handful of fields off it, and constructing the whole scene would test the scene.

import { describe, it, expect, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { SLG_TEAM_STAMINA_COST, SLG_TEAM_STAMINA_MAX } from '@nw/shared';
import { initI18n, setLocale, t } from '../../src/i18n';
import { renderTeamCard } from '../../src/scenes/CityScene/teamRow';
import type { CitySceneCore } from '../../src/scenes/CityScene/core';
import type { MarchView, TeamTemplate } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const NOW = 1_700_000_000_000;
const MIN = 60_000;

type TeamState = { injuredUntil?: number; stamina?: number; staminaAt?: number };

function harness(opts: {
  army?: { cardInstanceId: string }[];
  teamState?: Record<string, TeamState>;
  march?: MarchView | null;
  ordersLoaded?: boolean;
} = {}) {
  const layer = new PIXI.Container();
  const team = { id: 't1', name: 'Alpha', army: opts.army ?? [{ cardInstanceId: 'c1' }] } as unknown as TeamTemplate;
  const core = {
    teams: [team],
    teamsLoaded: true,
    ordersLoaded: opts.ordersLoaded ?? true,
    loadDots: 0,
    me: { teamState: opts.teamState ?? {} },
    // The three order sources collapse into this one lookup (CityScene/helpers.teamOrder); a march is
    // the only one these cases need, and `null` is "this team is at home".
    teamOrder: () => (opts.march ? { march: opts.march } : null),
    committedTroops: () => 0,
    drawArtFit: () => {},
    paint: { pageLayer: layer },
    hits: [] as unknown[],
    cb: { getSave: () => ({ cardInv: {}, equipmentInv: {} }) },
  } as unknown as CitySceneCore;
  return { core, layer };
}

/** Every string the card drew, in draw order (name, status, sub-label). */
function texts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const child of c.children) {
      if (child instanceof PIXI.Text) out.push(child.text);
      if (child instanceof PIXI.Container) walk(child);
    }
  };
  walk(root);
  return out;
}

function render(opts: Parameters<typeof harness>[0] = {}, now = NOW): string[] {
  const { core, layer } = harness(opts);
  renderTeamCard(core, 0, 0, 0, 300, 140, now);
  return texts(layer);
}

const resting = (n: number): string => t('world.team.resting').replace('{n}', String(n));

describe('city team card — the stamina branch in the status chain', () => {
  beforeEach(() => { setLocale('en'); });

  it('a team that can still be given an order reads as idle', () => {
    const drawn = render({ teamState: { t1: { stamina: SLG_TEAM_STAMINA_COST, staminaAt: NOW } } });
    expect(drawn).toContain(t('city.military.teamIdle'));
    expect(drawn).not.toContain(resting(SLG_TEAM_STAMINA_COST));
  });

  it('a team below one order\'s cost says so, with the figure, instead of claiming to be idle', () => {
    const left = SLG_TEAM_STAMINA_COST - 1;
    const drawn = render({ teamState: { t1: { stamina: left, staminaAt: NOW } } });
    expect(drawn).toContain(resting(left));
    expect(drawn).not.toContain(t('city.military.teamIdle'));
  });

  it('a team that has never marched is idle, not exhausted (absent state = full)', () => {
    const drawn = render({});
    expect(drawn).toContain(t('city.military.teamIdle'));
    expect(drawn).not.toContain(resting(SLG_TEAM_STAMINA_MAX));
  });

  it('the figure follows the wall clock between server responses', () => {
    // Stored empty; ten minutes later the card says 10, not 0 — the same lazy recompute the world-map
    // rows and the picker do, so the three never disagree about the same team.
    const drawn = render({ teamState: { t1: { stamina: 0, staminaAt: NOW } } }, NOW + 10 * MIN);
    expect(drawn).toContain(resting(10));
  });

  it('an order outranks exhaustion — a marching team reports the march', () => {
    const drawn = render({
      teamState: { t1: { stamina: 0, staminaAt: NOW } },
      march: { arriveAt: NOW + 5 * MIN } as unknown as MarchView,
    });
    expect(drawn).toContain(t('world.team.marching'));
    expect(drawn).not.toContain(resting(0));
  });

  it('injury outranks exhaustion — the longer, harder lock is the one worth showing', () => {
    const drawn = render({ teamState: { t1: { injuredUntil: NOW + 30 * MIN, stamina: 0, staminaAt: NOW } } });
    expect(drawn.some((s) => s.includes('30m'))).toBe(true);
    expect(drawn).not.toContain(resting(0));
  });

  it('and the loading label still outranks it, so a card never asserts "resting" before the orders land', () => {
    // Same reason the idle branch is gated on ordersLoaded (§8.8): this team may well be out on a march
    // whose slice has not arrived, and correcting itself a moment later is the exact flicker that flag exists to stop.
    const drawn = render({ teamState: { t1: { stamina: 0, staminaAt: NOW } }, ordersLoaded: false });
    expect(drawn.some((s) => s.startsWith(t('city.military.teamLoading')))).toBe(true);
    expect(drawn).not.toContain(resting(0));
  });

  it('an EMPTY slot stays empty — stamina is a property of a team that could march', () => {
    const drawn = render({ army: [], teamState: { t1: { stamina: 0, staminaAt: NOW } } });
    expect(drawn).toContain(t('world.team.empty'));
    expect(drawn).not.toContain(resting(0));
  });
});
