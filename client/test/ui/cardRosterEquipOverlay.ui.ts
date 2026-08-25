// Regression coverage for ADR-072 — EquipmentScene opens as an OVERLAY on top of a still-live
// CardScene instead of replacing it.
//
// The bug: tapping a gear slot in the roster's detail modal ran `core.closeModal()` and navigated to
// EquipmentScene as a full scene swap, and its back handler re-entered `goCardRoster` — building a
// brand-new CardScene. A player equipping three pieces onto one card therefore had to scroll the
// roster back down and re-open that card's detail after every single piece (2026-08-25 report).
//
// The fix moves the whole detour under SceneManager.pushOverlay, which means this scene has to
// survive being covered. That imposes four properties, all pinned here:
//   1. pause() suspends ONLY the pointer subscriptions — InputManager broadcasts to every
//      subscriber regardless of z-order, so a tap meant for the overlay must not also run the
//      roster's hit rects underneath it.
//   2. pause() does NOT drop the save subscription. Every equip/unequip up there writes the save,
//      and this scene has to fold those in or the player pops back to stale power/gear readouts.
//   3. a render() requested while covered is deferred, not run: the overlay's actions each ping
//      onSaveChanged, and an unguarded pass would rebuild the whole roster per equip, behind an
//      opaque panel. resume() flushes exactly one pass off the final save.
//   4. scrollY + the open detail modal survive the round trip — the actual user-visible point.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import type * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { makeNewSave, type SaveData, type CardInstance, type EquipSlot } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

interface Rect { x: number; y: number; w: number; h: number; }
interface SceneInternals {
  core: {
    tab: 'list' | 'skins';
    scrollY: number;
    maxScroll: number;
    scrollRegionTop: number;
    scrollRegionBottom: number;
    detailId: string | null;
    modalOpen: boolean;
    modalHits: { rect: Rect; action: () => void }[];
    hitRects: { rect: Rect; action: () => void; owner?: string }[];
    backRect: Rect;
    paused: boolean;
    pendingRender: boolean;
    modalLayer: PIXI.Container;
  };
  detail: { openDetail(id: string): void };
}

interface Harness {
  scene: CardScene;
  core: SceneInternals['core'];
  detail: SceneInternals['detail'];
  input: InputManager;
  save: SaveData;
  openEquipment: ReturnType<typeof vi.fn>;
  onBack: ReturnType<typeof vi.fn>;
  /** Unsub handed back by cb.onSaveChanged — pause() must never call this (property 2). */
  unsubSave: ReturnType<typeof vi.fn>;
  /** Fire the save-change ping the way SaveManager would after an equip lands. */
  notifySave(): void;
}

function makeCard(id: string): CardInstance {
  return { id, defId: 'max', level: 3, gear: {}, locked: false };
}

/** 30 cards so the roster grid is genuinely taller than the viewport and scrollY can be non-zero. */
function buildScene(): Harness {
  const save = makeNewSave();
  save.cardInv = {};
  for (let i = 0; i < 30; i++) save.cardInv[`c${i}`] = makeCard(`c${i}`);
  const openEquipment = vi.fn();
  const onBack = vi.fn();
  const unsubSave = vi.fn();
  let saveListener: (() => void) | null = null;
  const cb: CardCallbacks = {
    onBack,
    getSave: () => save,
    onSaveChanged: (listener) => { saveListener = listener; return unsubSave; },
    fuseCards: async () => ({ ok: true }),
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
    openEquipment,
  };
  const input = new InputManager();
  const scene = new CardScene(createLayout(1920, 1080), input, cb);
  const internals = scene as unknown as SceneInternals;
  return {
    scene,
    core: internals.core,
    detail: internals.detail,
    input,
    save,
    openEquipment,
    onBack,
    unsubSave,
    notifySave: () => saveListener?.(),
  };
}

/** Emit a tap (down+up at the same point) the way a platform adapter would. */
function tap(input: InputManager, x: number, y: number): void {
  (input as unknown as { _emitDown(x: number, y: number): void })._emitDown(x, y);
  (input as unknown as { _emitUp(x: number, y: number): void })._emitUp(x, y);
}

/** Scroll the roster down by a wheel notch, the PC path (wheelScroll.ts). */
function wheelDown(h: Harness): void {
  const midY = (h.core.scrollRegionTop + h.core.scrollRegionBottom) / 2;
  (h.input as unknown as { _emitWheel(x: number, y: number, d: number): void })._emitWheel(960, midY, 400);
}

