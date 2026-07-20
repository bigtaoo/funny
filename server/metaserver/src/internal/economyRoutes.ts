// Material/equipment/card/skin escrow-transfer + progression snapshot — called by worldsvc (auction + siege engine).
import type { FastifyInstance } from 'fastify';
import type { SaveData, EquipmentInstance, CardInstance } from '@nw/shared';
import { createLogger, ERROR_HTTP_STATUS } from '@nw/shared';
import { escrowEquipment, grantEquipment } from '../equipment.js';
import { grantCard } from '../cards.js';
import { escrowSkin, grantSkin } from '../skin.js';
import type { InternalCtx } from './context.js';

const log = createLogger('meta:internal');

export function registerEconomyRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed, now } = ctx;

  // ── Material deduction / grant (S8-5, called by worldsvc auction) ─────────────────────────────────
  // Bypasses openapi glue, authenticated via X-Internal-Key.
  // POST /internal/materials/deduct  { accountId, material, qty, orderId }
  //   → deduct the specified material; insufficient balance → 402; optimistic-lock conflict retried 3 times, then 409.
  app.post('/internal/materials/deduct', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, material, qty } = req.body as {
      accountId?: string;
      material?: string;
      qty?: number;
    };
    if (!accountId || !material || typeof qty !== 'number' || qty <= 0) {
      return reply.code(400).send({ ok: false, error: 'accountId + material + qty (>0) required' });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return reply.code(404).send({ ok: false, error: 'save not found' });
      const cur = doc.save.materials?.[material] ?? 0;
      if (cur < qty) return reply.code(402).send({ ok: false, error: 'insufficient materials' });
      const next: SaveData = {
        ...doc.save,
        rev: doc.save.rev + 1,
        updatedAt: now(),
        materials: { ...doc.save.materials, [material]: cur - qty },
      };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
      );
      if (res) return reply.send({ ok: true, remaining: cur - qty });
    }
    return reply.code(409).send({ ok: false, error: 'rev conflict, retry' });
  });

  // POST /internal/materials/grant  { accountId, material, qty, orderId }
  //   → grant the specified material; idempotent (orderId is currently logged only, no dedup collection, best-effort).
  app.post('/internal/materials/grant', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, material, qty, orderId } = req.body as {
      accountId?: string;
      material?: string;
      qty?: number;
      orderId?: string;
    };
    if (!accountId || !material || typeof qty !== 'number' || qty <= 0) {
      return reply.code(400).send({ ok: false, error: 'accountId + material + qty (>0) required' });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return reply.code(404).send({ ok: false, error: 'save not found' });
      const cur = doc.save.materials?.[material] ?? 0;
      const everOwnedMaterial = new Set(doc.save.everOwned?.material ?? []);
      everOwnedMaterial.add(material);
      const next: SaveData = {
        ...doc.save,
        rev: doc.save.rev + 1,
        updatedAt: now(),
        materials: { ...doc.save.materials, [material]: cur + qty },
        everOwned: { ...doc.save.everOwned, material: [...everOwnedMaterial] },
      };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
      );
      if (res) {
        log.info('materials granted', { accountId, material, qty, orderId, after: cur + qty });
        return reply.send({ ok: true, after: cur + qty });
      }
    }
    return reply.code(409).send({ ok: false, error: 'rev conflict, retry' });
  });

  // ── Equipment escrow / transfer (E2, called by worldsvc auction equipment transactions) ─────────────────────────────
  // POST /internal/equipment/escrow  { accountId, instanceId, orderId } → { instance }
  //   Listing escrow: verify not equipped/locked → remove from seller's inventory → return snapshot (worldsvc stores it in the listing doc). orderId is idempotent.
  app.post('/internal/equipment/escrow', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instanceId, orderId } = req.body as {
      accountId?: string;
      instanceId?: string;
      orderId?: string;
    };
    if (!accountId || !instanceId || !orderId) {
      return reply.code(400).send({ ok: false, error: 'accountId + instanceId + orderId required' });
    }
    const r = await escrowEquipment(cols, now, accountId, instanceId, orderId);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('equipment escrowed', { accountId, instanceId, orderId });
    return reply.send({ ok: true, instance: r.instance });
  });

  // ── Card escrow / grant (CC-5, called by worldsvc auction card transactions) ─────────────────────
  // POST /internal/cards/escrow  { accountId, instanceId, orderId } → { instance }
  //   Listing escrow: validate gear all empty (§11 rule) → remove from cardInv → return snapshot (worldsvc stores in listing doc).
  app.post('/internal/cards/escrow', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instanceId, orderId } = req.body as {
      accountId?: string;
      instanceId?: string;
      orderId?: string;
    };
    if (!accountId || !instanceId || !orderId) {
      return reply.code(400).send({ ok: false, error: 'accountId + instanceId + orderId required' });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return reply.code(404).send({ ok: false, error: 'save not found', code: 'NOT_FOUND' });
      const card = doc.save.cardInv?.[instanceId];
      if (!card) return reply.code(404).send({ ok: false, error: 'card not found', code: 'CARD_NOT_FOUND' });
      if (Object.values(card.gear).some((v) => !!v)) {
        return reply.code(409).send({ ok: false, error: 'card has equipped gear; unequip before listing', code: 'CARD_HAS_GEAR' });
      }
      const nextCardInv = { ...(doc.save.cardInv ?? {}) };
      delete nextCardInv[instanceId];
      const next = { ...doc.save, rev: doc.save.rev + 1, updatedAt: now(), cardInv: nextCardInv };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
      );
      if (res) {
        log.info('card escrowed', { accountId, instanceId, orderId });
        return reply.send({ ok: true, instance: card });
      }
    }
    return reply.code(409).send({ ok: false, error: 'rev conflict, retry', code: 'REV_CONFLICT' });
  });

  // POST /internal/cards/grant  { accountId, instance, orderId } → { ok }
  //   Sale transfer (to buyer) / cancellation·expiry·season-end return (to seller): writes the instance snapshot into cardInv.
  //   No cap check — a card returned from escrow or sold to a buyer is always delivered (the buyer paid coins for it).
  app.post('/internal/cards/grant', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instance, orderId } = req.body as {
      accountId?: string;
      instance?: CardInstance;
      orderId?: string;
    };
    if (!accountId || !instance?.id) {
      return reply.code(400).send({ ok: false, error: 'accountId + instance required' });
    }
    const r = await grantCard(cols, now, accountId, instance);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('card granted', { accountId, instanceId: instance.id, orderId });
    return reply.send({ ok: true });
  });

  // POST /internal/equipment/grant  { accountId, instance, orderId } → { ok }
  //   Sale transfer (to buyer) / cancellation·expiry·season-end return (to seller): writes the instance snapshot into inventory (upsert by id makes it idempotent).
  app.post('/internal/equipment/grant', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instance, orderId } = req.body as {
      accountId?: string;
      instance?: EquipmentInstance;
      orderId?: string;
    };
    if (!accountId || !instance?.id) {
      return reply.code(400).send({ ok: false, error: 'accountId + instance required' });
    }
    const r = await grantEquipment(cols, now, accountId, instance);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('equipment granted', { accountId, instanceId: instance.id, orderId });
    return reply.send({ ok: true });
  });

  // ── Skin escrow / grant (auction task2, called by worldsvc/auctionsvc auction skin transactions) ─────────
  // POST /internal/skins/escrow  { accountId, skinId, orderId } → { skinId }
  //   Listing escrow: verify owned + not equipped → remove from inventory.skins → orderId idempotent.
  app.post('/internal/skins/escrow', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, skinId, orderId } = req.body as {
      accountId?: string;
      skinId?: string;
      orderId?: string;
    };
    if (!accountId || !skinId || !orderId) {
      return reply.code(400).send({ ok: false, error: 'accountId + skinId + orderId required' });
    }
    const r = await escrowSkin(cols, now, accountId, skinId, orderId);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('skin escrowed', { accountId, skinId, orderId });
    return reply.send({ ok: true, skinId: r.skinId });
  });

  // POST /internal/skins/grant  { accountId, skinId, orderId } → { ok }
  //   Sale transfer (to buyer) / cancellation·expiry return (to seller): adds skinId back into inventory.skins ($addToSet-equivalent, idempotent).
  app.post('/internal/skins/grant', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, skinId, orderId } = req.body as {
      accountId?: string;
      skinId?: string;
      orderId?: string;
    };
    if (!accountId || !skinId) {
      return reply.code(400).send({ ok: false, error: 'accountId + skinId required' });
    }
    const r = await grantSkin(cols, now, accountId, skinId);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('skin granted', { accountId, skinId, orderId });
    return reply.send({ ok: true });
  });

  // ── Progression snapshot (E8, called by worldsvc siege engine authoritative computation) ────────────────────────────────
  // GET /internal/save-fields?accountId=  → { pveUpgrades, unitLevels, gear, equipmentInv }
  //   Returns the attacker's progression-related fields for worldsvc to pass into buildSiegeBlueprints for authoritative blueprint computation.
  //   If the account does not exist, treats it as a new account (returns empty defaults); does not return 404 to avoid freezing a march.
  app.get('/internal/save-fields', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const accountId = (req.query as Record<string, string>).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const doc = await cols.saves.findOne({ _id: accountId });
    const s = doc?.save;
    return reply.send({
      pveUpgrades: s?.pveUpgrades ?? {},
      cardInv: s?.cardInv ?? {},
      equipmentInv: s?.equipmentInv ?? {},
    });
  });
}
