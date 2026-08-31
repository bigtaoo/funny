// Coverage for the family/sect emblem-picker open→pick→confirm flow (family-emblem-art-prompts.md,
// 2026-08-14) — FamilyScene/actions.ts's openEmblemPicker/doSetEmblem and SectScene's mirror.
// Real FamilyScene/SectScene instances (same pattern as sectRemovalVoteGate.ui.ts): drives the
// actual lazy hooks (core.openEmblemPicker / core.emblemHooks.openEmblemPicker) reached from
// header.ts, asserts on core.modalHits / core.modalOpen / core.family / core.sect / the worldApi
// spy calls — no PIXI-pixel inspection needed, the modal's own hit-rect contract is already
// covered by emblemPickerDialog.ui.ts.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { EMBLEM_KEYS, EMBLEM_COLORS } from '../../src/render/emblemIcon';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import type { FamilyDetailView } from '../../src/net/WorldApiClient';
import type { SectDetailView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const LANDSCAPE = { designWidth: 1280, designHeight: 800, orientation: 'landscape' } as any;

// ── FamilyScene ────────────────────────────────────────────────────────────────

function makeFamily(role: 'leader' | 'member', overrides: Partial<FamilyDetailView> = {}): FamilyDetailView {
  return {
    familyId: 'fam:AA', name: 'Alpha', tag: 'AA', leaderId: role === 'leader' ? 'me' : 'boss',
    memberCount: 1, prosperity: 0,
    members: [{ accountId: 'me', role, joinedAt: 0 }],
    ...overrides,
  };
}

function buildFamilyScene(fam: FamilyDetailView, worldApiOverrides: Record<string, unknown> = {}): any {
  const worldApi = {
    getMyFamily: async () => fam,
    getFamily: async () => fam,
    getFamilyChannel: async () => [],
    listJoinRequests: async () => [],
    setFamilyEmblem: vi.fn().mockResolvedValue({ ok: true }),
    ...worldApiOverrides,
  };
  const cb = {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    async addFriend() {}, async getFriendPublicIds() { return new Set<string>(); },
    openChat() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
  };
  return new FamilyScene(LANDSCAPE, new InputManager(), cb as any);
}

async function flushFamily(scene: any): Promise<void> {
  await scene.data.loadData();
  scene.render();
}

/** Flushes a real macrotask boundary, not just N chained microtasks — robust against
 *  withTimeout's Promise.race+finally adding an unpredictable number of microtask hops. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('FamilyScene — emblem picker open/pick/confirm flow', () => {
  it('leader with no emblem yet: tapping the placeholder badge opens the picker modal (core.openEmblemPicker reaches the real ActionsPanel)', async () => {
    const scene = buildFamilyScene(makeFamily('leader'));
    await flushFamily(scene);
    expect(scene.core.modalOpen).toBe(false);

    scene.core.openEmblemPicker(); // the lazy hook header.ts's badge tap wires to

    expect(scene.core.modalOpen).toBe(true);
    // dim + 24 grid + 8 swatches + confirm + cancel (emblemPickerDialog.ui.ts pins this shape).
    expect(scene.core.modalHits.length).toBe(1 + EMBLEM_KEYS.length + EMBLEM_COLORS.length + 2);
  });

  it('a plain member calling the hook is a silent no-op (mirrors: header.ts never wires a hit rect for them at all)', async () => {
    const scene = buildFamilyScene(makeFamily('member'));
    await flushFamily(scene);

    expect(() => scene.core.openEmblemPicker()).not.toThrow();
    expect(scene.core.modalOpen).toBe(false);
  });

  it('no family loaded: the hook is a silent no-op', async () => {
    const scene = buildFamilyScene(makeFamily('leader'), { getMyFamily: async () => null });
    await flushFamily(scene);

    expect(() => scene.core.openEmblemPicker()).not.toThrow();
    expect(scene.core.modalOpen).toBe(false);
  });

  it('pick an icon + a colour, then Confirm: calls setFamilyEmblem with exactly that pair, updates core.family, and closes the modal', async () => {
    const scene = buildFamilyScene(makeFamily('leader'));
    await flushFamily(scene);
    scene.core.openEmblemPicker();

    const gridHit = scene.core.modalHits[3]; // hits[0]=dim, hits[1]=grid[0], hits[2]=grid[1], hits[3]=grid[2]
    gridHit.fn(); // pick EMBLEM_KEYS[2] — redraws modalHits in place
    const swatchStart = 1 + EMBLEM_KEYS.length;
    const swatchHit = scene.core.modalHits[swatchStart + 5]; // EMBLEM_COLORS[5]
    swatchHit.fn();
    const confirmHit = scene.core.modalHits[scene.core.modalHits.length - 2];
    confirmHit.fn();
    await flushAsync(); await flushAsync(); await flushAsync(); await flushAsync(); // let withTimeout (Promise.race+finally) + doSetEmblem's own await settle

    expect(scene.core.cb.worldApi.setFamilyEmblem).toHaveBeenCalledWith(EMBLEM_KEYS[2], EMBLEM_COLORS[5]);
    expect(scene.core.family.emblemKey).toBe(EMBLEM_KEYS[2]);
    expect(scene.core.family.emblemColor).toBe(EMBLEM_COLORS[5]);
    expect(scene.core.modalOpen).toBe(false);
  });

  it('Cancel discards the pick without calling setFamilyEmblem', async () => {
    const scene = buildFamilyScene(makeFamily('leader'));
    await flushFamily(scene);
    scene.core.openEmblemPicker();
    scene.core.modalHits[3].fn(); // pick something
    const cancelHit = scene.core.modalHits[scene.core.modalHits.length - 1];
    cancelHit.fn();

    expect(scene.core.modalOpen).toBe(false);
    expect(scene.core.cb.worldApi.setFamilyEmblem).not.toHaveBeenCalled();
  });

  it('setFamilyEmblem rejecting: modal stays open (re-shows the picker so the pick isn\'t lost) and core.family is untouched', async () => {
    const scene = buildFamilyScene(makeFamily('leader'), {
      setFamilyEmblem: vi.fn().mockRejectedValue(new Error('network down')),
    });
    await flushFamily(scene);
    scene.core.openEmblemPicker();
    const confirmHit = scene.core.modalHits[scene.core.modalHits.length - 2];
    confirmHit.fn();
    await flushAsync(); await flushAsync(); await flushAsync(); 

    expect(scene.core.modalOpen).toBe(true);
    expect(scene.core.family.emblemKey).toBeUndefined();
  });

  it('opening the picker seeds it with the family\'s CURRENT badge, not always the first key/colour', async () => {
    const scene = buildFamilyScene(makeFamily('leader', { emblemKey: EMBLEM_KEYS[7], emblemColor: EMBLEM_COLORS[4] } as any));
    await flushFamily(scene);
    scene.core.openEmblemPicker();

    // The seeded cell (EMBLEM_KEYS[7]) is hits[1+7]=hits[8]; confirm without picking anything new
    // should round-trip the SAME key/colour it was seeded with.
    const confirmHit = scene.core.modalHits[scene.core.modalHits.length - 2];
    confirmHit.fn();
    await flushAsync(); await flushAsync(); await flushAsync(); await flushAsync(); 
    expect(scene.core.cb.worldApi.setFamilyEmblem).toHaveBeenCalledWith(EMBLEM_KEYS[7], EMBLEM_COLORS[4]);
  });
});

// ── SectScene ──────────────────────────────────────────────────────────────────

function makeSect(overrides: Partial<SectDetailView> = {}): SectDetailView {
  return {
    sectId: 'sect1', worldId: 'w1', name: 'Great Nation', tag: 'TAO',
    leaderFamilyId: 'fam:LEAD', leaderId: 'boss', memberFamilyCount: 1,
    allySectIds: [], prosperity: 0, memberFamilies: [],
    ...overrides,
  };
}

function makeMyFamily(role: 'leader' | 'member'): FamilyDetailView {
  return {
    familyId: 'fam:LEAD', name: 'Lead Fam', tag: 'LF', leaderId: role === 'leader' ? 'boss' : 'someone-else',
    memberCount: 1, prosperity: 0, sectId: 'sect1',
    members: [{ accountId: 'boss', role, joinedAt: 0 }],
  };
}

function buildSectScene(sect: SectDetailView, fam: FamilyDetailView, worldApiOverrides: Record<string, unknown> = {}): any {
  const worldApi = {
    getMyFamily: async () => fam,
    getSect: async () => sect,
    getSectChannel: async () => [],
    listSects: async () => [],
    setSectEmblem: vi.fn().mockResolvedValue({ ok: true }),
    ...worldApiOverrides,
  };
  const cb = {
    onBack() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'boss', playerName: 'tao',
    getCoins: () => 0, refreshWallet: async () => {},
  };
  return new SectScene(LANDSCAPE, new InputManager(), cb as any);
}

async function flushSect(scene: any): Promise<void> {
  await scene.data.loadData();
  scene.render();
}

describe('SectScene — emblem picker open/pick/confirm flow (sect-leader-only, stricter than family-leader)', () => {
  it('the sect leader (boss, leaderId===sect.leaderId) opens the picker via core.emblemHooks', async () => {
    const scene = buildSectScene(makeSect(), makeMyFamily('leader'));
    await flushSect(scene);

    scene.core.emblemHooks.openEmblemPicker();
    expect(scene.core.modalOpen).toBe(true);
  });

  it('a family leader whose family is a MEMBER (not the leader) family gets a no-op, even though they lead their own family', async () => {
    // sect.leaderId is 'boss' from a different family; this player leads fam:LEAD too but boss ≠ the caller.
    const sect = makeSect({ leaderId: 'someone-else' });
    const scene = buildSectScene(sect, makeMyFamily('leader'));
    await flushSect(scene);

    expect(() => scene.core.emblemHooks.openEmblemPicker()).not.toThrow();
    expect(scene.core.modalOpen).toBe(false);
  });

  it('pick + confirm calls setSectEmblem(worldId, key, color) and updates core.sect', async () => {
    const scene = buildSectScene(makeSect(), makeMyFamily('leader'));
    await flushSect(scene);
    scene.core.emblemHooks.openEmblemPicker();

    scene.core.modalHits[5].fn(); // pick EMBLEM_KEYS[4]
    const confirmHit = scene.core.modalHits[scene.core.modalHits.length - 2];
    confirmHit.fn();
    await flushAsync(); await flushAsync(); await flushAsync(); await flushAsync(); 

    expect(scene.core.cb.worldApi.setSectEmblem).toHaveBeenCalledWith('w1', EMBLEM_KEYS[4], EMBLEM_COLORS[0]);
    expect(scene.core.sect.emblemKey).toBe(EMBLEM_KEYS[4]);
    expect(scene.core.modalOpen).toBe(false);
  });
});