describe('CardScene under an EquipmentScene overlay (ADR-072)', () => {
  it('pause() suspends pointer input; resume() takes it back', () => {
    const h = buildScene();
    const { x, y, w, h: bh } = h.core.backRect;
    const [cx, cy] = [x + w / 2, y + bh / 2];

    tap(h.input, cx, cy);
    expect(h.onBack).toHaveBeenCalledTimes(1); // sanity: that point really is the Back button

    h.scene.pause();
    tap(h.input, cx, cy);
    expect(h.onBack).toHaveBeenCalledTimes(1); // the tap belonged to the overlay, not to us

    h.scene.resume();
    tap(h.input, cx, cy);
    expect(h.onBack).toHaveBeenCalledTimes(2);

    h.scene.destroy();
  });

  it('pause() keeps the save subscription — it is dropped only at destroy()', () => {
    const h = buildScene();
    h.scene.pause();
    // The trap this pins: unsubscribing everything in pause() (the obvious implementation) would
    // leave the roster frozen on the pre-equip save for the whole detour.
    expect(h.unsubSave).not.toHaveBeenCalled();
    h.scene.resume();
    expect(h.unsubSave).not.toHaveBeenCalled();
    h.scene.destroy();
    expect(h.unsubSave).toHaveBeenCalledTimes(1);
  });

  it('defers renders requested while covered, then flushes exactly one on resume', () => {
    const h = buildScene();
    h.detail.openDetail('c0');
    h.scene.pause();

    // Three equips up in the overlay → three save pings. None of them may render: nothing is visible.
    h.notifySave();
    h.notifySave();
    h.notifySave();
    expect(h.core.pendingRender).toBe(true);
    expect(h.core.paused).toBe(true);

    h.scene.resume();
    expect(h.core.pendingRender).toBe(false);
    expect(h.core.paused).toBe(false);
    // The flush really redrew (the detail panel is still on screen, rebuilt off the final save).
    expect(h.core.modalOpen).toBe(true);
    expect(h.core.modalHits.length).toBeGreaterThan(0);

    h.scene.destroy();
  });

  it('keeps the scroll offset and the open detail modal across the whole detour', () => {
    const h = buildScene();
    wheelDown(h);
    expect(h.core.maxScroll).toBeGreaterThan(0); // sanity: 30 cards really do overflow the viewport
    const scrolled = h.core.scrollY;
    expect(scrolled).toBeGreaterThan(0);

    h.detail.openDetail('c7');
    expect(h.core.detailId).toBe('c7');

    // …tap a gear slot → overlay opens → equip lands (save ping) → overlay pops.
    h.scene.pause();
    h.notifySave();
    h.scene.resume();

    expect(h.core.scrollY).toBe(scrolled);
    expect(h.core.detailId).toBe('c7');
    expect(h.core.modalOpen).toBe(true);

    h.scene.destroy();
  });

  it('a gear-slot tap in the detail modal no longer closes it', () => {
    // Pre-ADR-072 the action was `core.closeModal(); openEquipment(...)`. With the equipment screen
    // overlaid rather than swapped in, the modal stays up underneath and is what the player lands
    // back on. Which modalHit is a gear slot isn't knowable from the outside, so probe each one on
    // its own scene and assert the property on whichever ones do call openEquipment.
    const probe = buildScene();
    probe.detail.openDetail('c0');
    const hitCount = probe.core.modalHits.length;
    probe.scene.destroy();

    const slotsSeen: EquipSlot[] = [];
    for (let i = 0; i < hitCount; i++) {
      const h = buildScene();
      h.detail.openDetail('c0');
      h.core.modalHits[i]!.action();
      if (h.openEquipment.mock.calls.length > 0) {
        const [cardId, slot] = h.openEquipment.mock.calls[0]! as [string, EquipSlot];
        expect(cardId).toBe('c0');
        expect(h.core.modalOpen).toBe(true);
        expect(h.core.detailId).toBe('c0');
        slotsSeen.push(slot);
      }
      h.scene.destroy();
    }
    expect(slotsSeen.sort()).toEqual(['armor', 'trinket', 'weapon']);
  });

  it('showTab() moves a live roster to the wardrobe without a rebuild', () => {
    // The Skins peer in the overlay's own rail pops back to this scene and calls showTab('skins'),
    // instead of the old goCardRoster(back, 'skins') full rebuild.
    const h = buildScene();
    expect(h.core.tab).toBe('list');
    h.scene.showTab('skins');
    expect(h.core.tab).toBe('skins');
    h.scene.showTab('skins'); // idempotent
    expect(h.core.tab).toBe('skins');
    h.scene.destroy();
  });
});
