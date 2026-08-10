// Live-ops shared helper: the idempotent card/equipment delivery step used by both check-in and
// weekly-chest reward settlement. Split out of liveops.ts (2026-08-10, 独立函数模块 form — see
// liveops.ts's facade comment). Takes `deps` explicitly rather than through a mixin's `this` — it only
// ever touched `this.deps.cols`/`this.deps.now`, never a protected base method, so no ctx/binding is
// needed at all (unlike pve.ts's clear/verify handlers). No behavior change.
import type { EquipmentInstance, CardInstance } from '@nw/shared';
import { EQUIPMENT_IDEM_TTL_SEC } from '@nw/shared';
import { grantCard } from '../../cards.js';
import { grantEquipment } from '../../equipment.js';
import type { ServiceDeps } from '../base.js';

export function idemExpireAt(nowMs: number): Date {
  return new Date(nowMs + EQUIPMENT_IDEM_TTL_SEC * 1000);
}

/** The concrete item resolved for a checkin/weekly-chest reward that needs an async delivery call
 *  (card/equipment — material rewards are applied synchronously and never reach this). Picked
 *  ONCE and persisted to `cols.equipmentIdem` before the grant call runs (see deliverRetentionReward). */
export type RetentionItemPick =
  | { kind: 'card'; instance: CardInstance; defId: string }
  | { kind: 'equipment'; instance: EquipmentInstance; defId: string };

/**
 * Deliver a checkin/weekly-chest reward that needs an async grant call (card/equipment —
 * material/stamina/coins are handled by their own callers and never reach here) exactly once,
 * surviving a failed grant across retries.
 *
 * 2026-08-05 resilience fix. Root cause: claimCheckin/claimWeeklyChest mark the underlying claim
 * durably (mutateSave, "already claimed" guard) BEFORE this ever runs — that ordering is correct
 * and unchanged, it's the single race-free gate that lets concurrent duplicate requests serialize
 * to one winner. The bug was in what happened AFTER: the picked item's grant call
 * (grantEquipment/grantCard) could fail (rev conflict, transient DB blip) and the
 * failure was silently swallowed — the claim stayed marked forever, the item was never delivered,
 * and a client retry just got bounced with ALREADY_CLAIMED before ever reaching the grant again.
 *
 * Fix mirrors equipment.ts's craft/enhance/salvage `committed` idem-ledger convention (same
 * `cols.equipmentIdem` collection, new `checkin_reward`/`weekly_chest` ops): the concrete item is
 * picked and persisted with `committed: false` BEFORE the grant call runs, so re-entering this
 * method later (the caller re-enters it from the ALREADY_CLAIMED recovery branch) resumes
 * delivering the *same* item — picked once, never re-rolled — instead of losing it or granting a
 * second, different one. grantEquipment/grantCard are themselves idempotent by
 * instance.id, so replaying the grant call itself is always safe too.
 *
 * (2026-08-08: dropped the 'skin' variant — the weekly chest's tier-3 skin reward was replaced
 * by a legendary card, and checkin never used 'skin' here; grantSkin is no longer reachable from
 * this delivery path at all, see retention.ts WEEKLY_CHEST_TIERS comment.)
 */
export async function deliverRetentionReward(
  deps: ServiceDeps,
  accountId: string,
  orderId: string,
  op: 'checkin_reward' | 'weekly_chest',
  pick: () => RetentionItemPick,
): Promise<{ deliveredId: string } | { error: string; code: string }> {
  const { cols, now } = deps;
  let claim = await cols.equipmentIdem.findOne({ _id: orderId });
  if (!claim) {
    const picked = pick();
    try {
      await cols.equipmentIdem.insertOne({
        _id: orderId, accountId, op, result: picked, committed: false, expireAt: idemExpireAt(now()),
      });
      claim = { _id: orderId, accountId, op, result: picked, committed: false, expireAt: idemExpireAt(now()) };
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      // Lost the insert race to a concurrent caller (e.g. two requests both hit ALREADY_CLAIMED and
      // recovered here at once) — read back whichever pick won; deliver that one, not ours.
      claim = await cols.equipmentIdem.findOne({ _id: orderId });
    }
  }
  if (!claim) return { error: 'reward grant failed, retry', code: 'REV_CONFLICT' };
  const picked = claim.result as RetentionItemPick;
  const deliveredId = picked.defId;
  if (claim.committed) return { deliveredId }; // already delivered by an earlier attempt — pure replay, no DB write

  const g = picked.kind === 'equipment' ? await grantEquipment(cols, now, accountId, picked.instance)
    : await grantCard(cols, now, accountId, picked.instance);
  if ('error' in g) return { error: g.error, code: g.code };
  await cols.equipmentIdem.updateOne({ _id: orderId }, { $set: { committed: true } });
  return { deliveredId };
}
