// Regression test for the "族长无法创建帮会 / hub leader-gating broken" bug (14.07.2026).
//
// The family hub, sect hub, world map and auction house all identify "me" via `myAccountId`,
// which app/nav/world.ts used to read from platform.storage.getItem('nw_account_id') — a key
// that is NEVER written in the client (phantom read since the first SLG commit). As a result
// every leader/ownership check (FamilyScene promote/kick, SectScene isFamilyLeader/isSectLeader,
// auction "my listings") silently failed. Fixed to read the authoritative cloud-save identity
// saveManager.get().accountId.
//
// This test pins the nav-factory boundary: each entry point must forward save.accountId — and
// specifically NOT whatever happens to sit under the phantom storage key. To make that distinction
// sharp, storage returns a different sentinel than the save.
import { describe, it, expect } from 'vitest';
import { createWorldNav } from '../src/app/nav/world';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { FamilySceneCallbacks } from '../src/scenes/FamilyScene';
import type { SectSceneCallbacks } from '../src/scenes/SectScene';
import type { AuctionSceneCallbacks } from '../src/scenes/AuctionScene';
import { WorldApiClient } from '../src/net/WorldApiClient';

const SAVE_ACCOUNT_ID = 'acct_from_save';
const PHANTOM_STORAGE_VALUE = 'phantom_should_be_ignored';

function buildCtx(): {
  ctx: AppCtx;
  getFamilyCb: () => FamilySceneCallbacks;
  getSectCb: () => SectSceneCallbacks;
  getAuctionCb: () => AuctionSceneCallbacks;
} {
  let familyCb: FamilySceneCallbacks | null = null;
  let sectCb: SectSceneCallbacks | null = null;
  let auctionCb: AuctionSceneCallbacks | null = null;

  const storage = {
    // Any getItem (incl. the phantom 'nw_account_id') returns a sentinel that must NOT leak
    // into myAccountId — the token read for auction entry is non-empty so the gate passes.
    getItem: (): string | null => PHANTOM_STORAGE_VALUE,
    setItem: (): void => {},
    removeItem: (): void => {},
  };

  const views = {
    showFamily: (cb: FamilySceneCallbacks) => { familyCb = cb; },
    showSect: (cb: SectSceneCallbacks) => { sectCb = cb; return { applySectMsg() {} }; },
    showAuction: (cb: AuctionSceneCallbacks) => { auctionCb = cb; },
    showWorldMap: () => ({ applyMarchUpdate() {}, applyTileUpdate() {}, applyUnderAttack() {}, applySiegeResult() {} }),
  } as unknown as AppViews;

  const ctx: AppCtx = {
    platform: { storage } as unknown as AppCtx['platform'],
    views,
    api: {} as unknown as AppCtx['api'],
    baseUrl: null,
    saveManager: { get: () => ({ accountId: SAVE_ACCOUNT_ID, wallet: { coins: 0 } }) } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: {} as unknown as AppState,
    nav: { goFriends: () => {} } as unknown as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'Tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  return {
    ctx,
    getFamilyCb: () => { if (!familyCb) throw new Error('views.showFamily was not called'); return familyCb; },
    getSectCb: () => { if (!sectCb) throw new Error('views.showSect was not called'); return sectCb; },
    getAuctionCb: () => { if (!auctionCb) throw new Error('views.showAuction was not called'); return auctionCb; },
  };
}

const worldApi = {} as unknown as WorldApiClient;

describe('nav hubs forward the authoritative save.accountId as myAccountId (not the phantom nw_account_id storage key)', () => {
  it('goFamilyHub passes save.accountId', () => {
    const { ctx, getFamilyCb } = buildCtx();
    createWorldNav(ctx).goFamilyHub(worldApi, 'world:1:0');
    expect(getFamilyCb().myAccountId).toBe(SAVE_ACCOUNT_ID);
    expect(getFamilyCb().myAccountId).not.toBe(PHANTOM_STORAGE_VALUE);
  });

  it('goSectHub passes save.accountId', () => {
    const { ctx, getSectCb } = buildCtx();
    createWorldNav(ctx).goSectHub(worldApi, 'world:1:0');
    expect(getSectCb().myAccountId).toBe(SAVE_ACCOUNT_ID);
    expect(getSectCb().myAccountId).not.toBe(PHANTOM_STORAGE_VALUE);
  });

  it('goAuctionFromLobby passes save.accountId', () => {
    const { ctx, getAuctionCb } = buildCtx();
    createWorldNav(ctx).goAuctionFromLobby();
    expect(getAuctionCb().myAccountId).toBe(SAVE_ACCOUNT_ID);
  });

  it('goAuctionHouse passes save.accountId', () => {
    const { ctx, getAuctionCb } = buildCtx();
    createWorldNav(ctx).goAuctionHouse(worldApi, 'world:1:0');
    expect(getAuctionCb().myAccountId).toBe(SAVE_ACCOUNT_ID);
  });
});
