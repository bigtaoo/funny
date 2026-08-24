// auctionsvc AuctionService split — settlement flow plans + every idempotency key (see journal.ts).
//
// Two responsibilities, both deliberately concentrated in one small file:
//
//   1. **Every `auction_…` key in auctionsvc is minted here.** `npm run check:auctionjournal` enforces it,
//      because both of the money-losing bugs this round fixed were malformed keys rather than missing
//      locks. `auction_buy:{id}` carried no buyer, so the second of two racing buyers hit commercial's
//      cross-account ownership guard and got a bare BAD_REQUEST — and worse, a crash after a charge left
//      the key permanently owned by a buyer who never received the item, which meant nobody could ever buy
//      that listing again. Separately, two concurrent same-amount bids from one bidder shared a key, so the
//      loser mailed out a full refund against a charge that had only happened once.
//   2. **Every flow's plan**: the ordered side effects, how many of them run before the flow's branch
//      point, and what to undo if it cannot go forward. Plans are pure functions of a snapshot, which is
//      what lets the sweep rebuild one from a listing document alone when the original process died before
//      it could even write the journal row.
import type { AuctionDoc, AuctionItemSnapshot, AuctionOrderKind, AuctionOrderStep } from '../db';

export interface JournalPlan {
  steps: AuctionOrderStep[];
  /** How many leading steps run before the flow's branch point (see `AuctionOrderDoc.prefix`). */
  prefix: number;
  compensation: AuctionOrderStep[];
  decided: boolean;
}

// ── Key factories (the ONLY place an `auction_…` literal is allowed to exist) ──────────────────────

/**
 * Journal row id, i.e. the flow's dedupe identity. Always carries the acting account, either directly or
 * (for `list`/`settle`/`cancel`/`expire`, where the actor is the seller) inside `auctionId`, which is
 * `a:{sellerId}:{ts}:{seq}`.
 *
 * Note the split between this and `stepKey`: the row id is stable across retries so a duplicate submission
 * collides with itself, while the DOWNSTREAM key carries the row's `cycle`, so a genuine retry after an
 * aborted attempt is a genuine new charge rather than a free replay of the old one.
 */
export function flowKey(kind: AuctionOrderKind, auctionId: string, actorId?: string, discriminator?: string): string {
  const parts = [`auction_${kind}:${auctionId}`];
  if (actorId) parts.push(actorId);
  if (discriminator) parts.push(discriminator);
  return parts.join(':');
}

/**
 * Downstream idempotency key for one step (commercial `orderId` / meta-mail `dispatchKey`).
 * Cycle 0 renders exactly the pre-journal strings, so nothing already delivered under the old code can be
 * re-delivered under a newly-shaped key.
 */
function stepKey(rowId: string, cycle: number, suffix?: string): string {
  return `${rowId}${cycle > 0 ? `#${cycle}` : ''}${suffix ? `:${suffix}` : ''}`;
}

/**
 * Refund key for a bidder who has just been outbid. Deliberately NOT derived from the outbidding flow's
 * row: it belongs to the previous bid, and `topBid.amount` is strictly increasing, so a given
 * (auction, bidder, amount) can be the top bid — and therefore be refunded — at most once.
 */
function prevBidRefundKey(auctionId: string, bidderId: string, amount: number): string {
  return `auction_bid_refund:${auctionId}:${bidderId}:${amount}`;
}

/** The listing payload a hand-over needs, detached from the (mutable, purgeable) listing document. */
export function snapshotOf(doc: Pick<AuctionDoc, 'itemType' | 'item' | 'qty'>): AuctionItemSnapshot {
  return { itemType: doc.itemType, item: doc.item, qty: doc.qty };
}

// ── Plans ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Listing creation: hold the seller's item in escrow, then insert the listing.
 * The escrow is the pre-branch step; if the flow never reaches its branch (a crash before the insert
 * landed, or a cap rejection) the item goes straight back into the inventory, matching the immediate
 * re-grant the old inline try/catch used. That rollback only ever covered thrown business errors, so a
 * crash in this window used to destroy a seller's equipment outright.
 */
export function planForList(rowId: string, cycle: number, sellerId: string, snapshot: AuctionItemSnapshot): JournalPlan {
  return {
    steps: [{ name: 'escrow', op: 'escrow', key: stepKey(rowId, cycle), accountId: sellerId, snapshot }],
    prefix: 1,
    compensation: [
      { name: 'return', op: 'grant', key: stepKey(rowId, cycle, 'return'), requires: 'escrow', accountId: sellerId, snapshot },
    ],
    decided: false,
  };
}

