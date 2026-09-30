// Sect business layer — channel messaging (S8-4b, SLG_DESIGN §2.1/§9.3). Split out of sectService.ts
// (2026-08-11, 独立类+组合 form, familyService.ts's sibling — see ../sectService.ts for the composing
// facade). Zero cross-domain calls into query.ts/membership.ts.
import { randomBytes } from 'node:crypto';
import { FAMILY_MSG_BODY_MAX, SlgError, censorChat, UNRESOLVED_SENDER_NAME, type ChatRegion } from '@nw/shared';
import type { SectMessageDoc } from '../db';
import { nullWorldGatewayClient, type WorldGatewayClient } from '../gatewayClient';
import { nullWorldSocialsvcClient, type WorldSocialsvcClient } from '../socialsvcClient';
import { nullWorldMetaClient, type WorldMetaClient } from '../metaClient';
import type { SectMessageView, SectServiceDeps } from './types';

/** In-process monotonic sequence number to prevent message id collisions within the same millisecond. */
let msgSeq = 0;

export class SectChatService {
  private readonly gateway: WorldGatewayClient;
  private readonly socialsvc: WorldSocialsvcClient;
  private readonly meta: WorldMetaClient;

  constructor(private readonly deps: SectServiceDeps) {
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
    this.socialsvc = deps.socialsvc ?? nullWorldSocialsvcClient;
    this.meta = deps.meta ?? nullWorldMetaClient;
  }

  /**
   * Send a sect channel message (any member may send; persisted + real-time push).
   * After writing to the DB, the message is fan-out to other online sect members via Redis pub/sub
   * (≤900 members; worldsvc publishes a single message to GW_PUSH_REDIS_CHANNEL; each gateway delivers
   * it to online members on that node; no Redis → gateway client falls back to O(n) HTTP push).
   * Offline members retrieve history via REST polling (TTL 7 days).
   */
  async sendMessage(
    worldId: string,
    accountId: string,
    _clientSenderName: string,
    body: string,
    region: ChatRegion = 'global',
  ): Promise<SectMessageView> {
    const { cols } = this.deps;
    const mem = await this.socialsvc.getMember(accountId);
    if (!mem) throw new SlgError('NOT_IN_SECT');
    if (!mem.sectId) throw new SlgError('NOT_IN_SECT');
    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    // Resolve display name + title from meta (source of truth for renames). Fetched before censoring the body
    // (mirrors family/world chat, CONTENT_MODERATION_DESIGN.md CM7.1): profile.mutedUntil is the mute check,
    // which sect chat was missing until Guideline 1.2 — a muted player could keep posting here.
    const profile = this.meta.available ? await this.meta.getProfile(accountId).catch(() => null) : null;
    if (profile?.mutedUntil && profile.mutedUntil > this.deps.now()) throw new SlgError('ACCOUNT_MUTED');

    // CONTENT_MODERATION_DESIGN.md CM5: sect chat is ephemeral like DM/family/world chat —
    // mask on hit, never reject delivery (mirrors nationChannelService.ts's sendMessage).
    body = censorChat(body, region, this.deps.wordlists).text;

    const sectId = mem.sectId;
    const ts = this.deps.now();
    const seq = ++msgSeq;
    // 2026-08-03 (worldsvc code review): same fix as nationChannelService.ts — `msgSeq` is only
    // unique within a single process, and worldsvc fans out across multiple instances (Redis pub/sub
    // for cross-instance push), so a random suffix is added to make an _id collision across instances
    // astronomically unlikely without needing cross-instance coordination.
    const msgId = `sm:${sectId}:${ts}:${seq}:${randomBytes(4).toString('hex')}`;

    // Meta unavailable / profile missing → a neutral placeholder, never the client-supplied name: that string
    // bypasses the display-name filter and lets a client post under any name it likes (Guideline 1.2).
    const resolvedSenderName = profile?.displayName ?? UNRESOLVED_SENDER_NAME;
    const title = profile?.equippedTitle;
    // Family + sect name are already resolved above (mem.name / the sect this channel belongs to) — no extra lookups.
    const familyName = mem.name;
    const sectDoc = await cols.sects.findOne({ _id: sectId });
    const sectDocName = sectDoc?.name;

    const msgDoc: SectMessageDoc = {
      _id: msgId,
      worldId,
      sectId,
      senderId: accountId,
      senderName: resolvedSenderName,
      ...(profile?.publicId ? { senderPublicId: profile.publicId } : {}),
      ...(title ? { title } : {}),
      ...(sectDocName ? { sectName: sectDocName } : {}),
      ...(familyName ? { familyName } : {}),
      body,
      ts: new Date(ts),
    };
    await cols.sectMessages.insertOne(msgDoc);

    // Push: prefer delegating to socialsvc (the push hub, §5); fall back to direct gateway push when socialsvc is unavailable.
    const payload = { sectId, fromPublicId: profile?.publicId ?? '', fromName: resolvedSenderName, title, sectName: sectDocName, familyName, body, ts };
    if (this.socialsvc.available) {
      const recipients = await this.sectMemberAccountIds(worldId, sectId, accountId);
      void this.socialsvc.push({ kind: 'sect', sectId }, 'sect_msg', payload, recipients);
    } else {
      const recipients = await this.sectMemberAccountIds(worldId, sectId, accountId);
      void this.gateway.broadcast(recipients, { kind: 'sect_msg', ...payload });
    }

    return { id: msgId, senderId: accountId, senderName: resolvedSenderName, senderPublicId: profile?.publicId ?? '', title, sectName: sectDocName, familyName, body, ts };
  }

