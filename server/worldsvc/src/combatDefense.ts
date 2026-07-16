// worldsvc combat domain: defense config (S8-4) + siege replay spectating (G3-2c).
// Peeled out of CombatService (2026-07-03). Depends on WorldCore for shared state and family checks. No behavior change.
import { buildSiegeBattle, playerWorldId, SlgError, type SiegeOutcome } from '@nw/shared';
import { validateDefenseConfig } from './siegeEngine';
import { WorldCore } from './core';
import type { SiegeSummaryView } from './worldTypes';

/** Upper bound on how many recent sieges the browser can pull in one call (last-100 replay browser). */
const SIEGE_LIST_MAX = 100;

export class DefenseService {
  constructor(private readonly core: WorldCore) {}

  // ── S8-4 residual: defense config ────────────────────────────────

  /**
   * Set the defense config for a territory tile or capital (player editing the defense).
   * tileKey='base' → write to the capital's playerWorld.defense; otherwise write to the corresponding tile.defense.
   * Defense config contents are not validated at this layer (P2 deferred validation, §14.9); levelSchema validation on the engine side is added in S8-3b.
   */
  async setDefense(
    worldId: string,
    accountId: string,
    tileKey: string,
    defenseConfig: Record<string, unknown>,
  ): Promise<void> {
    const { cols } = this.core.deps;
    // G3-2c: editor writes a structured formation → validated against the engine levelSchema on save (invalid unitType/column/row → rejected).
    try {
      validateDefenseConfig(defenseConfig);
    } catch (err) {
      throw new SlgError('BAD_REQUEST', `Invalid defense formation: ${(err as Error).message}`);
    }
    if (tileKey === 'base') {
      const pwId = playerWorldId(worldId, accountId);
      const pw = await cols.playerWorld.findOne({ _id: pwId });
      if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
      await cols.playerWorld.updateOne(
        { _id: pwId },
        { $set: { defense: defenseConfig }, $inc: { rev: 1 } },
      );
    } else {
      const tile = await cols.tiles.findOne({ _id: tileKey });
      if (!tile?.ownerId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
      // Own territory, or same-family ally territory (§4 proxy defense; allied sect passage pending alliance system) can both be set for defense.
      if (tile.ownerId !== accountId && !(await this.core.sameFamily(worldId, accountId, tile.ownerId))) {
        throw new SlgError('TILE_NOT_OWNED', 'Not your own or allied territory');
      }
      await cols.tiles.updateOne(
        { _id: tileKey },
        { $set: { defense: defenseConfig }, $inc: { rev: 1 } },
      );
    }
  }

  async getDefense(
    worldId: string,
    accountId: string,
    tileKey: string,
  ): Promise<Record<string, unknown> | null> {
    const { cols } = this.core.deps;
    if (tileKey === 'base') {
      const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
      if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
      return (pw.defense as Record<string, unknown> | undefined) ?? null;
    }
    const tile = await cols.tiles.findOne({ _id: tileKey });
    if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
    return (tile.defense as Record<string, unknown> | undefined) ?? null;
  }

  // ── G3-2c: siege replay spectating ───────────────────────────────────

  /**
   * Retrieve the "replay spectating" level for a decisive siege (G3-2c, §16.3). Both attacker and defender can read it (spectating is not authoritative; purely visual).
   * Reconstructs buildSiegeBattle from the seed + both sides' formations + tile level persisted by landSiege → shape aligned with the client's LevelDefinition.
   * The client reruns the same siege headless in siege mode using an empty ReplayInputSource and the same seed, reproducing exactly what worldsvc ran.
   * If replay inputs are missing (cheap fallback / NPC sweep / old battle report) → REPLAY_UNAVAILABLE.
   */
  async getSiegeReplay(
    worldId: string,
    accountId: string,
    sid: string,
  ): Promise<{ siegeId: string; seed: number; outcome: SiegeOutcome; level: Record<string, unknown> }> {
    const siege = await this.core.deps.cols.sieges.findOne({ _id: sid, worldId });
    if (!siege) throw new SlgError('NOT_FOUND', 'Battle report not found');
    if (siege.attackerId !== accountId && siege.defenderId !== accountId) {
      throw new SlgError('NO_PERMISSION', 'Only the attacker or defender can spectate this battle');
    }
    if (typeof siege.seed !== 'number' || !Array.isArray(siege.attackerArmy)) {
      throw new SlgError('NOT_FOUND', 'This battle report has no replayable record');
    }
    const level = buildSiegeBattle(
      { army: siege.attackerArmy },
      siege.defenderConfig ?? null,
      siege.tileLevel ?? 1,
      siege.seed,
    );
    return { siegeId: sid, seed: siege.seed, outcome: siege.outcome, level };
  }

  /**
   * List the requester's most recent siege battle reports (attacker OR defender), newest first, for the
   * client-side replay browser (last-100). Backed by the `{ worldId, ts:-1 }` index; sieges have no TTL, so
   * this is the player's full history capped at `limit` (≤ SIEGE_LIST_MAX). Only compact fields are returned —
   * the heavy replay inputs (seed + formations) are fetched per-row via getSiegeReplay when a row is opened.
   * `hasReplay` tells the client which rows are actually replayable (cheap-settle / NPC-sweep rows are not).
   */
  async listSieges(worldId: string, accountId: string, limit = SIEGE_LIST_MAX): Promise<SiegeSummaryView[]> {
    const n = Math.max(1, Math.min(SIEGE_LIST_MAX, Math.floor(limit) || SIEGE_LIST_MAX));
    const rows = await this.core.deps.cols.sieges
      .find({ worldId, $or: [{ attackerId: accountId }, { defenderId: accountId }] })
      .sort({ ts: -1 })
      .limit(n)
      .toArray();
    return rows.map((s) => ({
      siegeId: s._id,
      tile: s.tile,
      ...(typeof s.tileLevel === 'number' ? { tileLevel: s.tileLevel } : {}),
      outcome: s.outcome,
      role: s.attackerId === accountId ? 'attacker' : 'defender',
      ts: s.ts,
      hasReplay: typeof s.seed === 'number' && Array.isArray(s.attackerArmy) && s.attackerArmy.length > 0,
    }));
  }
}
