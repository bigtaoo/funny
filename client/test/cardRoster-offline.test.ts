// Regression coverage for offline Hero Roster access (LOBBY_IA_REDESIGN §15 / ADR-038): CardScene used
// to be gated entirely behind `api` (goCardRoster bailed straight to `back()` when offline, matching
// the retired CollectionScene's fallback role). Now the roster itself works read-only offline — server-
// authoritative mutations (feed/lock/gear) fail gracefully instead of the page being unreachable, and
// skin equip's local mirror updates instantly offline too (SaveManager.equipSkin writes it unconditionally
// before attempting the — now server-authoritative, PUT /skin/equip — sync call; see SaveManager.ts).
//
// Hand-built AppCtx style, same as careerNav-backNavigation.test.ts / game-nav-fight-again.test.ts.
import { describe, it, expect } from 'vitest';
import { createGameNav } from '../src/app/nav/game';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { ApiClient } from '../src/net/ApiClient';
import type { CardCallbacks } from '../src/scenes/CardScene';
import type { EquipmentCallbacks } from '../src/scenes/EquipmentScene';
import { UnitType } from '@nw/engine/types';

function buildCtx(opts: { online: boolean; api?: Partial<ApiClient> }): {
  ctx: AppCtx;
  getCardRoster: () => CardCallbacks | null;
  getEquipment: () => EquipmentCallbacks | null;
  save: { equipped: Record<string, string>; cardInv: Record<string, unknown>; inventory: { skins: string[] } };
  adopted: () => unknown[];
} {
  let lastCardRoster: CardCallbacks | null = null;
  let lastEquipment: EquipmentCallbacks | null = null;
  const adopted: unknown[] = [];
  const save = {
    equipped: {} as Record<string, string>,
    cardInv: {} as Record<string, unknown>,
    inventory: { skins: [] as string[] },
  };

  const views = {
    showCardRoster: (cb: CardCallbacks) => { lastCardRoster = cb; },
    showEquipment: (cb: EquipmentCallbacks) => { lastEquipment = cb; },
  } as unknown as AppViews;

  const nav: Partial<Nav> = { goLobby: () => {} };

  const ctx: AppCtx = {
    platform: { storage: { getItem: () => null } } as unknown as AppCtx['platform'],
    views,
    api: opts.online ? ((opts.api ?? {}) as ApiClient) : undefined,
    baseUrl: null,
    saveManager: {
      get: () => save,
      update: (mutator: (d: typeof save) => void) => mutator(save),
      // Mirrors SaveManager.equipSkin's local-write-first behavior (offline or online, see SaveManager.ts).
      equipSkin: (unitType: UnitType, skinId: string | null) => {
        const key = `skin:${unitType}`;
        if (skinId) save.equipped[key] = skinId; else delete save.equipped[key];
      },
      adoptServer: (next: unknown) => { adopted.push(next); },
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

  return {
    ctx,
    getCardRoster: () => lastCardRoster,
    getEquipment: () => lastEquipment,
    save,
    adopted: () => adopted,
  };
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

  it('fuse/lock fail gracefully offline instead of throwing or hitting the network', async () => {
    const { ctx, getCardRoster } = buildCtx({ online: false });
    const { goCardRoster } = createGameNav(ctx);
    goCardRoster();
    const cb = getCardRoster()!;

    await expect(cb.fuseCards('target', ['mat1', 'mat2', 'mat3', 'mat4', 'mat5']))
      .resolves.toEqual({ ok: false, key: 'roster.err.offline' });
    await expect(cb.fuseCardsBatch([{ targetId: 'target', materialIds: ['m1', 'm2', 'm3', 'm4', 'm5'] }]))
      .resolves.toEqual({ ok: false, key: 'roster.err.offline' });
    await expect(cb.setCardLock('c1', true)).resolves.toEqual({ ok: false, key: 'roster.err.offline' });
  });

  // The batch callback is the only place the wire response is translated for the panel — it adopts
  // the save, decides whether the run counts as a failure, and swallows transport errors. The UI
  // suites stub it out wholesale, so without these three cases nothing exercises that translation.
  describe('online: the fuseCardsBatch adapter', () => {
    const ROUNDS = [
      { targetId: 'f1', materialIds: ['a1', 'a2', 'a3', 'a4', 'a5'] },
      { targetId: 'f2', materialIds: ['b1', 'b2', 'b3', 'b4', 'b5'] },
    ];

    it('adopts the returned save and reports a clean run with no failure key', async () => {
      const nextSave = { rev: 7 };
      const { ctx, getCardRoster, adopted } = buildCtx({
        online: true,
        api: { fuseCardsBatch: async () => ({ completed: 2, save: nextSave }) } as unknown as Partial<ApiClient>,
      });
      createGameNav(ctx).goCardRoster();

      await expect(getCardRoster()!.fuseCardsBatch(ROUNDS)).resolves.toEqual({ ok: true, completed: 2 });
      expect(adopted(), 'the roster must see the post-batch save, not re-fetch it').toEqual([nextSave]);
    });

    it('a run that halted is still ok — the count stands, with a key explaining the stop', async () => {
      const { ctx, getCardRoster, adopted } = buildCtx({
        online: true,
        api: {
          fuseCardsBatch: async () => ({ completed: 1, failed: { index: 1, code: 'CARD_LOCKED', error: 'x' }, save: {} }),
        } as unknown as Partial<ApiClient>,
      });
      createGameNav(ctx).goCardRoster();

      await expect(getCardRoster()!.fuseCardsBatch(ROUNDS))
        .resolves.toEqual({ ok: true, completed: 1, failKey: 'roster.fuseErr' });
      expect(adopted(), 'partial progress still changed the roster').toHaveLength(1);
    });

    it('a transport failure is a plain error, and nothing is adopted from it', async () => {
      const { ctx, getCardRoster, adopted } = buildCtx({
        online: true,
        api: { fuseCardsBatch: async () => { throw new Error('offline mid-flight'); } } as unknown as Partial<ApiClient>,
      });
      createGameNav(ctx).goCardRoster();

      await expect(getCardRoster()!.fuseCardsBatch(ROUNDS))
        .resolves.toEqual({ ok: false, key: 'roster.err.generic' });
      expect(adopted()).toEqual([]);
    });
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

  // A gear-slot tap in the card detail passes the tapped slot through openEquipment → goEquipment →
  // EquipmentScene, so the equipment page opens already filtered to that slot's tab instead of "All".
  it('online: openEquipment(cardId, slot) forwards the slot to EquipmentScene as initialFilterSlot', () => {
    const { ctx, getCardRoster, getEquipment } = buildCtx({ online: true });
    const { goCardRoster } = createGameNav(ctx);
    goCardRoster();
    const cb = getCardRoster()!;

    cb.openEquipment!('card1', 'armor');
    const equip = getEquipment();
    expect(equip, 'views.showEquipment was not called by openEquipment').not.toBeNull();
    expect(equip!.activeCardInstanceId).toBe('card1');
    expect(equip!.initialFilterSlot).toBe('armor');
  });

  it('online: openEquipment(cardId) with no slot leaves initialFilterSlot unset (defaults to "All")', () => {
    const { ctx, getCardRoster, getEquipment } = buildCtx({ online: true });
    const { goCardRoster } = createGameNav(ctx);
    goCardRoster();
    const cb = getCardRoster()!;

    cb.openEquipment!('card1');
    const equip = getEquipment();
    expect(equip).not.toBeNull();
    expect(equip!.initialFilterSlot).toBeUndefined();
  });
});
