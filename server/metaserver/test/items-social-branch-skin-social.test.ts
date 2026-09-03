// Branch-coverage backfill for src/skin.ts, src/social.ts, src/titles.ts and src/mail.ts
// (group G, 2026-09-03). skin-unit.test.ts / social-service-unit.test.ts / titles.test.ts cover the
// well-formed-save happy paths; every branch left over is an absent-field fallback that only shows up
// on a save/account document written before the field existed (or overwritten mid-flight by a
// concurrent full-document write) plus the two "nothing to do" short-circuits.
// Imports from '../src/...' (never '../dist/...') so v8 coverage attributes lines to source.
import { describe, it, expect } from 'vitest';
import {
  INITIAL_ELO,
  eloToRank,
  STARTER_TITLE,
  type Collections,
  type MailAttachmentDoc,
  type SaveData,
} from '@nw/shared';
import { escrowSkin, grantSkin, assembleSkinCounts } from '../src/skin.js';
import { profileOf, profilesOf } from '../src/social.js';
import { grantTitleToPlayer } from '../src/titles.js';
import { splitAttachments, bulkInsertSystemMail } from '../src/mail.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { seedSave, type FakeSaveDoc, type FakeIdemDoc } from './helpers/fakeEquipCols.js';
import { FakeSocialsvc } from './helpers/fakeClients.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-grpG-skin';
const SKIN = 'skin_test_alpha';

type FakeSkinDoc = { _id: string; accountId: string; skinId: string; sourceType?: string; obtainedAt?: number };

interface FakeSkinCols {
  cols: Collections;
  saves: FakeCollection<FakeSaveDoc>;
  skinInstances: FakeCollection<FakeSkinDoc>;
  equipmentIdem: FakeCollection<FakeIdemDoc>;
}

function makeCols(): FakeSkinCols {
  const saves = new FakeCollection<FakeSaveDoc>();
  const skinInstances = new FakeCollection<FakeSkinDoc>();
  const equipmentIdem = new FakeCollection<FakeIdemDoc>();
  return {
    cols: { saves, skinInstances, equipmentIdem } as unknown as Collections,
    saves,
    skinInstances,
    equipmentIdem,
  };
}

/** Deletes `inventory` off the stored save just before the Nth `saves.findOne` resolves — i.e. a
 *  concurrent full-document save write landing between escrow's ownership check and its rev loop. */
function dropInventoryOnNthRead(saves: FakeCollection<FakeSaveDoc>, nth: number): void {
  let calls = 0;
  const real = saves.findOne.bind(saves);
  saves.findOne = async (q: Record<string, unknown>) => {
    calls++;
    if (calls === nth) {
      const d = await real(q);
      if (d) {
        const next = { ...d.save } as Record<string, unknown>;
        delete next.inventory;
        saves.docs.set(d._id, { ...d, save: next as unknown as SaveData });
      }
    }
    return real(q);
  };
}

