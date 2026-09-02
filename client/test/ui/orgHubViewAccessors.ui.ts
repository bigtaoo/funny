/**
 * orgHubViewAccessors.ui.ts — regression test for the SectSceneView.getFamily/getSect and
 * FamilySceneView.getFamily accessors added by family-sect-tab-switch-flicker-fix-2026-08-30.
 *
 * nav/world.ts's goFamilyHub/goSectHub read these directly off the CURRENTLY-MOUNTED scene at the
 * moment of a rail tap, to hand the already-loaded family/sect to the sibling hub as preload instead
 * of re-fetching (see SOCIAL_DESIGN.md's dated entry). sectLoadDecouple.test.ts/familyLoadDecouple.
 * test.ts already pin DataPanel's own state (core.family/core.sect) at the unit level with a fake
 * core — this constructs the REAL SectScene/FamilyScene classes (same harness composition-wiring.
 * ui.ts uses) so a typo in the two one-line delegate methods themselves (e.g. SectScene.getFamily()
 * accidentally returning core.sect) would actually fail a test, not just look right by inspection.
 */
import { describe, expect, it } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import type { WorldApiClient } from '../../src/net/WorldApiClient';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const FAM = {
  familyId: 'fam_mine',
  name: 'Clan',
  tag: 'CLN',
  sectId: 'sect_1',
  leaderId: 'me',
  members: [{ accountId: 'me', role: 'leader', joinedAt: 0 }],
};

const SECT = {
  sectId: 'sect_1', name: 'Sect', tag: 'SCT', leaderId: 'me', leaderFamilyId: 'fam_mine',
  memberFamilyCount: 1, prosperity: 7, allySectIds: [],
  memberFamilies: [{ familyId: 'fam_mine', name: 'Clan', tag: 'CLN', memberCount: 1, territoryCount: 0 }],
};

function stubWorldApi(overrides: Record<string, unknown> = {}): WorldApiClient {
  return {
    getMyFamily: async () => FAM,
    getSect: async () => SECT,
    getSectChannel: async () => [],
    getFamilyChannel: async () => [],
    listJoinRequests: async () => [],
    ...overrides,
  } as unknown as WorldApiClient;
}

// Flush the microtasks loadData()'s awaited chain needs (getMyFamily → getSect/getFamilyChannel →
// render) — loadData() is fired with `void` from each scene's constructor, so there's nothing to
// await directly; a handful of resolved-promise ticks is the same technique sectLoadDecouple.test.ts/
// familyLoadDecouple.test.ts use.
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('SectScene.getFamily/getSect — SectSceneView accessors', () => {
  it('return the family/sect this scene actually loaded, not null/undefined and not each other', async () => {
    const { SectScene } = await import('../../src/scenes/SectScene');
    const scene = new SectScene(createLayout(1280, 800), new InputManager(), {
      onBack() {}, onNavTab() {},
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'me', playerName: 'Tester',
      getCoins: () => 0, refreshWallet: async () => {}, openTextInput: createFakeTextInput().openTextInput,
    });
    await flush();

    expect(scene.getFamily()).toEqual(FAM);
    expect(scene.getSect()).toEqual(SECT);
    // The two accessors must not be accidentally swapped/aliased.
    expect(scene.getFamily()).not.toEqual(scene.getSect());
    scene.destroy();
  });

  it('return null while still loading (no crash on an early tap before the network resolves)', async () => {
    const { SectScene } = await import('../../src/scenes/SectScene');
    const scene = new SectScene(createLayout(1280, 800), new InputManager(), {
      onBack() {}, onNavTab() {},
      worldApi: stubWorldApi({ getMyFamily: () => new Promise(() => {}) }), // never resolves
      worldId: 'world:1:0', myAccountId: 'me', playerName: 'Tester',
      getCoins: () => 0, refreshWallet: async () => {}, openTextInput: createFakeTextInput().openTextInput,
    });

    expect(scene.getFamily()).toBeNull();
    expect(scene.getSect()).toBeNull();
    scene.destroy();
  });
});

describe('FamilyScene.getFamily — FamilySceneView accessor', () => {
  it('returns the family this scene actually loaded', async () => {
    const { FamilyScene } = await import('../../src/scenes/FamilyScene');
    const scene = new FamilyScene(createLayout(1280, 800), new InputManager(), {
      onBack() {}, onOpenSect() {}, onNavTab() {},
      async addFriend() {}, async getFriendPublicIds() { return new Set<string>(); },
      openChat() {},
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'me', playerName: 'Tester',
      openTextInput: createFakeTextInput().openTextInput,
    });
    await flush();

    expect(scene.getFamily()).toEqual(FAM);
    scene.destroy();
  });

  it('returns null while still loading', async () => {
    const { FamilyScene } = await import('../../src/scenes/FamilyScene');
    const scene = new FamilyScene(createLayout(1280, 800), new InputManager(), {
      onBack() {}, onOpenSect() {}, onNavTab() {},
      async addFriend() {}, async getFriendPublicIds() { return new Set<string>(); },
      openChat() {},
      worldApi: stubWorldApi({ getMyFamily: () => new Promise(() => {}) }),
      worldId: 'world:1:0', myAccountId: 'me', playerName: 'Tester',
      openTextInput: createFakeTextInput().openTextInput,
    });

    expect(scene.getFamily()).toBeNull();
    scene.destroy();
  });
});
