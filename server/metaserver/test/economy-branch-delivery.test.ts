// Branch-coverage backfill for src/economy/delivery.ts + src/economy/duplicates.ts (2026-09-03).
// The happy paths are already exercised by economy.e2e.test.ts, but that file imports '../dist/app.js',
// which vitest's v8 provider cannot attribute back to src/*.ts — so every branch here reads as
// uncovered. This file imports the primitives straight from '../src/economy/*.js' and drives the
// branches an HTTP-level test structurally cannot reach: the `{$ne: orderId}` idempotency guard losing
// its match (a replayed delivery), a lost `findOneAndUpdate` CAS on the wallet mirror, and the
// absent-field fallbacks the handlers rely on when a save document is missing or partially populated.
//
// Real Mongo (rs0, DB nw_meta_grpC_branch_test): deliverGrant/deliverMailGrant depend on
// `$addToSet`+`$each`, `$push`+`$each`/`$slice` and a `{$ne: ...}` filter — none of which
// test/helpers/fakeCollection.ts implements, so a fake would prove nothing about the guard being
// tested here.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createMongo, makeNewSave, type MongoHandle, type Collections, type SaveData, type SkinInstance,
  type EquipmentInstance, EQUIPMENT_DEFS, CARD_DEFS,
} from '@nw/shared';
import { deliverGrant, deliverMailGrant, mirrorCoins, mirrorWalletFrom } from '../src/economy/delivery.js';
import { markDuplicates, unionOwnershipForDuplicateCheck } from '../src/economy/duplicates.js';
import type { WalletView, GachaResultEntry } from '../src/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_grpC_branch_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[economy-branch-delivery] Mongo unreachable (${URI}) — skipping.`);

const NOW = 1_800_000_000_000;

function wallet(over: Partial<WalletView> = {}): WalletView {
  return {
    coins: 100,
    pity: { standard: 3 },
    fatePoints: 0,
    subscriptionExpiry: 0,
    starterUsed: [],
    firstPurchaseUsed: false,
    totalRechargeCents: 0,
    ...over,
  } as WalletView;
}

