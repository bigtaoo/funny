// Gacha pools + draw + Fate Point redemption (GACHA_DESIGN §2/§7). Split out of service/economy.ts
// (2026-08-10, 独立函数模块 form — see economy.ts's facade comment). `gachaDrawHandler`/
// `redeemFateHandler` take `core: MetaCore` directly (2026-08-11 ctx-bind cleanup — see base.ts's
// header, for `core.ensureCommercial`/`core.bumpRetentionTask`); `getGachaPoolsHandler` only ever
// touches `deps` so it takes that directly. No behavior change.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ErrorCode, err, ok, GACHA_POOLS, poolEntries, gachaCost, buildLimitedPool, customPoolEntries,
  customPoolCostTen, accrueRetentionTask, createLogger, type GachaPoolDef,
} from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import type { GachaPoolView } from '../../commercialClient.js';
import { markDuplicates, unionOwnershipForDuplicateCheck, deliverLootBox, deliverOrder } from '../../economy.js';
import { nullMetaSocialsvcClient } from '../../socialsvcClient.js';
import { accountIdOf, clientPlatformOf, type ServiceDeps, type MetaCore } from '../base.js';

const log = createLogger('meta:economy');

/** Client-facing gacha pool view (GACHA_DESIGN §2 + §8): static + active limited pools with per-entry odds.
 * Exported (2026-08-11 mixin-chain split) so EconomyService.getGachaPools's inferred return type can be
 * named in the .d.ts — under the old mixin form, EconomyMixin's explicit `Constructor<EconomyHandlers>`
 * return-type annotation erased this internal detail from declaration emit; a plain class method has no
 * such annotation, so tsc must be able to name every type it infers. */
export interface PoolView {
  id: string;
  costSingle: number;
  costTen: number;
  pityThreshold: number;
  dupePolicy: string;
  limited?: boolean;
  name?: string;
  featuredLegendary?: string;
  endAt?: number;
  entries: { itemId: string; weight: number; rarity: string; probability: number }[];
}

/** Gacha pool list (entries expanded for client display). Includes active limited pools (GACHA_DESIGN §2.2) with banner metadata. */
export async function getGachaPoolsHandler(deps: ServiceDeps) {
  const { commercial, now } = deps;
  const toView = (p: GachaPoolDef, name?: string): PoolView => {
    const entries = poolEntries(p);
    const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
    return {
      id: p.id,
      costSingle: p.costSingle,
      costTen: p.costTen,
      pityThreshold: p.pityThreshold,
      dupePolicy: p.dupePolicy,
      // Limited pool banner metadata (absent on static pools).
      ...(p.limited
        ? { limited: true, name, featuredLegendary: p.featuredLegendary, endAt: p.endAt }
        : {}),
      // C5-a: each entry includes a probability field (required by Apple 3.1.1).
      entries: entries.map((e) => ({
        ...e,
        probability: totalWeight > 0 ? e.weight / totalWeight : 0,
      })),
    };
  };
  // Build a client view for an ops-authored custom pool (§12): its own cost/entries, no pity/featured.
  const customToView = (cfg: Extract<GachaPoolView, { kind: 'custom' }>): PoolView => {
    const entries = customPoolEntries(cfg);
    const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
    return {
      id: cfg.id,
      costSingle: cfg.costSingle,
      costTen: customPoolCostTen(cfg),
      pityThreshold: 0, // custom pools have no pity
      dupePolicy: 'coins',
      limited: true,
      name: cfg.name,
      endAt: cfg.endAt,
      entries: entries.map((e) => ({ ...e, probability: totalWeight > 0 ? e.weight / totalWeight : 0 })),
    };
  };
  const pools: PoolView[] = GACHA_POOLS.map((p) => toView(p));
  // Append active limited pools (best-effort; if commercial is down the client still gets the static pools).
  if (commercial.available) {
    try {
      const active = await commercial.listActiveLimitedPools(now());
      for (const cfg of active) {
        if (cfg.kind === 'custom') pools.push(customToView(cfg));
        else pools.push(toView(buildLimitedPool(cfg), cfg.name));
      }
    } catch {
      /* best-effort: static pools already returned */
    }
  }
  return ok({ pools });
}

