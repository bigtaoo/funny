// SectScene error paths — "the request failed, what does the player actually read?".
//
// sectActionBusyLock.ui.ts covers the mechanics of a failure (bt unlocks, buttons come back,
// TimeoutError → common.networkTimeout). What it never touched is SectSceneCore.errorMsg()'s
// server-code → i18n table, nor whether the mutating actions' `catch { showToast(errorMsg(e)) }`
// arms actually feed it. sectActions.test.ts can't cover the table either — its FakeSectSceneCore
// substitutes `errorMsg = String(e)`, so the mapping is stubbed out of the run.
//
// Two blocks below:
//  1. the table itself — ONE `it` per server code (8 of them). A loop with forEach would go red as
//     a single opaque failure when someone drops a row; one case per code names the row.
//  2. the wiring — representative actions driven end-to-end against a real scene (real errorMsg,
//     real render) with worldApi rejecting a concrete code, asserting the toast text, the unlock,
//     and the redraw.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { SectScene } from '../../src/scenes/SectScene';
import { WorldApiError } from '../../src/net/WorldApiClient';
import type { WorldApiClient, SectDetailView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1280, 800];
const WORLD_ID = 'world:1:0';

function makeSectDetail(overrides: Partial<SectDetailView> = {}): SectDetailView {
  return {
    sectId: 'sect_1', worldId: WORLD_ID, name: 'Sky Sect', tag: 'SKY',
    leaderId: 'boss', leaderFamilyId: 'fam_1', memberFamilyCount: 1, prosperity: 0,
    memberFamilies: [], allySectIds: [],
    ...overrides,
  } as unknown as SectDetailView;
}

function stubWorldApi(overrides: Partial<WorldApiClient> = {}): WorldApiClient {
  return { ...overrides } as unknown as WorldApiClient;
}

function newScene(worldApi: WorldApiClient, myAccountId = 'other'): any {
  return new SectScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onNavTab() {},
    worldApi, worldId: WORLD_ID, myAccountId, playerName: 'Tester',
    getCoins: () => 0, refreshWallet: async () => {},
  });
}

/** Bare scene, no mode fiddling — enough to reach core.errorMsg(). */
function buildBareScene(): any {
  return newScene(stubWorldApi({}));
}

/** Scene parked in 'mySect' with a family-leader viewer — same shortcut as sectActionBusyLock.ui.ts. */
function buildMySectScene(worldApi: WorldApiClient, sect: SectDetailView, myAccountId = 'other'): any {
  const scene = newScene(worldApi, myAccountId);
  scene.core.inFamily = true;
  scene.core.myFamilyRole = 'leader';
  scene.core.sect = sect;
  scene.core.messages = [];
  scene.core.mode = 'mySect';
  scene.render();
  return scene;
}

/** Scene parked in 'create' with both fields filled, so doCreate() reaches the network. */
function buildCreateScene(worldApi: WorldApiClient): any {
  const scene = newScene(worldApi);
  scene.core.inFamily = true;
  scene.core.myFamilyRole = 'leader';
  scene.core.mode = 'create';
  scene.core.createName = 'Sky Sect';
  scene.core.createTag = 'SKY';
  scene.render();
  return scene;
}

// ── 1. errorMsg()'s server-code table ────────────────────────────────────────
//
// One case per row of SectScene/core.ts's `map`. `t(...)` is resolved through the same i18n
// instance the scene uses, so a key that exists in the table but is missing from
// i18n/locales/*.ts would surface here as the raw key on both sides — see the companion
// "every code resolves to real copy" case at the end of the block, which is what actually
// catches a missing translation.

describe('SectScene — errorMsg() maps server codes to sect.err.* copy', () => {
  it('ALREADY_IN_SECT → sect.err.alreadyIn', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('ALREADY_IN_SECT', 'raw'))).toBe(t('sect.err.alreadyIn'));
  });

  it('SECT_FULL → sect.err.full', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('SECT_FULL', 'raw'))).toBe(t('sect.err.full'));
  });

  it('NOT_IN_SECT → sect.err.notIn', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('NOT_IN_SECT', 'raw'))).toBe(t('sect.err.notIn'));
  });

  it('NO_PERMISSION → sect.err.noPermission', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('NO_PERMISSION', 'raw'))).toBe(t('sect.err.noPermission'));
  });

  it('NOT_FOUND → sect.err.notFound', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('NOT_FOUND', 'raw'))).toBe(t('sect.err.notFound'));
  });

  it('ALLY_CAP_REACHED → sect.err.allyCap', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('ALLY_CAP_REACHED', 'raw'))).toBe(t('sect.err.allyCap'));
  });

  it('INSUFFICIENT_FUNDS → sect.err.funds', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('INSUFFICIENT_FUNDS', 'raw'))).toBe(t('sect.err.funds'));
  });

  it('BAD_REQUEST → sect.err.badReq', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('BAD_REQUEST', 'raw'))).toBe(t('sect.err.badReq'));
  });

  it('every mapped code resolves to real copy, never a passed-through key or the raw message', () => {
    const scene = buildBareScene();
    const codes = ['ALREADY_IN_SECT', 'SECT_FULL', 'NOT_IN_SECT', 'NO_PERMISSION',
                   'NOT_FOUND', 'ALLY_CAP_REACHED', 'INSUFFICIENT_FUNDS', 'BAD_REQUEST'];
    for (const code of codes) {
      const msg = scene.core.errorMsg(new WorldApiError(code, 'raw-server-text'));
      expect(msg, code).not.toBe('raw-server-text');   // the row exists
      expect(msg, code).not.toMatch(/^sect\.err\./);   // …and its key has copy behind it
    }
  });
});

