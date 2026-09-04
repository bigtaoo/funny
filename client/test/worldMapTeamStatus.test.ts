// buildTeamRows — the world-map team panel's rows (2026-08-30, replaces the march list).
//
// The point of the replacement is coverage: the march list could only ever show a team that happened
// to be IN TRANSIT, so a team holding an occupation, parked in the field, injured, or idle at home
// had no row at all. These pin that every one of those states produces exactly one row, that its jump
// target is where the team actually is (the main base for a team at home — the specific behaviour
// asked for), and that flat-troop marches, which are not teams, keep their own recallable rows.

import { describe, it, expect, beforeAll } from 'vitest';
import { SLG_TEAM_STAMINA_COST, SLG_TEAM_STAMINA_MAX } from '@nw/shared';
import { initI18n, t } from '../src/i18n';
import { buildTeamRows, awayCount } from '../src/scenes/worldmap/logic/teamStatus';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';
import type { MarchView, OccupationView, StationedView, TeamTemplate } from '../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
beforeAll(() => { initI18n('en', memStore, ['zh', 'en', 'de']); });

const WORLD = 'w1';
const NOW = 1_000_000;
const BASE = { x: 50, y: 50 };

/** A one-card team carrying `troops`, wired through the cardState ledger carriedTroops reads. */
function team(id: string, troops: number): { tmpl: TeamTemplate; cardId: string; troops: number } {
  const cardId = `card-${id}`;
  return { tmpl: { id, name: '', army: [{ cardInstanceId: cardId }] } as TeamTemplate, cardId, troops };
}

function harness(opts: {
  teams?: { tmpl: TeamTemplate; cardId: string; troops: number }[];
  marches?: MarchView[];
  occupations?: OccupationView[];
  stationed?: StationedView[];
  teamState?: Record<string, { injuredUntil?: number; stamina?: number; staminaAt?: number }>;
}): WorldMapContext {
  const teams = opts.teams ?? [];
  const cardState: Record<string, { currentTroops: number }> = {};
  for (const t of teams) cardState[t.cardId] = { currentTroops: t.troops };
  return {
    teams: teams.map((t) => t.tmpl),
    marches: opts.marches ?? [],
    occupations: opts.occupations ?? [],
    stationed: opts.stationed ?? [],
    me: {
      joined: true,
      mainBaseTile: `${WORLD}:${BASE.x}:${BASE.y}`,
      cardState,
      teamState: opts.teamState,
    },
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[1]), Number(p[2])]; },
    cb: { worldId: WORLD },
  } as unknown as WorldMapContext;
}

const march = (over: Partial<MarchView>): MarchView => ({
  marchId: 'm', kind: 'attack', fromTile: `${WORLD}:${BASE.x}:${BASE.y}`, toTile: `${WORLD}:60:70`,
  troops: 100, departAt: NOW, arriveAt: NOW + 60_000, status: 'marching', mine: true, ...over,
});

