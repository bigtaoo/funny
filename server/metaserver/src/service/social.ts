// Social: friends / chat / mail (S6-1/2/3). From P2 onwards these are proxied to socialsvc when
// NW_SOCIALSVC_INTERNAL_URL is configured. claimMail is the exception: socialsvc atomically marks the
// claim, then meta performs the actual attachment delivery (coins/equipment/cards/skins/materials).
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok } from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { splitAttachments } from '../mail.js';
import { grantEquipment } from '../equipment.js';
import { grantCard } from '../cards.js';
import { deliverMailGrant } from '../economy.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, type Constructor, type MetaBaseCtor } from './base.js';

type SocialHandlers = Pick<
  MetaHandlers,
  | 'getFriends' | 'getFriendRequests' | 'getSocialBadges' | 'searchFriend' | 'requestFriend'
  | 'respondFriend' | 'removeFriend' | 'blockUser' | 'unblockUser' | 'getConversations'
  | 'getMessages' | 'sendChat' | 'readChat' | 'getMail' | 'readMail' | 'deleteMail'
  | 'claimMail' | 'sendMail'
>;

export function SocialMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<SocialHandlers> {
  return class extends Base {
    /** Proxy to socialsvc (pass-through JWT + body). socialsvc not configured → 503. */
    private async proxySocial(
      req: FastifyRequest,
      reply: FastifyReply,
      socialPath: string,
      body?: unknown,
    ): Promise<void> {
      if (!this.deps.socialsvc?.available) {
        reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'socialsvc not configured'));
        return;
      }
      const auth = (req.headers.authorization ?? '') as string;
      const r = await this.deps.socialsvc.proxy(req.method, socialPath, body ?? null, auth);
      reply.status(r.status).send(r.data);
    }

    async getFriends(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/friends');
    }

    async getFriendRequests(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/friends/requests');
    }

    async getSocialBadges(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/badges');
    }

    async searchFriend(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/friends/search', req.body);
    }

    async requestFriend(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/friends/request', req.body);
    }

    async respondFriend(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/friends/respond', req.body);
    }

    async removeFriend(req: FastifyRequest, reply: FastifyReply) {
      const { publicId } = req.params as { publicId: string };
      return this.proxySocial(req, reply, `/social/friends/${encodeURIComponent(publicId)}`);
    }

    async blockUser(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/friends/block', req.body);
    }

    async unblockUser(req: FastifyRequest, reply: FastifyReply) {
      const { publicId } = req.params as { publicId: string };
      return this.proxySocial(req, reply, `/social/friends/block/${encodeURIComponent(publicId)}`);
    }

    async getConversations(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/chat/conversations');
    }

    async getMessages(req: FastifyRequest, reply: FastifyReply) {
      const { convId } = req.params as { convId: string };
      const q = req.query as { before?: string | number; limit?: string | number };
      const qs = new URLSearchParams();
      if (q.before !== undefined) qs.set('before', String(q.before));
      if (q.limit !== undefined) qs.set('limit', String(q.limit));
      const qStr = qs.toString();
      return this.proxySocial(req, reply, `/social/chat/${encodeURIComponent(convId)}/messages${qStr ? `?${qStr}` : ''}`);
    }

    async sendChat(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/chat/send', req.body);
    }

    async readChat(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/chat/read', req.body);
    }

    async getMail(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/mail');
    }

    async readMail(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      return this.proxySocial(req, reply, `/social/mail/${encodeURIComponent(id)}/read`, {});
    }

    async deleteMail(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      return this.proxySocial(req, reply, `/social/mail/${encodeURIComponent(id)}`);
    }

    async claimMail(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { id } = req.params as { id: string };
      const { cols, commercial, now } = this.deps;

      if (!this.deps.socialsvc?.available) {
        return reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'socialsvc not configured'));
      }
      const orderId = randomUUID();
      const claimedResult = await this.deps.socialsvc.claimMail(id, accountId, orderId);
      if ('error' in claimedResult) {
        if (claimedResult.error === 'NOT_FOUND') return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'mail not found'));
        if (claimedResult.error === 'NO_ATTACHMENT') return reply.code(400).send(err(ErrorCode.NO_ATTACHMENT, 'no attachment'));
        return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed'));
      }
      const attachments = claimedResult.doc.attachments ?? [];
      if (attachments.length === 0) return reply.code(400).send(err(ErrorCode.NO_ATTACHMENT, 'no attachment'));
      const split = splitAttachments(attachments);
      if (split.coins > 0 && !commercial.available) {
        return reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'commercial service unavailable'));
      }
      let coinsAfter: number | null = null;
      if (split.coins > 0) {
        const g = await commercial.grant({ accountId, amount: split.coins, reason: 'mail', orderId });
        if (g.ok) coinsAfter = g.coinsAfter;
      }
      // Equipment/card instance snapshots (auction escrow-out): write back to equipmentInv/cardInv by instance.id.
      // Idempotent both ways — claimMailAtomic already gates single-shot claim, and grant* overwrites by id.
      for (const inst of split.equipment) await grantEquipment(cols, now, accountId, inst);
      for (const inst of split.cards) await grantCard(cols, now, accountId, inst);
      const cur = await getOrCreateSave(cols, accountId, now());
      const newSkins = split.skins.filter((s) => !cur.inventory.skins.includes(s));
      const save = await deliverMailGrant(cols, accountId, orderId, newSkins, split.items, coinsAfter, now(), split.materials);
      return ok({ save });
    }

    async sendMail(req: FastifyRequest, reply: FastifyReply) {
      return this.proxySocial(req, reply, '/social/mail/send', req.body);
    }
  };
}
