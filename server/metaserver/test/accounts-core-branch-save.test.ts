// Branch-coverage backfill for src/save.ts (2026-09-03 branch-coverage task, group F).
//
// Why this file exists: save.ts is exercised end-to-end by save.e2e.test.ts et al., but those import
// `buildApp` from '../dist/app.js' and v8 coverage cannot attribute dist/*.js execution back to
// src/*.ts — so every fallback here read as "never taken" even though the happy path runs constantly.
// This file imports the functions directly from '../src/save.js' and drives the branches an HTTP test
// structurally cannot: absent optional save fields (a save written before a feature existed, or an
// account whose inventory/everOwned sections were never lazily created) and the lost races in
// getOrCreateSave / writeMigratedSave.
//
// The stakes for the fallbacks below are concrete: isAvatarOwned/isSkinOwned decide whether an equip
// request is refused, and writeMigratedSave decides whether a season migration's settled rewards are
// persisted or silently dropped.
import { describe, expect, it } from 'vitest';
import { makeNewSave, type SaveData } from '@nw/shared';
import {
  PRESET_AVATAR_IDS,
  getOrCreateSave,
  isAvatarOwned,
  isSkinOwned,
  sanitizeEquippedAvatar,
  writeMigratedSave,
} from '../src/save.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import type { Collections } from '@nw/shared';

type SaveDoc = { _id: string; save: SaveData; rev: number };

const TS = 1_700_000_000_000;

function baseSave(accountId = 'acc-1'): SaveData {
  return makeNewSave(accountId, TS);
}

/** Strips optional sections off a fresh save — the shape of a save persisted before those sections
 *  existed (the only way to reach save.ts's `?? []` / `?.` fallbacks; makeNewSave always fills them). */
function legacySave(accountId = 'acc-legacy'): SaveData {
  const s = baseSave(accountId) as unknown as Record<string, unknown>;
  delete s.titles;
  delete s.everOwned;
  delete s.inventory;
  return s as unknown as SaveData;
}

function colsWith(docs: SaveDoc[] = []): { cols: Collections; saves: FakeCollection<SaveDoc> } {
  const saves = new FakeCollection<SaveDoc>().seed(...docs);
  return { cols: { saves } as unknown as Collections, saves };
}

// ── getOrCreateSave ─────────────────────────────────────────────────────────────────────────────
describe('getOrCreateSave', () => {
  it('existing doc is returned as-is (no upsert)', async () => {
    const save = baseSave('acc-exists');
    const { cols, saves } = colsWith([{ _id: 'acc-exists', save, rev: save.rev }]);
    expect(await getOrCreateSave(cols, 'acc-exists', TS)).toBe(save);
    expect(saves.docs.size).toBe(1);
  });

  it('missing doc is created via upsert and read back', async () => {
    const { cols, saves } = colsWith();
    const out = await getOrCreateSave(cols, 'acc-new', TS);
    expect(out.accountId).toBe('acc-new');
    expect(saves.docs.get('acc-new')!.save.accountId).toBe('acc-new');
  });

  it('read-back after the upsert comes back empty -> the locally built save is returned, not null', async () => {
    // Why this branch matters: `return fresh ? fresh.save : save` is the only thing standing between a
    // read that misses the just-written doc (a read routed to a lagging replica-set secondary) and a
    // caller dereferencing undefined. The player must still get a usable starter save for this request.
    class BlindSaves extends FakeCollection<SaveDoc> {
      override async findOne(): Promise<SaveDoc | null> {
        return null;
      }
    }
    const saves = new BlindSaves();
    const cols = { saves } as unknown as Collections;
    const out = await getOrCreateSave(cols, 'acc-blind', TS);
    expect(out.accountId).toBe('acc-blind');
    expect(out.rev).toBe(0);
    // The upsert itself still landed — only the read-back was blind.
    expect(saves.docs.get('acc-blind')).toBeDefined();
  });
});

