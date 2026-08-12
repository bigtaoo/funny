// Coverage for the bag-mode "assign to card" picker being an icon-card GRID (mirroring the Hero
// Roster) instead of the old full-width one-per-row list (2026-07-18). Entering assign mode
// (beginAssign) must lay the candidate cards out in multiple columns per row, each cell a fixed
// portrait-tall card, with a per-card hit action that equips onto that card.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData } from '../../src/game/meta/SaveData';
import { cardInstanceArtUrl } from '../../src/render/cardArt';
import { skinEquipKey } from '../../src/game/meta/skinDefs';
import { UnitType } from '@nw/engine/types';

// Every export passes through untouched except cardInstanceArtUrl, wrapped in vi.fn (keeping its
// real implementation) so the 2026-08-01-scoping spec below can inspect call arguments.
vi.mock('../../src/render/cardArt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/cardArt')>();
  return { ...actual, cardInstanceArtUrl: vi.fn(actual.cardInstanceArtUrl) };
});

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const LANDSCAPE: [number, number] = [1280, 800];
// Cell height from assign.ts (PICK_CELL_H) — the picker cells are portrait-tall, unlike the old rows.
const PICK_CELL_H = 266;

interface Rect { x: number; y: number; w: number; h: number; }
interface SceneInternals {
  core: { hitRects: { rect: Rect; action: () => void }[] };
  assign: { beginAssign(instId: string, slot: 'weapon' | 'armor' | 'trinket'): void };
}

function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  // A dozen distinct heroes so the grid must wrap into multiple columns and rows.
  save.cardInv = {};
  for (let i = 0; i < 12; i++) {
    const id = `card_${i}`;
    save.cardInv[id] = { id, defId: 'lichuang', level: (i % 5) + 1, gear: {}, locked: false };
  }
  // One bag weapon to assign.
  save.equipmentInv = {
    inst_wp: { id: 'inst_wp', defId: 'wp_pencil', rarity: 'rare', level: 3, affixes: [], locked: true },
  };
  return save;
}

function buildScene(w: number, h: number): EquipmentScene {
  const save = buildSave();
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '', // bag mode ⇒ Equip prompts for a card (assign flow)
  };
  return new EquipmentScene(createLayout(w, h), new InputManager(), cb);
}

function groupByRow(cells: Rect[]): Rect[][] {
  const rows = new Map<number, Rect[]>();
  for (const r of cells) {
    const row = rows.get(r.y) ?? [];
    row.push(r);
    rows.set(r.y, row);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row.sort((a, b) => a.x - b.x));
}

describe('EquipmentScene — assign picker renders as an icon-card grid', () => {
  it('lays candidate cards into multiple columns per row (not a one-per-row list)', () => {
    const scene = buildScene(...LANDSCAPE);
    const internals = scene as unknown as SceneInternals;
    internals.assign.beginAssign('inst_wp', 'weapon');

    const cells = internals.core.hitRects.map((h) => h.rect).filter((r) => r.h === PICK_CELL_H);
    expect(cells.length).toBe(12); // one hit per candidate card

    const rows = groupByRow(cells);
    // The whole point of the change: several cards share a row (grid), and the grid wraps to >1 row.
    expect(rows.length).toBeGreaterThan(1);
    expect(Math.max(...rows.map((r) => r.length))).toBeGreaterThan(1);
    // All cells in a row share the same width (uniform grid columns).
    for (const row of rows) {
      for (const c of row) expect(c.w).toBeCloseTo(row[0].w, 3);
    }
    scene.destroy();
  });

  it('tapping a card cell invokes an equip action for that card', async () => {
    const scene = buildScene(...LANDSCAPE);
    const internals = scene as unknown as SceneInternals;
    let equippedTo: string | null = null;
    // Wrap the save callback's equip to capture the target card id.
    const save = buildSave();
    const cb: EquipmentCallbacks = {
      onBack() {},
      getSave: () => save,
      craft: async () => ({ ok: true }),
      enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }),
      equip: async (_slot, _inst, cardId) => { equippedTo = cardId; return { ok: true }; },
      reforge: async () => ({ ok: true }),
      activeCardInstanceId: '',
    };
    const scene2 = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const int2 = scene2 as unknown as SceneInternals;
    int2.assign.beginAssign('inst_wp', 'weapon');
    const cellHit = int2.core.hitRects.find((h) => h.rect.h === PICK_CELL_H);
    expect(cellHit).toBeTruthy();
    cellHit!.action();
    await Promise.resolve();
    expect(equippedTo).not.toBeNull();
    scene.destroy();
    scene2.destroy();
  });
});

// Regression coverage for the 2026-08-01 scoping decision (UI_DESIGN.md §27 addendum): the
// equip-to-card picker must always show a candidate card's base portrait, never whichever skin is
// equipped for its unit type — this view answers "which of my cards is this," not "what does my
// army look like." Asserted on call arguments (not the rendered texture — headless PIXI stubs every
// binary asset to the same 1×1 PNG data URI).
describe('EquipmentScene — assign picker always uses the base portrait, never an equipped skin', () => {
  it('passes only the card, never an equipped-skin map, even when the account has a skin equipped', () => {
    const save = buildSave();
    save.equipped = { [skinEquipKey(UnitType.Infantry)]: 'skin_shop_c1' };
    const cb: EquipmentCallbacks = {
      onBack() {},
      getSave: () => save,
      craft: async () => ({ ok: true }),
      enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }),
      equip: async () => ({ ok: true }),
      reforge: async () => ({ ok: true }),
      activeCardInstanceId: '',
    };
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const spy = cardInstanceArtUrl as unknown as { mock: { calls: unknown[][] } };
    spy.mock.calls.length = 0;
    (scene as unknown as SceneInternals).assign.beginAssign('inst_wp', 'weapon');

    const cardCalls = spy.mock.calls.filter((call) => (call[0] as { defId?: string } | undefined)?.defId === 'lichuang');
    expect(cardCalls.length).toBeGreaterThan(0);
    for (const call of cardCalls) expect(call.length === 1 || call[1] === undefined).toBe(true);
    scene.destroy();
  });
});
