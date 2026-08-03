// Material/equipment/card/skin escrow-transfer + progression snapshot — called by worldsvc (auction + siege engine).
import type { FastifyInstance } from 'fastify';
import type { Collections, SaveData, EquipmentInstance, CardInstance, InternalGrantOrderDoc } from '@nw/shared';
import { createLogger, ERROR_HTTP_STATUS } from '@nw/shared';
import { escrowEquipment, grantEquipment, assembleEquipmentInv } from '../equipment.js';
import { escrowCard, grantCard, assembleCardInv, assembleCardInvSubset } from '../cards.js';
import { escrowSkin, grantSkin } from '../skin.js';
import type { InternalCtx } from './context.js';

const log = createLogger('meta:internal');

/** Retention window for grant-orderId dedup records (long enough for any realistic caller retry). */
const GRANT_ORDER_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Reserve an orderId in the internalGrantOrders dedup ledger (comm-audit-internal-2026-07-28 batch D:
 * callers retry granting after a timeout — without dedup a retry double-grants).
 * Returns 'reserved' when this call owns the orderId (proceed with the grant), 'duplicate' when a prior
 * call already processed (or is processing) it — the endpoint should short-circuit with {ok, deduped}.
 */
async function reserveGrantOrder(
  cols: Collections,
  orderId: string,
  accountId: string,
  kind: InternalGrantOrderDoc['kind'],
  now: number,
): Promise<'reserved' | 'duplicate'> {
  try {
    await cols.internalGrantOrders.insertOne({
      _id: orderId,
      accountId,
      kind,
      ts: now,
      expireAt: new Date(now + GRANT_ORDER_TTL_MS),
    });
    return 'reserved';
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return 'duplicate';
    throw e;
  }
}

/** Drop a grant-orderId reservation after the grant itself failed, so a retry can go through (best-effort). */
async function releaseGrantOrder(cols: Collections, orderId: string): Promise<void> {
  await cols.internalGrantOrders.deleteOne({ _id: orderId }).catch((e) =>
    log.error('releaseGrantOrder failed (a retry of this orderId will be treated as a duplicate)', {
      orderId,
      err: (e as Error).message,
    }),
  );
}

