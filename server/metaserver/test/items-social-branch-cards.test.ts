// Branch-coverage backfill for src/cards/{grant,escrow,fuse,query}.ts (group G, 2026-09-03).
// cards-fuse-unit.test.ts / cards-lock-unit.test.ts / cards.e2e.test.ts already cover the happy paths
// and the common refusals; what is missing here is the roster-full *mail* overflow path (grantCards'
// mailCtx quota arithmetic, never exercised because no test fills a 500-card roster), the concurrent
// escrow replay, and the two "this operation cannot be retried cleanly" bail-outs.
// Imports from '../src/...' (never '../dist/...') so v8 coverage attributes lines to source.
import { describe, it, expect } from 'vitest';
import {
  CARD_DEFS,
  CARD_INV_CAP,
  CARD_INV_OVERFLOW_BUFFER,
  CARD_FULL_COMPENSATION_COINS,
  FUSION_MATERIAL_COUNT,
  type CardDef,
  type CardInstance,
  type Collections,
  type SaveData,
} from '@nw/shared';
import { grantCards } from '../src/cards/grant.js';
import { escrowCard } from '../src/cards/escrow.js';
import { fuseCards } from '../src/cards/fuse.js';
import { assembleCardInvSubset } from '../src/cards/query.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { FakeCollectionEx, seedSave, type FakeSaveDoc } from './helpers/fakeEquipCols.js';
import { FakeSocialsvc, ThrowingSocialsvc } from './helpers/fakeClients.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-grpG-cards';

type FakeCardDoc = {
  _id: string;
  accountId: string;
  defId: string;
  level: number;
  gear: Record<string, string>;
  locked: boolean;
};
type FakeCardIdemDoc = { _id: string; accountId: string; op: string; result: unknown; expireAt: Date };

interface FakeCardCols {
  cols: Collections;
  saves: FakeCollection<FakeSaveDoc>;
  cardIdem: FakeCollection<FakeCardIdemDoc>;
  cardInstances: FakeCollectionEx<FakeCardDoc>;
}

function makeCols(): FakeCardCols {
  const saves = new FakeCollection<FakeSaveDoc>();
  const cardIdem = new FakeCollection<FakeCardIdemDoc>();
  const cardInstances = new FakeCollectionEx<FakeCardDoc>();
  return { cols: { saves, cardIdem, cardInstances } as unknown as Collections, saves, cardIdem, cardInstances };
}

function seedCard(cols: FakeCardCols, card: { id: string; defId: string; level?: number; locked?: boolean }): void {
  cols.cardInstances.seed({
    _id: card.id,
    accountId: ACC,
    defId: card.defId,
    level: card.level ?? 1,
    gear: {},
    locked: card.locked ?? false,
  });
}

/** Two same-faction card defs (fusion requires matching factions). */
const TAO_DEFS = Object.values(CARD_DEFS).filter((d): d is CardDef => !!d && d.faction === 'tao');
const ONE_DEF = TAO_DEFS[0]!;

