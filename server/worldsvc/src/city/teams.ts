// worldsvc home-city domain: attack formation templates (teams) + card troop pool (G3-2c / CC-3). Split
// out of city.ts (2026-08-10, 独立类+组合 form, friendService.ts/familyService.ts's sibling — see
// city.ts's facade comment for why). Depends only on WorldCore. No behavior change.
import {
  playerWorldId,
  SlgError,
  SIEGE_TEAM_CAP,
  CARD_TEAM_MAX_SIZE,
  CARD_TROOP_PAPER_COST,
  CARD_TROOP_GRAPHITE_COST,
  CARD_TROOP_METAL_COST,
  CARD_TROOP_REFUND_RATE,
  CARD_RECOVER_COIN_COST,
  cardTroopCap,
  type CardInstance,
} from '@nw/shared';
import { validateAttackerArmy, sanitizeCardArmy } from '../siegeEngine';
import { WorldCore } from '../core';
import type { TeamTemplate } from '../db';

/**
 * Rebuild a team around its sanitized army, keeping `leaderCardId` only while the leader is still
 * one of the team's cards (2026-07-25). A stale leader is dropped rather than rejected — the card
 * may have been sold, moved to another team, or simply erased from the formation, and none of those
 * are worth failing a whole save over; the client then falls back to the strongest card for the icon.
 * The key is deleted (not set to undefined) so it doesn't linger as a null in the stored document.
 */
function withValidLeader(team: TeamTemplate, army: TeamTemplate['army']): TeamTemplate {
  const next: TeamTemplate = { ...team, army };
  if (!next.leaderCardId || !army.some((e) => e.cardInstanceId === next.leaderCardId)) delete next.leaderCardId;
  return next;
}

export class CityTeamsService {
  constructor(private readonly core: WorldCore) {}

  /**
   * Read the player's list of attack formation templates in a given world (editor / pre-fill on departure).
   * Throws TILE_NOT_OWNED if the player has not joined the world.
   * Self-heal: drops any army entry that no longer resolves to an owned card (stale reference, or a
   * pre-CC-3 raw unit-type entry — no compat path, see `sanitizeCardArmy`) and persists the cleanup so it
   * only runs once; freed cards are released via the same teamId/currentTroops-clear + refund path as an
   * explicit `setTeams` removal. Skipped (returns raw data) if meta is unreachable — never destroy team
   * data just because the cardInv lookup degraded.
   *
   * Latency (2026-08-02): this is on the CityScene critical path, and the self-heal only needs to know
   * whether the ids the formations already reference still resolve — so it asks meta for exactly those
   * (`cardIds`) instead of the player's entire roster, and skips the cross-service hop altogether when
   * no team references a card at all.
   */
  async getTeams(worldId: string, accountId: string): Promise<TeamTemplate[]> {
    const pwId = playerWorldId(worldId, accountId);
    const pw = await this.core.deps.cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    const teams = pw.teams ?? [];
    if (teams.length === 0) return teams;

    const referencedIds = [...new Set(
      teams.flatMap((team) => team.army.map((e) => e.cardInstanceId).filter((id): id is string => !!id)),
    )];
    let cardInv: Record<string, CardInstance> = {};
    if (referencedIds.length > 0) {
      const save = await this.core.meta.getSaveFields(accountId, ['cardInv'], referencedIds).catch(() => null);
      if (!save) return teams; // meta unreachable; degrade without touching stored data
      cardInv = save.cardInv ?? {};
    }

    let changed = false;
    const cleaned = teams.map((team) => {
      const { army } = sanitizeCardArmy(team.army, cardInv);
      if (army.length !== team.army.length) changed = true;
      const healed = withValidLeader(team, army);
      if (healed.leaderCardId !== team.leaderCardId) changed = true;
      return healed;
    });
    if (!changed) return teams;

    const patch = this.buildCardRemovalPatch(pw.cardState ?? {}, cleaned);
    // rev-guard: the refund in patch.resourceInc was computed from this exact read (`pw.cardState`).
    // Without it, two concurrent self-heals (or a self-heal racing an explicit setTeams) both compute
    // the same removed-card refund from the same pre-removal snapshot and both $inc it — a repeatable
    // resource dupe. On conflict, skip persisting this round; the next read will self-heal again.
    await this.core.deps.cols.playerWorld.updateOne(
      { _id: pwId, rev: pw.rev },
      { $set: { teams: cleaned, ...patch.cardStateSet }, $inc: { rev: 1, ...patch.resourceInc } },
    );
    return cleaned;
  }

