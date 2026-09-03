/**
 * `scenes/worldmap/logic/teamStatus.ts` + `occupyFrontier.ts` — the march kinds and the two
 * "no world state yet" fallbacks.
 *
 * `worldMapTeamStatus.test.ts` covers one row per team STATE (marching / occupying / stationed /
 * injured / home) but only ever with an `attack` march and always with a joined `me` block. The
 * seven branches left are the other five march kinds, the flat-troop `return` case, and what the
 * panel does before the player has joined a world (or before `/world/me` has resolved) — which is
 * exactly when a scene first constructs it.
 *
 * The march-kind labels are worth a case each because the label is the whole status line: a
 * `sweep` reading as `attack` tells the player their army is about to take a tile it is only
 * clearing. And the `me`-less fallback decides where every "jump to" button on the panel points —
 * `(0,0)` rather than `undefined`, so the camera goes somewhere real instead of NaN.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initI18n, t } from '../src/i18n';
import type { TranslationKey } from '../src/i18n';
import { awayCount, buildTeamRows, teamRowIcon } from '../src/scenes/worldmap/logic/teamStatus';
import { occupyFrontierCells } from '../src/scenes/worldmap/logic/occupyFrontier';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';
import type { MarchView, TeamTemplate, WorldTileView } from '../src/net/WorldApiClient';

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

function ctxOf(opts: { marches?: MarchView[]; teams?: TeamTemplate[]; me?: unknown }): WorldMapContext {
  return {
    teams: opts.teams ?? [],
    marches: opts.marches ?? [],
    occupations: [],
    stationed: [],
    me: opts.me,
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[1]), Number(p[2])]; },
    cb: { worldId: WORLD },
  } as unknown as WorldMapContext;
}

function march(kind: MarchView['kind'], over: Partial<MarchView> = {}): MarchView {
  return {
    marchId: `m_${kind}`,
    kind,
    toTile: `${WORLD}:12:34`,
    arriveAt: NOW + 60_000,
    troops: 100,
    mine: true,
    ...over,
  } as MarchView;
}

// ── Every march kind gets its own label ─────────────────────────────────────────────────────

describe('march kind labels', () => {
  const KINDS: { kind: MarchView['kind']; key: TranslationKey }[] = [
    { kind: 'attack', key: 'world.actAttack' },
    { kind: 'reinforce', key: 'world.actReinforce' },
    { kind: 'sweep', key: 'world.actSweep' },
    { kind: 'occupy', key: 'world.actOccupy' },
    { kind: 'move', key: 'world.team.moving' },
    { kind: 'return', key: 'world.team.returning' },
  ];

  it('labels a flat-troop march with its own kind, and no two kinds share a label', () => {
    const seen = new Map<string, string>();
    for (const { kind, key } of KINDS) {
      const rows = buildTeamRows(ctxOf({ marches: [march(kind)] }), NOW);
      expect(rows, kind).toHaveLength(1);
      const label = t(key);
      expect(rows[0]!.status.startsWith(label), `${kind} → ${rows[0]!.status}`).toBe(true);
      expect(seen.has(label), `${kind} reuses ${seen.get(label)}'s label`).toBe(false);
      seen.set(label, kind);
    }
  });

  it('reads a returning flat-troop army as returning and every other kind as marching', () => {
    // The state drives the row's icon and whether the recall button shows: a returning army is
    // already coming home and must not offer "recall".
    for (const { kind } of KINDS) {
      const rows = buildTeamRows(ctxOf({ marches: [march(kind)] }), NOW);
      expect(rows[0]!.state, kind).toBe(kind === 'return' ? 'returning' : 'marching');
    }
    expect(teamRowIcon('returning')).not.toBe(teamRowIcon('marching'));
  });

  it('lists the destination tile and the arrival countdown on the status line', () => {
    const rows = buildTeamRows(ctxOf({ marches: [march('sweep')] }), NOW);
    expect(rows[0]!.status).toContain('(12,34)');
    expect(rows[0]!).toMatchObject({ jumpX: 12, jumpY: 34, troops: 100 });
  });

  it('ignores an enemy march in vision — neither ours to list nor ours to recall', () => {
    const rows = buildTeamRows(ctxOf({ marches: [march('attack', { mine: false })] }), NOW);
    expect(rows).toEqual([]);
    // `mine: undefined` (an older server) counts as ours: only an explicit false is theirs.
    const legacy = buildTeamRows(ctxOf({ marches: [march('attack', { mine: undefined })] }), NOW);
    expect(legacy).toHaveLength(1);
  });
});

// ── Before /world/me resolves ───────────────────────────────────────────────────────────────

describe('with no world membership yet', () => {
  it('falls back to tile (0,0) for the home jump target instead of undefined', () => {
    // The panel can be built before `/world/me` lands (or for a player who has not joined). A
    // `jumpX: undefined` would move the camera to NaN and blank the map.
    const team = { id: 't1', name: '', army: [{ cardInstanceId: 'c1' }] } as TeamTemplate;
    const rows = buildTeamRows(ctxOf({ teams: [team], me: undefined }), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'home', jumpX: 0, jumpY: 0 });
    // No cardState ledger either → the troop readout is 0, not NaN.
    expect(rows[0]!.troops).toBe(0);
  });

  it('falls back the same way when `me` exists but carries no main base', () => {
    const team = { id: 't1', name: '', army: [{ cardInstanceId: 'c1' }] } as TeamTemplate;
    const rows = buildTeamRows(ctxOf({ teams: [team], me: { joined: true } }), NOW);
    expect(rows[0]).toMatchObject({ jumpX: 0, jumpY: 0, troops: 0 });
  });

  it('skips an empty team slot entirely', () => {
    const empty = { id: 't1', name: '', army: [] } as TeamTemplate;
    expect(buildTeamRows(ctxOf({ teams: [empty] }), NOW)).toEqual([]);
  });

  it('counts every away row and no home row', () => {
    const team = { id: 't1', name: '', army: [{ cardInstanceId: 'c1' }] } as TeamTemplate;
    const home = buildTeamRows(ctxOf({ teams: [team] }), NOW);
    expect(awayCount(home)).toBe(0);
    const away = buildTeamRows(ctxOf({ marches: [march('attack')] }), NOW);
    expect(awayCount(away)).toBe(1);
  });
});

// ── occupyFrontier's out-of-bounds neighbour ────────────────────────────────────────────────

describe('occupyFrontierCells at the map edge', () => {
  it('does not treat an off-map neighbour as owned land', () => {
    // Column -1 does not exist. Without the bounds guard `tileCache.get('-1:0')` is a miss and the
    // answer happens to be right — but the base-footprint set is keyed by string, so a negative
    // coordinate that collided with a real key would make an off-map tile "owned" and offer the
    // player a frontier target outside the world.
    const tileCache = new Map<string, WorldTileView>();
    const tile = (x: number, y: number, mine = false): WorldTileView =>
      ({ x, y, type: 'neutral', level: 0, mine }) as unknown as WorldTileView;
    tileCache.set('0:0', tile(0, 0, true));
    tileCache.set('1:0', tile(1, 0));

    const cells = occupyFrontierCells({
      worldId: WORLD,
      mapW: 4,
      mapH: 4,
      bounds: { minTx: -2, maxTx: 5, minTy: -2, maxTy: 5 },
      mainBaseTile: undefined,
      tileCache,
      parseAnchor: (id: string) => { const p = id.split(':'); return [Number(p[1]), Number(p[2])]; },
    });

    // Every returned cell is inside the map…
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThan(4);
      expect(c.y).toBeLessThan(4);
    }
    // …and the neutral tile next to the owned one is among them.
    expect(cells).toEqual(expect.arrayContaining([{ x: 1, y: 0 }]));
  });
});
