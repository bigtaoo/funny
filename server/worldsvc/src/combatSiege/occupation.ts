// ADR-037 (§5.4): occupy-march PvE battle + delayed occupation-hold settlement. `applyOccupy` is the arrival
// handler for MarchKind='occupy' (dispatched from combatMarch.ts, replacing the old instant/no-combat grab);
// `applyOccupationExpulsion` is shared by both an interrupting 'occupy' march (combatMarch.ts) and an
// interrupting 'attack' march against a mid-hold tile (combatSiege/arrival.ts); `processDueOccupations` is the
// scheduler tick that finalizes ownership once the hold elapses (mirrors ADR-026's processDueSiegeDamage).
// Depends on the helpers mixin (recordSiege) for battle-report logging; shares refundTroops with the rest of
// the combat domain.
import {
  proceduralTile,
  siegeSeedFromId,
  playerWorldId,
  resolveSiege,
  npcGarrison,
  OCCUPY_HOLD_SEC,
  type SiegeResolution,
  type ProceduralTile,
} from '@nw/shared';
import { runSiegeBattle, synthesizeArmy, resolveCardArmy, toEngineCardInstances, computeCardStateUpdates } from '../siegeEngine';
import type { GarrisonEntry, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import type { TileDoc, PlayerWorldDoc, MarchDoc, OccupationDoc } from '../db';
import type { SiegeReplayInputs } from '../worldTypes';
import { refundTroops } from '../combatShared';
import type { SiegeServiceBaseCtor, Constructor } from './base';
import type { WorldCore } from '../core';

export interface OccupationHandlers {
  applyOccupy(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void>;
  applyOccupationExpulsion(m: MarchDoc, pw: PlayerWorldDoc, tile: TileDoc, t: number): Promise<void>;
  processDueOccupations(nowMs?: number): Promise<number>;
}

/**
 * Writes post-battle cardState (currentTroops + injuredUntil) for a card army's survivors on an occupy/expulsion
 * march (§6.1 — the card keeps its own troops regardless of outcome). Never touches playerWorld.troops.
 */
async function writeOccupyCardState(
  core: WorldCore,
  m: MarchDoc,
  pw: PlayerWorldDoc,
  survivors: number,
  t: number,
): Promise<void> {
  const cardUpdates = computeCardStateUpdates(m.army ?? [], pw.cardState ?? {}, survivors, t);
  const cardStateSet: Record<string, unknown> = {};
  for (const [id, update] of Object.entries(cardUpdates)) {
    cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
    cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil != null ? update.injuredUntil : null;
  }
  if (Object.keys(cardStateSet).length > 0) {
    await core.deps.cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
  }
}

export function OccupationMixin<TBase extends SiegeServiceBaseCtor>(Base: TBase): TBase & Constructor<OccupationHandlers> {
  return class extends Base {
    /**
     * Occupy march arrival (§5.4): re-validate the target is still occupiable, then either fight the tile's
     * system garrison (npcGarrison(level), same source of truth as applySweep) or — if the tile is already
     * mid occupation-hold by someone else — treat this as an expulsion attempt against their held garrison.
     * Victory starts (or restarts) an occupation hold rather than writing ownership immediately.
     */
    async applyOccupy(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
      const { cols } = this.core.deps;
      // CC-3 (2026-07-15, SLG_DESIGN §4.2): a card-army march's strength lives entirely in cardState.currentTroops,
      // never in playerWorld.troops — every refund path below must skip the pool credit for such a march.
      const rawArmy = m.army ?? [];
      const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
      const x = this.core.coordX(m.toTile);
      const y = this.core.coordY(m.toTile);
      const proc = proceduralTile(m.worldId, x, y);
      const occ = await cols.tiles.findOne({ _id: m.toTile });

      // ADR-039 territory connectivity: the occupier's sect territory can shift during transit; re-validate
      // here before any capture branch — treat like a miss (refund), same as the ownership recheck below.
      // occupy never targets a capital, so a single cell (no footprint resolution needed).
      if (!(await this.core.isConnectedToSectTerritory(m.worldId, m.ownerId, [{ x, y }]))) {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
        return;
      }

      const blocked =
        proc.type === 'center' ||
        (occ?.ownerId != null && occ.ownerId !== m.ownerId) ||
        (occ?.ownerId === m.ownerId && occ.type !== 'base');
      if (blocked) {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
        return;
      }

      // Mid occupation-hold by someone else → this march is an expulsion attempt against their held garrison.
      if (occ?.contestedBy && occ.contestedBy !== m.ownerId && (occ.contestedUntil ?? 0) > t) {
        await this.applyOccupationExpulsion(m, pw, occ, t);
        return;
      }
      // Our own pending hold already occupies this tile (race: a second occupy march from the same player) —
      // reinforcing an in-progress hold is out of scope for v1; treat as a miss and refund.
      if (occ?.contestedBy && occ.contestedBy === m.ownerId) {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
        return;
      }

      const garrison = npcGarrison(proc.level);
      if (garrison <= 0) {
        // Defensive-only fallback (npcGarrison always > 0 given resourceDensity=1.0 — see §5.4); instant occupy, no combat.
        await this.startOccupationHold(m, pw, proc, x, y, m.troops, t, null);
        return;
      }

      // Real card team (2026-07-15, SLG_DESIGN §4.2) → resolve via cardState + blueprint injection, same as
      // attack sieges (combatSiege/arrival.ts) — occupying land now reflects the player's actual army, not a
      // generic synthesized force. Flat/legacy army or none → synthesize as before.
      const attackerSave = hasCardArmy ? await this.core.meta.getSaveFields(m.ownerId).catch(() => null) : null;
      const attackerArmy: GarrisonEntry[] =
        hasCardArmy
          ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
          : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker'));
      let cardInstances: EngineCardInstance[] | undefined;
      let cardEquipInv: EngineEquipInv | undefined;
      if (hasCardArmy && attackerSave) {
        const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv, attackerSave.equipmentInv);
        cardInstances = ci;
        cardEquipInv = engEquipInv;
      }
      const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender') };
      const tileLevel = proc.level;
      const seed = siegeSeedFromId(m._id);
      let res: SiegeResolution;
      let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
      try {
        res = runSiegeBattle({ attackerArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv });
      } catch (err) {
        console.error('[worldsvc] occupy siege engine failed — fallback to cheap resolve', {
          tile: m.toTile,
          err: (err as Error).message,
        });
        res = resolveSiege(m.troops, garrison);
        replay = null;
      }

      if (res.outcome === 'attacker_win') {
        // Card survivors also land on cardState (§6.1 — the card keeps its own troops) in addition to seeding
        // the newly captured tile's independent garrison stat below (startOccupationHold); the two are unrelated
        // ledgers, not a double-refund of the same pool (see SLG_DESIGN §4.2).
        if (hasCardArmy) await writeOccupyCardState(this.core, m, pw, res.attackerSurvivors, t);
        await this.startOccupationHold(m, pw, proc, x, y, res.attackerSurvivors, t, replay);
      } else {
        if (hasCardArmy) {
          await writeOccupyCardState(this.core, m, pw, res.attackerSurvivors, t);
        } else if (res.attackerSurvivors > 0) {
          await refundTroops(this.core, pw, res.attackerSurvivors, t);
        }
        void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
        const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
        void this.core.pushSiege(m.ownerId, siege, '');
      }
    }

    /**
     * Expulsion (§5.4): an interrupting 'attack' march (combatSiege/arrival.ts applySiege, target no-owner but
     * mid-hold) or 'occupy' march (applyOccupy above) fights the CURRENT held garrison (tile.contestedGarrison),
     * not a re-fetched NPC garrison — the original occupier already replaced the system defenders with real troops.
     * Win → cancel the old hold and start a fresh one for the interrupter (reusing startOccupationHold).
     * Loss → the original hold is undisturbed; interrupter survivors are refunded.
     */
    override async applyOccupationExpulsion(m: MarchDoc, pw: PlayerWorldDoc, tile: TileDoc, t: number): Promise<void> {
      const { cols } = this.core.deps;
      const rawArmy = m.army ?? [];
      const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
      const garrison = tile.contestedGarrison ?? 0;
      const attackerSave = hasCardArmy ? await this.core.meta.getSaveFields(m.ownerId).catch(() => null) : null;
      const attackerArmy: GarrisonEntry[] =
        hasCardArmy
          ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
          : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker'));
      let cardInstances: EngineCardInstance[] | undefined;
      let cardEquipInv: EngineEquipInv | undefined;
      if (hasCardArmy && attackerSave) {
        const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv, attackerSave.equipmentInv);
        cardInstances = ci;
        cardEquipInv = engEquipInv;
      }
      const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender') };
      const tileLevel = tile.level ?? 1;
      const seed = siegeSeedFromId(m._id);
      let res: SiegeResolution;
      let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
      try {
        res = runSiegeBattle({ attackerArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv });
      } catch (err) {
        console.error('[worldsvc] occupation expulsion siege engine failed — fallback to cheap resolve', {
          tile: m.toTile,
          err: (err as Error).message,
        });
        res = resolveSiege(m.troops, garrison);
        replay = null;
      }

      if (res.outcome === 'attacker_win') {
        // Cancel the old hold (atomic claim by id + expected holder guards against a race with a concurrent
        // processDueOccupations tick that may have already settled/claimed it — in that case just proceed to
        // start our own hold on top of whatever ownership now stands, re-validated by the blocked check upstream).
        await cols.occupations.deleteOne({ _id: tile._id, ownerId: tile.contestedBy });
        await this.core.unscheduleOccupation(m.worldId, tile._id);
        if (hasCardArmy) await writeOccupyCardState(this.core, m, pw, res.attackerSurvivors, t);
        const proc = proceduralTile(m.worldId, tile.x, tile.y);
        await this.startOccupationHold(m, pw, proc, tile.x, tile.y, res.attackerSurvivors, t, replay);
      } else {
        if (hasCardArmy) {
          await writeOccupyCardState(this.core, m, pw, res.attackerSurvivors, t);
        } else if (res.attackerSurvivors > 0) {
          await refundTroops(this.core, pw, res.attackerSurvivors, t);
        }
        void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
        const siege = await this.recordSiege(m, tile.contestedBy, res.outcome, t, replay);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
        void this.core.pushSiege(m.ownerId, siege, '');
      }
    }

    /**
     * Start (or restart, on expulsion) an occupation hold: write the tile's contested fields (no ownerId yet),
     * upsert the OccupationDoc keyed by tileId, and schedule the delayed settlement. Reused by both the fresh
     * PvE-win path (applyOccupy) and the expulsion-win path (applyOccupationExpulsion).
     */
    private async startOccupationHold(
      m: MarchDoc,
      pw: PlayerWorldDoc,
      proc: ProceduralTile,
      x: number,
      y: number,
      survivors: number,
      t: number,
      replay: SiegeReplayInputs | null,
    ): Promise<void> {
      const { cols } = this.core.deps;
      const dueAt = t + OCCUPY_HOLD_SEC * 1000;
      const tileDoc: TileDoc = {
        _id: m.toTile,
        worldId: m.worldId,
        x,
        y,
        type: proc.type,
        level: proc.level,
        ...(proc.resType ? { resType: proc.resType } : {}),
        contestedBy: m.ownerId,
        contestedUntil: dueAt,
        contestedGarrison: survivors,
        ...(pw.familyId ? { contestedFamilyId: pw.familyId } : {}),
        rev: 0,
      };
      await cols.tiles.updateOne({ _id: m.toTile }, { $set: tileDoc }, { upsert: true });

      const occDoc: OccupationDoc = {
        _id: m.toTile,
        worldId: m.worldId,
        ownerId: m.ownerId,
        ...(pw.familyId ? { familyId: pw.familyId } : {}),
        tile: m.toTile,
        x,
        y,
        level: proc.level,
        ...(proc.resType ? { resType: proc.resType } : {}),
        garrison: survivors,
        dueAt,
        ...(m.teamId ? { teamId: m.teamId } : {}),
      };
      await cols.occupations.updateOne({ _id: m.toTile }, { $set: occDoc }, { upsert: true });
      await this.core.scheduleOccupation(m.worldId, m.toTile, dueAt);

      void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      const siege = await this.recordSiege(m, undefined, 'attacker_win', t, replay);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushSiege(m.ownerId, siege, '');
      const after = await cols.tiles.findOne({ _id: m.toTile });
      if (after) {
        void this.core.pushTile(m.ownerId, after);
        await this.core.pushTileToObservers(after, new Set([m.ownerId]));
      }
    }

    /**
     * Scheduler tick (mirrors processDueSiegeDamage): claim due OccupationDocs and finalize ownership. Atomic
     * claim-and-delete by (_id, ownerId, dueAt) makes this single-consumer safe against a concurrent expulsion
     * that may have already replaced/deleted the same doc.
     */
    async processDueOccupations(nowMs?: number): Promise<number> {
      const { cols } = this.core.deps;
      const t = nowMs ?? this.core.deps.now();
      const due = await cols.occupations.find({ dueAt: { $lte: t } }).limit(500).toArray();
      let n = 0;
      for (const d of due) {
        const claimed = await cols.occupations.findOneAndDelete({ _id: d._id, ownerId: d.ownerId, dueAt: d.dueAt });
        if (!claimed) continue; // lost to a concurrent expulsion / processor
        await this.core.unscheduleOccupation(claimed.worldId, claimed._id);
        try {
          await this.settleOccupation(claimed, t);
        } catch (e) {
          console.error('[worldsvc] settleOccupation failed:', { id: claimed._id, err: (e as Error).message });
        }
        n++;
      }
      return n;
    }

    /** Finalize a settled OccupationDoc into real TileDoc ownership. Re-validates contestedBy to guard against a lost race. */
    private async settleOccupation(d: OccupationDoc, t: number): Promise<void> {
      const { cols } = this.core.deps;
      const tile = await cols.tiles.findOne({ _id: d.tile });
      if (!tile || tile.contestedBy !== d.ownerId) return; // stale (expelled / already settled elsewhere) — nothing to finalize

      const tileDoc: TileDoc = {
        _id: d.tile,
        worldId: d.worldId,
        x: d.x,
        y: d.y,
        type: 'territory',
        level: d.level,
        ...(d.resType ? { resType: d.resType } : {}),
        ownerId: d.ownerId,
        garrison: d.garrison,
        ...(d.familyId ? { familyId: d.familyId } : {}),
        rev: 0,
      };
      await cols.tiles.updateOne(
        { _id: d.tile },
        { $set: tileDoc, $unset: { contestedBy: '', contestedUntil: '', contestedGarrison: '', contestedFamilyId: '' } },
      );

      const pw = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, d.ownerId) });
      if (pw) {
        const yieldRate = await this.core.recomputeYield(d.worldId, d.ownerId);
        await cols.playerWorld.updateOne({ _id: pw._id }, { $set: { yieldRate }, $inc: { rev: 1 } });
        void this.core.bumpFamilyActivity(d.worldId, pw.familyId, 1);
      }
      void this.core.applyNationChange(d.worldId, d.x, d.y, d.ownerId, d.familyId);

      const after = await cols.tiles.findOne({ _id: d.tile });
      if (after) {
        void this.core.pushTile(d.ownerId, after);
        await this.core.pushTileToObservers(after, new Set([d.ownerId]));
      }
    }
  };
}