  /**
   * Shared by `getTeams` (self-heal) and `setTeams` (explicit save): diffs `cardState`'s current
   * teamId assignments against `teams` and builds the $set/$inc patch that frees any card no longer
   * referenced by any team — clears teamId + currentTroops, refunds 80% of its training resources
   * (same terms as an explicit removal in the editor).
   */
  private buildCardRemovalPatch(
    cardState: Record<string, { currentTroops?: number; teamId?: string }>,
    teams: TeamTemplate[],
  ): { cardStateSet: Record<string, unknown>; resourceInc: Record<string, number> } {
    const cardIds = new Set<string>();
    for (const team of teams) for (const e of team.army) if (e.cardInstanceId) cardIds.add(e.cardInstanceId);

    const prevCardTeams = Object.entries(cardState).filter(([, cs]) => cs.teamId).map(([id]) => id);
    const removedCards = prevCardTeams.filter((id) => !cardIds.has(id));

    const cardStateSet: Record<string, unknown> = {};
    for (const team of teams) {
      for (const entry of team.army) {
        if (entry.cardInstanceId) cardStateSet[`cardState.${entry.cardInstanceId}.teamId`] = team.id;
      }
    }
    const resourceInc: Record<string, number> = {};
    for (const id of removedCards) {
      const troops = cardState[id]?.currentTroops ?? 0;
      if (troops > 0) {
        resourceInc['resources.paper'] = (resourceInc['resources.paper'] ?? 0) + Math.floor(troops * CARD_TROOP_PAPER_COST * CARD_TROOP_REFUND_RATE);
        resourceInc['resources.graphite'] = (resourceInc['resources.graphite'] ?? 0) + Math.floor(troops * CARD_TROOP_GRAPHITE_COST * CARD_TROOP_REFUND_RATE);
        resourceInc['resources.metal'] = (resourceInc['resources.metal'] ?? 0) + Math.floor(troops * CARD_TROOP_METAL_COST * CARD_TROOP_REFUND_RATE);
      }
      cardStateSet[`cardState.${id}.currentTroops`] = 0;
      cardStateSet[`cardState.${id}.teamId`] = null;
    }
    return { cardStateSet, resourceInc };
  }

