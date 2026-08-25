// Pure-function coverage for @nw/shared slg/citySiege.ts (ADR-074). The CURVES are calibrated and pinned by
// `server/tools/econ-sim/src/citySiege.test.ts` (which runs real engine battles); this file pins the parts
// that are pure geometry and arithmetic, and the shape invariants a future retune must not break silently.
import { describe, expect, it } from 'vitest';
import {
  WILD_CITY_MIN_LEVEL,
  WILD_CITY_MAX_LEVEL,
  CITY_WAVE_COUNT,
  CITY_WAVE_RESPAWN_MS,
  CITY_WORLD_CENTER_MULT,
  CITY_CAPTURE_PROTECTION_MS,
  CITY_KIND_RANK,
  cityDocId,
  cityNodeCovering,
  cityWaveCount,
  cityWaveGarrison,
  cityWaveBaseHp,
  cityLadderGarrison,
  cityKindMult,
  cityDurabilityMax,
  cityRegenPerHour,
  regenCityDurability,
  cityFootprint,
  allCityNodes,
  proceduralTile,
  isCityGroundTile,
  SLG_TEAM_INJURY_MS,
  PROTECTION_SEC,
  OUTER_GRADED_CITY_TIERS,
  type CityFootprintNode,
} from '../src/index';

describe('citySiege: level range', () => {
  it('derives the weakest wild city from the graded tier table rather than restating it', () => {
    // The solo-proof invariant is measured at the WEAKEST city (cheapest wave ladder = closest an attacker
    // gets to out-damaging regen). Hard-coding 3 here would silently go stale if the tier table changed.
    expect(WILD_CITY_MIN_LEVEL).toBe(Math.min(...OUTER_GRADED_CITY_TIERS));
    expect(WILD_CITY_MAX_LEVEL).toBeGreaterThan(WILD_CITY_MIN_LEVEL);
  });
});

describe('citySiege: wave ladder', () => {
  it('is flat in city level — the level scaling lives in the per-wave numbers, not the wave count', () => {
    // Measured (citySiegeRun.ts): a 4th wave at level 10 is unclearable by ANY roster the game can produce,
    // because a fixed 12-card team's survivors decay multiplicatively between waves. A city nobody can
    // damage is worse than one they can, so wave count is deliberately constant.
    for (const l of [WILD_CITY_MIN_LEVEL, 4, 5, 6, 7, 8, 9, WILD_CITY_MAX_LEVEL]) {
      expect(cityWaveCount(l)).toBe(CITY_WAVE_COUNT);
    }
  });

  it('scales garrison and wave base HP linearly with level, and the ladder total with both', () => {
    expect(cityWaveGarrison(10)).toBe(cityWaveGarrison(1) * 10);
    expect(cityWaveBaseHp(10)).toBe(cityWaveBaseHp(1) * 10);
    expect(cityLadderGarrison(10)).toBe(CITY_WAVE_COUNT * cityWaveGarrison(10));
    expect(cityWaveGarrison(WILD_CITY_MAX_LEVEL)).toBeGreaterThan(cityWaveGarrison(WILD_CITY_MIN_LEVEL));
  });

  it('floors level at 1 so a malformed node can never produce a zero-troop wave', () => {
    expect(cityWaveGarrison(0)).toBe(cityWaveGarrison(1));
    expect(cityWaveBaseHp(-5)).toBe(cityWaveBaseHp(1));
  });

  it('keeps CITY_WAVE_RESPAWN_MS aligned with the defender-injury rule it mirrors', () => {
    // It applies to P3's owner-stationed defender teams, not to the NPC ladder — same "your team is spent,
    // come back later" rule the main-base siege already uses.
    expect(CITY_WAVE_RESPAWN_MS).toBe(SLG_TEAM_INJURY_MS);
  });
});

describe('citySiege: durability + regen curves', () => {
  it('is base-dominated: a level-10 capital is within ~1/3 of the weakest wild city', () => {
    // Not a taste choice — per-siege troop cost rises ~2.7x with city level, so a level-proportional wall
    // would push the attackers-needed curve to roughly L², i.e. 100+ players for a capital against 13 for a
    // level-3 city. See SLG_CITY_SIEGE_DESIGN §6.5.
    const weak = cityDurabilityMax(WILD_CITY_MIN_LEVEL, 'garrison');
    const strong = cityDurabilityMax(WILD_CITY_MAX_LEVEL, 'garrison');
    expect(strong / weak).toBeGreaterThan(1);        // still monotone: a bigger city IS tougher
    expect(strong / weak).toBeLessThan(1.35);
    expect(cityRegenPerHour(WILD_CITY_MAX_LEVEL, 'garrison') / cityRegenPerHour(WILD_CITY_MIN_LEVEL, 'garrison')).toBeLessThan(1.35);
  });

  it('doubles both curves for the world center and only for the world center', () => {
    expect(cityKindMult('worldCenter')).toBe(CITY_WORLD_CENTER_MULT);
    expect(cityKindMult('capital')).toBe(1);
    expect(cityKindMult('garrison')).toBe(1);
    expect(cityDurabilityMax(10, 'worldCenter')).toBe(cityDurabilityMax(10, 'garrison') * CITY_WORLD_CENTER_MULT);
    expect(cityRegenPerHour(10, 'worldCenter')).toBe(cityRegenPerHour(10, 'garrison') * CITY_WORLD_CENTER_MULT);
  });

  it('regen is a meaningful fraction of durability — the city must actually heal within hours', () => {
    // If regen were a rounding error the design would be "堆血量" (which the ADR explicitly rejected: high HP
    // only buys time, a lone grinder still wins). A city left alone has to come back within a session.
    const max = cityDurabilityMax(WILD_CITY_MIN_LEVEL, 'garrison');
    const rate = cityRegenPerHour(WILD_CITY_MIN_LEVEL, 'garrison');
    const hoursToFull = max / rate;
    expect(hoursToFull).toBeGreaterThan(1);
    expect(hoursToFull).toBeLessThan(6);
  });

  it('caps the post-capture protection well below the main base\'s shield', () => {
    // A captured city ALSO resets to full durability, so retaking it already costs a second full assault.
    // The main base gets no such reset (it relocates), which is why its shield is much longer.
    expect(CITY_CAPTURE_PROTECTION_MS).toBeLessThan(PROTECTION_SEC * 1000);
    expect(CITY_CAPTURE_PROTECTION_MS).toBeGreaterThan(30 * 60 * 1000);
  });
});

