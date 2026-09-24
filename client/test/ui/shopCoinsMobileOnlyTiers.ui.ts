// Regression coverage for the 2026-09-23 fix (design/game/ECONOMY_BALANCE.md §2.2 / COMMERCIAL_DESIGN
// §IAP): before, the Coins grid hardcoded the Paddle-only 5-tier list and never rendered the two
// mobile-only tiers (t099/t199) anywhere — including on native, where Apple/Google (not Paddle) take
// the fee and the tiers stop being uneconomic. The fix threads a platform flag through two spots that
// had no test: CoinsPanel.drawCoinsGrid's filter on `core.cb.includeMobileOnlyCoinTiers`
// (src/scenes/ShopScene/coins.ts) and nav.ts's wiring of that flag to
// `platform.iapKind() === 'apple' || 'google'` (src/app/nav/shop/nav.ts). An inverted filter would
// either hide two paid tiers on mobile or leak them onto web where Paddle's fee eats the margin.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { ShopScene } from '../../src/scenes/ShopScene';
import { createShopNav } from '../../src/app/nav/shop';
import type { AppCtx, AppState, Nav } from '../../src/app/appCtx';
import type { IPlatform, IStorage } from '../../src/platform/IPlatform';
import type { ApiClient } from '../../src/net/ApiClient';
import { SaveManager } from '../../src/game/meta/SaveManager';
import { LocalSaveStore } from '../../src/game/meta/SaveStore';
import { makeNewSave } from '../../src/game/meta/SaveData';
import { TOKEN_KEY } from '../../src/app/appConstants';
import { HeadlessAppViews } from '../harness/HeadlessAppViews';

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

function tierTitles(scene: ShopScene): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(scene.container);
  return out;
}

function buildCoinsScene(includeMobileOnlyCoinTiers?: boolean): ShopScene {
  return new ShopScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    getOwnedSkins: () => [],
    loadItems: async () => [],
    buy: async () => ({ ok: true }),
    openGacha() {},
    rechargeCoins: async () => ({ ok: true }),
    initialTab: 'coins',
    includeMobileOnlyCoinTiers,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

describe('CoinsPanel — mobile-only tiers (t099/t199) only render when the platform can sell them', () => {
  it('default (web/no flag): the 5 Paddle tiers render, t099/t199 do not', () => {
    const scene = buildCoinsScene();
    const titles = tierTitles(scene);
    expect(titles).not.toContain('$0.99');
    expect(titles).not.toContain('$1.99');
    expect(titles).toContain('$4.99');
    expect(titles).toContain('$99.99');
    scene.destroy();
  });

  it('includeMobileOnlyCoinTiers=true (apple/google): all 7 tiers render, including t099/t199', () => {
    const scene = buildCoinsScene(true);
    const titles = tierTitles(scene);
    expect(titles).toContain('$0.99');
    expect(titles).toContain('$1.99');
    expect(titles).toContain('$4.99');
    scene.destroy();
  });
});

class MemStorage implements IStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

// logged in + online, mirroring shopNav-buySubscription.test.ts's buildShopNav: includeMobileOnlyCoinTiers
// is only ever set alongside rechargeCoins (shopLoggedIn && platform.iapKind() !== null in nav.ts), so
// this is the one state where the flag's value is actually observable.
function includeFlagFor(iapKind: 'paddle' | 'apple' | 'google' | null): boolean | undefined {
  const storage = new MemStorage();
  storage.setItem(TOKEN_KEY, 'test-token');
  const platform = { storage, iapKind: () => iapKind } as unknown as IPlatform;
  const fakeApi = { hasToken: () => true, async getSave() { return { save: makeNewSave() }; } } as unknown as ApiClient;
  const saveManager = new SaveManager({ store: new LocalSaveStore(storage), api: fakeApi });
  const views = new HeadlessAppViews();
  const state: AppState = {
    inLobby: true, offlineMode: false, gatewayUrl: null, netSession: null,
    firstLobbyHandled: false, socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false,
    shopCardClaimable: false, achievementReached: null,
  };
  const nav = {} as Nav;
  nav.goLobby = () => {};
  const ctx: AppCtx = {
    platform, views, api: fakeApi, baseUrl: null, saveManager, replayStore: {} as AppCtx['replayStore'],
    featureFlags: null, state, nav, getNetSession: () => null, applyGatewayUrl: () => {},
    playerName: () => 'tester', avatarId: () => undefined, gateConsent: (next) => next(),
    resolvePvpDeck: () => [], keepReplay: (r) => r, resolveWorldShard: () => {},
  };
  Object.assign(nav, createShopNav(ctx));
  nav.goShop();
  return views.shop?.includeMobileOnlyCoinTiers;
}

describe('createShopNav — includeMobileOnlyCoinTiers wiring (src/app/nav/shop/nav.ts)', () => {
  it('apple/google → true; web (paddle) and no channel (null) → falsy', () => {
    expect(includeFlagFor('apple')).toBe(true);
    expect(includeFlagFor('google')).toBe(true);
    expect(includeFlagFor('paddle')).toBeFalsy();
    expect(includeFlagFor(null)).toBeFalsy();
  });
});