  /**
   * Overwrite the player's attack formation templates (editor save, §16.2).
   * CC-3: each team's army is resolved against the player's real card inventory first (`sanitizeCardArmy`) —
   * an entry with no `cardInstanceId` (pre-CC-3 raw unit-type format) or one that no longer resolves to an
   * owned card is dropped silently rather than rejecting the whole save; the dropped card (if any) is freed
   * by the same removal path as an explicit un-assign (teamId/currentTroops cleared, 80% refund). Then
   * validates cardInstanceId uniqueness across all teams, max CARD_TEAM_MAX_SIZE slots per team, formation
   * legality (`validateAttackerArmy`), and injured-card lock.
   * Full-set overwrite (frontend sends the complete list).
   */
  async setTeams(worldId: string, accountId: string, teams: TeamTemplate[]): Promise<void> {
    if (!Array.isArray(teams)) throw new SlgError('BAD_REQUEST', 'teams must be an array');
    if (teams.length > SIEGE_TEAM_CAP) throw new SlgError('BAD_REQUEST', `Team count exceeds the cap of ${SIEGE_TEAM_CAP}`);
    const teamIds = new Set<string>();
    for (const team of teams) {
      if (!team || typeof team.id !== 'string' || !team.id) throw new SlgError('BAD_REQUEST', 'Team id is invalid');
      if (teamIds.has(team.id)) throw new SlgError('BAD_REQUEST', `Duplicate team id: ${team.id}`);
      teamIds.add(team.id);
      if (team.army.length > CARD_TEAM_MAX_SIZE) throw new SlgError('BAD_REQUEST', `Team ${team.id} exceeds max size of ${CARD_TEAM_MAX_SIZE}`);
    }

    const pwId = playerWorldId(worldId, accountId);
    const pw = await this.core.deps.cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    const save = await this.core.meta.getSaveFields(accountId, ['cardInv']).catch(() => null);
    if (!save) throw new SlgError('INTERNAL', 'Card inventory unavailable, please retry');
    const cardInv = save.cardInv ?? {};

    const cardIds = new Set<string>();
    const cleanedTeams: TeamTemplate[] = [];
    for (const team of teams) {
      const { army, resolved } = sanitizeCardArmy(team.army, cardInv);
      for (const e of army) {
        if (cardIds.has(e.cardInstanceId!)) throw new SlgError('BAD_REQUEST', `Card ${e.cardInstanceId} assigned to multiple teams`);
        cardIds.add(e.cardInstanceId!);
      }
      try {
        validateAttackerArmy(resolved);
      } catch (err) {
        throw new SlgError('BAD_REQUEST', `Team ${team.id} formation is invalid: ${(err as Error).message}`);
      }
      cleanedTeams.push(withValidLeader(team, army));
    }

    const now = this.core.deps.now();
    const cardState = pw.cardState ?? {};
    // Injured card check: a card with injuredUntil > now cannot be (re)assigned to a team it wasn't
    // already on. Compare against the *previous* teamId rather than blanket-checking every card in
    // the full payload — the client always resends every team's army on save, so editing team B
    // while team A (already fighting, unrelated) happens to hold an injured card must not fail: that
    // card's assignment to A isn't changing. Only a genuinely new assignment (unteamed or moving to a
    // different team) is blocked, matching CHARACTER_CARDS_DESIGN §7.2/§8.
    const nextTeamOf = new Map<string, string>();
    for (const team of cleanedTeams) for (const e of team.army) if (e.cardInstanceId) nextTeamOf.set(e.cardInstanceId, team.id);
    for (const id of cardIds) {
      const cs = cardState[id];
      if (!cs?.injuredUntil || cs.injuredUntil <= now) continue;
      if (cs.teamId && cs.teamId === nextTeamOf.get(id)) continue; // unchanged assignment, already legitimate
      throw new SlgError('CARD_INJURED', `Card ${id} is injured and cannot be assigned until ${cs.injuredUntil}`);
    }

    const patch = this.buildCardRemovalPatch(cardState, cleanedTeams);
    // rev-guard: same reasoning as getTeams's self-heal write — patch.resourceInc is a refund computed
    // from this exact `cardState` read, so a concurrent write (another setTeams call, or a racing
    // getTeams self-heal) must not be allowed to land its own refund on top of a stale snapshot.
    const update: Record<string, unknown> = { $set: { teams: cleanedTeams, ...patch.cardStateSet }, $inc: { rev: 1, ...patch.resourceInc } };
    const result = await this.core.deps.cols.playerWorld.updateOne({ _id: pwId, rev: pw.rev }, update);
    if (result.matchedCount === 0) throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');
  }

