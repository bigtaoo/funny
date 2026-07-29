// Regression coverage for the 2026-07-29 "equip succeeds but the card doesn't show the new gear
// immediately" bug: /equipment/equip returns a lean response (cardInv omitted, EQUIPMENT_DESIGN
// §3.3 phase 2) because the server assumes the caller already knows what changed — but
// createGameNav's `equip()` callback (app/nav/game.ts) called `adoptServerPartial(save, {})` with
// an EMPTY patch, so the local cardInv mirror never picked up the new/removed gear pointer on the
// equipped-to card. Symptom: EquipmentScene's own loadout strip and CardScene both kept showing the
// pre-equip gear until the next full save refresh, even though the server-side equip had actually
// succeeded. Fixed by having `equip()` construct a `cardUpsert` patch from the local card + the
// slot/instanceId it just sent, mirroring equipEquipment's own `gear[slot]` mutation exactly.
import { describe, it, expect } from 'vitest';
import { createGameNav } from '../src/app/nav/game';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { makeNewSave, type SaveData, type LeanSaveResponse } from '../src/game/meta';
import type { ApiClient } from '../src/net/ApiClient';
import type { IStorage } from '../src/platform/IPlatform';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { EquipmentCallbacks } from '../src/scenes/EquipmentScene';

class MemStorage implements IStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

function buildCtx(save: SaveData): { ctx: AppCtx; getEquipment: () => EquipmentCallbacks | null } {
  let lastEquipment: EquipmentCallbacks | null = null;
  const views = { showEquipment: (cb: EquipmentCallbacks) => { lastEquipment = cb; } } as unknown as AppViews;

  const api = {
    hasToken: () => true,
    getSave: async () => ({ save }),
    equipEquipment: async (slot: string, instanceId: string | null, cardInstanceId: string) => {
      const card = save.cardInv[cardInstanceId];
      const gear = { ...card.gear };
      if (instanceId === null) delete gear[slot as keyof typeof gear]; else gear[slot as keyof typeof gear] = instanceId;
      save.cardInv[cardInstanceId] = { ...card, gear };
      const lean: LeanSaveResponse = { ...save, equipmentInv: null, cardInv: null };
      return { save: lean };
    },
  } as unknown as ApiClient;

  const store = new LocalSaveStore(new MemStorage());
  store.saveLocal(save);
  const saveManager = new SaveManager({ store, api });

  const ctx: AppCtx = {
    platform: { storage: { getItem: () => null } } as unknown as AppCtx['platform'],
    views,
    api,
    baseUrl: null,
    saveManager,
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: { inLobby: true, offlineMode: false, achievementClaimable: false } as unknown as AppState,
    nav: { goLobby: () => {} } as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  return { ctx, getEquipment: () => lastEquipment };
}

describe('createGameNav — equip() keeps the local cardInv mirror in sync (2026-07-29 fix)', () => {
  it('equipping onto a card updates that card\'s gear locally right away, without a fresh GET /save', async () => {
    const save = makeNewSave('acc_test', 1);
    save.cardInv = { card1: { id: 'card1', defId: 'lichuang', level: 1, locked: false, gear: {} } };
    const { ctx, getEquipment } = buildCtx(save);
    const { goEquipment: goEquip } = createGameNav(ctx);

    goEquip(() => {}, 'none', 'card1');
    const cb = getEquipment()!;
    expect(cb).not.toBeNull();
    expect(ctx.saveManager.get().cardInv.card1.gear.weapon).toBeUndefined();

    const res = await cb.equip('weapon', 'inst_wp', 'card1');
    expect(res.ok).toBe(true);

    // The whole point of the fix: this must be true immediately, synchronously after equip()
    // resolves — not only after some later full save refresh.
    expect(ctx.saveManager.get().cardInv.card1.gear.weapon).toBe('inst_wp');
  });

  it('unequipping clears the gear slot locally right away', async () => {
    const save = makeNewSave('acc_test', 1);
    save.cardInv = { card1: { id: 'card1', defId: 'lichuang', level: 1, locked: false, gear: { weapon: 'inst_wp' } } };
    const { ctx, getEquipment } = buildCtx(save);
    const { goEquipment: goEquip } = createGameNav(ctx);

    goEquip(() => {}, 'none', 'card1');
    const cb = getEquipment()!;
    expect(ctx.saveManager.get().cardInv.card1.gear.weapon).toBe('inst_wp');

    const res = await cb.equip('weapon', null, 'card1');
    expect(res.ok).toBe(true);
    expect(ctx.saveManager.get().cardInv.card1.gear.weapon).toBeUndefined();
  });
});
