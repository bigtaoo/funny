// Next-day hero gift (ONBOARDING_DESIGN §17.4): the first HERO_GIFT_LEVEL_ID clear — the level where the
// hero joins the fight as a trial card — earns that hero card for keeps, claimable from the next UTC
// midnight. Written by pveClear (recordHeroGift), claimed by POST /pve/hero-gift/claim (claimHeroGiftHandler).
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SaveData } from '@nw/shared';
import { CARD_DEFS, ErrorCode, err, ok, HERO_GIFT_DEF_ID, HERO_GIFT_LEVEL_ID, heroGiftClaimableAt } from '@nw/shared';
import { grantCards } from '../../cards.js';
import { accountIdOf, type MetaCore } from '../base.js';

/**
 * Stamp the gift on the save after a clear of `levelId`, if it is the gift level and the account has none
 * yet. Idempotent by the `heroGift` presence check inside the rev-guarded transform, so a replayed or
 * concurrent duplicate clear never moves `claimableAt`. Best-effort: returns the updated save, or
 * undefined when nothing changed (or the write lost — the clear itself is already settled).
 */
export async function recordHeroGift(core: MetaCore, accountId: string, levelId: string): Promise<SaveData | undefined> {
  if (levelId !== HERO_GIFT_LEVEL_ID) return undefined;
  const at = core.deps.now();
  let changed = false;
  const out = await core.mutateSave(accountId, (s) => {
    if (s.heroGift) { changed = false; return s; }
    changed = true;
    return { ...s, heroGift: { defId: HERO_GIFT_DEF_ID, claimableAt: heroGiftClaimableAt(at) } };
  });
  return 'error' in out || !changed ? undefined : out.save;
}

/**
 * POST /pve/hero-gift/claim. 404 without a gift, 400 before `claimableAt`, the current save once claimed
 * (idempotent). `claimedAt` is written first, inside the rev guard, so two racing claims grant one card;
 * the card then goes through grantCards like any drop (roster full → mailed / coin compensation inside).
 */
export async function claimHeroGiftHandler(core: MetaCore, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { cols, now } = core.deps;
  if (await core.rejectIfBanned(cols, accountId, reply)) return;
  const at = now();
  let first = false;
  const marked = await core.mutateSave(accountId, (s) => {
    const gift = s.heroGift;
    if (!gift) return 'none';
    if (gift.claimedAt !== undefined) { first = false; return s; }
    if (at < gift.claimableAt) return 'early';
    first = true;
    return { ...s, heroGift: { ...gift, claimedAt: at } };
  });
  if ('error' in marked) {
    if (marked.error === 'none') return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'no hero gift'));
    if (marked.error === 'early') return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'hero gift not claimable yet'));
    return reply.code(409).send(err(ErrorCode.REV_CONFLICT, marked.error));
  }
  let save = marked.save;
  const def = CARD_DEFS[marked.save.heroGift!.defId];
  if (first && def) {
    const granted = await grantCards(cols, now, accountId, [def], 'hero_gift', 1);
    if (!('error' in granted)) {
      save = granted.save;
      if (granted.compensatedCoins > 0 && core.deps.commercial.available) {
        await core.deps.commercial
          .grant({ accountId, amount: granted.compensatedCoins, reason: 'hero_gift_inv_full', orderId: `heroGift:${accountId}` })
          .catch(() => { /* best-effort compensation */ });
      }
    }
  }
  return ok({ save: { ...save, stamina: await core.readStaminaSnapshot(accountId, now()) } });
}
