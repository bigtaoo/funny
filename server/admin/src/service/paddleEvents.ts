// Paddle webhook event log (support/CS lookup, COMMERCIAL_DESIGN §10.4). Read-only proxy to commercial's
// paddleEvents collection — recording happens in metaserver's /paddle/webhook handler, not here.
import type { PaddleEventView } from '../clients';
import type { AdminBaseCtor, Constructor } from './base';

export interface PaddleEventsHandlers {
  listPaddleEvents(args: { accountId?: string; transactionId?: string; limit?: number }): Promise<PaddleEventView[]>;
}

export function PaddleEventsMixin<TBase extends AdminBaseCtor>(
  Base: TBase,
): TBase & Constructor<PaddleEventsHandlers> {
  return class extends Base {
    /** List logged Paddle events for support lookup; returns an empty list if commercial is unreachable. */
    async listPaddleEvents(args: {
      accountId?: string;
      transactionId?: string;
      limit?: number;
    }): Promise<PaddleEventView[]> {
      if (!this.paddleEvents.available) return [];
      return this.paddleEvents.list(args);
    }
  };
}
