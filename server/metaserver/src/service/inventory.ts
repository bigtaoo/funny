// Equipment lifecycle (E2-E6, EQUIPMENT_DESIGN) + Hero Roster card feeding (CC-2).
// Thin HTTP wrappers over the authoritative logic in ../equipment.ts and ../cards.ts; each maps a
// domain error code to its HTTP status via ERROR_HTTP_STATUS.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, ERROR_HTTP_STATUS, err, ok } from '@nw/shared';
import { craftEquipment, enhanceEquipment, salvageEquipment, equipEquipment, reforgeEquipment } from '../equipment.js';
import { feedCards, setCardLock } from '../cards.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, type Constructor, type MetaBaseCtor } from './base.js';

type InventoryHandlers = Pick<
  MetaHandlers,
  | 'craftEquipment' | 'enhanceEquipment' | 'salvageEquipment' | 'equipEquipment' | 'reforgeEquipment'
  | 'cardsFeed' | 'cardsLock' | 'cardsUnlock'
>;

export function InventoryMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<InventoryHandlers> {
  return class extends Base {
    /**
     * Equipment crafting (E2, EQUIPMENT_DESIGN §4/§7): deduct stationery materials → roll one +0 base equipment → store (300-item cap).
     * idempotencyKey is idempotent (client-generated): replay returns the first result without re-deducting materials or re-rolling.
     */
    async craftEquipment(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { defId, idempotencyKey } = req.body as { defId: string; idempotencyKey: string };
      const { cols, now } = this.deps;
      const r = await craftEquipment(cols, now, accountId, defId, idempotencyKey);
      if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
      return ok({ save: r.save, instance: r.instance });
    }

    /**
     * Equipment enhancement (E3, EQUIPMENT_DESIGN §6): server rolls the dice (success rate table) → deduct materials + coins (commercial is authoritative) →
     * success increments level by 1, failure does not downgrade. idempotencyKey is idempotent (roll and deduction bound to key; replay returns the first result).
     */
    async enhanceEquipment(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { instanceId, idempotencyKey, useProtect } = req.body as { instanceId: string; idempotencyKey: string; useProtect?: boolean };
      const { cols, commercial, now } = this.deps;
      const r = await enhanceEquipment(cols, commercial, now, accountId, instanceId, idempotencyKey, useProtect === true);
      if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
      return ok({ success: r.success, instance: r.instance, save: r.save });
    }

    /**
     * Equipment salvage (E3, EQUIPMENT_DESIGN §6.3): +0~4 items return 70% of crafting materials and are removed from inventory; +5 items rejected, equipped/locked items rejected.
     * Batch operation + idempotencyKey is idempotent (replay returns the first refund).
     */
    async salvageEquipment(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { instanceIds, idempotencyKey } = req.body as { instanceIds: string[]; idempotencyKey: string };
      const { cols, now } = this.deps;
      const r = await salvageEquipment(cols, now, accountId, instanceIds, idempotencyKey);
      if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
      return ok({ refunded: r.refunded, save: r.save });
    }

    /**
     * Equip / unequip equipment (E4, EQUIPMENT_DESIGN §3.4): validate slot match → write gear into the target CardInstance.
     * instanceId=null to unequip. cardInstanceId identifies which card's gear slot is written. Naturally idempotent.
     */
    async equipEquipment(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { slot, instanceId, cardInstanceId } = req.body as {
        slot: string;
        instanceId: string | null;
        cardInstanceId: string;
      };
      const { cols, now } = this.deps;
      const r = await equipEquipment(cols, now, accountId, slot, instanceId ?? null, cardInstanceId);
      if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
      return ok({ save: r.save });
    }

    /**
     * Equipment reforging (E6, EQUIPMENT_DESIGN §7.8): consume a lower-tier material of the same slot, keep the primary stat, re-roll secondary stats.
     * fine/rare/epic can be reforged; material must be the same slot and exactly one tier lower. idempotencyKey is idempotent.
     */
    async reforgeEquipment(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { targetId, materialId, idempotencyKey } = req.body as {
        targetId: string;
        materialId: string;
        idempotencyKey: string;
      };
      const { cols, commercial, now } = this.deps;
      const r = await reforgeEquipment(cols, commercial, now, accountId, targetId, materialId, idempotencyKey);
      if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
      return ok({ instance: r.instance, save: r.save });
    }

    /**
     * Feed material cards into a target card to gain XP and level up (CHARACTER_CARDS_DESIGN §3.3, CC-2).
     * Same-faction required; locked materials rejected; idempotencyKey prevents double-consumption.
     */
    async cardsFeed(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { targetId, materialIds, idempotencyKey } = req.body as {
        targetId: string;
        materialIds: string[];
        idempotencyKey: string;
      };
      const { cols, now } = this.deps;
      const r = await feedCards(cols, now, accountId, targetId, materialIds, idempotencyKey);
      if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
      return ok({ card: r.card, levelsGained: r.levelsGained, save: r.save });
    }

    /**
     * Lock a character card (CC-4): locked cards cannot be consumed as feed material.
     * Idempotent — locking an already-locked card succeeds without bumping the save rev.
     */
    async cardsLock(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cardInstanceId } = req.body as { cardInstanceId: string };
      const { cols, now } = this.deps;
      const r = await setCardLock(cols, now, accountId, cardInstanceId, true);
      if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
      return ok({ save: r.save });
    }

    /**
     * Unlock a character card (CC-4): unlocked cards may again be consumed as feed material.
     * Idempotent — unlocking an already-unlocked card succeeds without bumping the save rev.
     */
    async cardsUnlock(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cardInstanceId } = req.body as { cardInstanceId: string };
      const { cols, now } = this.deps;
      const r = await setCardLock(cols, now, accountId, cardInstanceId, false);
      if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
      return ok({ save: r.save });
    }
  };
}
