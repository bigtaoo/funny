// FamilyScene error paths — "the request failed, what does the player actually read?".
//
// Companion to sectErrorPaths.ui.ts, same two blocks and same reasoning: familyActionBusyLock.ui.ts
// covers the mechanics of a failure (bt unlocks, buttons return, TimeoutError → networkTimeout) and
// familySendButton.test.ts covers the optimistic-echo rollback, but FamilySceneCore.errorMsg()'s
// server-code → i18n table was never asserted, and neither was the fact that each action's
// `catch { showToast(errorMsg(e)) }` arm actually runs it.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { WorldApiError } from '../../src/net/WorldApiClient';
import type { WorldApiClient, FamilyMemberView } from '../../src/net/WorldApiClient';
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

const [W, H] = [1280, 800];

function stubWorldApi(overrides: Partial<WorldApiClient> = {}): WorldApiClient {
  return { ...overrides } as unknown as WorldApiClient;
}

function member(accountId: string, role: 'leader' | 'elder' | 'member'): FamilyMemberView {
  return { accountId, name: accountId, role, level: 1 } as unknown as FamilyMemberView;
}

function newScene(worldApi: WorldApiClient, myAccountId = 'me'): any {
  const { openTextInput } = createFakeTextInput();
  return new FamilyScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId, playerName: 'Tester',
    getFriendPublicIds: async () => new Set<string>(),
    addFriend: async () => {}, openChat: () => {},
    openTextInput,
  });
}

/** Bare scene, no mode fiddling — enough to reach core.errorMsg(). */
function buildBareScene(): any {
  return newScene(stubWorldApi({}));
}

/** Scene parked in 'create' with both fields filled — same shortcut as familyActionBusyLock.ui.ts. */
function buildCreateScene(worldApi: WorldApiClient): any {
  const scene = newScene(worldApi);
  scene.core.mode = 'create';
  scene.core.createName = 'Iron Quill';
  scene.core.createTag = 'IRQ';
  scene.render();
  return scene;
}

/** Scene parked in 'myFamily' with a fixed roster. */
function buildMyFamilyScene(worldApi: WorldApiClient, members: FamilyMemberView[], myAccountId = 'me'): any {
  const scene = newScene(worldApi, myAccountId);
  scene.core.family = {
    familyId: 'fam1', name: 'Iron Quill', tag: 'IRQ',
    leaderId: members.find((m) => m.role === 'leader')?.accountId ?? 'me',
    memberCount: members.length, prosperity: 0,
  };
  scene.core.members = members;
  scene.core.messages = [];
  scene.core.mode = 'myFamily';
  scene.render();
  return scene;
}

// ── 1. errorMsg()'s server-code table ────────────────────────────────────────
//
// One case per row of FamilyScene/core.ts's `map` — a loop would collapse a dropped row into one
// nameless failure.

describe('FamilyScene — errorMsg() maps server codes to family.err.* copy', () => {
  it('ALREADY_IN_FAMILY → family.err.alreadyIn', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('ALREADY_IN_FAMILY', 'raw'))).toBe(t('family.err.alreadyIn'));
  });

  it('FAMILY_FULL → family.err.cap', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('FAMILY_FULL', 'raw'))).toBe(t('family.err.cap'));
  });

  it('NOT_IN_FAMILY → family.err.notIn', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('NOT_IN_FAMILY', 'raw'))).toBe(t('family.err.notIn'));
  });

  it('NO_PERMISSION → family.err.noPermission', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('NO_PERMISSION', 'raw'))).toBe(t('family.err.noPermission'));
  });

  it('INVALID_TAG → family.err.badTag', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('INVALID_TAG', 'raw'))).toBe(t('family.err.badTag'));
  });

  it('NOT_FOUND → family.err.notFound', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('NOT_FOUND', 'raw'))).toBe(t('family.err.notFound'));
  });

  it('ALREADY_REQUESTED → family.err.alreadyRequested', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('ALREADY_REQUESTED', 'raw'))).toBe(t('family.err.alreadyRequested'));
  });

  it('every mapped code resolves to real copy, never a passed-through key or the raw message', () => {
    const scene = buildBareScene();
    const codes = ['ALREADY_IN_FAMILY', 'FAMILY_FULL', 'NOT_IN_FAMILY', 'NO_PERMISSION',
                   'INVALID_TAG', 'NOT_FOUND', 'ALREADY_REQUESTED'];
    for (const code of codes) {
      const msg = scene.core.errorMsg(new WorldApiError(code, 'raw-server-text'));
      expect(msg, code).not.toBe('raw-server-text');     // the row exists
      expect(msg, code).not.toMatch(/^family\.err\./);   // …and its key has copy behind it
    }
  });
});

