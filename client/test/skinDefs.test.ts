// Pure-logic tests for the per-character skin equip model (LOBBY_IA_REDESIGN §15 / ADR-038):
// skins used to live on a single global SaveData.equipped[EQUIP_SLOT] slot; now each character has its
// own slot, so several skins can be equipped simultaneously.
import { describe, it, expect } from 'vitest';
import { SKIN_TARGET_UNIT, skinsForUnitType, skinEquipKey, allEquippedSkins, equippedSkinIdForType, isKnownSkin, skinDisplayName } from '../src/game/meta/skinDefs';
import { snapshotClientLogs, LOG_LEVEL_RANK } from '../src/net/log';
import { UnitType } from '@nw/engine/types';

describe('SKIN_TARGET_UNIT', () => {
  it('maps every catalogue skin to exactly one unit type', () => {
    expect(SKIN_TARGET_UNIT.skin_shop_c1).toBe(UnitType.Infantry);
    expect(SKIN_TARGET_UNIT.skin_shop_r1).toBe(UnitType.Archer);
    expect(SKIN_TARGET_UNIT.skin_shop_e1).toBe(UnitType.ShieldBearer);
    expect(SKIN_TARGET_UNIT.skin_e1).toBe(UnitType.Lena);
    expect(SKIN_TARGET_UNIT.skin_e2).toBe(UnitType.Mara);
    expect(SKIN_TARGET_UNIT.skin_l1).toBe(UnitType.Max);
  });
});

describe('skinsForUnitType', () => {
  it('filters an owned-skins list down to the ones matching a character', () => {
    const owned = ['skin_e1', 'skin_l1', 'skin_shop_c1'];
    expect(skinsForUnitType(UnitType.Lena, owned)).toEqual(['skin_e1']);
    expect(skinsForUnitType(UnitType.Max, owned)).toEqual(['skin_l1']);
    expect(skinsForUnitType(UnitType.Mara, owned)).toEqual([]);
  });
});

describe('skinEquipKey', () => {
  it('namespaces the slot key so it never collides with the title slot', () => {
    expect(skinEquipKey(UnitType.Lena)).toBe('skin:lena');
    expect(skinEquipKey(UnitType.Lena)).not.toBe('title');
  });
});

describe('allEquippedSkins', () => {
  it('extracts only skin: keys, ignoring the unrelated title slot', () => {
    const equipped = { title: 'champion', 'skin:lena': 'skin_e1', 'skin:max': 'skin_l1' };
    expect(allEquippedSkins(equipped).sort()).toEqual(['skin_e1', 'skin_l1']);
  });

  it('returns an empty array when nothing is equipped', () => {
    expect(allEquippedSkins({})).toEqual([]);
  });
});

describe('equippedSkinIdForType', () => {
  it('finds the one equipped skin targeting a given unit type, out of the flattened battle list', () => {
    const skins = ['skin_e1', 'skin_l1'];
    expect(equippedSkinIdForType(UnitType.Lena, skins)).toBe('skin_e1');
    expect(equippedSkinIdForType(UnitType.Max, skins)).toBe('skin_l1');
  });

  it('returns null for a type with nothing equipped', () => {
    expect(equippedSkinIdForType(UnitType.Mara, ['skin_e1', 'skin_l1'])).toBeNull();
    expect(equippedSkinIdForType(UnitType.Infantry, [])).toBeNull();
  });
});

