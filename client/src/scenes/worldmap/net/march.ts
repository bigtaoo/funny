// WorldMapNet's march/team-dispatch cluster (team picker, dispatch, join, recall), extracted as
// form① free functions (claudedocs/client-modules.md "单文件 500 行收敛"). `pendingTeamIds` is
// passed in explicitly (not module-level state) — it's genuinely per-WorldMapNet-instance guard
// state (closes the double-dispatch window for THIS scene's in-flight requests), so a module-level
// Set would incorrectly leak across instances; the plain Set reference is mutated in place
// (.add/.delete/.has), so no getter/setter is needed either.
import { t } from '../../../i18n';
import { ui as C } from '../../../render/sketchUi';
import type { TeamTemplate } from '../../../net/WorldApiClient';
import { carriedTroops, teamDisplayName } from '../../../game/meta/teamTroops';
import { cardPower } from '../../../game/meta/cardDefs';
import type { WorldMapContext, DeployKind } from '../WorldMapContext';
import { loadMapViewport } from './loaders';
import { errorMsg } from './errors';
import { territoryConnected, attackFootprintCells } from '../logic/attackConnectivity';

/**
 * Team picker for a team-based march. kind='attack' (siege a real player / stronghold) or 'occupy'
 * (grab neutral land, §4.2): both attach an attack-formation team so the committed troops belong to the
 * team's cards (cardState.currentTroops), not the flat pool — survivors are retained on the cards and the
 * team can march on after its occupation hold, instead of the pool troops being consumed as garrison.
 * For occupy we also keep the legacy "散兵占领" flat-pool option, so early players with no card team can
 * still grab land the old way.
 */