export async function gachaDrawHandler(core: MetaCore, req: FastifyRequest, reply: FastifyReply) {
  if (!core.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { poolId, count } = req.body as { poolId: string; count: number };
  // Static pools validate here; limited pools exist only in commercial (validated there → POOL_UNAVAILABLE).
  if (count !== 1 && count !== 10) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid count'));
  }
  void gachaCost; // cost is authoritative in commercial (computed per pool); here we only validate the draw count.

  const { cols, commercial, now } = core.deps;
  const orderId = randomUUID();
  // getOrCreateSave doesn't depend on the draw result — kick it off alongside the commercial HTTP round-trip
  // instead of waiting for the response first (was serialized, adding a full Mongo round-trip to the critical path).
  const savePromise = getOrCreateSave(cols, accountId, now());
  const draw = await commercial.gachaDraw({ accountId, poolId, count, orderId, clientPlatform: clientPlatformOf(req) });
  if (!draw.ok) {
    if (draw.error === 'INSUFFICIENT_FUNDS') {
      return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
    }
    if (draw.error === 'POOL_UNAVAILABLE') {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'pool unavailable'));
    }
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, draw.error));
  }
  // Route each result: mat_* → materials, equipment defId → equipment instance, character card
  // defId → hero card grant (cardInstances via grantHeroCards), everything else → skin (idempotent
  // inventory.skins add; duplicate-to-coin conversion deferred to S5, see economy.ts comment).
  // `marked` (new/duplicate badges for the reveal UI) is computed on the full raw result list —
  // every kind checked against real lifetime ownership (live inventory ∪ everOwned ledger; see
  // markDuplicates/unionOwnershipForDuplicateCheck doc comments), not just cards. Projected
  // defId-only queries (cards moved to their own collection 2026-07-27, equipment 2026-07-26) run
  // alongside savePromise instead of after it.
  const [cur, cardDocs, equipDocs] = await Promise.all([
    savePromise,
    cols.cardInstances.find({ accountId }, { projection: { defId: 1 } }).toArray(),
    cols.equipmentInstances.find({ accountId }, { projection: { defId: 1 } }).toArray(),
  ]);
  const { ownedHero, ownedEquipment, ownedMaterial } = unionOwnershipForDuplicateCheck(
    cardDocs.map((d) => d.defId), equipDocs.map((d) => d.defId), cur,
  );
  const { marked } = markDuplicates(
    cur.inventory.skins, cur.everOwned?.skin ?? [], ownedHero, ownedEquipment, ownedMaterial, draw.results,
  );
  const { save, overflow, cardGrants, equipmentGrants } = await deliverLootBox(
    cols,
    commercial,
    core.deps.socialsvc ?? nullMetaSocialsvcClient,
    accountId,
    orderId,
    draw.results,
    draw.coinsAfter,
    { [poolId]: draw.pityAfter },
    now(),
  );
  // Bookkeeping-only (marks the order row 'delivered'); not on the critical path. If it fails, the order
  // stays 'charged' and is reconciled on the account's next GET /save via commercial.undeliveredOrders.
  void commercial.orderDelivered({ orderId }).catch((e) => {
    log.warn('gachaDraw: fire-and-forget orderDelivered failed', {
      orderId,
      accountId,
      error: (e as Error).message,
    });
  });
  // B5: record daily task "open gacha" (best-effort, does not block the response — see bumpRetentionTask).
  // The retention state merged into the response below is computed locally, independent of this write landing.
  void core.bumpRetentionTask(accountId, 'gacha.draw');
  const nextRetention2 = accrueRetentionTask(save.retention, 'gacha.draw', now());
  let saveWithRet2 = nextRetention2 !== save.retention ? { ...save, retention: nextRetention2 } : save;
  // Fate points (§7): reflect the freshly-credited balance immediately (mirror catches up fully on next GET /save).
  if (draw.fateGained > 0) {
    saveWithRet2 = {
      ...saveWithRet2,
      monetization: {
        fatePoints: draw.fatePointsAfter,
        subscriptionExpiry: saveWithRet2.monetization?.subscriptionExpiry ?? 0,
        starterUsed: saveWithRet2.monetization?.starterUsed ?? [],
        firstPurchaseUsed: saveWithRet2.monetization?.firstPurchaseUsed,
      },
    };
  }
  // Lean response (2026-07-28, same phase-2 treatment as /equipment/* — see shared/src/types.ts
  // cardInv/equipmentInv doc comments): this is the highest-frequency card/equipment-granting
  // endpoint (nothing stops a player mashing "draw" back to back), so paying for a fresh
  // cardInstances/equipmentInstances join on every single call — and shipping the whole map back
  // over the wire — is pure waste when `cardGrants`/`equipmentGrants` already say exactly what
  // changed. The client reconstructs its local copy via SaveManager.adoptServerPartial.
  return ok({
    save: { ...saveWithRet2, cardInv: null, equipmentInv: null },
    results: marked,
    overflow,
    cardGrants,
    equipmentGrants,
  });
}

/** Fate Point redemption (GACHA_DESIGN §7): 30 points → one self-chosen past-featured legendary skin. */
export async function redeemFateHandler(core: MetaCore, req: FastifyRequest, reply: FastifyReply) {
  if (!core.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { itemId } = req.body as { itemId: string };
  if (!itemId) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing itemId'));

  const { cols, commercial, now } = core.deps;
  const orderId = randomUUID();
  const r = await commercial.redeemFate({ accountId, itemId, orderId, clientPlatform: clientPlatformOf(req) });
  if (!r.ok) {
    if (r.error === 'FATE_INSUFFICIENT') {
      return reply.code(402).send(err(ErrorCode.FATE_INSUFFICIENT, 'not enough fate points'));
    }
    if (r.error === 'FATE_INVALID_ITEM') {
      return reply.code(400).send(err(ErrorCode.FATE_INVALID_ITEM, 'not a featured legendary'));
    }
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
  }
  await getOrCreateSave(cols, accountId, now());
  // Deliver the chosen skin idempotently (shared routing), then reflect the new fate balance immediately.
  let { save } = await deliverOrder(
    cols, commercial, core.deps.socialsvc ?? nullMetaSocialsvcClient, accountId,
    { _id: orderId, kind: 'fate', result: { itemId } },
    r.coinsAfter, null, now(),
  );
  save = {
    ...save,
    monetization: {
      fatePoints: r.fatePointsAfter,
      subscriptionExpiry: save.monetization?.subscriptionExpiry ?? 0,
      starterUsed: save.monetization?.starterUsed ?? [],
      firstPurchaseUsed: save.monetization?.firstPurchaseUsed,
    },
  };
  return ok({ save, granted: itemId });
}