describe('grantCards — roster-full mail overflow and the absent-counter fallback', () => {
  it('empty defs list short-circuits to the current save with nothing granted', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now());
    const r = await grantCards(f.cols, now, ACC, [], 'test');
    expect(r).toMatchObject({ instances: [], mailedCount: 0, compensatedCoins: 0 });
    expect(f.cardInstances.docs.size).toBe(0);
  });

  it('no save document -> NOT_FOUND (never mints instances for an account that does not exist)', async () => {
    const f = makeCols();
    const r = await grantCards(f.cols, now, ACC, [ONE_DEF], 'test');
    expect(r).toEqual({ error: 'save not found', code: 'NOT_FOUND' });
    expect(f.cardInstances.docs.size).toBe(0);
  });

  it('full roster with mailCtx: the first CARD_INV_OVERFLOW_BUFFER cards are mailed, the rest coin-compensated', async () => {
    // Exercises the mail-quota arithmetic in one pass: a save with no `cardMailOverflowCount` yet
    // (the `?? 0` fallback — every account before this counter existed), the quota-available arm of the
    // `mailCtx && mailOverflowCount < BUFFER` test, and the quota-exhausted fall-through to coins.
    const f = makeCols();
    const socialsvc = new FakeSocialsvc();
    seedSave(f.saves, ACC, now(), (s) => {
      s.cardInvCount = CARD_INV_CAP; // roster completely full
      delete (s as Partial<SaveData>).cardMailOverflowCount;
    });
    const overflow = CARD_INV_OVERFLOW_BUFFER + 3;
    const defs = Array.from({ length: overflow }, (_, i) => TAO_DEFS[i % TAO_DEFS.length]!);
    const r = await grantCards(f.cols, now, ACC, defs, 'gacha', 1, { socialsvc, dispatchKey: 'grpG-mail' });
    const ok = r as { instances: CardInstance[]; mailedCount: number; compensatedCoins: number; save: SaveData };
    expect(ok.instances).toEqual([]); // nothing fits in the roster
    expect(ok.mailedCount).toBe(CARD_INV_OVERFLOW_BUFFER);
    expect(ok.compensatedCoins).toBe(3 * CARD_FULL_COMPENSATION_COINS);
    expect(ok.save.cardMailOverflowCount).toBe(CARD_INV_OVERFLOW_BUFFER); // quota now spent
    expect(socialsvc.mail.size).toBe(1); // one mail carrying all mailed instances
    expect(socialsvc.mail.get('grpG-mail:' + ACC)!.attachments).toHaveLength(CARD_INV_OVERFLOW_BUFFER);
    expect(f.cardInstances.docs.size).toBe(0); // mailed cards are not in the roster yet
  });

  it('roster with room + mailCtx: cards land normally and the mail quota is reset to 0', async () => {
    // The counter is only meant to cap *consecutive* overflow mails — observing free room refills it,
    // so a player who cleared space gets the full buffer again on their next full roster.
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.cardInvCount = 0; s.cardMailOverflowCount = 9; });
    const r = await grantCards(f.cols, now, ACC, [ONE_DEF], 'gacha', 1, {
      socialsvc: new FakeSocialsvc(),
      dispatchKey: 'grpG-room',
    });
    const ok = r as { instances: CardInstance[]; mailedCount: number; save: SaveData };
    expect(ok.instances).toHaveLength(1);
    expect(ok.mailedCount).toBe(0);
    expect(ok.save.cardMailOverflowCount).toBe(0); // quota refilled
    expect(f.cardInstances.docs.size).toBe(1);
  });

  it('mail delivery failing is swallowed (best-effort) — the grant itself still reports the mailed count', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.cardInvCount = CARD_INV_CAP; s.cardMailOverflowCount = 0; });
    const r = await grantCards(f.cols, now, ACC, [ONE_DEF], 'gacha', 1, {
      socialsvc: new ThrowingSocialsvc(),
      dispatchKey: 'grpG-mail-fail',
    });
    expect(r).toMatchObject({ mailedCount: 1, compensatedCoins: 0 });
  });

  it('full roster without mailCtx: pure coin compensation, and the persisted mail counter is left alone', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.cardInvCount = CARD_INV_CAP; s.cardMailOverflowCount = 7; });
    const r = await grantCards(f.cols, now, ACC, [ONE_DEF, ONE_DEF], 'pve');
    const ok = r as { mailedCount: number; compensatedCoins: number; save: SaveData };
    expect(ok.mailedCount).toBe(0);
    expect(ok.compensatedCoins).toBe(2 * CARD_FULL_COMPENSATION_COINS);
    expect(ok.save.cardMailOverflowCount).toBe(7); // carried forward untouched, not reset to 0
  });
});

describe('escrowCard — argument guard, concurrent-escrow replay, save vanishing mid-flight', () => {
  it('missing orderId (instanceId present) -> BAD_REQUEST', async () => {
    const f = makeCols();
    const r = await escrowCard(f.cols, now, ACC, 'card-1', '');
    expect(r).toEqual({ error: 'instanceId + orderId required', code: 'BAD_REQUEST' });
  });

  it('baseline: a gearless owned card escrows, is removed, and decrements the roster mirror', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.cardInvCount = 4; });
    seedCard(f, { id: 'card-ok', defId: ONE_DEF.id });
    const r = await escrowCard(f.cols, now, ACC, 'card-ok', 'order-ok');
    expect(r).toHaveProperty('instance');
    expect(f.cardInstances.docs.get('card-ok')).toBeUndefined();
    expect((await f.saves.findOne({ _id: ACC }))!.save.cardInvCount).toBe(3);
  });

  it('card already gone but an escrow ledger entry appeared in the meantime -> replays that escrow', async () => {
    // A duplicate request arriving just after the winner deleted the instance but before this call's
    // first ledger read: without the second read it would answer CARD_NOT_FOUND and the seller would
    // see their card as simply lost.
    const f = makeCols();
    seedSave(f.saves, ACC, now());
    const escrowed: CardInstance = { id: 'card-race', defId: ONE_DEF.id, level: 1, gear: {}, locked: false };
    let reads = 0;
    const real = f.cardIdem.findOne.bind(f.cardIdem);
    f.cardIdem.findOne = async (q: Record<string, unknown>) => {
      reads++;
      if (reads === 1) return null; // the winner's ledger write has not landed yet
      f.cardIdem.seed({ _id: 'order-race', accountId: ACC, op: 'escrow', result: escrowed, expireAt: new Date(now()) });
      return real(q);
    };
    const r = await escrowCard(f.cols, now, ACC, 'card-race', 'order-race');
    expect(r).toEqual({ instance: escrowed });
  });

  it('card gone and no ledger entry -> CARD_NOT_FOUND', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now());
    const r = await escrowCard(f.cols, now, ACC, 'ghost', 'order-ghost');
    expect(r).toEqual({ error: 'card not found', code: 'CARD_NOT_FOUND' });
  });

  it('save deleted between validation and the count decrement -> NOT_FOUND, but the escrow ledger already stands', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.cardInvCount = 1; });
    seedCard(f, { id: 'card-vanish', defId: ONE_DEF.id });
    let reads = 0;
    const real = f.saves.findOne.bind(f.saves);
    f.saves.findOne = async (q: Record<string, unknown>) => {
      reads++;
      return reads === 1 ? real(q) : null; // 1st = validation, 2nd = inside the decrement loop
    };
    const r = await escrowCard(f.cols, now, ACC, 'card-vanish', 'order-vanish');
    expect(r).toEqual({ error: 'save not found', code: 'NOT_FOUND' });
    expect(f.cardInstances.docs.get('card-vanish')).toBeUndefined(); // destructive step already ran
    expect(await f.cardIdem.findOne({ _id: 'order-vanish' })).not.toBeNull(); // recorded, so it is recoverable
  });
});