export async function showTeamPicker(
  ctx: WorldMapContext, pendingTeamIds: Set<string>,
  tx: number, ty: number, kind: 'attack' | 'occupy' | 'move' = 'attack', stationMode?: 'idle' | 'garrison',
): Promise<void> {
  const me = ctx.me;
  if (!me?.joined || !me.mainBaseTile) { ctx.panels.showToast(t('world.needBase'), C.red); return; }
  // ADR-039 连地 pre-check for attack/siege (2026-08-29 user report): without this, an unreachable target
  // with zero USABLE teams (all busy elsewhere) fell straight through to the generic "no teams, go edit a
  // formation" toast below — misleading, since the real (and here the only) blocker is that the target
  // doesn't border the player's own territory. Checking it up front surfaces the actual reason regardless
  // of team availability. Solo-only precision (territoryConnected defers to true for family members, same
  // as WorldMapInput.occupyConnected) — the server re-validates on departure either way.
  if (kind === 'attack' && !territoryConnected(ctx, attackFootprintCells(ctx, tx, ty))) {
    ctx.panels.showToast(t('world.err.notConnected'), C.red);
    return;
  }
  let teams: TeamTemplate[] = [];
  try {
    teams = await ctx.cb.worldApi.getTeams(ctx.cb.worldId);
  } catch { /* offline — treat as empty */ }
  // Idle-team gate (2026-07-15): a team already committed to an active (non-recalled) march — marching or
  // holding a captured tile — must not accept a new order (mirrors the server-side TEAM_BUSY check in
  // combatMarch.ts, which checks both `marches` and `occupations`).
  // ADR-051 (P3c, scope extended 2026-08-08 to include attack): a 停留 idle field team is NOT busy — it can
  // be re-commanded straight from where it stands, for attack/occupy/move alike (mirrors the server-side
  // idleRedispatch bypass in combatMarch/command.ts). Only 驻扎 garrison stationed teams count as busy here.
  // (2026-08-08 user report: a forward-stationed team looked idle but attack kept failing TEAM_BUSY — turned
  // out the server itself didn't allow attack-in-place at the time; fixed server-side to match this filter,
  // which already treated idle-stationed as free for every kind — see slg-attack-picker-idle-stationed
  // memory for the full incident, including the brief kind-restricted intermediate fix this superseded.)
  const busyTeamIds = new Set([
    ...ctx.marches.filter((m) => m.mine && m.teamId).map((m) => m.teamId),
    ...ctx.occupations.filter((o) => o.teamId).map((o) => o.teamId),
    ...ctx.stationed.filter((s) => s.mine !== false && s.mode === 'garrison').map((s) => s.teamId), // own 驻扎 = locked; own 停留 idle = free; enemy stationed ignored (teamId blanked anyway)
    ...pendingTeamIds, // in-flight dispatch not yet reflected in ctx.marches
  ]);
  // Committed troops = the strength the team actually CARRIES, from each card's cardState.currentTroops
  // ledger (§6.1). Legacy pre-migration teams (unit entries, no cardInstanceId) carry 0 — they can't be
  // dispatched, so they read 0 here and drop out of `usable` below (see teamTroops.ts). Mirrors
  // CityScene.committedTroops / TeamsScene so the picker shows the same number as those screens.
  const cardState = me.cardState ?? {};
  const committedOf = (tm: TeamTemplate): number => carriedTroops(tm.army, cardState);
  // Combat-power tiebreak: sum of each placed card's cardPower (Hero Roster level + gear), same proxy
  // formula CityScene/DefenseEditorScene use to rank cards. getSave is optional (test harnesses may omit
  // it) — teams without it just tie at power 0, falling back to the troops tiebreak above them.
  const save = ctx.cb.getSave?.();
  const cardInv = save?.cardInv ?? {};
  const equipmentInv = save?.equipmentInv ?? {};
  const powerOf = (tm: TeamTemplate): number => {
    let total = 0;
    for (const entry of tm.army) {
      const card = entry.cardInstanceId ? cardInv[entry.cardInstanceId] : undefined;
      if (card) total += cardPower(card, equipmentInv);
    }
    return total;
  };
  // A team's current position for the distance sort: an idle field team (停留, ADR-051 P3c) sits at its
  // stationed tile; every other usable team (never dispatched, or 停留 back home) is still at the main
  // base. Distance is Chebyshev (max of the two axis deltas) to match march-time convention (§ march
  // duration is computed off diagonal-capable path length, not straight-line/Euclidean distance).
  const positionOf = (tm: TeamTemplate): [number, number] => {
    const field = ctx.stationed.find((s) => s.mine !== false && s.teamId === tm.id);
    if (field) return [field.x, field.y];
    return me.mainBaseTile ? ctx.parseTileId(me.mainBaseTile) : [tx, ty];
  };
  const distanceOf = (tm: TeamTemplate): number => {
    const [px, py] = positionOf(tm);
    return Math.max(Math.abs(px - tx), Math.abs(py - ty));
  };
  // Only offer teams that can actually go into battle right now: non-empty army, not already
  // out on a march/hold, and carrying troops > 0 (a wiped-out or legacy team can't fight).
  // Sort: nearer first; ties broken by carried troops (more first), then combat power (higher first).
  const usable = teams
    .filter((tm) => tm.army.length > 0 && !busyTeamIds.has(tm.id) && committedOf(tm) > 0)
    .sort((a, b) => distanceOf(a) - distanceOf(b) || committedOf(b) - committedOf(a) || powerOf(b) - powerOf(a));
  const buttons: { label: string; action: () => void }[] = [];
  for (const tm of usable) {
    const committed = committedOf(tm);
    buttons.push({
      label: `${teamDisplayName(tm)} · ${t('world.team.committed').replace('{n}', String(committed))}`,
      action: () => void doMarchTeam(ctx, pendingTeamIds, tx, ty, tm.id, kind, stationMode),
    });
  }
  buttons.push({ label: '✕', action: () => ctx.panels.closeModal() });
  // 移动并驻扎 (stationMode==='garrison') gets its own picker title so the intent is unmistakable at team-select time.
  const moveTitle = stationMode === 'garrison' ? t('world.team.pickTitleGarrison') : t('world.team.pickTitleMove');
  const head = usable.length > 0
    ? (kind === 'occupy' ? t('world.team.pickTitleOccupy') : kind === 'move' ? moveTitle : t('world.team.pickTitle'))
    : (kind === 'occupy' ? t('world.team.noTeamsOccupy') : kind === 'move' ? t('world.team.noTeamsMove') : t('world.team.noTeams'));
  ctx.panels.showModal([head, `(${tx}, ${ty})`], buttons);
}

export async function doMarchTeam(
  ctx: WorldMapContext, pendingTeamIds: Set<string>,
  tx: number, ty: number, teamId: string, kind: 'attack' | 'occupy' | 'move' = 'attack', stationMode?: 'idle' | 'garrison',
): Promise<void> {
  ctx.panels.closeModal();
  const me = ctx.me;
  if (!me?.mainBaseTile) { ctx.panels.showToast(t('world.needBase'), C.red); return; }
  // Guard against a second dispatch of the same team while the first is still in flight (see pendingTeamIds).
  if (pendingTeamIds.has(teamId)) { ctx.panels.showToast(t('world.team.busy'), C.red); return; }
  pendingTeamIds.add(teamId);
  // Origin is always the main base for a fresh dispatch. ADR-051 (P3c): if the picked team is actually a 停留
  // idle field team being re-commanded, worldsvc overrides fromX/fromY to its stationed cell server-side, so
  // passing the base coords here is harmless (the client can't send a wrong origin that matters).
  const [fx, fy] = ctx.parseTileId(me.mainBaseTile);
  try {
    // troops=1 is a placeholder; the server overwrites it with the team's committed troop count (§16.2).
    // P1-3 (comm-audit-2026-07-27): startMarch's response already carries the created march + updated
    // `me` (troops/resources committed) — locally append/adopt both instead of following up with
    // GET /world/march + GET /world/me. `mine` isn't set on the raw march object (only getMarches'
    // list-assembly stamps it, since only it knows who's asking) — a march THIS call just dispatched
    // is unconditionally the caller's own, so it's safe to stamp true here directly.
    const { me: newMe, ...march } = await ctx.cb.worldApi.startMarch(ctx.cb.worldId, fx, fy, tx, ty, kind, 1, teamId, stationMode);
    ctx.marches = [...ctx.marches, { ...march, mine: true }];
    if (newMe) ctx.me = newMe; // defensive: never null out the cached state if a response omits it
    ctx.panels.showToast(t('world.dispatched'));
    ctx.view.renderMap(); ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  } finally {
    pendingTeamIds.delete(teamId);
  }
}

