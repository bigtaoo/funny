// Regression for the 15.08.2026 report: the auction house showed materials under a second, private set
// of names (`auction.scrap|lead|binding` → "废料/铅块/绑线") while the backpack, shop, gacha and stats
// screens all used `material.*` ("旧纸片/铅笔芯/装订线"). Same stack, two names. The auction.* synonyms
// are gone; every auction surface now reads the shared `material.*` keys.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree, no renderer.

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import { buildPickEntries, selectedItemLabel } from '../../src/scenes/AuctionScene/itemPickerRender';
import { auctionLabel } from '../../src/scenes/AuctionScene/itemLabels';
import type { WorldApiClient, AuctionView } from '../../src/net/WorldApiClient';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('zh', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 1280];
const MATS = ['scrap', 'lead', 'binding'] as const;

function stubWorldApi(): WorldApiClient {
  return {
    listAuctions: vi.fn(async () => [] as AuctionView[]),
    getMyListings: vi.fn(async () => [] as AuctionView[]),
    getAuctionRefBand: vi.fn(async () => ({ ref: 10, floor: 5, ceil: 20 })),
    createAuction: vi.fn(), buyAuction: vi.fn(), cancelAuction: vi.fn(), placeBid: vi.fn(),
  } as unknown as WorldApiClient;
}

// Scene internals are `protected`/`private` (mixin-internal); every other UI spec reaches them via an
// untyped handle rather than re-exposing them for tests, so we do the same.
function buildScene(): any {
  const { openTextInput } = createFakeTextInput();
  return new AuctionScene(createLayout(W, H), new InputManager(), { onBack() {}, worldApi: stubWorldApi(), openTextInput });
}

describe('AuctionScene — material names match the rest of the game', () => {
  it('picker entries use the shared material.* names', () => {
    const scene = buildScene();
    const labels = buildPickEntries(scene.core).filter((e: { cls: string }) => e.cls === 'material')
      .map((e: { label: string }) => e.label);
    expect(labels.sort()).toEqual(MATS.map((m) => t(`material.${m}`)).sort());
    scene.destroy();
  });

  it('the create-form selected-item label uses the shared material.* name', () => {
    const scene = buildScene();
    for (const mat of MATS) {
      scene.core.createClass = 'material';
      scene.core.createMaterial = mat;
      expect(selectedItemLabel(scene.core)).toBe(t(`material.${mat}`));
    }
    scene.destroy();
  });

  it('a material listing row reads "<shared name> ×qty"', () => {
    for (const mat of MATS) {
      const auc = { itemType: 'material', item: { material: mat }, qty: 7 } as unknown as AuctionView;
      expect(auctionLabel(auc)).toBe(`${t(`material.${mat}`)} ×7`);
    }
  });

  it('no auction.* material synonyms survive in any locale', () => {
    for (const lang of ['zh', 'en', 'de'] as const) {
      initI18n(lang, memStore, ['zh', 'en', 'de']);
      for (const mat of MATS) {
        // t() echoes the key back when it is missing — that is exactly what we want here.
        expect(t(`auction.${mat}` as never)).toBe(`auction.${mat}`);
      }
    }
    initI18n('zh', memStore, ['zh', 'en', 'de']);
  });
});