describe('citySiege: regenCityDurability (lazy, pure)', () => {
  const max = 10_000;
  const rate = 1_000;

  it('heals exactly rate x elapsed hours', () => {
    expect(regenCityDurability(0, max, 0, 3_600_000, rate)).toBe(rate);
    expect(regenCityDurability(0, max, 0, 1_800_000, rate)).toBe(rate / 2);
    expect(regenCityDurability(5_000, max, 0, 3_600_000, rate)).toBe(6_000);
  });

  it('clamps to max and never overshoots', () => {
    expect(regenCityDurability(0, max, 0, 100 * 3_600_000, rate)).toBe(max);
    expect(regenCityDurability(max, max, 0, 3_600_000, rate)).toBe(max);
  });

  it('never heals backwards on a clock that went backwards', () => {
    // A `now` behind the stored checkpoint is possible across instances with skewed clocks; it must be a
    // no-op, not a subtraction.
    expect(regenCityDurability(4_000, max, 1_000_000, 0, rate)).toBe(4_000);
  });

  it('is a pure function of its arguments (same inputs, same result, no state)', () => {
    const a = regenCityDurability(1_234, max, 500, 900_000, rate);
    expect(regenCityDurability(1_234, max, 500, 900_000, rate)).toBe(a);
  });
});

describe('citySiege: cityNodeCovering', () => {
  const node = (over: Partial<CityFootprintNode> = {}): CityFootprintNode => ({ kind: 'garrison', x: 100, y: 100, footprint: 5, ...over });

  it('matches every cell of the plot, and nothing outside it', () => {
    const n = node();
    const r = 2;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        expect(cityNodeCovering([n], 100 + dx, 100 + dy), `${dx},${dy}`).toBe(n);
      }
    }
    for (const [dx, dy] of [[r + 1, 0], [0, r + 1], [-(r + 1), 0], [0, -(r + 1)], [r + 1, r + 1]] as const) {
      expect(cityNodeCovering([n], 100 + dx, 100 + dy), `${dx},${dy}`).toBeNull();
    }
  });

  it('breaks an overlap by kind: world center > capital > graded', () => {
    // Overlaps are real (a map-edge city has its anchor clamped back inside the map), and from ADR-074 P1 on
    // the winner decides the cell's level — which IS the besieged city's durability and garrison scale. This
    // ranking must stay identical to rasterizeMapEdits' CITY_PAINT_RANK and _cityGroundNodeAt's walk order;
    // those three drifting apart was a real P0 bug (a Lv.8 graded city overwriting a Lv.10 capital's cells).
    expect(CITY_KIND_RANK.worldCenter).toBeLessThan(CITY_KIND_RANK.capital);
    expect(CITY_KIND_RANK.capital).toBeLessThan(CITY_KIND_RANK.garrison);
    const graded = node({ kind: 'garrison' });
    const capital = node({ kind: 'capital' });
    const centre = node({ kind: 'worldCenter', footprint: 9 });
    expect(cityNodeCovering([graded, capital], 100, 100)).toBe(capital);
    expect(cityNodeCovering([capital, graded], 100, 100)).toBe(capital); // order-independent
    expect(cityNodeCovering([graded, capital, centre], 100, 100)).toBe(centre);
  });

  it('returns null for an empty list', () => {
    expect(cityNodeCovering([], 5, 5)).toBeNull();
  });

  it('agrees with proceduralTile about which cells of a real world are city ground', () => {
    // The whole point of sharing this helper: the server's siege target, the rasterizer's tile painting and
    // the client's map click must all name the same city for the same cell.
    const worldId = 's1-citysiege-shared';
    const nodes = allCityNodes(worldId);
    const graded = nodes.find((n) => n.kind === 'garrison' && n.footprint >= 5)!;
    const r = (graded.footprint - 1) / 2;
    for (const [dx, dy] of [[0, 0], [r, 0], [0, r], [-r, -r]] as const) {
      const x = graded.x + dx;
      const y = graded.y + dy;
      if (x < 0 || y < 0) continue;
      expect(isCityGroundTile(proceduralTile(worldId, x, y).type), `${x},${y}`).toBe(true);
      expect(cityNodeCovering(nodes, x, y)).not.toBeNull();
    }
  });

  it('footprint comes from the level tier, so the lookup box and the drawn plot cannot disagree', () => {
    for (const n of allCityNodes('s1-citysiege-shared')) {
      if (n.kind === 'worldCenter') continue; // its own constant, larger than the tier table
      expect(n.footprint).toBe(cityFootprint(n.level));
    }
  });
});

describe('citySiege: document identity', () => {
  it('cityDocId is stable and namespaced per world', () => {
    expect(cityDocId('w1', 'garrison-3')).toBe('city:w1:garrison-3');
    expect(cityDocId('w1', 'worldCenter')).not.toBe(cityDocId('w2', 'worldCenter'));
  });
});