/**
 * ADR-051 (P4 §4.3): 就地占领 — an idle 停留 team standing on a neutral tile occupies that very tile without
 * marching. Dispatched as a normal team `occupy` on the tile the team already stands on: worldsvc's P3c
 * idle-redispatch forces the origin to the team's stationed cell (= this tile), so origin === destination →
 * a zero-distance occupy that fights the tile's NPC garrison and, on winning the hold, flips it to owned with
 * the team left standing there (idle). Reuses doMarchTeam verbatim (pendingTeamIds guard, occupy toast/refresh).
 */
export async function doInPlaceOccupy(ctx: WorldMapContext, pendingTeamIds: Set<string>, tx: number, ty: number, teamId: string): Promise<void> {
  await doMarchTeam(ctx, pendingTeamIds, tx, ty, teamId, 'occupy');
}

export async function doMarch(ctx: WorldMapContext, tx: number, ty: number, kind: DeployKind, troops: number): Promise<void> {
  ctx.panels.closeModal();
  const me = ctx.me;
  if (!me?.mainBaseTile) { ctx.panels.showToast(t('world.needBase'), C.red); return; }
  if (troops < 1) { ctx.panels.showToast(t('world.err.noTroops'), C.red); return; }
  const [fx, fy] = ctx.parseTileId(me.mainBaseTile);
  try {
    // P1-3: see doMarchTeam's comment above — adopt march + me from the response directly.
    const { me: newMe, ...march } = await ctx.cb.worldApi.startMarch(ctx.cb.worldId, fx, fy, tx, ty, kind, troops);
    ctx.marches = [...ctx.marches, { ...march, mine: true }];
    if (newMe) ctx.me = newMe; // defensive: never null out the cached state if a response omits it
    ctx.panels.showToast(t('world.dispatched'));
    ctx.view.renderMap(); ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

/** Join the world: the system automatically places the capital (§3.4, preferring proximity to the family); the position is determined by the server. After placement, pan the camera to the new capital. */
export async function doJoin(ctx: WorldMapContext): Promise<void> {
  ctx.panels.closeModal();
  try {
    ctx.me = await ctx.cb.worldApi.joinWorld(ctx.cb.worldId);
    ctx.panels.showToast(t('world.myBase'));
    if (ctx.me.mainBaseTile) {
      const [bx, by] = ctx.parseTileId(ctx.me.mainBaseTile);
      ctx.view.centerAt(bx, by);
      if (!(ctx.cb.getFlag?.('guide.world.step1') ?? false)) ctx.guideStep = 'step1';
    }
    await loadMapViewport(ctx);
    ctx.view.renderMap(); ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

export async function doRecall(ctx: WorldMapContext, marchId: string, worldId: string): Promise<void> {
  try {
    await ctx.cb.worldApi.recallMarch(marchId, worldId);
    ctx.marches = await ctx.cb.worldApi.getMarches(ctx.cb.worldId);
    ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

/** Pay coins to instantly complete an in-transit 'return' march (2026-08-01, SLG_DESIGN_LOG §46). */
export async function doInstantReturn(ctx: WorldMapContext, marchId: string, worldId: string): Promise<void> {
  try {
    ctx.me = await ctx.cb.worldApi.instantReturnMarch(marchId, worldId);
    ctx.marches = await ctx.cb.worldApi.getMarches(ctx.cb.worldId);
    ctx.panels.showToast(t('world.instantReturnDone'));
    ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

/** Recall a team stationed on a tile back home (2026-07-23): dispatches a return leg, then refreshes the map. */
export async function doRecallStationed(ctx: WorldMapContext, teamId: string): Promise<void> {
  ctx.panels.closeModal();
  try {
    await ctx.cb.worldApi.recallStationed(teamId, ctx.cb.worldId);
    const [marches, stationed] = await Promise.all([
      ctx.cb.worldApi.getMarches(ctx.cb.worldId),
      ctx.cb.worldApi.getStationed(ctx.cb.worldId),
    ]);
    ctx.marches = marches;
    ctx.stationed = stationed;
    ctx.panels.showToast(t('world.stationRecalled'));
    ctx.view.renderMap(); ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}