describe.skipIf(!mongo)('economy/delivery.ts + duplicates.ts branch backfill', () => {
  const m = mongo!;
  let accountId: string;

  const saveOf = async (id = accountId): Promise<SaveData> =>
    (await m.collections.saves.findOne({ _id: id }))!.save;

  async function seedSave(id: string, patch: Partial<SaveData> = {}): Promise<void> {
    const save = { ...makeNewSave(id, NOW), ...patch };
    await m.collections.saves.updateOne(
      { _id: id },
      { $setOnInsert: { _id: id, save, rev: save.rev } },
      { upsert: true },
    );
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    accountId = `acc-${randomUUID()}`;
    await seedSave(accountId);
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  // ── deliverGrant ───────────────────────────────────────────────────────────────────────────────
  describe('deliverGrant', () => {
    it('no materials/equipment/pity: skips every optional $addToSet ledger and the provenance write', async () => {
      // The all-absent side of lines 80/83/98/114 — a plain skin-only shop delivery.
      const save = await deliverGrant(m.collections, accountId, 'ord-plain', ['skin_l1'], 250, null, NOW);
      expect(save.inventory.skins).toContain('skin_l1');
      expect(save.wallet.coins).toBe(250);
      expect(save.everOwned?.material ?? []).toEqual([]);
      expect(save.equipMailOverflowCount).toBeUndefined();
      // No material was granted -> no MaterialInstance provenance rows at all.
      expect(await m.collections.materialInstances.countDocuments({ accountId })).toBe(0);
    });

    it('a zero-quantity material entry is dropped: no $inc, no everOwned ledger entry, no provenance row', async () => {
      // `if (qty > 0)` guard — a caller-computed materialInc can legitimately carry a 0 (e.g. a
      // grant table entry that rounded to nothing); crediting it would create a phantom
      // everOwned.material entry that permanently unlocks an avatar the player never earned.
      const save = await deliverGrant(
        m.collections, accountId, 'ord-zero-mat', [], 10, null, NOW,
        { scrap: 0 }, undefined, undefined, undefined,
      );
      expect(save.materials?.scrap ?? 0).toBe(0);
      expect(save.everOwned?.material ?? []).not.toContain('scrap');
      expect(await m.collections.materialInstances.countDocuments({ accountId })).toBe(0);
    });

    it('positive materials + equipment + pity: everOwned ledgers grow and provenance is recorded', async () => {
      const inst = {
        id: 'eq-1', defId: 'wp_pencil', slot: 'weapon', rarity: 'common',
        level: 0, mainStat: {}, subStats: [], sourceType: 'gacha:ord-mixed', obtainedAt: NOW,
      } as unknown as EquipmentInstance;
      const save = await deliverGrant(
        m.collections, accountId, 'ord-mixed', ['skin_l1'], 999, { standard: 7 }, NOW,
        { scrap: 10 }, { 'eq-1': inst }, 0, [{ id: 'sk-1', skinId: 'skin_l1', sourceType: 'gacha:ord-mixed', obtainedAt: NOW }],
      );
      expect(save.materials.scrap).toBe(10);
      expect(save.everOwned?.material).toContain('scrap');
      expect(save.everOwned?.equipment).toContain('wp_pencil');
      expect(save.everOwned?.skin).toContain('skin_l1');
      expect(save.gacha.pity.standard).toBe(7);
      expect(save.equipMailOverflowCount).toBe(0);
      expect(await m.collections.equipmentInstances.countDocuments({ accountId })).toBe(1);
      expect(await m.collections.skinInstances.countDocuments({ accountId })).toBe(1);
      expect(await m.collections.materialInstances.countDocuments({ accountId })).toBe(1);
    });

    it('replay of an already-delivered orderId re-grants nothing (the {$ne: orderId} guard loses its match)', async () => {
      // This is the branch that decides whether a reconciliation retry double-credits a player.
      await deliverGrant(m.collections, accountId, 'ord-dup', ['skin_l1'], 100, null, NOW, { scrap: 10 });
      const replay = await deliverGrant(m.collections, accountId, 'ord-dup', ['skin_l1'], 100, null, NOW, { scrap: 10 });
      expect(replay.materials.scrap).toBe(10); // NOT 20
      expect(replay.inventory.skins.filter((s) => s === 'skin_l1')).toHaveLength(1);
      // The second call must not write a second provenance row either.
      expect(await m.collections.materialInstances.countDocuments({ accountId })).toBe(1);
    });

    it('save vanishes between the guarded update and the fallback read -> throws instead of returning a bogus save', async () => {
      const real = m.collections.saves;
      const cols: Collections = {
        ...m.collections,
        saves: {
          ...real,
          findOne: async () => null,
          findOneAndUpdate: async () => null,
          updateOne: real.updateOne.bind(real),
        } as unknown as typeof real,
      };
      await expect(deliverGrant(cols, accountId, 'ord-gone', [], 0, null, NOW)).rejects.toThrow('save missing after grant');
    });
  });

  // ── deliverMailGrant ───────────────────────────────────────────────────────────────────────────
  describe('deliverMailGrant', () => {
    it('null coinsAfter leaves the wallet mirror untouched; zero-qty items/materials are dropped', async () => {
      await deliverGrant(m.collections, accountId, 'ord-seed-coins', [], 777, null, NOW);
      const save = await deliverMailGrant(
        m.collections, accountId, 'mail-1', ['skin_e1'], { protect_enhance: 0 }, null, NOW,
        { scrap: 0 }, [{ id: 'sk-mail-1', skinId: 'skin_e1', sourceType: 'mail', obtainedAt: NOW }],
      );
      expect(save.wallet.coins).toBe(777); // coinsAfter === null -> no mirror write
      expect(save.inventory.items?.protect_enhance ?? 0).toBe(0);
      expect(save.materials?.scrap ?? 0).toBe(0);
      expect(save.everOwned?.material ?? []).toEqual([]);
      expect(await m.collections.skinInstances.countDocuments({ accountId })).toBe(1);
    });

    it('replay of a claimed mail orderId does not re-grant items (the ledger stays at one claim)', async () => {
      await deliverMailGrant(m.collections, accountId, 'mail-dup', [], { protect_enhance: 2 }, 50, NOW, { lead: 3 });
      const replay = await deliverMailGrant(m.collections, accountId, 'mail-dup', [], { protect_enhance: 2 }, 50, NOW, { lead: 3 });
      expect(replay.inventory.items?.protect_enhance).toBe(2); // NOT 4
      expect(replay.materials.lead).toBe(3);
    });

    it('save vanishes between the guarded update and the fallback read -> throws', async () => {
      const real = m.collections.saves;
      const cols: Collections = {
        ...m.collections,
        saves: {
          ...real,
          findOne: async () => null,
          findOneAndUpdate: async () => null,
          updateOne: real.updateOne.bind(real),
        } as unknown as typeof real,
      };
      await expect(deliverMailGrant(cols, accountId, 'mail-gone', [], {}, null, NOW))
        .rejects.toThrow('save missing after mail grant');
    });
  });

  // ── mirrorCoins ────────────────────────────────────────────────────────────────────────────────
  describe('mirrorCoins', () => {
    it('writes the balance back and bumps rev, leaving items untouched (top-up / ad reward)', async () => {
      await deliverGrant(m.collections, accountId, 'ord-before-mirror', ['skin_l1'], 0, null, NOW);
      const save = await mirrorCoins(m.collections, accountId, 1234, NOW + 5);
      expect(save.wallet.coins).toBe(1234);
      expect(save.inventory.skins).toContain('skin_l1');
      expect(save.updatedAt).toBe(NOW + 5);
    });

    it('lost CAS but the save still exists -> returns the current save rather than throwing', async () => {
      const real = m.collections.saves;
      const cols: Collections = {
        ...m.collections,
        saves: { ...real, findOne: real.findOne.bind(real), findOneAndUpdate: async () => null } as unknown as typeof real,
      };
      const save = await mirrorCoins(cols, accountId, 4242, NOW);
      expect(save.accountId).toBe(accountId);
      expect(save.wallet.coins).toBe(0); // the mirror write was lost; the caller still gets a real save
    });

    it('no save document at all -> throws (an ad reward can never be mirrored onto a missing account)', async () => {
      await expect(mirrorCoins(m.collections, `ghost-${randomUUID()}`, 10, NOW))
        .rejects.toThrow('save missing after mirror');
    });
  });

  // ── mirrorWalletFrom ───────────────────────────────────────────────────────────────────────────
  describe('mirrorWalletFrom', () => {
    it('mirror already current -> skips the write entirely (rev unchanged, so no spurious 409 for an in-flight PUT)', async () => {
      // Every field of `monetization` must be present in the stored mirror for the equality check to
      // hold, `subscriptionLastClaimDay` included — see the next test for what happens when it isn't.
      const w = wallet({ subscriptionExpiry: NOW + 86400000, subscriptionLastClaimDay: '2027-01-01' });
      const first = await mirrorWalletFrom(m.collections, accountId, w, NOW);
      const revAfterFirst = first.rev;
      const second = await mirrorWalletFrom(m.collections, accountId, w, NOW + 1000);
      expect(second.rev).toBe(revAfterFirst);
    });

    it('KNOWN GAP: an unsubscribed wallet (subscriptionLastClaimDay undefined) re-writes the mirror every time', async () => {
      // Mongo drops undefined-valued fields on write, so the stored monetization sub-document is missing
      // the `subscriptionLastClaimDay` key that stableStringify of the freshly-built object emits — the
      // two never compare equal and the 2026-07-27 "skip the write when the mirror is already current"
      // optimization never engages for any account without a subscription claim. Asserted here as the
      // current behavior (rev keeps climbing on every GET /save), not as the desired one.
      const w = wallet();
      const first = await mirrorWalletFrom(m.collections, accountId, w, NOW);
      const second = await mirrorWalletFrom(m.collections, accountId, w, NOW + 1000);
      expect(second.rev).toBe(first.rev + 1);
    });

    it('growth pack still unused + account within the window -> mirrors starterGrowthEligible true', async () => {
      await m.collections.accounts.updateOne(
        { _id: accountId },
        { $setOnInsert: { _id: accountId, createdAt: NOW } },
        { upsert: true },
      );
      const save = await mirrorWalletFrom(m.collections, accountId, wallet(), NOW);
      expect(save.monetization?.starterGrowthEligible).toBe(true);
    });

    it('account row older than the growth-pack window -> mirrors starterGrowthEligible false', async () => {
      await m.collections.accounts.updateOne(
        { _id: accountId },
        { $setOnInsert: { _id: accountId, createdAt: NOW - 90 * 86400000 } },
        { upsert: true },
      );
      const save = await mirrorWalletFrom(m.collections, accountId, wallet(), NOW);
      expect(save.monetization?.starterGrowthEligible).toBe(false);
    });

    it('growth pack already used -> skips the account-age lookup and stays eligible-by-default', async () => {
      const save = await mirrorWalletFrom(m.collections, accountId, wallet({ starterUsed: ['starter_growth'] }), NOW);
      expect(save.monetization?.starterUsed).toEqual(['starter_growth']);
    });

    it('lost CAS on the mirror write -> falls back to the current save instead of throwing', async () => {
      const real = m.collections.saves;
      const cols: Collections = {
        ...m.collections,
        saves: {
          ...real,
          findOne: real.findOne.bind(real),
          findOneAndUpdate: async () => null,
        } as unknown as typeof real,
      };
      const save = await mirrorWalletFrom(cols, accountId, wallet({ coins: 555 }), NOW);
      expect(save.accountId).toBe(accountId);
      expect(save.wallet.coins).toBe(0);
    });

    it('no save document at all -> throws', async () => {
      await expect(mirrorWalletFrom(m.collections, `ghost-${randomUUID()}`, wallet(), NOW))
        .rejects.toThrow('save missing after wallet mirror');
    });
  });

  // ── duplicates.ts (pure) ───────────────────────────────────────────────────────────────────────
  describe('markDuplicates', () => {
    const cardId = Object.keys(CARD_DEFS)[0]!;
    const equipId = Object.keys(EQUIPMENT_DEFS)[0]!;
    const r = (itemId: string): GachaResultEntry => ({ itemId, rarity: 'common' } as GachaResultEntry);

    it('character cards are badged against lifetime hero ownership, not the skin array', async () => {
      const out = markDuplicates([], [], [cardId], [], [], [r(cardId), r(cardId)]);
      expect(out.marked.map((x) => x.duplicate)).toEqual([true, true]);
      expect(out.newSkins).toEqual([]); // a card must never leak into inventory.skins
    });

    it('a first-ever card is NEW, and a second copy in the same batch is already a duplicate', async () => {
      const out = markDuplicates([], [], [], [], [], [r(cardId), r(cardId)]);
      expect(out.marked.map((x) => x.duplicate)).toEqual([false, true]);
    });

    it('materials are badged by their granted material key (mat_scrap -> scrap), not by the itemId', async () => {
      // The bug this branch exists for: a player holding 400 scrap still saw a NEW badge on every
      // mat_scrap pull, because the material branch used to fall through to the skin branch.
      const owned = markDuplicates([], [], [], [], ['scrap'], [r('mat_scrap')]);
      expect(owned.marked[0]!.duplicate).toBe(true);
      const fresh = markDuplicates([], [], [], [], [], [r('mat_scrap'), r('mat_scrap')]);
      expect(fresh.marked.map((x) => x.duplicate)).toEqual([false, true]);
    });

    it('equipment is badged against lifetime equipment ownership; a first copy is NEW, a second is not', async () => {
      expect(markDuplicates([], [], [], [equipId], [], [r(equipId)]).marked[0]!.duplicate).toBe(true);
      const fresh = markDuplicates([], [], [], [], [], [r(equipId), r(equipId)]);
      expect(fresh.marked.map((x) => x.duplicate)).toEqual([false, true]);
    });

    it('a skin sold out of inventory but present in everOwned: re-added to newSkins, badged as a duplicate', async () => {
      const out = markDuplicates([], ['skin_l1'], [], [], [], [r('skin_l1')]);
      expect(out.newSkins).toEqual(['skin_l1']); // must go back into inventory.skins
      expect(out.marked[0]!.duplicate).toBe(true); // but it is not a NEW pull
    });
  });

  describe('unionOwnershipForDuplicateCheck', () => {
    it('a legacy save with no everOwned ledger and no materials falls back to empty sets', async () => {
      const save = makeNewSave('legacy', NOW);
      delete (save as { everOwned?: unknown }).everOwned;
      delete (save as { materials?: unknown }).materials;
      const out = unionOwnershipForDuplicateCheck(['lichuang'], ['wp_pencil'], save);
      expect(out.ownedHero).toEqual(['lichuang']);
      expect(out.ownedEquipment).toEqual(['wp_pencil']);
      expect(out.ownedMaterial).toEqual([]);
    });

    it('a material spent down to 0 counts only via everOwned, never via the live balance', async () => {
      const save: SaveData = {
        ...makeNewSave('u2', NOW),
        materials: { scrap: 0, lead: 4 },
        everOwned: { hero: ['maomao'], equipment: [], material: ['binding'], skin: [] },
      } as SaveData;
      const out = unionOwnershipForDuplicateCheck([], [], save);
      expect(out.ownedMaterial.sort()).toEqual(['binding', 'lead']); // scrap:0 is not owned
      expect(out.ownedHero).toEqual(['maomao']);
    });
  });
});
