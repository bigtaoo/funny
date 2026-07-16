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
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData, EquipmentInstance, CardInstance } from '../../src/game/meta/SaveData';
import type { WorldApiClient, AuctionView } from '../../src/net/WorldApiClient';

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
  return { id, defId: 'suyuan', level: 1, xp: 0, gear: {}, locked: false, ...opts };
}
function saveWith(equipmentInv: Record<string, EquipmentInstance>, cardInv: Record<string, CardInstance>): SaveData {
  return { ...makeNewSave('acc_1'), equipmentInv, cardInv };
}

type PickEntry = { cls: 'material' | 'equipment' | 'card'; label: string; value: number; locked: boolean; defId?: string; material?: string; onPick: () => void };

describe('AuctionScene picker — equipment/card dedupe (buildPickEntries)', () => {
  it('collapses N identical equipment instances (same defId+level) into one entry labeled "×N"', () => {
    const save = saveWith({ e1: equip('e1'), e2: equip('e2'), e3: equip('e3') }, {});
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = scene.buildPickEntries();
    const equipEntries = entries.filter((e) => e.cls === 'equipment');
    expect(equipEntries).toHaveLength(1);
    expect(equipEntries[0].label).toBe(`${scene.equipName('wp_pencil')} +0 ×3`);
    scene.destroy();
  });

  it('collapses N identical card instances (same defId+level) into one entry labeled "×N"', () => {
    const save = saveWith({}, { c1: card('c1'), c2: card('c2'), c3: card('c3'), c4: card('c4') });
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = scene.buildPickEntries();
    const cardEntries = entries.filter((e) => e.cls === 'card');
    expect(cardEntries).toHaveLength(1);
    expect(cardEntries[0].label).toBe(`${scene.cardName('suyuan')} Lv.1 ×4`);
    scene.destroy();
  });

  it('keeps distinct defId/level combos as separate entries, and a lone instance has no "×N" suffix', () => {
    const save = saveWith(
      { e1: equip('e1'), e2: equip('e2'), e3: equip('e3', { defId: 'wp_marker', rarity: 'rare' }) },
      { c1: card('c1'), c2: card('c2', { defId: 'max', level: 5 }) },
    );
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = scene.buildPickEntries();
    const equipEntries = entries.filter((e) => e.cls === 'equipment');
    const cardEntries = entries.filter((e) => e.cls === 'card');
    expect(equipEntries).toHaveLength(2);
    expect(equipEntries.map((e) => e.label).sort()).toEqual(
      [`${scene.equipName('wp_pencil')} +0 ×2`, `${scene.equipName('wp_marker')} +0`].sort(),
    );
    expect(cardEntries).toHaveLength(2);
    expect(cardEntries.map((e) => e.label).sort()).toEqual(
      [`${scene.cardName('suyuan')} Lv.1`, `${scene.cardName('max')} Lv.5`].sort(),
    );
    scene.destroy();
  });

  it('picking a merged equipment entry resolves to one of the actual grouped instance ids', () => {
    const save = saveWith({ e1: equip('e1'), e2: equip('e2'), e3: equip('e3') }, {});
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = scene.buildPickEntries();
    entries.find((e) => e.cls === 'equipment')!.onPick();
    expect(scene.createClass).toBe('equipment');
    expect(['e1', 'e2', 'e3']).toContain(scene.createEquipId);
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
    const entries: PickEntry[] = scene.buildPickEntries();
    const cardEntry = entries.find((e) => e.cls === 'card')!;
    expect(cardEntry.locked).toBe(false);
    cardEntry.onPick();
    expect(scene.createCardId).toBe('c2');
    scene.destroy();
  });

  it('a card group where every instance is locked is itself marked locked', () => {
    const save = saveWith({}, { c1: card('c1', { locked: true }), c2: card('c2', { locked: true }) });
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = scene.buildPickEntries();
    expect(entries.find((e) => e.cls === 'card')!.locked).toBe(true);
    scene.destroy();
  });

  it('materials are unaffected by the equipment/card dedupe logic (still one entry per material type)', () => {
    const scene = buildScene();
    const entries: PickEntry[] = scene.buildPickEntries();
    expect(entries.filter((e) => e.cls === 'material')).toHaveLength(3); // scrap/lead/binding
    scene.destroy();
  });
});

describe('AuctionScene picker — real per-item icon wiring (defId carried through)', () => {
  it('equipment/card entries carry the defId needed to draw the real glyph/art, not a fixed class icon', () => {
    const save = saveWith({ e1: equip('e1', { defId: 'wp_marker', rarity: 'rare' }) }, { c1: card('c1', { defId: 'max', level: 3 }) });
    const scene = buildScene({ getSave: () => save });
    const entries: PickEntry[] = scene.buildPickEntries();
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
    expect(() => scene.openItemPicker()).not.toThrow();
    expect(scene.itemPickerOpen).toBe(true);
    scene.destroy();
  });

  it('renders exactly one card per distinct defId+level regardless of how many raw instances exist', () => {
    const save = saveWith({ e1: equip('e1'), e2: equip('e2'), e3: equip('e3') }, {});
    const scene = buildScene({ getSave: () => save });
    scene.openItemPicker();
    scene.pickerFilter = 'equipment';
    scene.render();
    // One rendered card == one hit rect beyond the fixed chrome (back button + sidebar tab rail).
    const pickHits = scene.hitRects.filter((h: { action: () => void }) => {
      // Sidebar-tab/back actions don't touch createEquipId; the picker card's onPick does.
      const before = scene.createEquipId;
      h.action();
      const touched = scene.createEquipId !== before || (before === null && scene.createEquipId !== null);
      scene.createEquipId = before; // restore, since some other hits might also be pressed by this loop
      return touched;
    });
    expect(pickHits).toHaveLength(1);
    scene.destroy();
  });
});
