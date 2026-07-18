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
  /** 9-digit public id (display-only); empty if unknown (meta unavailable or message predates this field). */
  senderPublicId: string;
  /** Sender's equipped title (称号), if any. */
  title?: string;
  /** Sender's sect name (宗门), if any. */
  sectName?: string;
  /** Sender's family name (家族), if any. */
  familyName?: string;
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
   * Send a nation/world public-channel message. World chat is a social feature scoped to the
   * player's shard, not an SLG-map feature — posting must not require a playerWorld record (i.e.
   * having actually settled a base in that world); the message is persisted then broadcast to all
   * other online players in the world.
   */
  async sendMessage(
    worldId: string,
    accountId: string,
    senderName: string,
    body: string,
  ): Promise<NationMessageView> {
    const { cols } = this.deps;

    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    const ts = this.deps.now();

    // Charge the post BEFORE persisting. This is intentionally unconditional (mirrors every
    // other coin sink in worldsvc, e.g. city.ts speedup/recover): the old `if (commercial.available)`
    // guard let posts through for free whenever worldsvc was started without NW_COMMERCIAL_INTERNAL_URL.
    // If commercial is unconfigured, spend() throws → the message is rejected, never posted free.
    const orderId = `world_chat:${worldId}:${accountId}:${ts}`;
    await this.deps.commercial.spend(accountId, WORLD_CHAT_COST, orderId);
    const seq = ++msgSeq;
    const msgId = `nm:${worldId}:${ts}:${seq}`;

    // Resolve publicId + display name + title from meta (source of truth for renames); best-effort,
    // falls back to the client-supplied senderName if meta is unavailable or profile not found —
    // a stale/incorrect client-side cache must never be preferred over the account's real name.
    const profile = this.meta.available ? await this.meta.getProfile(accountId).catch(() => null) : null;
    const senderPublicId = profile?.publicId ?? '';
    const resolvedSenderName = profile?.displayName ?? senderName;
    const title = profile?.equippedTitle;

    // Resolve family + sect name (world chat spans every family/sect, unlike the family/sect-scoped
    // channels where the sender's own family/sect is already known); best-effort, both absent if the
    // sender is family-less or the family isn't in a sect.
    const mem = this.socialsvc.available ? await this.socialsvc.getMember(accountId).catch(() => null) : null;
    const familyName = mem?.name;
    let sectName: string | undefined;
    if (mem) {
      const [famSummary] = await this.socialsvc.getFamiliesByIds([mem.familyId]).catch(() => []);
      if (famSummary?.sectId) sectName = (await cols.sects.findOne({ _id: famSummary.sectId }))?.name;
    }

    const msgDoc: NationMessageDoc = {
      _id: msgId,
      worldId,
      senderId: accountId,
      senderName: resolvedSenderName,
      senderPublicId,
      ...(title ? { title } : {}),
      ...(sectName ? { sectName } : {}),
      ...(familyName ? { familyName } : {}),
      body,
      ts: new Date(ts),
    };
    await cols.nationMessages.insertOne(msgDoc);

    // Push: prefer delegating to socialsvc (push hub, §5); fall back to direct gateway push O(n) when socialsvc is unavailable.
    const payload = { worldId, fromPublicId: senderPublicId, fromName: resolvedSenderName, title, sectName, familyName, body, ts };
    if (this.socialsvc.available) {
      const recipients = await this.worldMemberAccountIds(worldId, accountId);
      void this.socialsvc.push({ kind: 'world', worldId }, 'nation_msg', payload, recipients);
    } else {
      const recipients = await this.worldMemberAccountIds(worldId, accountId);
      void this.deps.gateway.broadcast(recipients, { kind: 'nation_msg', ...payload });
    }

    return { id: msgId, senderId: accountId, senderName: resolvedSenderName, senderPublicId, title, sectName, familyName, body, ts };
  }

  /**
   * Fetch nation/world public-channel history (reverse-chronological pagination; before is an ms
   * epoch cursor; limit ≤ 50). Read access must not require a playerWorld record — a player who
   * has never settled a base in this world's SLG map can still read/post its social chat.
   */
  async getChannel(
    worldId: string,
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<NationMessageView[]> {
    const { cols } = this.deps;

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
      senderPublicId: d.senderPublicId ?? '',
      title: d.title,
      sectName: d.sectName,
      familyName: d.familyName,
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
