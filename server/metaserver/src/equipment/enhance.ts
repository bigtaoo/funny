// E3 Enhancement (EQUIPMENT_DESIGN §6 / §18.2) — see ../equipment.ts for the module overview.
import {
  EQUIP_MAX_LEVEL,
  PROTECT_ENHANCE_ITEM_ID,
  rollEnhanceSuccess,
  rollEnhanceDemote,
  enhanceCost,
  type Collections,
  type SaveData,
  type EquipmentInstance,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import type { CommercialClient } from '../commercialClient.js';
import {
  idemExpireAt,
  toInstanceDoc,
  fromInstanceDoc,
  leanSave,
  settleEquipCoins,
  REV_RETRIES,
  type EquipError,
} from './helpers.js';

/**
 * Enhances one equipment item (level → level+1). EQUIPMENT_DESIGN §6: server rolls dice
 * (success rate table, −10% per level), materials + coins are deducted on both success and
 * failure (failed-attempt loss is the core sink, §6.2). From +7 onward a failed attempt also
 * risks demoting the item one level (ADR-063, enhanceDemoteChance); a protect item blocks both
 * the material loss and the demote roll on the same failure.
 *
 * Coins go through commercial authority (`save.wallet.coins` is only a mirror, economy.ts §0),
 * so enhancement requires commercial to be online.
 * Idempotent (idempotencyKey): dice result + costs are all bound to the key; replays return
 * the first result (no second roll / second material deduction).
 * commercial.spend uses idemKey as orderId and is naturally idempotent → replaying the call
 * does not double-charge coins.
 *
 * Ordering (player safety): first atomically update the save (deduct materials, rev guard),
 * then apply the level/affix change to the equipmentInstances document, **then** deduct coins.
 * If the save update fails (rev exhausted / insufficient materials), coins are untouched and
 * the idempotency claim can safely be released for a retry; if the save update succeeds and the
 * coin-deduction step hits a network hiccup, the replay path idempotently re-charges
 * (spend(idemKey)) + mirrors, ensuring no charge is ever missed.
 */
export async function enhanceEquipment(
  cols: Collections,
  commercial: CommercialClient,
  now: () => number,
  accountId: string,
  instanceId: string,
  idempotencyKey: string,
  useProtect = false,
  clientPlatform?: string,
): Promise<{ success: boolean; instance: EquipmentInstance; save: SaveData } | EquipError> {
  if (!instanceId) return { error: 'instanceId required', code: 'BAD_REQUEST' };
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };

  // Replay: verify-and-heal (re-assert the instance reflects the replayed result — a prior attempt may
  // have deducted materials/consumed the protect item but crashed before the equipmentInstances write)
  // + idempotently settle coins (covers the "save updated but coin deduction interrupted" window).
  // Gated on `committed` (2026-08-03 fix): a claim doc can exist before its cost has landed (see the
  // insertOne below), so a concurrent duplicate arriving here first must not synthesize a free
  // enhancement — only replay once the original request's cost write actually succeeded.
  const replay = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'enhance' && replay.committed) {
    const r = replay.result as { success: boolean; instance: EquipmentInstance; coins: number; skipMaterials?: boolean };
    await cols.equipmentInstances.updateOne(
      { _id: r.instance.id },
      { $set: toInstanceDoc(r.instance, accountId) },
      { upsert: true },
    );
    const save = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, r.coins, 'equip_enhance', clientPlatform);
    return { success: r.success, instance: r.instance, save: leanSave(save) };
  }
  if (replay?.op === 'enhance' && !replay.committed) {
    return { error: 'enhance already in progress, retry', code: 'REV_CONFLICT' };
  }

  // Coins go through commercial authority; if not configured, enhancement is unavailable (same 503 as shop/gacha).
  if (!commercial.available) return { error: 'commercial service unavailable', code: 'NOT_IMPLEMENTED' };

  const [cur, inst0Doc] = await Promise.all([
    getOrCreateSave(cols, accountId, now()),
    cols.equipmentInstances.findOne({ _id: instanceId, accountId }),
  ]);
  if (!inst0Doc) return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
  const inst0 = fromInstanceDoc(inst0Doc);
  if (inst0.level >= EQUIP_MAX_LEVEL) return { error: 'already max level', code: 'ENHANCE_MAX_LEVEL' };

  const fromLevel = inst0.level;
  const cost = enhanceCost(fromLevel);
  // Pre-validate materials (friendly early error; re-checked inside the rev loop).
  for (const [mat, qty] of Object.entries(cost.materials)) {
    if ((cur.materials?.[mat] ?? 0) < qty) return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
  }
  // Pre-validate coins (commercial authoritative; insufficient → no state changes, friendly 402).
  const wallet = await commercial.getWallet(accountId, clientPlatform);
  if ((wallet?.coins ?? 0) < cost.coins) return { error: 'not enough coins', code: 'INSUFFICIENT_FUNDS' };

  const success = rollEnhanceSuccess(idempotencyKey, fromLevel);

  // Protect item (E7 §6.2): on failure consumes 1 protect_enhance → skip material deduction (skipMaterials=true).
  // Coins are still deducted (protect does not waive the enhancement fee, only saves materials); not consumed on success (success has no "failed-attempt loss" to begin with).
  const hasProtect = useProtect && (cur.inventory?.items?.[PROTECT_ENHANCE_ITEM_ID] ?? 0) > 0;
  const skipMaterials = hasProtect && !success;
  // Demote (ADR-063): only rolled on a failure that isn't already protected — the same protect item
  // covers both the material loss and the demote risk, since they're both consequences of the same
  // failed attempt. Only ever non-zero for fromLevel 7/8 (enhanceDemoteChance).
  const demoted = !success && !hasProtect && rollEnhanceDemote(idempotencyKey, fromLevel);
  const nextLevel = success ? fromLevel + 1 : demoted ? Math.max(0, fromLevel - 1) : fromLevel;
  const instanceAfter: EquipmentInstance = { ...inst0, level: nextLevel };

  // Idempotency claim (result includes coins + skipMaterials for replay re-settlement). dup = concurrent duplicate → takes the replay path.
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'enhance',
      result: { success, instance: instanceAfter, coins: cost.coins, skipMaterials },
      committed: false,
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      if (!prev?.committed) {
        return { error: 'enhance already in progress, retry', code: 'REV_CONFLICT' };
      }
      const r = prev.result as { success: boolean; instance: EquipmentInstance; coins: number; skipMaterials?: boolean };
      await cols.equipmentInstances.updateOne(
        { _id: r.instance.id },
        { $set: toInstanceDoc(r.instance, accountId) },
        { upsert: true },
      );
      const save = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, r.coins);
      return { success: r.success, instance: r.instance, save: leanSave(save) };
    }
    throw e;
  }

  // Cost side first (materials / protect-item consumption, rev-guarded save write). The per-instance
  // level check below (instDoc.level !== fromLevel) replaces the old whole-save rev check for "did the
  // instance change since I read it" — same safety property, just scoped to one document.
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const [doc, instDoc] = await Promise.all([
      cols.saves.findOne({ _id: accountId }),
      cols.equipmentInstances.findOne({ _id: instanceId, accountId }),
    ]);
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    if (!instDoc || instDoc.level !== fromLevel) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'instance level changed, retry', code: 'REV_CONFLICT' };
    }
    const save = doc.save;
    if (!skipMaterials) {
      // No protect item / success path: deduct materials normally
      for (const [mat, qty] of Object.entries(cost.materials)) {
        if ((save.materials?.[mat] ?? 0) < qty) {
          await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
          return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
        }
      }
    }
    const nextMaterials = { ...(save.materials ?? {}) };
    if (!skipMaterials) {
      for (const [mat, qty] of Object.entries(cost.materials)) nextMaterials[mat] = (nextMaterials[mat] ?? 0) - qty;
    }
    const nextItems = { ...(save.inventory?.items ?? {}) };
    if (skipMaterials) {
      // Consume the protect item
      nextItems[PROTECT_ENHANCE_ITEM_ID] = Math.max(0, (nextItems[PROTECT_ENHANCE_ITEM_ID] ?? 0) - 1);
    }
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      materials: nextMaterials,
      inventory: { ...(save.inventory ?? { skins: [] }), items: nextItems },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Cost committed → mark the claim so a concurrent duplicate's replay/catch path above can now
      // safely grant, then apply the level/affix change (filtered on fromLevel, mirroring the check
      // above; in the extreme case this doesn't match — a concurrent write to this exact instanceId
      // within the few-ms window since the check just above — the replay path's verify-and-heal
      // re-applies it later).
      await cols.equipmentIdem.updateOne({ _id: idempotencyKey }, { $set: { committed: true } });
      await cols.equipmentInstances.updateOne(
        { _id: instanceId, level: fromLevel },
        { $set: toInstanceDoc(instanceAfter, accountId) },
      );
      const saveFinal = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, cost.coins, 'equip_enhance', clientPlatform);
      return { success, instance: instanceAfter, save: leanSave(saveFinal) };
    }
    // rev conflict → re-read and retry
  }
  // Save update failed (coins untouched) → release claim; client can safely retry.
  await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