// `isKnownSkin` + its private warn-once helper (2026-09-10 FNDA sweep found both at zero hits).
// The only place either was mentioned in a test was a COMMENT in auctionPickerDedupe.ui.ts, which
// is how a gate that reads as covered can have never run.
//
// What it guards: an id sitting in `inventory.skins` that the catalogue no longer knows about —
// `skin_c1~c4` / `skin_r1~r3` were deleted from economy.ts before launch (GACHA_DESIGN §"上线皮肤
// 目录"), and two of them turned up in a live account's inventory on 2026-08-08. The auction item
// picker happily listed one, with the raw id as its label. Nothing errors on that path: the
// listing is created, the item cannot be delivered, and it reads to the player as a broken
// feature rather than as bad data. The warn-once half matters for a different reason — this is
// re-evaluated for every visible cell on every render pass, so a plain log call would bury the
// session's ring buffer (the remotely collectible one, FEATURE_FLAGS_DESIGN §9.4) under one
// message per frame and push the diagnosis of whatever else went wrong out of the window.
describe('isKnownSkin', () => {
  it('accepts every id in the catalogue', () => {
    for (const id of Object.keys(SKIN_TARGET_UNIT)) {
      expect(isKnownSkin(id), id).toBe(true);
    }
    expect(Object.keys(SKIN_TARGET_UNIT).length).toBeGreaterThan(0); // non-vacuity: the loop ran
  });

  it('rejects a SKU deleted from the catalogue before launch, and any other junk', () => {
    expect(isKnownSkin('skin_c1')).toBe(false); // the real 2026-08-08 finding
    expect(isKnownSkin('skin_r3')).toBe(false);
    expect(isKnownSkin('')).toBe(false);
    expect(isKnownSkin('title')).toBe(false); // an equip-slot key, not a skin id
  });

  it('does not treat inherited Object properties as catalogue entries', () => {
    // Found by this case on 2026-09-10, before the fix: `skinId in SKIN_TARGET_UNIT` walks the
    // prototype chain, so `constructor` / `toString` answered TRUE and reached the wardrobe and
    // auction paths as "known" skins — and `SKIN_TARGET_UNIT['constructor']` even handed the
    // gacha name resolver a function where a UnitType belongs. The map now has a null prototype;
    // these ids are ordinary junk again. Ids like these are not hypothetical here: the lookup key
    // is whatever sits in the account's `inventory.skins`.
    expect(isKnownSkin('constructor')).toBe(false);
    expect(isKnownSkin('toString')).toBe(false);
    expect(isKnownSkin('__proto__')).toBe(false);
    expect(SKIN_TARGET_UNIT['constructor']).toBeUndefined();
  });

  it('logs an unknown id once per session, not once per render', () => {
    const before = snapshotClientLogs(LOG_LEVEL_RANK.warn, 0).lastSeq;
    const unique = `skin_ghost_${Date.now()}`; // the dedup Set is module state shared across cases

    for (let i = 0; i < 30; i++) isKnownSkin(unique); // one grid, thirty cells
    const entries = snapshotClientLogs(LOG_LEVEL_RANK.warn, before).entries
      .filter((e) => e.tag === 'skinDefs' && e.msg.includes(unique));

    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe('warn');
    expect(entries[0]!.msg).toContain('unknown skin id');
  });

  it('still logs a SECOND unknown id (the dedup is per id, not a one-shot latch)', () => {
    // A latch would mean the first stale id in a session hides every other one — and the whole
    // point of the log is to name the ids sitting in that account's inventory.
    const before = snapshotClientLogs(LOG_LEVEL_RANK.warn, 0).lastSeq;
    const a = `skin_ghost_a_${Date.now()}`;
    const b = `skin_ghost_b_${Date.now()}`;

    isKnownSkin(a);
    isKnownSkin(b);
    isKnownSkin(a);

    const msgs = snapshotClientLogs(LOG_LEVEL_RANK.warn, before).entries
      .filter((e) => e.tag === 'skinDefs')
      .map((e) => e.msg);
    expect(msgs.filter((m) => m.includes(a))).toHaveLength(1);
    expect(msgs.filter((m) => m.includes(b))).toHaveLength(1);
  });

  it('skinDisplayName shares the same warn-once channel for an unmapped id', () => {
    // Both entry points funnel through warnUnknownSkin, so a name lookup for an id the picker has
    // already complained about must not add a second entry.
    const unique = `skin_ghost_name_${Date.now()}`;
    const before = snapshotClientLogs(LOG_LEVEL_RANK.warn, 0).lastSeq;

    isKnownSkin(unique);
    expect(skinDisplayName(unique)).toBe(unique); // falls back to the raw id

    const entries = snapshotClientLogs(LOG_LEVEL_RANK.warn, before).entries
      .filter((e) => e.tag === 'skinDefs' && e.msg.includes(unique));
    expect(entries).toHaveLength(1);
  });
});