// ── isAvatarOwned ───────────────────────────────────────────────────────────────────────────────
describe('isAvatarOwned', () => {
  it('legacy bare-digit preset ids are always owned', () => {
    const save = baseSave();
    for (const id of PRESET_AVATAR_IDS) expect(isAvatarOwned(save, id)).toBe(true);
  });

  it('"preset:<key>" is owned unconditionally, even for a key the art table does not have', () => {
    expect(isAvatarOwned(baseSave(), 'preset:not_a_real_key')).toBe(true);
  });

  it('title category: owned only when the titleId is in titles[]', () => {
    const save = { ...baseSave(), titles: ['veteran'] };
    expect(isAvatarOwned(save, 'title:veteran')).toBe(true);
    expect(isAvatarOwned(save, 'title:legend')).toBe(false);
  });

  it('title category on a save with no titles[] at all -> not owned (must not throw)', () => {
    expect(isAvatarOwned(legacySave(), 'title:veteran')).toBe(false);
  });

  it('hero category reads everOwned.hero (lifetime ledger, survives a salvaged hero)', () => {
    const save = { ...baseSave(), everOwned: { hero: ['lichuang'] } } as SaveData;
    expect(isAvatarOwned(save, 'hero:lichuang')).toBe(true);
    expect(isAvatarOwned(save, 'hero:other')).toBe(false);
    expect(isAvatarOwned(legacySave(), 'hero:lichuang')).toBe(false);
  });

  it('skin category: current inventory OR the lifetime ledger unlocks it (both operands matter)', () => {
    const inInventory = { ...baseSave(), inventory: { skins: ['ink_a'], items: {} } } as SaveData;
    expect(isAvatarOwned(inInventory, 'skin:ink_a')).toBe(true);
    // Sold into auction escrow: gone from inventory.skins, still in everOwned.skin -> still unlocked.
    const soldAway = { ...baseSave(), inventory: { skins: [], items: {} }, everOwned: { skin: ['ink_a'] } } as SaveData;
    expect(isAvatarOwned(soldAway, 'skin:ink_a')).toBe(true);
    expect(isAvatarOwned(legacySave(), 'skin:ink_a')).toBe(false);
  });

  it('retired categories and unknown categories are not owned', () => {
    const save = baseSave();
    expect(isAvatarOwned(save, 'equip:wp_pencil')).toBe(false);
    expect(isAvatarOwned(save, 'material:scrap')).toBe(false);
    expect(isAvatarOwned(save, 'nonsense:x')).toBe(false);
  });

  it('an id with no ":" separator is treated as a bare category with an empty key', () => {
    // sep < 0 => category is the whole string, key is ''. 'preset' still returns true (always free);
    // 'title'/'hero'/'skin' look for the empty-string key and therefore do not unlock anything.
    expect(isAvatarOwned(baseSave(), 'preset')).toBe(true);
    expect(isAvatarOwned({ ...baseSave(), titles: [''] }, 'title')).toBe(true);
    expect(isAvatarOwned({ ...baseSave(), titles: ['veteran'] }, 'title')).toBe(false);
    expect(isAvatarOwned(baseSave(), 'hero')).toBe(false);
  });
});

// ── sanitizeEquippedAvatar ──────────────────────────────────────────────────────────────────────
describe('sanitizeEquippedAvatar (2026-08-15 equip/material category retirement)', () => {
  it('no equipped avatar -> the same save object is returned untouched', () => {
    const save = baseSave();
    expect(sanitizeEquippedAvatar(save)).toBe(save);
  });

  it('bare-digit avatar is left alone (client migrates it positionally)', () => {
    const save = { ...baseSave(), equipped: { avatar: '3' } };
    expect(sanitizeEquippedAvatar(save)).toBe(save);
  });

  it('still-valid categories are left alone', () => {
    for (const avatar of ['preset:ink', 'title:veteran', 'hero:lichuang', 'skin:ink_a']) {
      const save = { ...baseSave(), equipped: { avatar } };
      expect(sanitizeEquippedAvatar(save)).toBe(save);
    }
  });

  it('a retired category is swapped for preset:0 without disturbing the other equipped slots', () => {
    const save = { ...baseSave(), equipped: { avatar: 'equip:wp_pencil', title: 'veteran', 'skin:ink': 'ink_a' } };
    const out = sanitizeEquippedAvatar(save);
    expect(out).not.toBe(save);
    expect(out.equipped.avatar).toBe('preset:0');
    expect(out.equipped.title).toBe('veteran');
    expect(out.equipped['skin:ink']).toBe('ink_a');
    // Read-time only: the input save (and therefore the stored doc) is not mutated.
    expect(save.equipped.avatar).toBe('equip:wp_pencil');
  });
});