describe('buildTeamRows — a team gets exactly one row whatever it is doing', () => {
  it('a team sitting at home still gets a row, and it jumps to the main base', () => {
    const rows = buildTeamRows(harness({ teams: [team('t1', 1200)] }), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('home');
    expect(rows[0]!.troops).toBe(1200);
    // The 2026-08-30 request in as many words: "队伍在家时直接跳转到基地".
    expect([rows[0]!.jumpX, rows[0]!.jumpY]).toEqual([BASE.x, BASE.y]);
  });

  it('a marching team reports its destination and jumps there', () => {
    const ctx = harness({ teams: [team('t1', 900)], marches: [march({ marchId: 'm1', teamId: 't1' })] });
    const rows = buildTeamRows(ctx, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('marching');
    expect(rows[0]!.march?.marchId).toBe('m1');
    expect(rows[0]!.status).toContain('(60,70)');
    expect([rows[0]!.jumpX, rows[0]!.jumpY]).toEqual([60, 70]);
  });

  it('a return march reads as "returning", which is what earns the instant-return button', () => {
    const ctx = harness({ teams: [team('t1', 900)], marches: [march({ marchId: 'm1', teamId: 't1', kind: 'return' })] });
    expect(buildTeamRows(ctx, NOW)[0]!.state).toBe('returning');
  });

  it('a team holding an occupation gets a row — the march list had none for it', () => {
    const ctx = harness({
      teams: [team('t1', 900)],
      occupations: [{ tile: `${WORLD}:12:34`, x: 12, y: 34, level: 3, garrison: 10, dueAt: NOW + 120_000, teamId: 't1' }],
    });
    const rows = buildTeamRows(ctx, NOW);
    expect(rows[0]!.state).toBe('occupying');
    expect([rows[0]!.jumpX, rows[0]!.jumpY]).toEqual([12, 34]);
  });

  it('a field-stationed team distinguishes 停留 idle from 驻扎 garrison, and offers a recall', () => {
    const station = (mode: 'idle' | 'garrison'): StationedView =>
      ({ tile: `${WORLD}:20:21`, x: 20, y: 21, teamId: 't1', troops: 500, sinceAt: NOW, mode, mine: true });
    const idle = buildTeamRows(harness({ teams: [team('t1', 900)], stationed: [station('idle')] }), NOW);
    const garrison = buildTeamRows(harness({ teams: [team('t1', 900)], stationed: [station('garrison')] }), NOW);
    expect(idle[0]!.state).toBe('stationed');
    expect(garrison[0]!.state).toBe('garrisoned');
    expect(idle[0]!.stationedTeamId).toBe('t1');
    expect([idle[0]!.jumpX, idle[0]!.jumpY]).toEqual([20, 21]);
  });

  it('an injured team reads as injured and jumps home (ADR-026 §5)', () => {
    const ctx = harness({ teams: [team('t1', 900)], teamState: { t1: { injuredUntil: NOW + 60_000 } } });
    const rows = buildTeamRows(ctx, NOW);
    expect(rows[0]!.state).toBe('injured');
    expect([rows[0]!.jumpX, rows[0]!.jumpY]).toEqual([BASE.x, BASE.y]);
  });

  it('an elapsed injury is not a status — the team is simply home again', () => {
    const ctx = harness({ teams: [team('t1', 900)], teamState: { t1: { injuredUntil: NOW - 1 } } });
    expect(buildTeamRows(ctx, NOW)[0]!.state).toBe('home');
  });

  it('an empty team slot produces no row', () => {
    const ctx = harness({});
    (ctx as unknown as { teams: TeamTemplate[] }).teams = [{ id: 't1', name: '', army: [] } as TeamTemplate];
    expect(buildTeamRows(ctx, NOW)).toHaveLength(0);
  });
});

describe('buildTeamRows — precedence and non-team armies', () => {
  it('a march outranks the station doc that coexists with it mid-recall', () => {
    // Same precedence CityScene/teamRow.ts applies: without it a recalled team flashes 野外驻扎 and
    // then corrects itself to 行军中 one tick later.
    const ctx = harness({
      teams: [team('t1', 900)],
      marches: [march({ marchId: 'm1', teamId: 't1', kind: 'return' })],
      stationed: [{ tile: `${WORLD}:20:21`, x: 20, y: 21, teamId: 't1', troops: 500, sinceAt: NOW, mode: 'garrison', mine: true }],
    });
    const rows = buildTeamRows(ctx, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('returning');
  });

  it('a flat-troop march (no teamId) still gets its own recallable row', () => {
    const ctx = harness({ teams: [team('t1', 900)], marches: [march({ marchId: 'flat1' })] });
    const rows = buildTeamRows(ctx, NOW);
    expect(rows.map((r) => r.key)).toEqual(['t1', 'march:flat1']);
    expect(rows[1]!.march?.marchId).toBe('flat1');
    expect(rows[1]!.troops).toBe(100); // the march's own committed troops, not a team's ledger
  });

  it('an enemy march inside my vision is never listed (G5: ctx.marches carries both)', () => {
    const ctx = harness({ marches: [march({ marchId: 'enemy1', mine: false })] });
    expect(buildTeamRows(ctx, NOW)).toHaveLength(0);
  });

  it('rows keep team-slot order, so a landing march does not reshuffle the list under a tap', () => {
    const ctx = harness({
      teams: [team('t1', 100), team('t2', 200), team('t3', 300)],
      marches: [march({ marchId: 'm2', teamId: 't2' })],
    });
    expect(buildTeamRows(ctx, NOW).map((r) => r.key)).toEqual(['t1', 't2', 't3']);
  });
});

describe('awayCount — the badge numerator', () => {
  it('counts only the teams that are actually out', () => {
    const ctx = harness({
      teams: [team('t1', 100), team('t2', 200), team('t3', 300)],
      marches: [march({ marchId: 'm2', teamId: 't2' })],
      teamState: { t3: { injuredUntil: NOW + 60_000 } },
    });
    const rows = buildTeamRows(ctx, NOW);
    expect(rows).toHaveLength(3);
    expect(awayCount(rows)).toBe(1); // home and injured are both "not out"
  });
});

// Team stamina (SLG_DESIGN §4.6, 2026-09-04). Home is the one state whose status line spends
// characters on stamina, because it is the only one where the number changes what the player can do
// next — a team too tired to be given an order must not read as plain 闲置 while the team picker
// silently refuses to list it.
describe('buildTeamRows — team stamina on the home row', () => {
  it('carries the live figure on every team row, and null on a flat-troop army row', () => {
    const ctx = harness({
      teams: [team('t1', 100)],
      teamState: { t1: { stamina: 40, staminaAt: NOW } },
      marches: [march({ marchId: 'flat1' })], // no teamId → a flat-pool army, not a team
    });
    const rows = buildTeamRows(ctx, NOW);
    expect(rows.find((r) => r.key === 't1')!.stamina).toBe(40);
    expect(rows.find((r) => r.key === 'march:flat1')!.stamina).toBeNull();
  });

  it('a team that has never marched reads as FULL, not empty', () => {
    const rows = buildTeamRows(harness({ teams: [team('t1', 100)] }), NOW);
    expect(rows[0]!.stamina).toBe(SLG_TEAM_STAMINA_MAX);
    expect(rows[0]!.status).toContain(t('world.team.stamina').replace('{n}', String(SLG_TEAM_STAMINA_MAX)));
  });

  it('folds the elapsed refill in, so the row does not freeze between server responses', () => {
    const ctx = harness({ teams: [team('t1', 100)], teamState: { t1: { stamina: 20, staminaAt: NOW } } });
    expect(buildTeamRows(ctx, NOW + 10 * 60_000)[0]!.stamina).toBe(30);
  });

  it('a team below one order\'s cost says "resting" instead of idle', () => {
    const ctx = harness({
      teams: [team('t1', 100)],
      teamState: { t1: { stamina: SLG_TEAM_STAMINA_COST - 1, staminaAt: NOW } },
    });
    const row = buildTeamRows(ctx, NOW)[0]!;
    expect(row.state).toBe('home'); // still home — stamina is not a separate row state
    expect(row.status).toBe(t('world.team.resting').replace('{n}', String(SLG_TEAM_STAMINA_COST - 1)));
    expect(row.status).not.toContain(t('city.military.teamIdle'));
  });

  it('exactly one order\'s worth still reads as idle (the gate is >=)', () => {
    const ctx = harness({
      teams: [team('t1', 100)],
      teamState: { t1: { stamina: SLG_TEAM_STAMINA_COST, staminaAt: NOW } },
    });
    expect(buildTeamRows(ctx, NOW)[0]!.status).toContain(t('city.military.teamIdle'));
  });

  it('an order outranks stamina — a marching team reports where it is, not how tired it is', () => {
    const ctx = harness({
      teams: [team('t1', 100)],
      teamState: { t1: { stamina: 0, staminaAt: NOW } },
      marches: [march({ marchId: 'm1', teamId: 't1' })],
    });
    const row = buildTeamRows(ctx, NOW)[0]!;
    expect(row.state).toBe('marching');
    expect(row.status).not.toContain(t('world.team.stamina').replace('{n}', '0'));
    expect(row.stamina).toBe(0); // still carried on the row for any caller that wants it
  });
});
