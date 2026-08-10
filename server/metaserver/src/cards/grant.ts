// cards/* split — grantCard/grantCards (see ../cards.ts for the module overview).
import { randomUUID } from 'node:crypto';
import {
  CARD_INV_CAP,
  CARD_FULL_COMPENSATION_COINS,
  CARD_INV_OVERFLOW_BUFFER,
  MAX_CARD_LEVEL,
  type Collections,
  type SaveData,
  type CardInstance,
  type CardDef,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { insertSystemMail } from '../mail.js';
import { REV_RETRIES, toCardDoc, type CardError, type CardMailCtx, CARD_OVERFLOW_MAIL_EXPIRE_DAYS } from './helpers.js';

/**
 * Write a full card instance snapshot into `cardInstances` (auction escrow-out: sale delivery to buyer /
 * cancellation·expiry·season-end return to seller, and mail-attachment claim).
 * Idempotent by instance.id: if this exact instance already exists for this account, a prior call already
 * completed (including the count increment) — replay without double-incrementing. Mirrors equipment.ts grantEquipment.
 * No roster-cap check (a card returned from escrow or bought is always delivered — the buyer paid for it).
 */
export async function grantCard(
  cols: Collections,
  now: () => number,
  accountId: string,
  instance: CardInstance,
): Promise<{ ok: true } | CardError> {
  if (!instance?.id) return { error: 'instance required', code: 'BAD_REQUEST' };

  const already = await cols.cardInstances.findOne({ _id: instance.id, accountId });
  await cols.cardInstances.updateOne(
    { _id: instance.id },
    { $set: toCardDoc(instance, accountId) },
    { upsert: true },
  );
  if (already) return { ok: true };

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const everOwnedHero = new Set(doc.save.everOwned?.hero ?? []);
    everOwnedHero.add(instance.defId);
    const next: SaveData = {
      ...doc.save,
      rev: doc.save.rev + 1,
      updatedAt: now(),
      cardInvCount: doc.save.cardInvCount + 1,
      everOwned: { ...doc.save.everOwned, hero: [...everOwnedHero] },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { ok: true };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * Create card instances (CHARACTER_CARDS_DESIGN §4).
 * Each entry in `defs` produces one new CardInstance at `level` (default 1).
 * When the roster is full (≥ CARD_INV_CAP):
 *   - if `mailCtx` is given, the first CARD_INV_OVERFLOW_BUFFER overflow cards since the roster last had
 *     free space are mailed to the player as real instances (best-effort via socialsvc; counted by
 *     the persistent save.cardMailOverflowCount, reset to 0 the moment this call observes free room),
 *     and any remaining overflow beyond that falls back to coin compensation below.
 *   - without `mailCtx` (existing callers), overflow is coin-compensated as before — unchanged behavior.
 * compensatedCoins is caller-delivered via commercial if > 0.
 */
export async function grantCards(
  cols: Collections,
  now: () => number,
  accountId: string,
  defs: CardDef[],
  sourceType: string,
  level = 1,
  mailCtx?: CardMailCtx,
): Promise<{ instances: CardInstance[]; mailedCount: number; compensatedCoins: number; save: SaveData } | CardError> {
  if (!defs.length) {
    const save = await getOrCreateSave(cols, accountId, now());
    return { instances: [], mailedCount: 0, compensatedCoins: 0, save };
  }

  // Pre-generate IDs outside the rev loop (same IDs on retry → the eventual instance upsert is idempotent).
  const cardLevel = Math.max(1, Math.min(Math.floor(level), MAX_CARD_LEVEL));
  const obtainedAt = now();
  const pendingInstances = defs.map<CardInstance>((def) => ({
    id: `card_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    defId: def.id,
    level: cardLevel,
    gear: {},
    locked: false,
    sourceType,
    obtainedAt,
  }));

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;

    const newInstances: CardInstance[] = [];
    const mailInstances: CardInstance[] = [];
    let compensatedCoins = 0;
    let cap = save.cardInvCount;
    // Free room right now → the mail quota refills; otherwise carry the persisted counter forward.
    let mailOverflowCount = mailCtx ? (cap < CARD_INV_CAP ? 0 : (save.cardMailOverflowCount ?? 0)) : 0;

    for (const inst of pendingInstances) {
      if (cap < CARD_INV_CAP) {
        newInstances.push(inst);
        cap++;
      } else if (mailCtx && mailOverflowCount < CARD_INV_OVERFLOW_BUFFER) {
        mailInstances.push(inst);
        mailOverflowCount++;
      } else {
        compensatedCoins += CARD_FULL_COMPENSATION_COINS;
      }
    }

    // Lifetime hero-owned ledger (avatar unlock): every def in this grant was obtained by the player,
    // regardless of whether the resulting instance landed in cardInv, was mailed, or was coin-compensated
    // for a full roster — the "obtained" event happened either way. Never pruned when cards are later
    // fused away (unlike cardInv), so an avatar picked from a since-consumed hero stays unlocked.
    const everOwnedHero = new Set(save.everOwned?.hero ?? []);
    for (const inst of pendingInstances) everOwnedHero.add(inst.defId);

    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      cardInvCount: cap,
      cardMailOverflowCount: mailCtx ? mailOverflowCount : save.cardMailOverflowCount,
      everOwned: { ...save.everOwned, hero: [...everOwnedHero] },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Save side (count/mail-quota/everOwned) committed FIRST — this attempt's classification has won
      // and cannot be reclassified by a later retry, so it's now safe to persist the actual instances
      // (an earlier retry attempt's classification, if any, was discarded before ever touching
      // cardInstances). A crash in this narrow window leaves cardInvCount ahead of the true
      // cardInstances count (self-heals downward via assembleCardInv's join on the next read; same
      // accepted tradeoff as equipment.ts's craftEquipment).
      for (const inst of newInstances) {
        await cols.cardInstances.updateOne(
          { _id: inst.id },
          { $set: toCardDoc(inst, accountId) },
          { upsert: true },
        );
      }
      if (mailInstances.length > 0 && mailCtx) {
        await insertSystemMail(mailCtx.socialsvc, mailCtx.dispatchKey, accountId, {
          subject: 'card.mail.rosterFull.subject',
          body: 'card.mail.rosterFull.body',
          attachments: mailInstances.map((instance) => ({ kind: 'card' as const, instance })),
          expireDays: CARD_OVERFLOW_MAIL_EXPIRE_DAYS,
        }).catch(() => { /* best-effort: same risk tolerance as the coin-compensation path below */ });
      }
      return { instances: newInstances, mailedCount: mailInstances.length, compensatedCoins, save: next };
    }
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
