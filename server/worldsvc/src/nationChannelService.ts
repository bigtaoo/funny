// Nation/world public-channel service (B7, §6.4 social channels).
// All players within the same world can post; messages are fanned out to online gateway members via
// Redis pub/sub. Without Redis the service degrades to O(n) HTTP push. Offline members fetch
// history via REST (TTL 7 days).
import { FAMILY_MSG_BODY_MAX, SlgError } from '@nw/shared';
import type { WorldCollections, NationMessageDoc } from './db';
import type { HttpWorldGatewayClient } from './gatewayClient';
import type { WorldCommercialClient } from './commercialClient';
import { nullWorldSocialsvcClient, type WorldSocialsvcClient } from './socialsvcClient';
import type { WorldMetaClient } from './metaClient';
import { nullWorldMetaClient } from './metaClient';

const WORLD_CHAT_COST = 50;

export interface NationMessageView {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: number;
}

interface Deps {
  cols: WorldCollections;
  gateway: HttpWorldGatewayClient;
  commercial: WorldCommercialClient;
  now: () => number;
  /** socialsvc client (push delegation, SOCIAL_SVC_DESIGN §5); omit to degrade to direct gateway push. */
  socialsvc?: WorldSocialsvcClient;
  /** meta client for publicId resolution in chat messages; omit to leave fromPublicId empty. */
  meta?: WorldMetaClient;
}

let msgSeq = 0;

export class NationChannelService {
  private readonly socialsvc: WorldSocialsvcClient;
  private readonly meta: WorldMetaClient;
  constructor(private readonly deps: Deps) {
    this.socialsvc = deps.socialsvc ?? nullWorldSocialsvcClient;
    this.meta = deps.meta ?? nullWorldMetaClient;
  }

  /**
   * Send a nation/world public-channel message. The player must already be settled in the world
   * (playerWorld record must exist); the message is persisted then broadcast to all other online
   * players in the world.
   */
  async sendMessage(
    worldId: string,
    accountId: string,
    senderName: string,
    body: string,
  ): Promise<NationMessageView> {
    const { cols } = this.deps;

    const pw = await cols.playerWorld.findOne({ _id: `${worldId}:${accountId}` });
    if (!pw) throw new SlgError('NOT_IN_WORLD');
    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    const ts = this.deps.now();

    if (this.deps.commercial.available) {
      const orderId = `world_chat:${worldId}:${accountId}:${ts}`;
      await this.deps.commercial.spend(accountId, WORLD_CHAT_COST, orderId);
    }
    const seq = ++msgSeq;
    const msgId = `nm:${worldId}:${ts}:${seq}`;

    const msgDoc: NationMessageDoc = {
      _id: msgId,
      worldId,
      senderId: accountId,
      senderName,
      body,
      ts: new Date(ts),
    };
    await cols.nationMessages.insertOne(msgDoc);

    // Resolve publicId from meta (best-effort; falls back to empty string if meta unavailable or profile not found).
    const profile = this.meta.available ? await this.meta.getProfile(accountId).catch(() => null) : null;
    // Push: prefer delegating to socialsvc (push hub, §5); fall back to direct gateway push O(n) when socialsvc is unavailable.
    const payload = { worldId, fromPublicId: profile?.publicId ?? '', fromName: senderName, body, ts };
    if (this.socialsvc.available) {
      const recipients = await this.worldMemberAccountIds(worldId, accountId);
      void this.socialsvc.push({ kind: 'world', worldId }, 'nation_msg', payload, recipients);
    } else {
      const recipients = await this.worldMemberAccountIds(worldId, accountId);
      void this.deps.gateway.broadcast(recipients, { kind: 'nation_msg', ...payload });
    }

    return { id: msgId, senderId: accountId, senderName, body, ts };
  }

  /**
   * Fetch nation/world public-channel history (reverse-chronological pagination; before is an ms
   * epoch cursor; limit ≤ 50). The player must already be settled in the world.
   */
  async getChannel(
    worldId: string,
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<NationMessageView[]> {
    const { cols } = this.deps;

    const pw = await cols.playerWorld.findOne({ _id: `${worldId}:${accountId}` });
    if (!pw) throw new SlgError('NOT_IN_WORLD');

    const realLimit = Math.min(Math.max(limit, 1), 50);
    const query: Record<string, unknown> = { worldId };
    if (before != null) query['ts'] = { $lt: new Date(before) };

    const docs = await cols.nationMessages
      .find(query)
      .sort({ ts: -1 })
      .limit(realLimit)
      .toArray();

    return docs.map((d) => ({
      id: d._id,
      senderId: d.senderId,
      senderName: d.senderName,
      body: d.body,
      ts: d.ts.getTime(),
    }));
  }

  private async worldMemberAccountIds(worldId: string, exclude: string): Promise<string[]> {
    const members = await this.deps.cols.playerWorld
      .find({ worldId })
      .project<{ accountId: string }>({ accountId: 1 })
      .toArray();
    return members.map((m) => m.accountId).filter((id) => id !== exclude);
  }
}
