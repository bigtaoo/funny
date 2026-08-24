// auctionsvc AuctionService split — system-mail delivery helpers (see ../auctionService.ts).
//
// Independent sibling class (2026-08-11 re-audit, converted from a linear inheritance chain to
// composition): zero dependencies on any other layer, only `deps`.
//
// 2026-08-24 (U13 close-out): callers changed from "the listing document" to "an `AuctionItemSnapshot`",
// and both methods now THROW on a failed send instead of logging and returning. Reached only from
// journalSteps.ts, whose caller records the step as still-owed and retries it — the old best-effort
// swallow was the likeliest way to lose real assets in production, since one meta 500 was enough to
// destroy a seller's proceeds or a buyer's item with nothing but a log line to show for it.
import type { AuctionItemSnapshot } from '../db';
import type { AuctionMailAttachment } from '../mailClient';
import type { AuctionServiceDeps } from './base';
import { AUCTION_MAIL_EXPIRE_DAYS, equipInstanceOf, cardInstanceOf } from './base';

/**
 * Mail attachment for a listing payload: equipment/card carry the full instance snapshot, material
 * carries id+qty, skin carries the id only. Null means there is nothing deliverable in the payload (a
 * malformed listing), which callers treat as a completed hand-over rather than a retryable failure —
 * retrying cannot conjure an instance that was never stored.
 */
function attachmentOf(snapshot: AuctionItemSnapshot): AuctionMailAttachment | null {
  if (snapshot.itemType === 'material') {
    const material = snapshot.item['material'] as string;
    return { kind: 'material', id: material, count: snapshot.qty };
  }
  if (snapshot.itemType === 'equipment') {
    const inst = equipInstanceOf(snapshot.item);
    return inst ? { kind: 'equipment', instance: inst } : null;
  }
  if (snapshot.itemType === 'card') {
    const inst = cardInstanceOf(snapshot.item);
    return inst ? { kind: 'card', instance: inst } : null;
  }
  if (snapshot.itemType === 'skin') {
    const skinId = snapshot.item['skinId'] as string | undefined;
    return skinId ? { kind: 'skin', id: skinId } : null;
  }
  return null;
}

export class AuctionServiceDelivery {
  constructor(private readonly deps: AuctionServiceDeps) {}

  /**
   * Delivers a listed item to the target account via system mail (escrow-out model, AUCTION_DESIGN):
   *   buyer on sale (reason 'sold') / seller on cancel or expiry (reason 'returned').
   * The item does NOT go straight into the inventory — the recipient must claim the mail attachment.
   * dispatchKey = the journal step's key → idempotent across retries and resumes.
   */
  async deliverItem(
    toAccountId: string,
    snapshot: AuctionItemSnapshot,
    dispatchKey: string,
    reason: 'sold' | 'returned',
  ): Promise<void> {
    const attachment = attachmentOf(snapshot);
    if (!attachment) return;
    // subject/body are i18n keys resolved client-side.
    await this.deps.mail.sendSystemMail(toAccountId, dispatchKey, {
      subject: `auction.mail.${reason}.subject`,
      body: `auction.mail.${reason}.body`,
      attachments: [attachment],
      expireDays: AUCTION_MAIL_EXPIRE_DAYS,
    });
  }

  /**
   * Delivers coins to an account via system mail (claimed → commercial.grant at claim time, metaserver claimMail).
   * Used for both seller sale proceeds ('proceeds') and buyer/bidder escrow refunds ('refund') — no path in
   * auctionsvc credits coins directly anymore; only real-money recharge goes straight to the wallet.
   * dispatchKey = the journal step's key → idempotent across retries and resumes.
   */
  async deliverCoins(
    toAccountId: string,
    amount: number,
    dispatchKey: string,
    reason: 'proceeds' | 'refund',
  ): Promise<void> {
    if (amount <= 0) return;
    await this.deps.mail.sendSystemMail(toAccountId, dispatchKey, {
      subject: `auction.mail.${reason}.subject`,
      body: `auction.mail.${reason}.body`,
      attachments: [{ kind: 'coins', count: amount }],
      expireDays: AUCTION_MAIL_EXPIRE_DAYS,
    });
  }
}
