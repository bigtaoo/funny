// auctionsvc AuctionService split — journal step executors (see journal.ts).
//
// This file is the ONLY place auctionsvc reaches another service's assets: `commercial.spend`, the
// `meta.escrow*`/`meta.grant*`/`meta.deductMaterial` inventory calls, and (via delivery.ts) system mail.
// `npm run check:auctionjournal` enforces that, because the point of the journal is worthless if a new
// flow can quietly move coins or items without recording that it owes them — the pre-journal code lost a
// seller's proceeds on any single meta hiccup precisely because the mail call sat inline, uncounted.
//
// Every executor is idempotent by the step's `key`: commercial dedupes on `orderId` (and binds it to the
// first account that used it), meta system mail dedupes on `dispatchKey`, and meta's inventory endpoints
// dedupe on `orderId`. That is what makes re-running a plan cheap and safe, and it is why the journal
// itself does not have to implement distributed atomicity.
import { SlgError } from '@nw/shared';
import type { AuctionItemSnapshot, AuctionOrderStep } from '../db';
import type { AuctionServiceDeps } from './base';
import { equipInstanceOf, cardInstanceOf } from './base';
import { AuctionServiceDelivery } from './delivery';

export class AuctionOrderStepRunner {
  private readonly delivery: AuctionServiceDelivery;

  constructor(private readonly deps: AuctionServiceDeps) {
    this.delivery = new AuctionServiceDelivery(deps);
  }

  /**
   * Run one step. Returns the escrowed snapshot when the step was an `escrow` that resolved an instance
   * (equipment/card/skin: the seller hands over an id, meta answers with the full instance the listing has
   * to store), otherwise null. Throws on failure; `journal.ts` decides whether that surfaces to the
   * caller or is recorded as still-owed.
   */
  async exec(step: AuctionOrderStep): Promise<AuctionItemSnapshot | null> {
    switch (step.op) {
      case 'escrow':
        return this.escrow(step.accountId, step.snapshot, step.key);
      case 'grant':
        await this.grant(step.accountId, step.snapshot, step.key);
        return null;
      case 'spend':
        await this.deps.commercial.spend(step.accountId, step.amount, step.key, step.clientPlatform);
        return null;
      case 'mailItem':
        await this.delivery.deliverItem(step.accountId, step.snapshot, step.key, step.reason);
        return null;
      case 'mailCoins':
        await this.delivery.deliverCoins(step.accountId, step.amount, step.key, step.reason);
        return null;
      case 'unclaim':
        await this.unclaim(step.auctionId, step.buyerId);
        return null;
    }
  }

  /**
   * Move the listed item out of the seller's inventory. Material carries its id+qty in the snapshot
   * already; equipment/card/skin arrive holding only the client-supplied `instanceId`/`skinId` and come
   * back as the full snapshot the listing document stores.
   */
  private async escrow(sellerId: string, snapshot: AuctionItemSnapshot, orderId: string): Promise<AuctionItemSnapshot | null> {
    const { meta } = this.deps;
    if (snapshot.itemType === 'material') {
      const material = snapshot.item['material'] as string;
      await meta.deductMaterial(sellerId, material, snapshot.qty, orderId);
      return null; // nothing to resolve — the listing already stores exactly this payload
    }
    if (snapshot.itemType === 'equipment') {
      const instanceId = snapshot.item['instanceId'] as string;
      const instance = await meta.escrowEquipment(sellerId, instanceId, orderId);
      return { itemType: 'equipment', item: { instance }, qty: 1 };
    }
    if (snapshot.itemType === 'card') {
      const instanceId = snapshot.item['instanceId'] as string;
      const instance = await meta.escrowCard(sellerId, instanceId, orderId);
      return { itemType: 'card', item: { instance }, qty: 1 };
    }
    if (snapshot.itemType === 'skin') {
      const skinId = snapshot.item['skinId'] as string;
      const escrowedId = await meta.escrowSkin(sellerId, skinId, orderId);
      return { itemType: 'skin', item: { skinId: escrowedId }, qty: 1 };
    }
    throw new SlgError('BAD_REQUEST', `unknown itemType ${snapshot.itemType}`);
  }

  /**
   * Hand an escrowed item straight back into the seller's inventory. Used only by the create-listing
   * rollback, matching what the inline try/catch already did: at that point the listing never became
   * visible, so there is no reason to make the seller claim a mail for something they never gave up.
   */
  private async grant(sellerId: string, snapshot: AuctionItemSnapshot, orderId: string): Promise<void> {
    const { meta } = this.deps;
    if (snapshot.itemType === 'material') {
      await meta.grantMaterial(sellerId, snapshot.item['material'] as string, snapshot.qty, orderId);
      return;
    }
    if (snapshot.itemType === 'equipment') {
      const inst = equipInstanceOf(snapshot.item);
      if (inst) await meta.grantEquipment(sellerId, inst, orderId);
      return;
    }
    if (snapshot.itemType === 'card') {
      const inst = cardInstanceOf(snapshot.item);
      if (inst) await meta.grantCard(sellerId, inst, orderId);
      return;
    }
    if (snapshot.itemType === 'skin') {
      const skinId = snapshot.item['skinId'] as string | undefined;
      if (skinId) await meta.grantSkin(sellerId, skinId, orderId);
    }
  }

  /**
   * Release a listing this flow claimed but could not pay for (buyer had no coins, or the process died
   * between the claim and the charge). Guard rationale is in db.ts's `AuctionOrderStep.unclaim`: the
   * triple `{status:'sold', buyerId, settledAt absent}` matches exactly our own unsettled claim, so this
   * is a no-op both for a claim that never happened and for a sale that did complete.
   */
  private async unclaim(auctionId: string, buyerId: string): Promise<void> {
    await this.deps.cols.auctions.updateOne(
      { _id: auctionId, status: 'sold', buyerId, settledAt: { $exists: false } },
      {
        $set: { status: 'open' },
        $unset: { buyerId: '', soldAt: '', closedAt: '' },
        $inc: { rev: 1 },
      },
    );
  }
}