describe('SectScene — errorMsg() fallbacks', () => {
  it('an unmapped WorldApiError code falls through to the server message', () => {
    const scene = buildBareScene();
    // e.g. a code worldsvc grows later, or a shared 500 — the player gets the server text rather
    // than a blank toast.
    expect(scene.core.errorMsg(new WorldApiError('WORLD_LOCKED', 'world is sealed'))).toBe('world is sealed');
  });

  it('a non-WorldApiError (transport blow-up, thrown string, …) falls through to String(e)', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new Error('socket hang up'))).toBe('Error: socket hang up');
    expect(scene.core.errorMsg('plain string reject')).toBe('plain string reject');
  });
});

// ── 2. action → toast wiring ─────────────────────────────────────────────────
//
// The catch arms all read `core.showToast(core.errorMsg(e), C.red)`; these drive the real actions
// so a catch arm that forgot errorMsg() (or the toast entirely) goes red.

describe('SectScene — a rejected action toasts the mapped copy and unlocks', () => {
  it('doJoin: ALREADY_IN_SECT surfaces sect.err.alreadyIn, skips loadMySect, unlocks and redraws', async () => {
    const joinSect = vi.fn(async () => { throw new WorldApiError('ALREADY_IN_SECT', 'raw'); });
    const listSects = vi.fn(async () => []);
    const scene = buildMySectScene(stubWorldApi({ joinSect, listSects }), makeSectDetail());
    const showToast = vi.spyOn(scene.core, 'showToast');
    const render = vi.spyOn(scene.core, 'render');
    const loadMySect = vi.spyOn(scene.data, 'loadMySect');

    await scene.actions.doJoin('sect_other');

    expect(showToast).toHaveBeenCalledWith(t('sect.err.alreadyIn'), expect.anything());
    expect(loadMySect).not.toHaveBeenCalled();
    expect(scene.core.bt.busy).toBe(false);
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(2); // bt.start() paint + finally paint
  });

  it('doCreate: INSUFFICIENT_FUNDS surfaces sect.err.funds and leaves the form standing', async () => {
    const createSect = vi.fn(async () => { throw new WorldApiError('INSUFFICIENT_FUNDS', 'raw'); });
    const scene = buildCreateScene(stubWorldApi({ createSect }));
    const showToast = vi.spyOn(scene.core, 'showToast');

    await scene.actions.doCreate();

    expect(createSect).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(t('sect.err.funds'), expect.anything());
    expect(scene.core.mode).toBe('create'); // no half-created sect — the player can retry/top up
    expect(scene.core.sect).toBeNull();
    expect(scene.core.bt.busy).toBe(false);
  });

  it('doAlly: ALLY_CAP_REACHED surfaces sect.err.allyCap and unlocks', async () => {
    const allySect = vi.fn(async () => { throw new WorldApiError('ALLY_CAP_REACHED', 'raw'); });
    const scene = buildMySectScene(stubWorldApi({ allySect }), makeSectDetail({ leaderId: 'me' }), 'me');
    const showToast = vi.spyOn(scene.core, 'showToast');

    await scene.actions.doAlly('sect_target');

    expect(showToast).toHaveBeenCalledWith(t('sect.err.allyCap'), expect.anything());
    expect(scene.core.bt.busy).toBe(false);
  });

  it('doLeave: a transport-level throw (no code) surfaces String(e) rather than an empty toast', async () => {
    const leaveSect = vi.fn(async () => { throw new Error('socket hang up'); });
    const scene = buildMySectScene(stubWorldApi({ leaveSect }), makeSectDetail());
    const showToast = vi.spyOn(scene.core, 'showToast');

    await scene.actions.doLeave();

    expect(showToast).toHaveBeenCalledWith('Error: socket hang up', expect.anything());
    expect(scene.core.mode).toBe('mySect'); // failure must NOT drop the player out of the sect view
    expect(scene.core.sect).not.toBeNull();
    expect(scene.core.bt.busy).toBe(false);
  });

  it('openBrowseList: a failed listSects toasts the mapped copy and opens no picker', async () => {
    const listSects = vi.fn(async () => { throw new WorldApiError('NOT_FOUND', 'raw'); });
    const scene = buildMySectScene(stubWorldApi({ listSects }), makeSectDetail());
    const showToast = vi.spyOn(scene.core, 'showToast');
    const pick = vi.spyOn(scene.modals, 'showSectPickModal');

    await scene.actions.openBrowseList();

    expect(showToast).toHaveBeenCalledWith(t('sect.err.notFound'), expect.anything());
    expect(pick).not.toHaveBeenCalled();
  });
});
