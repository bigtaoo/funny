// Regression coverage for offline Hero Roster access (LOBBY_IA_REDESIGN §15 / ADR-038): CardScene used
// to be gated entirely behind `api` (goCardRoster bailed straight to `back()` when offline, matching
// the retired CollectionScene's fallback role). Now the roster itself works read-only offline — server-
// authoritative mutations (feed/lock/gear) fail gracefully instead of the page being unreachable, and
// skin equip (a client-sync-section write, not a server call) works the same online or offline.
//
// Hand-built AppCtx style, same as careerNav-backNavigation.test.ts / game-nav-fight-again.test.ts.
import { describe, it, expect } from 'vitest';
import { createGameNav } from '../src/app/nav/game';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { ApiClient } from '../src/net/ApiClient';
import type { CardCallbacks } from '../src/scenes/CardScene';
import { UnitType } from '../src/game/types';

function buildCtx(opts: { online: boolean }): {
  ctx: AppCtx;
  getCardRoster: () => CardCallbacks | null;
  save: { equipped: Record<string, string>; cardInv: Record<string, unknown>; inventory: { skins: string[] } };
} {
  let lastCardRoster: CardCallbacks | null = null;
  const save = {
    equipped: {} as Record<string, string>,
    cardInv: {} as Record<string, unknown>,
    inventory: { skins: [] as string[] },
  };

  const views = {
    showCardRoster: (cb: CardCallbacks) => { lastCardRoster = cb; },
  } as unknown as AppViews;

  const nav: Partial<Nav> = { goLobby: () => {} };

  const ctx: AppCtx = {
    platform: { storage: { getItem: () => null } } as unknown as AppCtx['platform'],
    views,
    api: opts.online ? ({} as ApiClient) : undefined,
    baseUrl: null,
    saveManager: {
      get: () => save,
      update: (mutator: (d: typeof save) => void) => mutator(save),
    } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: { inLobby: true, offlineMode: !opts.online, achievementClaimable: false } as unknown as AppState,
    nav: nav as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  return { ctx, getCardRoster: () => lastCardRoster, save };
}

describe('createGameNav — goCardRoster offline', () => {
  it('is reachable offline (does not bail to back()) and hides server-authoritative gear entry points', async () => {
    const { ctx, getCardRoster } = buildCtx({ online: false });
    const { goCardRoster } = createGameNav(ctx);

    goCardRoster();
    const cb = getCardRoster();
    expect(cb, 'views.showCardRoster was not called — offline still bails out').not.toBeNull();
    expect(cb!.openEquipment).toBeUndefined();
    expect(cb!.openEquipmentBag).toBeUndefined();
  });

  it('feed/lock fail gracefully offline instead of throwing or hitting the network', async () => {
    const { ctx, getCardRoster } = buildCtx({ online: false });
    const { goCardRoster } = createGameNav(ctx);
    goCardRoster();
    const cb = getCardRoster()!;

    await expect(cb.feedCards('target', ['mat1'])).resolves.toEqual({ ok: false, key: 'roster.err.offline' });
    await expect(cb.setCardLock('c1', true)).resolves.toEqual({ ok: false, key: 'roster.err.offline' });
  });

  it('skin equip works offline (client-sync write, not a server call)', () => {
    const { ctx, getCardRoster, save } = buildCtx({ online: false });
    const { goCardRoster } = createGameNav(ctx);
    goCardRoster();
    const cb = getCardRoster()!;

    expect(cb.getOwnedSkins()).toEqual([]);
    expect(cb.getEquippedSkin(UnitType.Lena)).toBeNull();

    cb.equipSkin(UnitType.Lena, 'skin_e1');
    expect(save.equipped['skin:lena']).toBe('skin_e1');
    expect(cb.getEquippedSkin(UnitType.Lena)).toBe('skin_e1');

    cb.equipSkin(UnitType.Lena, null);
    expect(save.equipped['skin:lena']).toBeUndefined();
    expect(cb.getEquippedSkin(UnitType.Lena)).toBeNull();
  });

  it('online: exposes the equipment bag entry point', () => {
    const { ctx, getCardRoster } = buildCtx({ online: true });
    const { goCardRoster } = createGameNav(ctx);
    goCardRoster();
    const cb = getCardRoster()!;
    expect(cb.openEquipmentBag).toBeTypeOf('function');
    expect(cb.openEquipment).toBeTypeOf('function');
  });
});