describe('skin.ts — saves written before/without an `equipped` or `inventory` block', () => {
  it('escrowSkin on a save with no `equipped` block at all: nothing can be equipped, so escrow proceeds', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => {
      s.inventory = { skins: [SKIN], items: {} };
      delete (s as Partial<SaveData>).equipped;
    });
    f.skinInstances.seed({ _id: 'si-1', accountId: ACC, skinId: SKIN });
    const r = await escrowSkin(f.cols, now, ACC, SKIN, 'order-noequipped');
    expect(r).toEqual({ skinId: SKIN });
    expect(f.skinInstances.docs.size).toBe(0); // the single instance was removed
  });

  it('assembleSkinCounts on a save with no `inventory` block: counts real rows only, backfills nothing', async () => {
    const f = makeCols();
    const save = { ...({} as SaveData) } as SaveData;
    f.skinInstances.seed({ _id: 'si-a', accountId: ACC, skinId: SKIN }, { _id: 'si-b', accountId: ACC, skinId: SKIN });
    const counts = await assembleSkinCounts(f.cols, ACC, save);
    expect(counts).toEqual({ [SKIN]: 2 });
  });

  it('escrowSkin on a save with no `inventory` block -> SKIN_NOT_FOUND (never escrows an unowned skin)', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { delete (s as Partial<SaveData>).inventory; });
    const r = await escrowSkin(f.cols, now, ACC, SKIN, 'order-noinv');
    expect(r).toEqual({ error: 'skin not owned', code: 'SKIN_NOT_FOUND' });
  });

  it('escrowSkin with copies remaining, save losing `inventory` mid-flight: membership array is rebuilt, not left undefined', async () => {
    // remaining > 0 keeps the skinId in inventory.skins — but the concurrent write took the whole block
    // away, so the `?? []` / `?? { items: {} }` fallbacks are what keep the rev-guarded write well-formed
    // (a save with `inventory: undefined` would break every later read; it self-heals via assembleSkinCounts).
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.inventory = { skins: [SKIN], items: {} }; });
    f.skinInstances.seed({ _id: 'si-x1', accountId: ACC, skinId: SKIN }, { _id: 'si-x2', accountId: ACC, skinId: SKIN });
    dropInventoryOnNthRead(f.saves, 2); // 1st = ownership check, 2nd = inside the rev loop
    const r = await escrowSkin(f.cols, now, ACC, SKIN, 'order-race-multi');
    expect(r).toEqual({ skinId: SKIN });
    const stored = (await f.saves.findOne({ _id: ACC }))!.save;
    expect(stored.inventory).toEqual({ items: {}, skins: [] });
    expect(f.skinInstances.docs.size).toBe(1); // exactly one copy escrowed
  });

  it('escrowSkin with the last copy, save losing `inventory` mid-flight: still commits a well-formed save', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.inventory = { skins: [SKIN], items: {} }; });
    f.skinInstances.seed({ _id: 'si-y1', accountId: ACC, skinId: SKIN });
    dropInventoryOnNthRead(f.saves, 2);
    const r = await escrowSkin(f.cols, now, ACC, SKIN, 'order-race-last');
    expect(r).toEqual({ skinId: SKIN });
    expect((await f.saves.findOne({ _id: ACC }))!.save.inventory).toEqual({ items: {}, skins: [] });
  });

  it('grantSkin without an orderId mints a random instance id (never a literal "undefined" id)', async () => {
    // orderId is optional for back-compat call sites; two orderId-less grants must not collide on one id.
    const f = makeCols();
    seedSave(f.saves, ACC, now());
    expect(await grantSkin(f.cols, now, ACC, SKIN)).toEqual({ ok: true });
    const ids = [...f.skinInstances.docs.keys()];
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^skin_grant_[0-9a-f-]{36}$/);
  });

  it('grantSkin on a save with no `inventory` block rebuilds it and records the lifetime-owned ledger', async () => {
    const f = makeCols();
    seedSave(f.saves, ACC, now(), (s) => { delete (s as Partial<SaveData>).inventory; });
    expect(await grantSkin(f.cols, now, ACC, SKIN, 'order-grant-noinv')).toEqual({ ok: true });
    const stored = (await f.saves.findOne({ _id: ACC }))!.save;
    expect(stored.inventory).toEqual({ items: {}, skins: [SKIN] });
    expect(stored.everOwned?.skin).toEqual([SKIN]);
  });
});

describe('social.ts — accounts/saves missing the optional profile fields', () => {
  interface FakeAccountDoc { _id: string; publicId?: string; displayName?: string; flags?: { mutedUntil?: number } }

  function makeSocialCols(): { cols: Collections; accounts: FakeCollection<FakeAccountDoc>; saves: FakeCollection<FakeSaveDoc> } {
    const accounts = new FakeCollection<FakeAccountDoc>();
    const saves = new FakeCollection<FakeSaveDoc>();
    return { cols: { accounts, saves } as unknown as Collections, accounts, saves };
  }

  it('account with a publicId but no displayName and no save yet -> synthesized name + unranked baseline elo', async () => {
    // This is exactly a freshly registered account looked up by a friend before its first GET /save.
    const f = makeSocialCols();
    f.accounts.seed({ _id: ACC, publicId: 'PID-8421' });
    const p = await profileOf(f.cols, ACC);
    expect(p).toEqual({ displayName: 'Player8421', publicId: 'PID-8421', rank: eloToRank(INITIAL_ELO) });
  });

  it('equipped avatar and an active mute both surface on the profile view', async () => {
    const f = makeSocialCols();
    f.accounts.seed({ _id: ACC, publicId: 'PID-0001', displayName: 'Tao', flags: { mutedUntil: 999 } });
    seedSave(f.saves, ACC, now(), (s) => { s.equipped = { title: 't1', avatar: 'preset:fox' }; });
    const p = await profileOf(f.cols, ACC);
    expect(p).toMatchObject({ displayName: 'Tao', equippedTitle: 't1', avatarId: 'preset:fox', mutedUntil: 999 });
  });

  it('profilesOf with an empty id list short-circuits without touching Mongo', async () => {
    const f = makeSocialCols();
    f.accounts.find = (() => { throw new Error('should not query'); }) as never;
    expect(await profilesOf(f.cols, [])).toEqual(new Map());
  });

  it('profilesOf drops ids whose account has no publicId yet (invisible), keeping the rest', async () => {
    const f = makeSocialCols();
    f.accounts.seed({ _id: 'a1', publicId: 'PID-1111', displayName: 'One' }, { _id: 'a2' }); // a2: no publicId
    seedSave(f.saves, 'a1', now());
    const map = await profilesOf(f.cols, ['a1', 'a2']);
    expect([...map.keys()]).toEqual(['a1']);
    expect(await profileOf(f.cols, 'a2')).toBeNull();
  });
});

