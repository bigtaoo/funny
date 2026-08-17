// One control drawn twice: portrait and landscape take DIFFERENT code paths for the same tab strip
// (LOBBY_IA_REDESIGN §18 turned left rails into bottom bars / header strips), and each path used to
// build its own tab array. Wiring an icon into one of them and calling it done is a real, already-hit
// bug: batch 5 gave Equipment's Inventory/Craft cells their backpack/anvil glyphs in
// `InventoryPanel.renderSidebar` (landscape's `drawSidebarTabs`) and portrait's header strip
// (`EquipmentScene.renderHeaderRow`'s `drawHubTabs`) silently stayed label-only — invisible to the
// whole UI suite, caught only by a real 430×932 capture. Both now read one table (`EQUIP_SUBTABS`),
// and this pins the property that made the bug possible instead of the table that currently fixes it.
//
// Asserts on the ICON KINDS ACTUALLY REQUESTED while rendering, not on geometry: `buildIcon` is
// spied (wrap-don't-replace, same treatment as sceneHeaderTitleIcon.ui.ts) so this stays indifferent
// to where each path puts the glyph — rail cell, bottom-nav cell or header strip — and only cares
// that the picture is asked for at all. Under the headless harness the raster texture never decodes,
// so nothing downstream of the call is observable anyway.
//
// Run: npm run test:ui

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import type { IconKind } from '../../src/render/icons';

vi.mock('../../src/render/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/icons')>();
  return { ...actual, buildIcon: vi.fn(actual.buildIcon) };
});

import { buildIcon } from '../../src/render/icons';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { DailyScene, type DailyCallbacks } from '../../src/scenes/DailyScene';
import { makeNewSave, type SaveData } from '../../src/game/meta/SaveData';
import type { RetentionView } from '../../src/net/ApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// Physical sizes, not design units: which branch a scene takes is decided by the layout's
// orientation, so a real phone portrait and a real desktop landscape are the two cases that matter.
const PORTRAIT: [number, number] = [430, 932];
const LANDSCAPE: [number, number] = [1280, 800];

/** Every `IconKind` `buildIcon` was asked for since the last reset. */
function requestedKinds(): Set<IconKind> {
  return new Set(vi.mocked(buildIcon).mock.calls.map((c) => c[0]));
}

beforeEach(() => { vi.mocked(buildIcon).mockClear(); });

function buildEquipment(w: number, h: number): EquipmentScene {
  const save = makeNewSave('acc_test');
  save.cardInv = {
    card1: { id: 'card1', defId: 'lichuang', level: 1, gear: {}, locked: false },
  };
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: 'card1',
    // The growth-group peer tabs ([Cards | Equipment | Skins]) are what make landscape draw its
    // sidebar rail at all — without them `renderSidebar` early-returns in portrait and draws only
    // the sub-tabs in landscape, so the two branches wouldn't be comparable.
    peerTab: { labelKey: 'roster.title', icon: 'rosterIcon', onSelect() {} },
    trailingPeers: [{ labelKey: 'roster.tab.skins', icon: 'skinIcon', onSelect() {} }],
  };
  return new EquipmentScene(createLayout(w, h), new InputManager(), cb);
}

function buildDaily(w: number, h: number): DailyScene {
  const retention: RetentionView = {
    checkin: null, daily: null, weekly: null,
    defs: { rewards: [], tasks: [], pointsThreshold: 3, dailyCoinsReward: 5, weeklyChestTiers: [] },
    claimable: { checkin: false, daily: false, weeklyTiers: [] },
    ads: { watchedToday: 0, cap: 5, rewardCoins: 10, cooldownMs: 0, nextAvailableAt: 0 },
  };
  const save: SaveData = makeNewSave('acc_test');
  const cb: DailyCallbacks = {
    onBack() {},
    getSave: () => save,
    getRetention: () => Promise.resolve(retention),
    // Present so the ads tab isn't hidden — it's dropped entirely on platforms with no real ad
    // integration (IPlatform.hasRewardedAd), which is why a web capture can never show its glyph.
    onWatchAd: async () => ({ ok: true, coins: 10 }) as never,
  };
  return new DailyScene(createLayout(w, h), new InputManager(), cb);
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('tab-icon wiring is orientation-independent', () => {
  describe.each([['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const)('%s', (_label, [w, h]) => {
    it('EquipmentScene asks for the Inventory/Craft glyphs and all four slot-filter glyphs', () => {
      const scene = buildEquipment(w, h);
      const kinds = requestedKinds();
      // Inventory/Craft: landscape's sidebar rail vs portrait's header strip — the two arrays that
      // used to drift. Slot filter: one hand-rolled strip, but its cells are drawn from the same
      // per-orientation render pass, so a future §18-style split would break here too.
      for (const kind of ['bagTabIcon', 'craftTabIcon', 'allTabIcon', 'weaponTabIcon', 'armorslotTabIcon', 'trinketTabIcon'] as const) {
        expect(kinds, `${kind} never requested`).toContain(kind);
      }
      scene.destroy();
    });

    it('DailyScene asks for each of its four tab glyphs', async () => {
      const scene = buildDaily(w, h);
      await flush();
      const kinds = requestedKinds();
      // checkin is also the header title's glyph (the tab table feeds both), so its presence alone
      // wouldn't prove the strip is wired — the other three only exist as tab cells on first render.
      for (const kind of ['checkinTabIcon', 'tasksTabIcon', 'weeklyTabIcon', 'adsTabIcon'] as const) {
        expect(kinds, `${kind} never requested`).toContain(kind);
      }
      scene.destroy();
    });
  });
});