export function registerEconomyRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed, now } = ctx;

  // ── Material deduction / grant (S8-5, called by worldsvc auction) ─────────────────────────────────
  // Bypasses openapi glue, authenticated via X-Internal-Key.
  // POST /internal/materials/deduct  { accountId, material, qty, orderId }
  //   → deduct the specified material; insufficient balance → 402; optimistic-lock conflict retried 3 times, then 409.
  //   orderId (optional, back-compat) dedups via internalGrantOrders — mirrors /internal/materials/grant
  //   below (2026-08-03 fix: orderId was documented but previously unused here, so a caller retry after a
  //   timeout could deduct the same material twice for one logical transaction).
  app.post('/internal/materials/deduct', async (req, reply) => {
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, material, qty, orderId } = req.body as {
      accountId?: string;
      material?: string;
      qty?: number;
      orderId?: string;
    };
    if (!accountId || !material || typeof qty !== 'number' || qty <= 0) {
      return reply.code(400).send({ ok: false, error: 'accountId + material + qty (>0) required' });
    }
    if (orderId) {
      const r = await reserveGrantOrder(cols, orderId, accountId, 'material_deduct', now());
      if (r === 'duplicate') {
        log.info('materials deduct deduped', { accountId, material, qty, orderId });
        return reply.send({ ok: true, deduped: true });
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) {
        if (orderId) await releaseGrantOrder(cols, orderId);
        return reply.code(404).send({ ok: false, error: 'save not found' });
      }
      const cur = doc.save.materials?.[material] ?? 0;
      if (cur < qty) {
        if (orderId) await releaseGrantOrder(cols, orderId);
        return reply.code(402).send({ ok: false, error: 'insufficient materials' });
      }
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
    if (orderId) await releaseGrantOrder(cols, orderId);
    return reply.code(409).send({ ok: false, error: 'rev conflict, retry' });
  });

  // POST /internal/materials/grant  { accountId, material, qty, orderId }
  //   → grant the specified material; orderId (optional, back-compat) dedups via internalGrantOrders
  //     so a caller retry after a timeout never double-grants.
  app.post('/internal/materials/grant', async (req, reply) => {
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, material, qty, orderId } = req.body as {
      accountId?: string;
      material?: string;
      qty?: number;
      orderId?: string;
    };
    if (!accountId || !material || typeof qty !== 'number' || qty <= 0) {
      return reply.code(400).send({ ok: false, error: 'accountId + material + qty (>0) required' });
    }
    if (orderId) {
      const r = await reserveGrantOrder(cols, orderId, accountId, 'material', now());
      if (r === 'duplicate') {
        log.info('materials grant deduped', { accountId, material, qty, orderId });
        return reply.send({ ok: true, deduped: true });
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) {
        if (orderId) await releaseGrantOrder(cols, orderId);
        return reply.code(404).send({ ok: false, error: 'save not found' });
      }
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
    if (orderId) await releaseGrantOrder(cols, orderId);
    return reply.code(409).send({ ok: false, error: 'rev conflict, retry' });
  });

  // ── Equipment escrow / transfer (E2, called by worldsvc auction equipment transactions) ─────────────────────────────
  // POST /internal/equipment/escrow  { accountId, instanceId, orderId } → { instance }
  //   Listing escrow: verify not equipped/locked → remove from seller's inventory → return snapshot (worldsvc stores it in the listing doc). orderId is idempotent.
  app.post('/internal/equipment/escrow', async (req, reply) => {
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
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
  //   Listing escrow: validate gear all empty (§11 rule) → remove from cardInstances → return snapshot (worldsvc stores in listing doc).
  app.post('/internal/cards/escrow', async (req, reply) => {
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instanceId, orderId } = req.body as {
      accountId?: string;
      instanceId?: string;
      orderId?: string;
    };
    if (!accountId || !instanceId || !orderId) {
      return reply.code(400).send({ ok: false, error: 'accountId + instanceId + orderId required' });
    }
    const r = await escrowCard(cols, now, accountId, instanceId, orderId);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('card escrowed', { accountId, instanceId, orderId });
    return reply.send({ ok: true, instance: r.instance });
  });

  // POST /internal/cards/grant  { accountId, instance, orderId } → { ok }
  //   Sale transfer (to buyer) / cancellation·expiry·season-end return (to seller): writes the instance snapshot into cardInstances.
  //   No cap check — a card returned from escrow or sold to a buyer is always delivered (the buyer paid coins for it).
  app.post('/internal/cards/grant', async (req, reply) => {
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instance, orderId } = req.body as {
      accountId?: string;
      instance?: CardInstance;
      orderId?: string;
    };
    if (!accountId || !instance?.id) {
      return reply.code(400).send({ ok: false, error: 'accountId + instance required' });
    }
    if (orderId) {
      const dr = await reserveGrantOrder(cols, orderId, accountId, 'card', now());
      if (dr === 'duplicate') {
        log.info('card grant deduped', { accountId, instanceId: instance.id, orderId });
        return reply.send({ ok: true, deduped: true });
      }
    }
    const r = await grantCard(cols, now, accountId, instance);
    if ('error' in r) {
      if (orderId) await releaseGrantOrder(cols, orderId);
      return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    }
    log.info('card granted', { accountId, instanceId: instance.id, orderId });
    return reply.send({ ok: true });
  });

  // POST /internal/equipment/grant  { accountId, instance, orderId } → { ok }
  //   Sale transfer (to buyer) / cancellation·expiry·season-end return (to seller): writes the instance snapshot into inventory (upsert by id makes it idempotent).
  app.post('/internal/equipment/grant', async (req, reply) => {
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instance, orderId } = req.body as {
      accountId?: string;
      instance?: EquipmentInstance;
      orderId?: string;
    };
    if (!accountId || !instance?.id) {
      return reply.code(400).send({ ok: false, error: 'accountId + instance required' });
    }
    if (orderId) {
      const dr = await reserveGrantOrder(cols, orderId, accountId, 'equipment', now());
      if (dr === 'duplicate') {
        log.info('equipment grant deduped', { accountId, instanceId: instance.id, orderId });
        return reply.send({ ok: true, deduped: true });
      }
    }
    const r = await grantEquipment(cols, now, accountId, instance);
    if ('error' in r) {
      if (orderId) await releaseGrantOrder(cols, orderId);
      return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    }
    log.info('equipment granted', { accountId, instanceId: instance.id, orderId });
    return reply.send({ ok: true });
  });

  // ── Skin escrow / grant (auction task2, called by worldsvc/auctionsvc auction skin transactions) ─────────
  // POST /internal/skins/escrow  { accountId, skinId, orderId } → { skinId }
  //   Listing escrow: verify owned + not equipped → remove from inventory.skins → orderId idempotent.
  app.post('/internal/skins/escrow', async (req, reply) => {
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
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
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, skinId, orderId } = req.body as {
      accountId?: string;
      skinId?: string;
      orderId?: string;
    };
    if (!accountId || !skinId) {
      return reply.code(400).send({ ok: false, error: 'accountId + skinId required' });
    }
    if (orderId) {
      const dr = await reserveGrantOrder(cols, orderId, accountId, 'skin', now());
      if (dr === 'duplicate') {
        log.info('skin grant deduped', { accountId, skinId, orderId });
        return reply.send({ ok: true, deduped: true });
      }
    }
    const r = await grantSkin(cols, now, accountId, skinId);
    if ('error' in r) {
      if (orderId) await releaseGrantOrder(cols, orderId);
      return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    }
    log.info('skin granted', { accountId, skinId, orderId });
    return reply.send({ ok: true });
  });

  // ── Progression snapshot (E8, called by worldsvc siege engine authoritative computation) ────────────────────────────────
  // GET /internal/save-fields?accountId=&fields=cardInv,equipmentInv  → { cardInv?, equipmentInv? }
  //   Returns the attacker/defender's progression-related fields for worldsvc to pass into buildSiegeBlueprints
  //   for authoritative blueprint computation. `fields` (comm-audit batch F item 6) narrows the projection to
  //   only what the caller needs — omit for both (default). `pveUpgrades` was dropped from the wire (2026-07-28):
  //   the siege engine never read it (siegeEngine.ts runSiegeBattle deprecated/unused param).
  //   `cardIds=a,b,c` (2026-08-02) narrows the cardInv projection further, to just those instance ids: a
  //   caller that only needs to check whether specific cards are still owned (worldsvc's getTeams
  //   self-heal, on the CityScene critical path) shouldn't pay to reassemble a 500-card roster.
  //   Ignored unless cardInv is actually requested; omit it to get the full roster as before.
  //   If the account does not exist, treats it as a new account (returns empty defaults); does not return 404 to avoid freezing a march.
  app.get('/internal/save-fields', async (req, reply) => {
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, fields: fieldsParam, cardIds: cardIdsParam } = req.query as Record<string, string>;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const want = fieldsParam ? new Set(fieldsParam.split(',')) : null; // null = both (default)
    const wantCard = !want || want.has('cardInv');
    const wantEquip = !want || want.has('equipmentInv');
    const cardIds = cardIdsParam ? cardIdsParam.split(',').filter(Boolean) : null; // null = full roster
    const doc = await cols.saves.findOne({ _id: accountId });
    const s = doc?.save;
    // Equipment/card instances live in their own collections (2026-07-26/2026-07-27 splits, see
    // equipment.ts/cards.ts) — join them in here for wire-format compatibility (worldsvc's siege engine
    // expects the full maps, unchanged). Null-safe for an unknown account (no doc → still returns {}
    // rather than erroring, same as before).
    const [cardInv, equipmentInv] = await Promise.all([
      wantCard ? (s ? (cardIds ? assembleCardInvSubset(cols, accountId, cardIds) : assembleCardInv(cols, accountId, s)) : {}) : undefined,
      wantEquip ? (s ? assembleEquipmentInv(cols, accountId, s) : {}) : undefined,
    ]);
    return reply.send({
      ...(wantCard ? { cardInv } : {}),
      ...(wantEquip ? { equipmentInv } : {}),
    });
  });
}