  /**
   * Distribute troops from the base troop pool (`playerWorld.troops`, the unified 基地兵力池) to card
   * slots (CC-3, CHARACTER_CARDS_DESIGN §6.3). allocations: { [cardInstanceId]: troopsToAdd }.
   * Each card must have a teamId (be in a team). Deducts total from `troops`; updates cardState[id].currentTroops.
   *
   * Per-card cap (2026-08-19): each card's resulting `currentTroops` must stay within
   * `cardTroopCap(card)` = troopCapBase + growth×(level-1). This used to be a CLIENT-ONLY rule — the
   * stepper/fill button capped the numbers it sent and this method's doc comment asserted the invariant
   * was "enforced on every way IN", but nothing here checked it, so any hand-rolled request could park
   * an unbounded troop count on a single card. That mattered little while troops above a unit's HP cap
   * were inert; ADR-069 made siege damage scale linearly and without a ceiling on carried troops, which
   * turned the unchecked path into "one card with the whole pool flattens any base". Hence the real
   * check, plus the same per-card guard restated in the update filter so two concurrent calls can't
   * both pass it.
   */
  async distributeTroops(worldId: string, accountId: string, allocations: Record<string, number>): Promise<void> {
    const { cols } = this.core.deps;
    const pwId = playerWorldId(worldId, accountId);
    const pw = await cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const cardState = pw.cardState ?? {};
    let totalCost = 0;
    const cardStateInc: Record<string, number> = {};
    const requested: { id: string; amount: number }[] = [];

    for (const [id, amount] of Object.entries(allocations)) {
      if (typeof amount !== 'number' || amount < 0 || !Number.isInteger(amount)) {
        throw new SlgError('BAD_REQUEST', `Invalid troop count for card ${id}`);
      }
      if (amount === 0) continue;
      const cs = cardState[id];
      if (!cs?.teamId) throw new SlgError('BAD_REQUEST', `Card ${id} is not assigned to a team`);
      totalCost += amount;
      cardStateInc[`cardState.${id}.currentTroops`] = amount;
      requested.push({ id, amount });
    }

    if (totalCost === 0) return;

    // Per-card cap. `level` lives in the meta save (cardInv), not in worldsvc, so this needs the same
    // meta round-trip setTeams already does — scoped to the cards actually being topped up. A card the
    // inventory no longer knows about is rejected rather than waved through: it is the same "stale
    // reference" shape sanitizeCardArmy drops on the team path, and silently accepting troops for it
    // would burn them into a slot nothing can ever field.
    const save = await this.core.meta
      .getSaveFields(accountId, ['cardInv'], requested.map((r) => r.id))
      .catch(() => null);
    if (!save) throw new SlgError('INTERNAL', 'Card inventory unavailable, please retry');
    const cardInv = save.cardInv ?? {};
    const capFilter: Record<string, unknown> = {};
    for (const { id, amount } of requested) {
      const card = cardInv[id];
      if (!card) throw new SlgError('BAD_REQUEST', `Card ${id} is not in the inventory`);
      const cap = cardTroopCap(card);
      const current = cardState[id]?.currentTroops ?? 0;
      if (current + amount > cap) {
        throw new SlgError(
          'CARD_TROOP_CAP_EXCEEDED',
          `Card ${id} can hold ${cap} troops (has ${current}, tried to add ${amount})`,
        );
      }
      // Restate the same bound in the update filter: the check above is a read-then-check on `pw`, so
      // two concurrent calls each adding half the remaining headroom would both pass it. This is the
      // atomic equivalent, phrased as `$not: {$gt: …}` rather than `$lte: …` ON PURPOSE — `setTeams`
      // writes only `cardState.<id>.teamId` when it assigns a card, so `currentTroops` is ABSENT until
      // the first allocation, and a missing field never matches `$lte` (BSON type bracketing). With
      // `$lte` the player's very first 分兵 onto a fresh team card fails as "not enough troop stock"
      // with a full pool; the negated form matches a missing field, which is exactly right — absent
      // means 0 so far, and `amount <= cap` is already established above.
      capFilter[`cardState.${id}.currentTroops`] = { $not: { $gt: cap - amount } };
    }

    // Atomic guarded debit (troops:{$gte:totalCost} in the filter, $inc not $set): a stale JS-side
    // read-then-check would let two concurrent distributeTroops calls both pass and drive troops negative.
    // The per-card currentTroops bump is also a $inc (not a computed $set) for the same reason.
    const result = await cols.playerWorld.updateOne(
      { _id: pwId, troops: { $gte: totalCost }, ...capFilter },
      { $inc: { ...cardStateInc, troops: -totalCost, rev: 1 } },
    );
    if (result.matchedCount === 0) {
      // Either the pool moved under us or a concurrent allocation ate the per-card headroom; both are
      // "retry with fresh numbers", and the pool case is by far the more common one.
      throw new SlgError('NO_TROOPS', `Not enough troop stock (need ${totalCost}), or a card's cap was reached concurrently`);
    }
  }

  /**
   * Recover an injured card by spending CARD_RECOVER_COIN_COST coins (CC-3, CHARACTER_CARDS_DESIGN §7.2).
   * Clears injuredUntil. Throws CARD_NOT_INJURED if card is not currently injured.
   */
  async recoverCard(worldId: string, accountId: string, cardInstanceId: string, clientPlatform?: string): Promise<void> {
    const { cols, now } = this.core.deps;
    const pwId = playerWorldId(worldId, accountId);
    const pw = await cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const cs = pw.cardState?.[cardInstanceId];
    const nowMs = now();
    if (!cs?.injuredUntil || cs.injuredUntil <= nowMs) throw new SlgError('BAD_REQUEST', `Card ${cardInstanceId} is not injured`);

    // Deduct coins via commercial client (spend throws INSUFFICIENT_FUNDS if not enough). The orderId must
    // be unique per call (like every other coin-spend site in this file) — commercial.spend treats a
    // repeated orderId as an idempotent no-op success without re-debiting, so a bare `recover:${id}` would
    // make every recovery after the first one free forever for that card instance.
    await this.core.commercial.spend(
      accountId, CARD_RECOVER_COIN_COST, `recover:${worldId}:${accountId}:${cardInstanceId}:${nowMs}`, clientPlatform,
    );

    await cols.playerWorld.updateOne(
      { _id: pwId },
      { $set: { [`cardState.${cardInstanceId}.injuredUntil`]: null }, $inc: { rev: 1 } },
    );
  }
}
