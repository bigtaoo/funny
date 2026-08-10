// Family business layer — the family chat channel (SOCIAL_SVC_DESIGN §3/§4). Split out of
// familyService.ts (see ../familyService.ts for the composing facade).
import { FAMILY_MSG_BODY_MAX, SlgError, censorChat, type ChatRegion } from '@nw/shared';
import type { FamilyMessageDoc } from '../db';
import type { SocialGatewayClient } from '../gatewayClient';
import { nullSocialGatewayClient } from '../gatewayClient';
import type { SocialMetaClient } from '../metaClient';
import { nullSocialMetaClient } from '../metaClient';
import type { FamilyServiceDeps, FamilyMessageView } from './types';

/** In-process monotonic sequence number to prevent message ID collisions within the same millisecond. */
let msgSeq = 0;

export class FamilyChatService {
  private readonly gateway: SocialGatewayClient;
  private readonly meta: SocialMetaClient;

  constructor(private readonly deps: FamilyServiceDeps) {
    this.gateway = deps.gateway ?? nullSocialGatewayClient;
    this.meta = deps.meta ?? nullSocialMetaClient;
  }

  /** Send a message to the family channel. Pushes in real time to all other online members. */
  async sendMessage(
    accountId: string,
    senderName: string,
    body: string,
    region: ChatRegion = 'global',
  ): Promise<FamilyMessageView> {
    const cols = this.deps.cols;

    const mem = await cols.familyMembers.findOne({ _id: accountId });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');
    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    // Resolve display name + title from meta (source of truth for renames); best-effort, falls back
    // to the client-supplied senderName if meta is unavailable or profile not found — a stale/incorrect
    // client-side cache must never be preferred over the account's real name. Fetched before censoring
    // the body (CONTENT_MODERATION_DESIGN.md CM7.1): profiles.mutedUntil is the mute-enforcement check,
    // piggybacked on this call rather than a separate round trip.
    const profiles = this.meta.available ? await this.meta.batchProfiles([accountId]) : new Map();
    const mutedUntil = profiles.get(accountId)?.mutedUntil;
    if (mutedUntil && mutedUntil > this.deps.now()) throw new SlgError('ACCOUNT_MUTED');

    // CONTENT_MODERATION_DESIGN.md CM5: family chat is ephemeral like DM/world chat — mask on hit,
    // never reject delivery.
    body = censorChat(body, region, this.deps.wordlists).text;

    const ts = this.deps.now();
    const seq = ++msgSeq;
    const msgId = `fm:${mem.familyId}:${ts}:${seq}`;
    const resolvedSenderName = profiles.get(accountId)?.displayName ?? senderName;
    const title = profiles.get(accountId)?.equippedTitle;
    const fromPublicId = profiles.get(accountId)?.publicId ?? '';
    const familyDoc = await cols.families.findOne({ _id: mem.familyId });
    const familyName = familyDoc?.name;

    const msgDoc: FamilyMessageDoc = {
      _id: msgId,
      familyId: mem.familyId,
      senderId: accountId,
      senderName: resolvedSenderName,
      ...(title ? { title } : {}),
      ...(familyName ? { familyName } : {}),
      body,
      ts: new Date(ts),
    };
    await cols.familyMessages.insertOne(msgDoc);

    // Push to all other members (O(n), ≤30 members)
    const otherMembers = await cols.familyMembers
      .find({ familyId: mem.familyId, _id: { $ne: accountId } })
      .toArray();
    await this.gateway.pushMany(
      otherMembers.map((m) => m.accountId),
      { kind: 'family_msg', familyId: mem.familyId, fromPublicId, fromName: resolvedSenderName, title, familyName, body, ts },
    );

    return { id: msgId, senderId: accountId, senderName: resolvedSenderName, title, familyName, body, ts };
  }

  /** Get channel history (reverse-chronological pagination; `before` is a ms-epoch cursor; limit ≤50). */
  async getChannel(
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<FamilyMessageView[]> {
    const cols = this.deps.cols;

    const mem = await cols.familyMembers.findOne({ _id: accountId });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');

    const realLimit = Math.min(Math.max(limit, 1), 50);
    const query: Record<string, unknown> = { familyId: mem.familyId };
    if (before != null) query['ts'] = { $lt: new Date(before) };

    const docs = await cols.familyMessages
      .find(query)
      .sort({ ts: -1 })
      .limit(realLimit)
      .toArray();

    return docs.map((d) => ({
      id: d._id,
      senderId: d.senderId,
      senderName: d.senderName,
      title: d.title,
      familyName: d.familyName,
      body: d.body,
      ts: d.ts instanceof Date ? d.ts.getTime() : (d.ts as unknown as number),
    }));
  }
}