describe('fuseCards — duplicate-claim replay against a missing target, and the non-duplicate insert error', () => {
  /** Seeds a fusable target + FUSION_MATERIAL_COUNT same-faction materials at `level`. */
  function seedFusable(f: FakeCardCols, level = 1): { targetId: string; materialIds: string[] } {
    seedCard(f, { id: 'fuse-target', defId: ONE_DEF.id, level });
    const materialIds = Array.from({ length: FUSION_MATERIAL_COUNT }, (_, i) => `fuse-mat-${i}`);
    for (const id of materialIds) seedCard(f, { id, defId: ONE_DEF.id, level });
    return { targetId: 'fuse-target', materialIds };
  }

  it('E11000 race whose target has since left the account -> CARD_NOT_FOUND rather than a bogus card', async () => {
    // The winning request fused and the card was then traded away/escrowed; this duplicate must not
    // fabricate a result from its own pre-validation snapshot.
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.cardInvCount = FUSION_MATERIAL_COUNT + 1; });
    const { targetId, materialIds } = seedFusable(f);
    const realInsert = f.cardIdem.insertOne.bind(f.cardIdem);
    let first = true;
    f.cardIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        f.cardIdem.docs.set(doc._id, doc);
        f.cardInstances.docs.delete(targetId); // target no longer owned by this account
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsert(doc);
    };
    const r = await fuseCards(f.cols, now, ACC, targetId, materialIds, 'fuse-dup-gone');
    expect(r).toEqual({ error: 'target card not found', code: 'CARD_NOT_FOUND' });
    // Materials must still be there: nothing was consumed for a fusion this call never performed.
    for (const id of materialIds) expect(f.cardInstances.docs.get(id)).toBeDefined();
  });

  it('idem insert failing with a non-duplicate error is rethrown, nothing consumed', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.cardInvCount = FUSION_MATERIAL_COUNT + 1; });
    const { targetId, materialIds } = seedFusable(f);
    f.cardIdem.insertOne = async () => { throw Object.assign(new Error('not primary'), { code: 10107 }); };
    await expect(fuseCards(f.cols, now, ACC, targetId, materialIds, 'fuse-outage')).rejects.toThrow('not primary');
    expect(f.cardInstances.docs.get(targetId)!.level).toBe(1); // untouched
    for (const id of materialIds) expect(f.cardInstances.docs.get(id)).toBeDefined();
  });
});

describe('assembleCardInvSubset', () => {
  it('empty id list short-circuits without querying cardInstances', async () => {
    const f = makeCols();
    let queried = false;
    f.cardInstances.find = (() => { queried = true; throw new Error('should not query'); }) as never;
    expect(await assembleCardInvSubset(f.cols, ACC, [])).toEqual({});
    expect(queried).toBe(false);
  });

  it('a non-empty id list resolves only the requested, account-owned ids', async () => {
    const f = makeCols();
    seedCard(f, { id: 'sub-a', defId: ONE_DEF.id });
    seedCard(f, { id: 'sub-b', defId: ONE_DEF.id });
    const inv = await assembleCardInvSubset(f.cols, ACC, ['sub-a', 'not-owned']);
    expect(Object.keys(inv)).toEqual(['sub-a']);
  });
});
