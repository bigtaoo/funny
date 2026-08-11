// World channel (nation/public chat, S6-4, 50 coins per message).
import type { WorldApiCore } from './core';
import type { WorldChatMessage } from './types';

/** World-channel domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class WorldChannelService {
  constructor(private readonly core: WorldApiCore) {}

  async getWorldChannel(
    worldId: string,
    opts?: { before?: number; limit?: number }
  ): Promise<WorldChatMessage[]> {
    const params = new URLSearchParams({ worldId });
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.core.req('GET', `/nation/channel?${params}`);
  }

  async sendWorldChannelMessage(
    worldId: string,
    body: string,
    senderName: string
  ): Promise<WorldChatMessage> {
    return this.core.req('POST', '/nation/message', { worldId, body, senderName });
  }
}