// ── isSkinOwned ─────────────────────────────────────────────────────────────────────────────────
describe('isSkinOwned', () => {
  it('true from current inventory, true from the lifetime ledger, false when neither has it', () => {
    expect(isSkinOwned({ ...baseSave(), inventory: { skins: ['ink_a'], items: {} } } as SaveData, 'ink_a')).toBe(true);
    expect(isSkinOwned({ ...baseSave(), everOwned: { skin: ['ink_a'] } } as SaveData, 'ink_a')).toBe(true);
    expect(isSkinOwned(baseSave(), 'ink_a')).toBe(false);
  });

  it('a save with neither section present -> false (must not throw)', () => {
    expect(isSkinOwned(legacySave(), 'ink_a')).toBe(false);
  });
});

// ── writeMigratedSave ───────────────────────────────────────────────────────────────────────────
describe('writeMigratedSave', () => {
  /** migrate() double: records how many times it ran and returns a caller-supplied verdict. */
  function migrator(verdicts: { migrated: boolean; bump?: boolean }[]) {
    const calls: number[] = [];
    let i = 0;
    return {
      calls,
      fn: async (s: SaveData) => {
        calls.push(s.rev);
        const v = verdicts[Math.min(i++, verdicts.length - 1)]!;
        return { migrated: v.migrated, save: v.bump ? { ...s, rev: s.rev + 1 } : s };
      },
    };
  }

  it('happy path: CAS on {_id, rev} succeeds and the persisted save (rev+1) is returned', async () => {
    const stored = baseSave('acc-w1');
    const { cols, saves } = colsWith([{ _id: 'acc-w1', save: stored, rev: stored.rev }]);
    const m = migrator([{ migrated: false }]);
    const out = await writeMigratedSave(cols, { ...stored, wallet: { coins: 42 } }, TS + 5, m.fn);
    expect(out.rev).toBe(stored.rev + 1);
    expect(out.wallet.coins).toBe(42);
    expect(out.updatedAt).toBe(TS + 5);
    expect(saves.docs.get('acc-w1')!.rev).toBe(stored.rev + 1);
    expect(m.calls).toEqual([]); // no conflict -> migrate() is never re-run
  });

  it('CAS misses and the save row is gone -> the in-memory migrated save is returned, nothing resurrected', async () => {
    // Why this branch matters: the row disappearing mid-migration means the account was deleted (or its
    // save TTL'd). Re-inserting it would resurrect a deleted player's progress; returning the migrated
    // value un-persisted lets this one response finish without writing anything back.
    const { cols, saves } = colsWith();
    const migrated = { ...baseSave('acc-gone'), wallet: { coins: 7 } };
    const m = migrator([{ migrated: true, bump: true }]);
    const out = await writeMigratedSave(cols, migrated, TS, m.fn);
    expect(out).toBe(migrated);
    expect(saves.docs.size).toBe(0);
    expect(m.calls).toEqual([]); // never reached migrate() — the re-read returned nothing
  });

  it('CAS misses because a concurrent writer already migrated -> that writer\'s save is returned as-is', async () => {
    // rev on the doc (99) deliberately disagrees with the save we were handed, so the CAS guard misses.
    const winner = { ...baseSave('acc-race'), wallet: { coins: 500 } };
    const { cols } = colsWith([{ _id: 'acc-race', save: winner, rev: 99 }]);
    const m = migrator([{ migrated: false }]);
    const out = await writeMigratedSave(cols, { ...baseSave('acc-race'), wallet: { coins: 1 } }, TS, m.fn);
    expect(out).toBe(winner);
    expect(out.wallet.coins).toBe(500); // the loser's stale 1 coin never overwrote the winner's 500
    expect(m.calls).toHaveLength(1);
  });

  it('three consecutive CAS misses that each still need migrating -> gives up and returns the last migrated save', async () => {
    // Permanent rev disagreement (doc.rev pinned at 99, save.rev never reaches it) = every attempt loses.
    const stored = baseSave('acc-thrash');
    const { cols, saves } = colsWith([{ _id: 'acc-thrash', save: stored, rev: 99 }]);
    const m = migrator([{ migrated: true }]);
    const out = await writeMigratedSave(cols, { ...stored, wallet: { coins: 3 } }, TS, m.fn);
    expect(m.calls).toHaveLength(3); // attempts 0,1,2 all conflicted; the loop then bails out
    expect(out.accountId).toBe('acc-thrash');
    expect(saves.docs.get('acc-thrash')!.rev).toBe(99); // nothing was written
  });
});
