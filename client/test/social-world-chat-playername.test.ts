// Regression test for the "world chat shows the raw public ID instead of the nickname" bug.
//
// Root cause: createSocialNav's world-tab `playerName` callback (passed down into
// FriendsSceneCallbacks.playerName, used as `senderName` when posting to /nation/message)
// read `PLAYER_PUBLIC_ID_KEY` from storage directly instead of using the shared
// ctx.playerName() helper (which resolves the real nickname, falling back to a guest
// label). Every other caller of ctx.playerName() (lobby/auth/result/world nav) was
// already correct — only the world-chat wiring in social.ts had its own broken copy.
//
// This test pins the contract: the `playerName` callback handed to the Friends scene for
// the world tab must delegate to ctx.playerName(), not read the public-id key itself.
import { describe, it, expect } from 'vitest';
import { createSocialNav } from '../src/app/nav/social';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { FriendsSceneCallbacks } from '../src/scenes/FriendsScene';

function buildCtx(overrides: { playerName: string; publicId: string }): AppCtx {
  let capturedCb: FriendsSceneCallbacks | null = null;

  const storage = {
    getItem: (k: string): string | null => (k === 'nw_public_id' ? overrides.publicId : null),
    setItem: (): void => {},
    removeItem: (): void => {},
  };

  const views = {
    showFriends: (cb: FriendsSceneCallbacks) => {
      capturedCb = cb;
      return {
        applyFriendPresence() {}, applyFriendRequest() {}, applyFriendUpdate() {},
        applyChatMessage() {}, applyMailNew() {},
      };
    },
  } as unknown as AppViews;

  const ctx: AppCtx = {
    platform: { storage } as unknown as AppCtx['platform'],
    views,
    api: {} as unknown as AppCtx['api'],
    baseUrl: null,
    saveManager: {} as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: {} as unknown as AppState,
    nav: {} as unknown as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => overrides.playerName,
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  const { goFriends } = createSocialNav(ctx);
  goFriends();
  if (!capturedCb) throw new Error('views.showFriends was not called');
  return { cb: capturedCb } as unknown as AppCtx;
}

describe('regression: world-chat sender name must be the nickname, not the public id', () => {
  it("the world-tab playerName callback returns ctx.playerName(), not storage's public-id key", () => {
    const { cb } = buildCtx({ playerName: '陶大人', publicId: '233784986' }) as unknown as { cb: FriendsSceneCallbacks };

    expect(cb.playerName?.()).toBe('陶大人');
    // Must never fall back to exposing the raw numeric public id as the display name.
    expect(cb.playerName?.()).not.toBe('233784986');
  });
});
