// Coverage for the item-picker fix (2026-07-16, see design/game/AUCTION_DESIGN.md): equipment/card
// instances used to be listed one row per raw instance (a dozen identical +0 drops repeated the same
// card a dozen times) and always drew a fixed class-wide glyph regardless of which item it actually was.
// buildPickEntries() now groups by defId+level (label gets a "×N" suffix) and carries a `defId` so
// renderPickIcon can draw the real per-item picture instead of a hardcoded 'armor'/'cards' icon.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree, no renderer.

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import { buildPickEntries, openItemPicker, listableSkins, selectedItemLabel } from '../../src/scenes/AuctionScene/itemPickerRender';
import { equipName, cardName } from '../../src/scenes/AuctionScene/itemLabels';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData, EquipmentInstance, CardInstance } from '../../src/game/meta/SaveData';
import type { WorldApiClient, AuctionView } from '../../src/net/WorldApiClient';
import { skinDisplayName } from '../../src/game/meta/skinDefs';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 1280];

function stubWorldApi(): WorldApiClient {
  return {
    listAuctions: vi.fn(async () => [] as AuctionView[]),
    getMyListings: vi.fn(async () => [] as AuctionView[]),
    getAuctionRefBand: vi.fn(async () => ({ ref: 10, floor: 5, ceil: 20 })),
    createAuction: vi.fn(),
    buyAuction: vi.fn(),
    cancelAuction: vi.fn(),
    placeBid: vi.fn(),
  } as unknown as WorldApiClient;
}

// Scene fields/methods below are all TS `protected`/`private` (mixin-internal); every other UI spec
// in this codebase reaches them via an untyped handle (see auctionScene.ui.ts) rather than re-exposing
// internals just for tests, so we do the same here.
function buildScene(cb: Record<string, unknown> = {}): any {
  return new AuctionScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    worldApi: stubWorldApi(),
    ...cb,
  });
}

function equip(id: string, opts: Partial<EquipmentInstance> = {}): EquipmentInstance {
  return { id, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [], ...opts };
}
function card(id: string, opts: Partial<CardInstance> = {}): CardInstance {
  return { id, defId: 'suyuan', level: 1, gear: {}, locked: false, ...opts };
}
function saveWith(equipmentInv: Record<string, EquipmentInstance>, cardInv: Record<string, CardInstance>): SaveData {
  return { ...makeNewSave('acc_1'), equipmentInv, cardInv };
}
function saveWithSkins(skins: string[], equipped: Record<string, string> = {}, skinCounts: Record<string, number> = {}): SaveData {
  const save = makeNewSave('acc_1');
  return { ...save, inventory: { ...save.inventory, skins }, equipped, skinCounts };
}

type PickEntry = {
  cls: 'material' | 'equipment' | 'card' | 'skin'; label: string; value: number; locked: boolean;
  defId?: string; skinId?: string; material?: string; onPick: () => void;
};

