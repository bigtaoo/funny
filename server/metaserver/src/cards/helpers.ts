// Shared types + helpers for the cards/* split (see ../cards.ts for the module overview).
import { CARD_FEED_IDEM_TTL_SEC, type CardInstance, type CardInstanceDoc } from '@nw/shared';
import type { MetaSocialsvcClient } from '../socialsvcClient.js';

/** 30-day expiry, matching the auction/ladder-settlement system-mail convention. */
export const CARD_OVERFLOW_MAIL_EXPIRE_DAYS = 30;

/** Context required to mail roster-full overflow cards instead of silently coin-compensating them (see grantCards). */
export interface CardMailCtx {
  socialsvc: MetaSocialsvcClient;
  /** Idempotency key for the system-mail upsert; scope it to the triggering order/request. */
  dispatchKey: string;
}

export type CardErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'CARD_NOT_FOUND'
  | 'CARD_HAS_GEAR'
  | 'WRONG_FACTION'
  | 'CARD_LOCKED'
  | 'REV_CONFLICT';

export interface CardError {
  error: string;
  code: CardErrorCode;
}

export const REV_RETRIES = 3;

export function idemExpireAt(now: number): Date {
  return new Date(now + CARD_FEED_IDEM_TTL_SEC * 1000);
}

export function toCardDoc(instance: CardInstance, accountId: string): CardInstanceDoc {
  return {
    _id: instance.id,
    accountId,
    defId: instance.defId,
    level: instance.level,
    gear: instance.gear,
    locked: instance.locked,
    ...(instance.sourceType !== undefined ? { sourceType: instance.sourceType } : {}),
    ...(instance.obtainedAt !== undefined ? { obtainedAt: instance.obtainedAt } : {}),
  };
}

export function fromCardDoc(doc: CardInstanceDoc): CardInstance {
  return {
    id: doc._id,
    defId: doc.defId,
    level: doc.level,
    gear: doc.gear,
    locked: doc.locked,
    ...(doc.sourceType !== undefined ? { sourceType: doc.sourceType } : {}),
    ...(doc.obtainedAt !== undefined ? { obtainedAt: doc.obtainedAt } : {}),
  };
}
