// E4 Equip (EQUIPMENT_DESIGN §3.4 / CC-2) — see ../equipment.ts for the module overview.
import { EQUIP_SLOTS, EQUIPMENT_DEFS, type EquipSlot, type Collections, type SaveData } from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { leanSave, type EquipError } from './helpers.js';

/**
 * Equips or unequips one item onto a specific card instance (CC-2, CHARACTER_CARDS_DESIGN §5).
 * Pure state change, no randomness, no resources → naturally idempotent, no idemKey needed.
 * instanceId=null unequips the slot; otherwise validates instance existence + slot match (INVALID_SLOT).
 * cardInstanceId must reference an existing CardInstance in the `cardInstances` collection (2026-07-27
 * split, cards.ts); gear is written to CardInstance.gear[slot] (CC-2 per-card loadout;
 * CHARACTER_CARDS_DESIGN §5). Never touches equipmentInstances (only the card's gear, a pointer).
 * Doesn't touch `saves` at all anymore: gear lives entirely on the card document now, so there is
 * nothing left in the save doc for this mutation to change (no rev bump needed).
 */
export async function equipEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  slot: string,
  instanceId: string | null,
  cardInstanceId: string,
): Promise<{ save: SaveData } | EquipError> {
  if (!EQUIP_SLOTS.includes(slot as EquipSlot)) return { error: 'invalid slot', code: 'INVALID_SLOT' };
  if (!cardInstanceId) return { error: 'cardInstanceId required', code: 'BAD_REQUEST' };

  if (instanceId !== null) {
    const instDoc = await cols.equipmentInstances.findOne({ _id: instanceId, accountId });
    if (!instDoc) return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
    const def = EQUIPMENT_DEFS[instDoc.defId];
    if (def && def.slot !== slot) return { error: `slot mismatch: ${instDoc.defId} is ${def.slot}`, code: 'INVALID_SLOT' };
    // Must not already be equipped on a DIFFERENT card — without this check the same instanceId could be
    // written into two cards' gear[slot] at once, doubling its stat contribution (equipment duplication).
    // Re-equipping the same instance onto the SAME card/slot (no-op) is allowed through.
    const equippedOn = await cols.cardInstances.findOne({
      accountId,
      _id: { $ne: cardInstanceId },
      $or: EQUIP_SLOTS.map((s) => ({ [`gear.${s}`]: instanceId })),
    });
    if (equippedOn) return { error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' };
  }

  const cardDoc = await cols.cardInstances.findOne({ _id: cardInstanceId, accountId });
  if (!cardDoc) return { error: 'card instance not found', code: 'NOT_FOUND' };

  const updatedGear = { ...(cardDoc.gear ?? {}) };
  if (instanceId === null) delete (updatedGear as Record<string, string | undefined>)[slot];
  else (updatedGear as Record<string, string>)[slot] = instanceId;
  const updatedGearInstanceIds = Object.values(updatedGear).filter((v): v is string => !!v);

  try {
    await cols.cardInstances.updateOne(
      { _id: cardInstanceId, accountId },
      { $set: { gear: updatedGear, gearInstanceIds: updatedGearInstanceIds } },
    );
  } catch (e) {
    // Unique multikey index on gearInstanceIds (mongo.ts) is the atomic backstop behind the "equipped
    // elsewhere" read above: a concurrent equip of the SAME instanceId onto a DIFFERENT card that raced
    // past that check lands here instead of silently duplicating the instance's stat contribution.
    if ((e as { code?: number }).code === 11000) return { error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' };
    throw e;
  }

  const save = await getOrCreateSave(cols, accountId, now());
  return { save: leanSave(save) };
}