describe('AuctionScene picker — equipment/card dedupe (buildPickEntries)', () => {
  it('collapses N identical equipment instances (same defId+level) into one entry labeled "×N"', () => {
    const save = saveWith({ e1: equip('e1'), e2: equip('e2'), e3: equip('e3') }, {});
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    const equipEntries = entries.filter((e) => e.cls === 'equipment');
    expect(equipEntries).toHaveLength(1);
    // Level 0 gets no star suffix at all (2026-08-08: matches EquipmentScene's "+0 everywhere was pure
    // noise" convention — see levelStarsText) — just the name + the "×N" stack count.
    expect(equipEntries[0].label).toBe(`${equipName('wp_pencil')} ×3`);
    scene.destroy();
  });

  it('collapses N identical card instances (same defId+level) into one entry labeled "×N"', () => {
    const save = saveWith({}, { c1: card('c1'), c2: card('c2'), c3: card('c3'), c4: card('c4') });
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    const cardEntries = entries.filter((e) => e.cls === 'card');
    expect(cardEntries).toHaveLength(1);
    // 2026-08-08: cards now show a gold-star level too (matches equipment's convention and the
    // roster/detail card treatment) — no more "Lv.N" text.
    expect(cardEntries[0].label).toBe(`${cardName('suyuan')} ★ ×4`);
    scene.destroy();
  });

  it('keeps distinct defId/level combos as separate entries, and a lone instance has no "×N" suffix', () => {
    const save = saveWith(
      { e1: equip('e1'), e2: equip('e2'), e3: equip('e3', { defId: 'wp_marker', rarity: 'rare' }) },
      { c1: card('c1'), c2: card('c2', { defId: 'max', level: 5 }) },
    );
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    const equipEntries = entries.filter((e) => e.cls === 'equipment');
    const cardEntries = entries.filter((e) => e.cls === 'card');
    expect(equipEntries).toHaveLength(2);
    // Level 0 gets no star suffix (see the dedupe test above) — a lone instance is just the bare name.
    expect(equipEntries.map((e) => e.label).sort()).toEqual(
      [`${equipName('wp_pencil')} ×2`, equipName('wp_marker')].sort(),
    );
    expect(cardEntries).toHaveLength(2);
    expect(cardEntries.map((e) => e.label).sort()).toEqual(
      [`${cardName('suyuan')} ★`, `${cardName('max')} ★★★★★`].sort(),
    );
    scene.destroy();
  });

  it('picking a merged equipment entry resolves to one of the actual grouped instance ids', () => {
    const save = saveWith({ e1: equip('e1'), e2: equip('e2'), e3: equip('e3') }, {});
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    entries.find((e) => e.cls === 'equipment')!.onPick();
    expect(scene.core.createClass).toBe('equipment');
    expect(['e1', 'e2', 'e3']).toContain(scene.core.createEquipId);
    scene.destroy();
  });

  it('a card group with a mix of locked/unlocked instances is not marked locked, and picks an unlocked one', () => {
    const save = saveWith(
      {},
      { c1: card('c1', { locked: true }), c2: card('c2', { locked: false }), c3: card('c3', { locked: true }) },
    );
    const scene = buildScene({ getSave: () => save });
    // Note: listableCards() only excludes cards with gear equipped, not locked ones — locked cards are
    // still listable, just flagged. A locked representative would falsely hide an otherwise-pickable group.
    const entries: PickEntry[] = buildPickEntries(scene.core);
    const cardEntry = entries.find((e) => e.cls === 'card')!;
    expect(cardEntry.locked).toBe(false);
    cardEntry.onPick();
    expect(scene.core.createCardId).toBe('c2');
    scene.destroy();
  });

  it('a card group where every instance is locked is itself marked locked', () => {
    const save = saveWith({}, { c1: card('c1', { locked: true }), c2: card('c2', { locked: true }) });
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    expect(entries.find((e) => e.cls === 'card')!.locked).toBe(true);
    scene.destroy();
  });

  it('materials are unaffected by the equipment/card dedupe logic (still one entry per material type)', () => {
    const scene = buildScene();
    const entries: PickEntry[] = buildPickEntries(scene.core);
    expect(entries.filter((e) => e.cls === 'material')).toHaveLength(3); // scrap/lead/binding
    scene.destroy();
  });
});

