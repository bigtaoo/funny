// Paddle webhook event log (support/CS lookup, COMMERCIAL_DESIGN §10.4). Read-only proxy to commercial's
// paddleEvents collection — recording happens in metaserver's /paddle/webhook handler, not here.
import type { PaddleEventView } from '../clients';
import type { AdminCore } from './base';

export class PaddleEventsService {
  constructor(private readonly core: AdminCore) {}

  /** List logged Paddle events for support lookup; returns an empty list if commercial is unreachable. */
  async listPaddleEvents(args: {
    accountId?: string;
    transactionId?: string;
    limit?: number;
  }): Promise<PaddleEventView[]> {
    if (!this.core.paddleEvents.available) return [];
    return this.core.paddleEvents.list(args);
  }
}