  /** Collects all member accountIds within the sect who are joined to this world (spread across member families, via PlayerWorldDoc.familyId); optionally excludes one account (e.g., the sender). */
  private async sectMemberAccountIds(worldId: string, sectId: string, exclude?: string): Promise<string[]> {
    const fams = await this.socialsvc.getFamiliesBySect(sectId);
    const famIds = fams.map((f) => f.familyId);
    if (famIds.length === 0) return [];
    const members = await this.deps.cols.playerWorld
      .find({ worldId, familyId: { $in: famIds } })
      .project<{ accountId: string }>({ accountId: 1 })
      .toArray();
    const ids = members.map((m) => m.accountId).filter((id) => id !== exclude);
    // Deduplicate (in theory each accountId belongs to only one family, but deduplicate for safety).
    return [...new Set(ids)];
  }

  /** Retrieve sect channel history (readable by any member; paginated in reverse chronological order). */
  async getChannel(
    worldId: string,
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<SectMessageView[]> {
    const { cols } = this.deps;
    const mem = await this.socialsvc.getMember(accountId);
    if (!mem) throw new SlgError('NOT_IN_SECT');
    if (!mem.sectId) throw new SlgError('NOT_IN_SECT');

    const realLimit = Math.min(Math.max(limit, 1), 50);
    const query: Record<string, unknown> = { sectId: mem.sectId };
    if (before != null) query['ts'] = { $lt: new Date(before) };

    const docs = await cols.sectMessages.find(query).sort({ ts: -1 }).limit(realLimit).toArray();
    // Backfill senderPublicId for docs written before it was stored (one batched meta call, ≤50 ids).
    const missing = [...new Set(docs.filter((d) => !d.senderPublicId).map((d) => d.senderId))];
    const backfill = missing.length > 0 && this.meta.available
      ? await Promise.resolve().then(() => this.meta.batchProfiles(missing)).catch(() => new Map<string, { publicId: string }>())
      : new Map<string, { publicId: string }>();
    return docs.map((d) => ({
      id: d._id,
      senderId: d.senderId,
      senderName: d.senderName,
      senderPublicId: d.senderPublicId ?? backfill.get(d.senderId)?.publicId ?? '',
      title: d.title,
      sectName: d.sectName,
      familyName: d.familyName,
      body: d.body,
      ts: d.ts instanceof Date ? d.ts.getTime() : (d.ts as unknown as number),
    }));
  }
}
