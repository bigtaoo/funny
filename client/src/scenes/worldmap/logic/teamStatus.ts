// Team panel rows (2026-08-30) — "where is every one of my teams right now, and what can I do about
// it from here", derived purely from state the world map already caches.
//
// Replaces the old march list, which could only ever show teams that happened to be IN TRANSIT: a
// team holding an occupation, parked in the field, injured, or simply sitting at home was invisible,
// so the one list that claimed to answer "what are my forces doing" answered it for a minority of
// them. Ordering the rows by team slot (rather than by whatever marches exist) also keeps a row from
// jumping around under the player's finger every time one march lands.
//
// The status vocabulary is deliberately the SAME i18n keys CityScene/teamRow.ts uses for its own team
// rows — the two screens describe one set of teams and must not invent two names for one state.
//
// Flat-troop marches (散兵占领 / a plain reinforce, dispatched from the troop pool with no team
// attached) get their own trailing rows: they are not teams, but they ARE recallable armies, and the
// march list used to be the only place to recall them.
import { t } from '../../../i18n';
import { formatDuration } from './formatDuration';
import { carriedTroops, teamDisplayName } from '../../../game/meta/teamTroops';
import type { IconKind } from '../../../render/icons';
import type { MarchView } from '../../../net/WorldApiClient';
import type { WorldMapContext } from '../WorldMapContext';

/** What a row's status line is about — drives the row icon and the colour of its status text. */
export type TeamRowState =
  | 'marching'
  | 'returning'
  | 'occupying'
  | 'stationed'
  | 'garrisoned'
  | 'injured'
  | 'home';

export interface TeamRow {
  /** Stable per-row identity (team slot id, or `march:{id}` for a flat-troop army) — render-order key. */
  key: string;
  /** Row heading: the team's display name, or a "militia force" label for a flat-troop march. */
  title: string;
  /** Troops the row commands: the team's carried troops, or the march's committed troops. */
  troops: number;
  state: TeamRowState;
  /** Localized status line, already including coordinates and any countdown. */
  status: string;
  /** Camera target for a row tap. A team at home jumps to the main base, per the 2026-08-30 request. */
  jumpX: number;
  jumpY: number;
  /** Recallable march behind this row (recall for outbound kinds, instant-return for kind==='return'). */
  march: MarchView | null;
  /** Field-stationed team behind this row — recallable via ADR-051's recall-stationed endpoint. */
  stationedTeamId: string | null;
}

const STATE_ICON: Record<TeamRowState, IconKind> = {
  marching: 'flag',
  returning: 'replay',
  occupying: 'siege',
  stationed: 'armor',
  garrisoned: 'armorHeavy',
  injured: 'hp',
  home: 'home',
};

/** Icon for a row's state — one mapping so the panel and any future consumer agree. */
export function teamRowIcon(state: TeamRowState): IconKind {
  return STATE_ICON[state];
}

/** Localized label for a march's kind, used as the head of a marching row's status line. */
function marchKindLabel(kind: MarchView['kind']): string {
  switch (kind) {
    case 'attack': return t('world.actAttack');
    case 'reinforce': return t('world.actReinforce');
    case 'sweep': return t('world.actSweep');
    case 'occupy': return t('world.actOccupy');
    case 'move': return t('world.team.moving');
    case 'return': return t('world.team.returning');
  }
}

/** `(x, y)` suffix — every away-from-home status line ends with where that is. */
function at(x: number, y: number): string {
  return `(${x},${y})`;
}

/**
 * Every row the team panel should show, in render order: one per formation template (whatever it is
 * doing, including nothing), then one per own flat-troop march.
 *
 * `now` is passed in rather than read from serverClock so the derivation stays pure and testable.
 */
export function buildTeamRows(ctx: WorldMapContext, now: number): TeamRow[] {
  const me = ctx.me;
  const [baseX, baseY] = me?.mainBaseTile ? ctx.parseTileId(me.mainBaseTile) : [0, 0];
  const cardState = me?.cardState ?? {};
  const rows: TeamRow[] = [];

  for (const team of ctx.teams) {
    if (team.army.length === 0) continue; // an empty slot is not a team the player has anything to look at
    const march = ctx.marches.find((m) => m.mine !== false && m.teamId === team.id) ?? null;
    const occupation = ctx.occupations.find((o) => o.teamId === team.id) ?? null;
    const station = ctx.stationed.find((s) => s.mine !== false && s.teamId === team.id) ?? null;
    const injuredUntil = me?.teamState?.[team.id]?.injuredUntil ?? 0;
    const base = {
      key: team.id,
      title: teamDisplayName(team),
      troops: carriedTroops(team.army, cardState),
      march: null as MarchView | null,
      stationedTeamId: null as string | null,
    };

    // Order matters: a march outranks the station/occupation docs that coexist with it mid-recall,
    // the same precedence CityScene/teamRow.ts applies (§8.8 — a team mid-recall must read 行军中,
    // not flash its old posting and then correct itself).
    if (march) {
      const [mx, my] = ctx.parseTileId(march.toTile);
      const returning = march.kind === 'return';
      rows.push({
        ...base,
        state: returning ? 'returning' : 'marching',
        status: `${marchKindLabel(march.kind)} ${at(mx, my)} ${formatDuration((march.arriveAt - now) / 1000)}`,
        jumpX: mx, jumpY: my,
        march,
      });
      continue;
    }
    if (occupation) {
      rows.push({
        ...base,
        state: 'occupying',
        status: `${t('world.team.occupying').replace('{time}', formatDuration((occupation.dueAt - now) / 1000))} ${at(occupation.x, occupation.y)}`,
        jumpX: occupation.x, jumpY: occupation.y,
      });
      continue;
    }
    if (station) {
      const garrison = station.mode === 'garrison';
      rows.push({
        ...base,
        state: garrison ? 'garrisoned' : 'stationed',
        status: `${t(garrison ? 'world.team.garrisoned' : 'world.team.stationedIdle')} ${at(station.x, station.y)}`,
        jumpX: station.x, jumpY: station.y,
        stationedTeamId: station.teamId,
      });
      continue;
    }
    if (injuredUntil > now) {
      rows.push({
        ...base,
        state: 'injured',
        status: t('roster.injured').replace('{time}', formatDuration((injuredUntil - now) / 1000)),
        jumpX: baseX, jumpY: baseY,
      });
      continue;
    }
    rows.push({ ...base, state: 'home', status: t('city.military.teamIdle'), jumpX: baseX, jumpY: baseY });
  }

  // Flat-troop armies: own marches carrying no teamId. `mine !== false` because ctx.marches also holds
  // in-vision ENEMY marches (G5), which are neither ours to list nor ours to recall.
  for (const m of ctx.marches) {
    if (m.mine === false || m.teamId) continue;
    const [mx, my] = ctx.parseTileId(m.toTile);
    rows.push({
      key: `march:${m.marchId}`,
      title: t('world.team.flatArmy'),
      troops: m.troops,
      state: m.kind === 'return' ? 'returning' : 'marching',
      status: `${marchKindLabel(m.kind)} ${at(mx, my)} ${formatDuration((m.arriveAt - now) / 1000)}`,
      jumpX: mx, jumpY: my,
      march: m,
      stationedTeamId: null,
    });
  }

  return rows;
}

/** Count of rows that are away from home — the number the collapsed badge shows against the total. */
export function awayCount(rows: readonly TeamRow[]): number {
  return rows.filter((r) => r.state !== 'home' && r.state !== 'injured').length;
}
