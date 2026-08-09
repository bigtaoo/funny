// auctionsvc AuctionService split — system-mail delivery helpers (see ../auctionService.ts).
import type { AuctionDoc } from '../db';
import type { AuctionMailAttachment } from '../mailClient';
import { AuctionServicePricing } from './pricing';
import { AUCTION_MAIL_EXPIRE_DAYS, equipInstanceOf, cardInstanceOf } from './base';

export class AuctionServiceDelivery extends AuctionServicePricing {
  /**
   * Delivers the listed item to the target account via system mail (escrow-out model, AUCTION_DESIGN):
   *   buyer on sale (reason 'sold') / seller on cancel or expiry (reason 'returned').
   * The item does NOT go straight into the inventory — the recipient must claim the mail attachment
   * (equipment/card carry the full instance snapshot; material carries id+qty; skin carries id only).
   * dispatchKey = orderId → idempotent (each call site passes a stable, unique orderId).
   * Best-effort: mail unavailable → no-op (same degradation as the previous direct-grant path).
   */
  protected async deliverItem(
    toAccountId: string,
    doc: AuctionDoc,
    orderId: string,
    reason: 'sold' | 'returned',
  ): Promise<void> {
    let attachment: AuctionMailAttachment | null = null;
    if (doc.itemType === 'material') {
      const material = doc.item['material'] as string;
      attachment = { kind: 'material', id: material, count: doc.qty };
    } else if (doc.itemType === 'equipment') {
      const inst = equipInstanceOf(doc.item);
      if (inst) attachment = { kind: 'equipment', instance: inst };
    } else if (doc.itemType === 'card') {
      const inst = cardInstanceOf(doc.item);
      if (inst) attachment = { kind: 'card', instance: inst };
    } else if (doc.itemType === 'skin') {
      const skinId = doc.item['skinId'] as string | undefined;
      if (skinId) attachment = { kind: 'skin', id: skinId };
    }
    if (!attachment) return;
    // subject/body are i18n keys resolved client-side.
    await this.deps.mail.sendSystemMail(toAccountId, orderId, {
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
   * dispatchKey = orderId → idempotent (each call site passes a stable, unique orderId).
   */
  protected async deliverCoins(
    toAccountId: string,
    amount: number,
    orderId: string,
    reason: 'proceeds' | 'refund',
  ): Promise<void> {
    if (amount <= 0) return;
    await this.deps.mail.sendSystemMail(toAccountId, orderId, {
      subject: `auction.mail.${reason}.subject`,
      body: `auction.mail.${reason}.body`,
      attachments: [{ kind: 'coins', count: amount }],
      expireDays: AUCTION_MAIL_EXPIRE_DAYS,
    });
  }
}