describe('AuctionScene picker — real per-item icon wiring (defId carried through)', () => {
  it('equipment/card entries carry the defId needed to draw the real glyph/art, not a fixed class icon', () => {
    const save = saveWith({ e1: equip('e1', { defId: 'wp_marker', rarity: 'rare' }) }, { c1: card('c1', { defId: 'max', level: 3 }) });
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    expect(entries.find((e) => e.cls === 'equipment')!.defId).toBe('wp_marker');
    expect(entries.find((e) => e.cls === 'card')!.defId).toBe('max');
    scene.destroy();
  });

  it('rendering the picker with duplicated instances + an unknown defId does not throw (fallback icon path)', () => {
    const save = saveWith(
      { e1: equip('e1'), e2: equip('e2'), e3: equip('e3', { defId: 'does_not_exist' }) },
      { c1: card('c1'), c2: card('c2'), c3: card('c3', { defId: 'does_not_exist' }) },
    );
    const scene = buildScene({ getSave: () => save });
    expect(() => openItemPicker(scene.core)).not.toThrow();
    expect(scene.core.itemPickerOpen).toBe(true);
    scene.destroy();
  });

  it('renders exactly one card per distinct defId+level regardless of how many raw instances exist', () => {
    const save = saveWith({ e1: equip('e1'), e2: equip('e2'), e3: equip('e3') }, {});
    const scene = buildScene({ getSave: () => save });
    openItemPicker(scene.core);
    scene.core.pickerFilter = 'equipment';
    scene.render();
    // One rendered card == one hit rect beyond the fixed chrome (back button + sidebar tab rail).
    const pickHits = scene.core.hitRects.filter((h: { fn: () => void }) => {
      // Sidebar-tab/back actions don't touch createEquipId; the picker card's onPick does.
      const before = scene.core.createEquipId;
      h.fn();
      const touched = scene.core.createEquipId !== before || (before === null && scene.core.createEquipId !== null);
      scene.core.createEquipId = before; // restore, since some other hits might also be pressed by this loop
      return touched;
    });
    expect(pickHits).toHaveLength(1);
    scene.destroy();
  });
});

describe('AuctionScene picker — skins (2026-08-04, AUCTION_DESIGN.md §9 task7 follow-up)', () => {
  it('listableSkins excludes a skin currently equipped on its target unit', () => {
    // skin_e2 → UnitType.Mara (skinDefs.ts SKIN_TARGET_UNIT); equipped under the per-unit 'skin:<UnitType>' slot.
    const save = saveWithSkins(['skin_e1', 'skin_e2'], { 'skin:mara': 'skin_e2' });
    const scene = buildScene({ getSave: () => save });
    expect(listableSkins(scene.core)).toEqual(['skin_e1']);
    scene.destroy();
  });

  it('an owned, unequipped skin appears in buildPickEntries with cls="skin" and its display name', () => {
    const save = saveWithSkins(['skin_e2']);
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    const skinEntries = entries.filter((e) => e.cls === 'skin');
    expect(skinEntries).toHaveLength(1);
    expect(skinEntries[0].skinId).toBe('skin_e2');
    expect(skinEntries[0].label).toBe(skinDisplayName('skin_e2'));
    scene.destroy();
  });

  it('a skin with no owned copies (or fully equipped) contributes no entry', () => {
    const save = saveWithSkins(['skin_e2'], { 'skin:mara': 'skin_e2' });
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    expect(entries.filter((e) => e.cls === 'skin')).toHaveLength(0);
    scene.destroy();
  });

  it('picking a skin entry sets createClass/createSkinId and doCreate submits itemType="skin" with {skinId}', async () => {
    const save = saveWithSkins(['skin_e2']);
    const createAuction = vi.fn(async () => ({}));
    const scene = buildScene({ getSave: () => save, worldApi: { ...stubWorldApi(), createAuction } });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    entries.find((e) => e.cls === 'skin')!.onPick();
    expect(scene.core.createClass).toBe('skin');
    expect(scene.core.createSkinId).toBe('skin_e2');
    expect(selectedItemLabel(scene.core)).toBe(skinDisplayName('skin_e2'));

    await scene.createListing.doCreate();
    expect(createAuction).toHaveBeenCalledWith('skin', { skinId: 'skin_e2' }, 1, expect.any(Number), expect.any(Object));
    scene.destroy();
  });

  it('the skin category tab is included in FILTERS and renders without throwing', () => {
    const save = saveWithSkins(['skin_e2']);
    const scene = buildScene({ getSave: () => save });
    openItemPicker(scene.core);
    scene.core.pickerFilter = 'skin';
    expect(() => scene.render()).not.toThrow();
    scene.destroy();
  });
});

