// Regression coverage for the gacha draw lean-response wiring (2026-07-28, EQUIPMENT_DESIGN §3.3
// phase-2-for-gacha correction): shop.ts's `draw()` callback must adopt the response via
// `SaveManager.adoptServerPartial` (patching cardGrants/equipmentGrants onto the existing local
// cardInv/equipmentInv), never the plain `adoptServer` — `save.cardInv`/`equipmentInv` on this response
// are always `null`, and adoptServer would wholesale-replace the local inventory with that `null`,
// wiping out every card/equipment instance the account already had.
import { describe, it, expect } from 'vitest';
import { createShopNav } from '../src/app/nav/shop';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { IPlatform, IStorage } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { makeNewSave } from '../src/game/meta/SaveData';
import type { CardInstance, EquipmentInstance } from '../src/game/meta/SaveData';
import { TOKEN_KEY } from '../src/app/appConstants';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

class MemStorage implements IStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

const EXISTING_CARD: CardInstance = { id: 'card_existing', defId: 'lichuang', level: 1, gear: {}, locked: false };
const EXISTING_EQUIP: EquipmentInstance = { id: 'eq_existing', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
const NEW_CARD: CardInstance = { id: 'card_new', defId: 'suyuan', level: 1, gear: {}, locked: false };
const NEW_EQUIP: EquipmentInstance = { id: 'eq_new', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [] };

/** Same construction as shopNav-peerBadges.test.ts, plus a fake gachaDraw returning a lean response. */
function buildShopNav(gachaDraw: ApiClient['gachaDraw']): { views: HeadlessAppViews; saveManager: SaveManager } {
  const storage = new MemStorage();
  storage.setItem(TOKEN_KEY, 'test-token');
  const platform = { storage, iapKind: () => null } as unknown as IPlatform;
  const saveManager = new SaveManager({ store: new LocalSaveStore(storage) });
  saveManager.adoptServer({
    ...makeNewSave(),
    rev: 1,
    cardInv: { [EXISTING_CARD.id]: EXISTING_CARD },
    equipmentInv: { [EXISTING_EQUIP.id]: EXISTING_EQUIP },
  });

  const views = new HeadlessAppViews();
  const state: AppState = {
    inLobby: true, offlineMode: false, gatewayUrl: null, netSession: null,
    firstLobbyHandled: false, socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false,
    shopCardClaimable: false, achievementReached: null,
  };
  const nav = {} as Nav;
  nav.goLobby = () => {};

  const ctx: AppCtx = {
    platform,
    views,
    api: { gachaDraw } as unknown as ApiClient,
    baseUrl: null,
    saveManager,
    replayStore: {} as AppCtx['replayStore'],
    featureFlags: null,
    state,
    nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };
  Object.assign(nav, createShopNav(ctx));
  nav.goGacha({ shopBack: () => {} });
  return { views, saveManager };
}

describe('shop.ts draw(): adopts the lean gacha response via adoptServerPartial, never adoptServer', () => {
  it('merges cardGrants/equipmentGrants onto the existing inventory, keeping prior instances', async () => {
    const { views, saveManager } = buildShopNav(async () => ({
      save: { ...makeNewSave(), rev: 2, cardInv: null, equipmentInv: null },
      results: [{ itemId: 'suyuan', rarity: 'epic' }, { itemId: 'wp_marker', rarity: 'rare' }],
      overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 },
      cardGrants: [NEW_CARD],
      equipmentGrants: [NEW_EQUIP],
    }));

    const result = await views.gacha!.draw('standard', 1);
    expect(result.ok).toBe(true);

    const save = saveManager.get();
    // The newly-granted instances landed...
    expect(save.cardInv[NEW_CARD.id]).toEqual(NEW_CARD);
    expect(save.equipmentInv[NEW_EQUIP.id]).toEqual(NEW_EQUIP);
    // ...without wiping out what was already there (the bug a plain adoptServer(save) would cause,
    // since this response's save.cardInv/equipmentInv are null).
    expect(save.cardInv[EXISTING_CARD.id]).toEqual(EXISTING_CARD);
    expect(save.equipmentInv[EXISTING_EQUIP.id]).toEqual(EXISTING_EQUIP);
    expect(Object.keys(save.cardInv)).toHaveLength(2);
    expect(Object.keys(save.equipmentInv)).toHaveLength(2);
  });

  it('a draw that grants nothing new (skins/materials only) leaves the existing inventory untouched', async () => {
    const { views, saveManager } = buildShopNav(async () => ({
      save: { ...makeNewSave(), rev: 2, cardInv: null, equipmentInv: null },
      results: [{ itemId: 'mat_scrap', rarity: 'common' }],
      overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 },
      cardGrants: [],
      equipmentGrants: [],
    }));

    await views.gacha!.draw('standard', 1);

    const save = saveManager.get();
    expect(save.cardInv).toEqual({ [EXISTING_CARD.id]: EXISTING_CARD });
    expect(save.equipmentInv).toEqual({ [EXISTING_EQUIP.id]: EXISTING_EQUIP });
  });

  it('a rejected draw (insufficient funds) never touches the local inventory', async () => {
    const { views, saveManager } = buildShopNav(async () => {
      throw Object.assign(new Error('not enough coins'), { code: 'INSUFFICIENT_FUNDS' });
    });

    const result = await views.gacha!.draw('standard', 1);
    expect(result.ok).toBe(false);

    const save = saveManager.get();
    expect(save.cardInv).toEqual({ [EXISTING_CARD.id]: EXISTING_CARD });
    expect(save.equipmentInv).toEqual({ [EXISTING_EQUIP.id]: EXISTING_EQUIP });
  });
});