/**
 * Fixed-price purchase. Claim-then-charge (2026-08-24 ruling): the listing is flipped open→sold BEFORE any
 * coins move, so "charged but sniped" — and with it the whole refund-the-loser path that used to mail a
 * refund under a key shared with the winning buyer — cannot happen at all.
 *
 * `prefix: 0` is doing real work here. It says the journal owns nothing before the branch, so a resumer
 * that finds this row undecided knows the buyer was never charged and must not charge them now: the
 * request died without ever telling them they had bought anything. All it has to undo is the local claim.
 */
export function planForBuy(
  rowId: string,
  cycle: number,
  buyerId: string,
  sellerId: string,
  auctionId: string,
  snapshot: AuctionItemSnapshot,
  totalPrice: number,
  sellerReceives: number,
  clientPlatform?: string,
): JournalPlan {
  return {
    steps: [
      {
        name: 'spend',
        op: 'spend',
        key: stepKey(rowId, cycle),
        accountId: buyerId,
        amount: totalPrice,
        ...(clientPlatform ? { clientPlatform } : {}),
      },
      { name: 'item', op: 'mailItem', key: stepKey(rowId, cycle, 'item'), accountId: buyerId, snapshot, reason: 'sold' },
      { name: 'seller', op: 'mailCoins', key: stepKey(rowId, cycle, 'seller'), accountId: sellerId, amount: sellerReceives, reason: 'proceeds' },
    ],
    prefix: 0,
    compensation: [{ name: 'unclaim', op: 'unclaim', key: stepKey(rowId, cycle, 'unclaim'), auctionId, buyerId }],
    decided: false,
  };
}

/**
 * Auction bid. Charge-THEN-record, the opposite order from `planForBuy`, and the asymmetry is
 * load-bearing: a recorded `topBid` is what a later settlement pays the seller against, so it must never
 * exist without escrowed coins behind it. A refund path is therefore unavoidable here — what changes is
 * that it is journaled (retried until it lands, and only when the escrow provably went through) instead of
 * one best-effort mail call.
 */
export function planForBid(rowId: string, cycle: number, bidderId: string, escrowTotal: number, clientPlatform?: string): JournalPlan {
  return {
    steps: [
      {
        name: 'spend',
        op: 'spend',
        key: stepKey(rowId, cycle),
        accountId: bidderId,
        amount: escrowTotal,
        ...(clientPlatform ? { clientPlatform } : {}),
      },
    ],
    prefix: 1,
    compensation: [
      { name: 'refundSelf', op: 'mailCoins', key: stepKey(rowId, cycle, 'refund'), requires: 'spend', accountId: bidderId, amount: escrowTotal, reason: 'refund' },
    ],
    decided: false,
  };
}

/** Refund owed to the bidder this bid just outbid; appended to the bid flow once its `topBid` write has landed. */
export function outbidRefundStep(auctionId: string, bidderId: string, amount: number, qty: number): AuctionOrderStep {
  return {
    name: 'refundPrev',
    op: 'mailCoins',
    key: prevBidRefundKey(auctionId, bidderId, amount),
    accountId: bidderId,
    amount: amount * qty,
    reason: 'refund',
  };
}

/**
 * Auction win settlement. Forward-only: the winner's coins were escrowed at bid time, so there is no
 * charge to fail and nothing to compensate. Claim-first, hence `decided: true` — the open→sold CAS has
 * already happened by the time this row is written, and the listing document itself (status `sold` with no
 * `settledAt`) is what lets the repair sweep rebuild this plan if the process died before the row existed.
 */
export function planForSettle(
  rowId: string,
  cycle: number,
  winnerId: string,
  sellerId: string,
  snapshot: AuctionItemSnapshot,
  sellerReceives: number,
): JournalPlan {
  return {
    steps: [
      { name: 'item', op: 'mailItem', key: stepKey(rowId, cycle, 'item'), accountId: winnerId, snapshot, reason: 'sold' },
      { name: 'seller', op: 'mailCoins', key: stepKey(rowId, cycle, 'seller'), accountId: sellerId, amount: sellerReceives, reason: 'proceeds' },
    ],
    prefix: 0,
    compensation: [],
    decided: true,
  };
}

/** Cancel / expiry: hand the escrowed item back to the seller. Claim-first and forward-only, same as settlement. */
export function planForReturn(rowId: string, cycle: number, sellerId: string, snapshot: AuctionItemSnapshot): JournalPlan {
  return {
    steps: [{ name: 'return', op: 'mailItem', key: stepKey(rowId, cycle), accountId: sellerId, snapshot, reason: 'returned' }],
    prefix: 0,
    compensation: [],
    decided: true,
  };
}