describe('AuctionScene picker — skin instance counts (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08)', () => {
  it('listableSkins allows a surplus copy of an equipped skin (skinCounts > 1), but not the last one', () => {
    const surplus = saveWithSkins(['skin_e2'], { 'skin:mara': 'skin_e2' }, { skin_e2: 2 });
    expect(listableSkins(buildScene({ getSave: () => surplus }).core)).toEqual(['skin_e2']);
    const lastOne = saveWithSkins(['skin_e2'], { 'skin:mara': 'skin_e2' }, { skin_e2: 1 });
    expect(listableSkins(buildScene({ getSave: () => lastOne }).core)).toEqual([]);
  });

  it('a duplicate skin (skinCounts > 1) shows a "×N" suffix in its picker label, same as equipment/card groups', () => {
    const save = saveWithSkins(['skin_e2'], {}, { skin_e2: 3 });
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    expect(entries.find((e) => e.cls === 'skin')!.label).toBe(`${skinDisplayName('skin_e2')} ×3`);
    scene.destroy();
  });

  it('a lone copy (or a save predating skinCounts) gets no "×N" suffix', () => {
    const save = saveWithSkins(['skin_e2']); // skinCounts defaults to {} — falls back to "1 copy"
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    expect(entries.find((e) => e.cls === 'skin')!.label).toBe(skinDisplayName('skin_e2'));
    scene.destroy();
  });

  // 2026-08-15: the skin cards' second action ("出售 ›" — sell one surplus copy to the system for
  // DUPE_REFUND_COINS) is gone, client and server both. The payout table it reused sits far below a
  // skin's real market value (a 10000-coin skin refunded 200), so the shortcut only ever destroyed
  // value by accident; a surplus skin's one outlet is now the auction house, exactly like every other
  // item class. Guards against the split hint row coming back: one full-card hit zone, nothing else.
  // A `sellSkin` callback is deliberately still handed in (the callbacks type no longer declares one,
  // hence the untyped cb bag) — that was the exact condition the old code branched on, so this fails
  // if the sell action is ever rewired, instead of passing vacuously on "nobody wired it up".
  it('a skin card offers only the pick action — no sell half-row (2026-08-15)', () => {
    const save = saveWithSkins(['skin_e2'], {}, { skin_e2: 2 });
    const scene = buildScene({
      getSave: () => save,
      reloadSave: vi.fn(async () => {}),
      sellSkin: vi.fn(async () => ({ credited: 400 })),
    });
    openItemPicker(scene.core);
    scene.core.pickerFilter = 'skin';
    expect(() => scene.render()).not.toThrow();
    // itemPickerRender's CARD_H (156, not exported) — the full-card catch-all is the only zone a
    // picker card pushes now; the old sell/list split pushed two 28px-tall half-width ones on top.
    const cardHits = scene.core.hitRects.filter((h: { rect: { h: number } }) => h.rect.h === 156);
    expect(cardHits.length).toBe(1);
    expect(scene.core.hitRects.some((h: { rect: { h: number } }) => h.rect.h === 28)).toBe(false);
    scene.destroy();
  });
});

// 2026-08-08: a stale test account's inventory.skins turned out to hold both a removed/placeholder skin
// SKU (skin_c1~c4/r1~r3, deleted from economy.ts on 2026-07-02 per GACHA_DESIGN.md §"上线皮肤目录") and
// several equipment/material defIds that never belonged there at all — buildPickEntries happily listed
// all of them under cls="skin" with a raw-id label + generic icon (looked like a broken feature; was
// actually bad data — see [[skinDefs.ts]]'s isKnownSkin). listableSkins now filters unknown ids out so
// they can never reach the picker or be listed for auction.
describe('AuctionScene picker — unknown/orphaned skin ids are never listable (2026-08-08)', () => {
  it('listableSkins drops ids with no SKIN_TARGET_UNIT entry (removed SKUs, or non-skin ids that leaked in)', () => {
    const save = saveWithSkins(['skin_e2', 'skin_c1', 'wp_pen', 'mat_scrap']);
    const scene = buildScene({ getSave: () => save });
    expect(listableSkins(scene.core)).toEqual(['skin_e2']);
    scene.destroy();
  });

  it('buildPickEntries contributes no cls="skin" entry for an unknown id', () => {
    const save = saveWithSkins(['skin_c3', 'skin_r2']);
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = buildPickEntries(scene.core);
    expect(entries.filter((e) => e.cls === 'skin')).toHaveLength(0);
    scene.destroy();
  });
});