describe('titles.ts — saves written before titles[]/titleGrants existed', () => {
  it('save with neither `titles` nor `titleGrants` -> both are created and the title auto-equips', async () => {
    const saves = new FakeCollection<FakeSaveDoc>();
    const cols = { saves } as unknown as Collections;
    seedSave(saves, ACC, now(), (s) => {
      delete (s as Partial<SaveData>).titles;
      delete (s as Partial<SaveData>).titleGrants;
      delete (s as Partial<SaveData>).equipped;
    });
    await grantTitleToPlayer(cols, ACC, 'event.newbie', 12_345);
    const stored = (await saves.findOne({ _id: ACC }))!.save;
    expect(stored.titles).toEqual(['event.newbie']);
    expect(stored.titleGrants).toEqual({ 'event.newbie': 12_345 });
    expect(stored.equipped.title).toBe('event.newbie');
  });

  it('titleGrants already carries an obtainedAt for this title -> the original timestamp is never clobbered', async () => {
    // Defensive arm: the grant record survived (e.g. a rolled-back titles[] write), so re-granting must
    // keep the original obtained-at date the player's item detail panel shows.
    const saves = new FakeCollection<FakeSaveDoc>();
    const cols = { saves } as unknown as Collections;
    seedSave(saves, ACC, now(), (s) => {
      s.titles = [];
      s.titleGrants = { [STARTER_TITLE]: 111 };
      s.equipped = {};
    });
    await grantTitleToPlayer(cols, ACC, STARTER_TITLE, 999);
    const stored = (await saves.findOne({ _id: ACC }))!.save;
    expect(stored.titles).toEqual([STARTER_TITLE]);
    expect(stored.titleGrants).toEqual({ [STARTER_TITLE]: 111 }); // not 999
  });
});

describe('mail.ts — attachment count defaults and the empty bulk fan-out', () => {
  it('attachments with no `count`: coins default to 0, every other kind defaults to 1', async () => {
    // Attachment docs are forwarded verbatim from operator/admin JSON, so a missing `count` is normal.
    const attachments = [
      { kind: 'coins' },
      { kind: 'item', id: 'protect_enhance' },
      { kind: 'material', id: 'scrap' },
      { kind: 'skin', id: 'skin_a' },
    ] as unknown as MailAttachmentDoc[];
    expect(splitAttachments(attachments)).toEqual({
      coins: 0, // a coins attachment with no count is worth nothing, not one coin
      skins: ['skin_a'],
      items: { protect_enhance: 1 },
      materials: { scrap: 1 },
      equipment: [],
      cards: [],
    });
  });

  it('bulkInsertSystemMail with no recipients resolves locally without calling socialsvc', async () => {
    const socialsvc = new FakeSocialsvc();
    const r = await bulkInsertSystemMail(socialsvc, 'dk', [], {
      subject: 's', body: 'b', expireDays: 30, attachments: [{ kind: 'coins', count: 5 }],
    });
    expect(r).toEqual({ insertedAccountIds: [], hasAttachment: true });
    expect(socialsvc.mail.size).toBe(0);

    // …and with recipients it does delegate, reporting hasAttachment=false for an attachment-less mail.
    const r2 = await bulkInsertSystemMail(socialsvc, 'dk', ['a1', 'a2'], { subject: 's', body: 'b', expireDays: 30 });
    expect(r2).toEqual({ insertedAccountIds: ['a1', 'a2'], hasAttachment: false });
  });
});
