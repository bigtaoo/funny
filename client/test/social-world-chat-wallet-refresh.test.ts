// Regression test for the "world-chat post doesn't cost coins" symptom.
//
// Root cause: world-chat coins are debited in the commercial service by worldsvc, which never
// touches the metaserver save mirror the HUD reads (getCoins() → saveManager.get().wallet.coins).
// So even a successful 50-coin charge left the on-screen balance unchanged → looked free.
//
// Fix: createSocialNav wires a `refreshWallet` callback that re-fetches the save (GET /save
// re-mirrors the live commercial balance) and adopts it. This test pins that the world tab is
// handed a refreshWallet that goes through client.getSave() → saveManager.adoptServer().
import { describe, it, expect } from 'vitest';
import { createSocialNav } from '../src/app/nav/social';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { FriendsSceneCallbacks } from '../src/scenes/FriendsScene';
import type { SaveData } from '../src/game/meta/SaveData';

describe('regression: world-chat posts re-sync the wallet so the HUD reflects the coin spend', () => {
  it('the world-tab refreshWallet callback fetches the authoritative save and adopts it', async () => {
    const FRESH_SAVE = { wallet: { coins: 42 } } as unknown as SaveData;
    let getSaveCalls = 0;
    let adopted: SaveData | null = null;

    let capturedCb: FriendsSceneCallbacks | null = null;
    const views = {
      showFriends: (cb: FriendsSceneCallbacks) => {
        capturedCb = cb;
        return {
          applyFriendPresence() {}, applyFriendRequest() {}, applyFriendUpdate() {},
          applyChatMessage() {}, applyMailNew() {},
        };
      },
    } as unknown as AppViews;

    const storage = {
      getItem: (): string | null => null,
      setItem: (): void => {},
      removeItem: (): void => {},
    };

    const api = {
      async getSave() { getSaveCalls++; return { save: FRESH_SAVE }; },
    } as unknown as AppCtx['api'];

    const saveManager = {
      adoptServer: (s: SaveData) => { adopted = s; },
    } as unknown as AppCtx['saveManager'];

    const ctx: AppCtx = {
      platform: { storage } as unknown as AppCtx['platform'],
      views,
      api,
      baseUrl: null,
      saveManager,
      replayStore: {} as unknown as AppCtx['replayStore'],
      featureFlags: null,
      state: {} as unknown as AppState,
      nav: {} as unknown as Nav,
      getNetSession: () => null,
      applyGatewayUrl: () => {},
      playerName: () => 'Tester',
      avatarId: () => undefined,
      gateConsent: (next) => next(),
      resolvePvpDeck: () => [],
      keepReplay: (r) => r,
      resolveWorldShard: () => {},
    };

    const { goFriends } = createSocialNav(ctx);
    goFriends();
    if (!capturedCb) throw new Error('views.showFriends was not called');

    const cb = capturedCb as FriendsSceneCallbacks;
    expect(cb.refreshWallet).toBeTypeOf('function');

    await cb.refreshWallet!();
    expect(getSaveCalls).toBe(1);
    expect(adopted).toBe(FRESH_SAVE);
  });
});
