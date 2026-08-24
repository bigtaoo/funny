// worldsvc combat domain: defense config (S8-4) + siege replay spectating (G3-2c).
// Peeled out of CombatService (2026-07-03). Depends on WorldCore for shared state and family checks. No behavior change.
import { buildSiegeBattle, playerWorldId, SlgError, type SiegeOutcome } from '@nw/shared';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
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
      // Unguarded on purpose (2026-08-24 sweep): the value written is supplied by this command, not derived
      // from a snapshot read, and the `$set` is scoped to its own dotted path — so there is no other writer's
      // delta for it to overwrite. Last-writer-wins on a field the player just set is the intended semantics.
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
   * If replay inputs are missing (no-combat instant occupy / old battle report) → REPLAY_UNAVAILABLE.
   * 2026-08-12 fix: also returns `cardInstances`/`equipmentInv`/`siegeAcademy` (absent on a
   * flat/synthesized-army battle report, or a legacy record predating this fix) so the client's headless
   * re-simulation resolves the SAME `unitBlueprints` the real settlement did (mode:'siege' requires these
   * on `GameConfig` — see engine/setup/blueprints.ts). Without them the client used to silently fall back
   * to plain baseline blueprints for a card-army battle — "replaying" a materially different fight, able
   * to show a different winner than the recorded `outcome` (see SiegeReplayInputs' doc comment,
   * worldTypes.ts, for the production incident this closes).
   */
  async getSiegeReplay(
    worldId: string,
    accountId: string,
    sid: string,
  ): Promise<{
    siegeId: string;
    seed: number;
    outcome: SiegeOutcome;
    level: Record<string, unknown>;
    attackerName: string;
    defenderName: string;
    cardInstances?: EngineCardInstance[];
    equipmentInv?: EngineEquipInv;
    siegeAcademy?: { hp: number; damage: number; siege: number };
  }> {
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
    // Resolve both sides' display names for the replay's base plates / viewpoint tag (§16.3).
    // Same source as the march under_attack push — meta profile displayName. The attacker is always a
    // player (the march owner); the defender is a player for base/territory sieges but absent for PvE
    // targets (strongholds / crossings / ownerless buildings) → empty name, and the client falls back to
    // its generic placeholder (t('replay.player2')). Owner→side mapping: attacker = owner0 = bottom,
    // defender = owner1 = top (see buildSiegeBattle).
    const [attackerName, defenderName] = await Promise.all([
      this.resolveDisplayName(siege.attackerId),
      siege.defenderId ? this.resolveDisplayName(siege.defenderId) : Promise.resolve(''),
    ]);
    return {
      siegeId: sid, seed: siege.seed, outcome: siege.outcome, level, attackerName, defenderName,
      ...(siege.cardInstances ? { cardInstances: siege.cardInstances } : {}),
      ...(siege.equipmentInv ? { equipmentInv: siege.equipmentInv } : {}),
      ...(siege.siegeAcademy ? { siegeAcademy: siege.siegeAcademy } : {}),
    };
  }

  /** Resolve a player's display name via the meta service; '' when meta is unavailable or the lookup fails. */
  private async resolveDisplayName(id: string): Promise<string> {
    if (!this.core.meta.available) return '';
    const profile = await this.core.meta.getProfile(id).catch(() => null);
    return profile?.displayName ?? '';
  }

  /**
   * List the requester's most recent siege battle reports (attacker OR defender), newest first, for the
   * client-side replay browser (last-100). Backed by the `{ worldId, ts:-1 }` index; sieges have no TTL, so
   * this is the player's full history capped at `limit` (≤ SIEGE_LIST_MAX). Only compact fields are returned —
   * the heavy replay inputs (seed + formations) are fetched per-row via getSiegeReplay when a row is opened.
   * `hasReplay` tells the client which rows are actually replayable. As of 2026-08-01, replay inputs are stored
   * unconditionally — the cheap linear formula path (`shouldUseCheapSiege`) and a genuine engine-crash fallback
   * both still persist them (traceability decision — see combatSiege/arrival.ts applySiege), and getSiegeReplay
   * degrades safely if a stored crash-fallback battle can't actually be reconstructed. The sweep follow-up
   * extended this to `applySweep`, which used to never build a formation at all — it now synthesizes one purely
   * for replay storage, so sweeping a neutral tile is replayable too. Only a no-combat instant occupy (empty NPC
   * garrison — no army was ever built) or a legacy battle report predating this field leave `hasReplay` false.
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
