// Regression test for "the new 养成/商城 icons are almost invisible on the home screen" (15.08.2026).
//
// The five bottom-nav slots draw AI raster tab icons, whose colour is baked at PACK time into two
// variants: a white one for dark fills and a #686868 one for paper fills (see design/product/
// tab-icon-art-prompts.md). `buildIcon(kind, size, color)` therefore can't tint — it uses `color`
// only to pick a variant, via `tabIconVariant()`. The nav bar is filled with `C.cover` (near-black),
// so every slot on it MUST ask for an ink that resolves to the white variant; the bug was that
// non-active slots asked for `C.light` and disabled ones for `C.mid`, and the old strict
// `color === 0xffffff` pick handed both the paper-grey art, which vanished into the bar (worst on
// the thin-lined roster/gacha glyphs — the icons the user actually reported).
//
// tabIconVariant()'s own threshold is pinned from both sides in test/render/icons.test.ts. This file
// covers the other half — what the call site actually passes — which no unit test of the helper can
// see. Asserting the resolved VARIANT rather than an exact hex keeps it a legibility contract: any
// ink that still reads as white-on-dark passes, a palette swap that quietly darkens the slots fails.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { buildIcon, tabIconVariant, type IconKind } from '../../src/render/icons';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import type { LobbySceneCallbacks } from '../../src/scenes/LobbyScene/core';

// Wrap-don't-replace (same treatment as mailAttachmentIcons.ui.ts's cardArt mock): the real icon is
// still built, we only need to read back which ink each call site asked for. The stubbed 1×1 PNG the
// UI harness resolves every asset import to makes the two variants indistinguishable downstream, so
// the call arguments are the only place this is observable here.
vi.mock('../../src/render/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/icons')>();
  return { ...actual, buildIcon: vi.fn(actual.buildIcon) };
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

/** The five fixed bottom-nav slots (bottomNav.ts), in left-to-right order. Each kind is used by that
 *  bar only, so filtering the lobby's buildIcon calls by kind isolates the bar from the rest of it. */
const NAV_ICONS: IconKind[] = ['rosterIcon', 'gachaTabIcon', 'homeTabIcon', 'statsTabIcon', 'socialTabIcon'];

function buildLobby(extra: Partial<LobbySceneCallbacks> = {}): void {
  new LobbyScene(createLayout(800, 1280), new InputManager(), {
    onStartGame() {}, onOpenCampaign() {}, onOpenRoom() {}, onOpenShop() {},
    onOpenCards() {}, onOpenStats() {}, onOpenProfile() {},
    playerName: 'Tester',
    ...extra,
  });
}

/** Every ink the bottom nav asked for, keyed by slot icon — one entry per slot that drew. */
function navInks(): Map<IconKind, number[]> {
  const out = new Map<IconKind, number[]>();
  for (const [kind, , color] of vi.mocked(buildIcon).mock.calls) {
    if (!NAV_ICONS.includes(kind)) continue;
    out.set(kind, [...(out.get(kind) ?? []), color]);
  }
  return out;
}

describe('lobby bottom nav — every slot asks for an ink readable on the dark bar', () => {
  for (const offline of [false, true]) {
    it(`resolves all five slots to the white-ink variant (${offline ? 'offline: shop/stats/social greyed' : 'online'})`, () => {
      vi.mocked(buildIcon).mockClear();
      buildLobby({ offline, online: !offline, onLogin() {} });

      const inks = navInks();
      // Guards the filter itself: if a slot ever stops drawing (or is renamed), the variant assertion
      // below would pass vacuously for it.
      expect([...inks.keys()].sort()).toEqual([...NAV_ICONS].sort());

      for (const [kind, colors] of inks) {
        for (const color of colors) {
          expect(tabIconVariant(color), `${kind} asked for #${color.toString(16)}`).toBe('active');
        }
      }
    });
  }
});

// NOT covered here: that the slots still read as active/normal/disabled. The fix moved that
// distinction off the ink colour and onto `icon.alpha` (1.0 / 0.85 / 0.35 in bottomNav.ts), and the
// icon containers aren't addressable from outside the bar without pinning its child order, which is
// layout trivia this test has no business freezing.