describe('FamilyScene — errorMsg() fallbacks', () => {
  it('an unmapped WorldApiError code falls through to the server message', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new WorldApiError('SECT_FULL', 'sect is full'))).toBe('sect is full');
  });

  it('a non-WorldApiError (transport blow-up, thrown string, …) falls through to String(e)', () => {
    const scene = buildBareScene();
    expect(scene.core.errorMsg(new Error('socket hang up'))).toBe('Error: socket hang up');
    expect(scene.core.errorMsg('plain string reject')).toBe('plain string reject');
  });
});

// ── 2. action → toast wiring ─────────────────────────────────────────────────

describe('FamilyScene — a rejected action toasts the mapped copy and unlocks', () => {
  it('doCreate: ALREADY_IN_FAMILY surfaces family.err.alreadyIn and leaves the form standing', async () => {
    const createFamily = vi.fn(async () => { throw new WorldApiError('ALREADY_IN_FAMILY', 'raw'); });
    const scene = buildCreateScene(stubWorldApi({ createFamily }));
    const showToast = vi.spyOn(scene.core, 'showToast');
    const render = vi.spyOn(scene.core, 'render');

    await scene.actions.doCreate();

    expect(createFamily).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(t('family.err.alreadyIn'), expect.anything());
    expect(scene.core.mode).toBe('create');
    expect(scene.core.family).toBeNull();
    expect(scene.core.bt.busy).toBe(false);
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(2); // bt.start() paint + finally paint
  });

  it('confirmKick → doKick: NO_PERMISSION surfaces family.err.noPermission and keeps the member on the roster', async () => {
    const kickMember = vi.fn(async () => { throw new WorldApiError('NO_PERMISSION', 'raw'); });
    const roster = [member('me', 'elder'), member('victim', 'member')];
    const scene = buildMyFamilyScene(stubWorldApi({ kickMember }), roster);
    // confirmKick only opens the confirm sheet — grab its callback rather than hit-testing the modal.
    const confirm = vi.spyOn(scene.core, 'showConfirm');
    const showToast = vi.spyOn(scene.core, 'showToast');

    scene.actions.confirmKick('victim', 'victim');
    expect(confirm).toHaveBeenCalledTimes(1);
    const onOk = confirm.mock.calls[0]![1] as () => void;
    onOk();
    await vi.waitFor(() => expect(scene.core.bt.busy).toBe(false));

    expect(kickMember).toHaveBeenCalledWith('victim');
    expect(showToast).toHaveBeenCalledWith(t('family.err.noPermission'), expect.anything());
    // The optimistic roster filter lives on the SUCCESS side of the try — a rejected kick must not
    // vanish the member from the list the player is looking at.
    expect(scene.core.members.map((m: FamilyMemberView) => m.accountId)).toEqual(['me', 'victim']);
  });

  it('submitMessage: NOT_IN_FAMILY surfaces family.err.notIn (not the raw code) and rolls the echo back', async () => {
    const sendFamilyMessage = vi.fn(async () => { throw new WorldApiError('NOT_IN_FAMILY', 'raw'); });
    const scene = buildMyFamilyScene(stubWorldApi({ sendFamilyMessage }), [member('me', 'leader')]);
    const showToast = vi.spyOn(scene.core, 'showToast');

    await scene.input.submitMessage('hello');

    expect(sendFamilyMessage).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(t('family.err.notIn'), expect.anything());
    expect(scene.core.messages).toEqual([]); // optimistic line removed
    expect(scene.core.bt.busy).toBe(false);
  });

  it('doJoin: ALREADY_REQUESTED surfaces family.err.alreadyRequested instead of the success toast', async () => {
    const requestJoinFamily = vi.fn(async () => { throw new WorldApiError('ALREADY_REQUESTED', 'raw'); });
    const scene = newScene(stubWorldApi({ requestJoinFamily }));
    scene.core.mode = 'noFamily';
    scene.render();
    const showToast = vi.spyOn(scene.core, 'showToast');

    await scene.actions.doJoin('fam_other');

    expect(showToast).toHaveBeenCalledWith(t('family.err.alreadyRequested'), expect.anything());
    expect(showToast).not.toHaveBeenCalledWith(t('family.joinRequested'), expect.anything());
    expect(scene.core.bt.busy).toBe(false);
  });

  it('openJoinList: a failed listFamilies toasts the mapped copy and opens no picker', async () => {
    const listFamilies = vi.fn(async () => { throw new WorldApiError('NOT_FOUND', 'raw'); });
    const scene = newScene(stubWorldApi({ listFamilies }));
    scene.core.mode = 'noFamily';
    scene.render();
    const showToast = vi.spyOn(scene.core, 'showToast');

    await scene.actions.openJoinList();

    expect(showToast).toHaveBeenCalledWith(t('family.err.notFound'), expect.anything());
    expect(scene.core.modalOpen).toBe(false);
  });
});
