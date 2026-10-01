// ADR-058's busy lock on the Social hub's own family/sect tabs (FriendsScene/network.ts).
//
// FamilyScene/SectScene got the lock in 2026-08 (familyActionBusyLock.ui.ts), but the path a player
// actually takes to CREATE a family or sect is the Social hub's tab, which is FriendsScene — and its
// four org actions had no lock and no timeout. Found 2026-10-01 in real Chrome: two taps on Confirm
// with the request held open sent two `POST /social/family`; the button never greyed.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene, type FriendsSceneCallbacks } from '../../src/scenes/FriendsScene';
import { BUSY_TIMEOUT_MS } from '../../src/ui/busyTracker';
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

const [W, H] = [1920, 1040];

function buildScene(cb: Partial<FriendsSceneCallbacks> = {}): any {
  const { openTextInput } = createFakeTextInput();
  return new FriendsScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenRoom() {},
    openTextInput,
    myPublicId: '',
    getProfileExtra: async () => ({}),
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => null,
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    duelInvite: () => {}, duelRespond: () => {},
    openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    loadSLGStatus: async () => ({ worldId: 'world:1:0', isLeader: true }),
    ...cb,
  });
}

/** Parks the scene on the family create form with both fields filled. */
function onFamilyCreateForm(scene: any): void {
  scene.core.tab = 'family';
  scene.core.slgLoaded = true;
  scene.core.slgStatus = { worldId: 'world:1:0', isLeader: true };
  scene.core.familySubview = 'create';
  scene.core.familyCreateName = 'Iron Quill';
  scene.core.familyCreateTag = 'irq';
  scene.render();
}

/** drawFamilyCreateForm registers Confirm then Cancel last, so Confirm is the second-to-last hit. */
function confirmHit(scene: any): () => void {
  const hits = scene.core.hits as Array<{ fn: () => void }>;
  return hits[hits.length - 2]!.fn;
}

afterEach(() => { vi.useRealTimers(); });

describe('FriendsScene — family/sect create/join busy lock (ADR-058)', () => {
  it('a second Confirm tap while the create request is in flight does not POST again', async () => {
    let release!: () => void;
    const createFamily = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const scene = buildScene({ createFamily });
    onFamilyCreateForm(scene);

    confirmHit(scene)();
    expect(createFamily).toHaveBeenCalledTimes(1);
    expect(scene.core.orgSending).toBe(true);
    // The re-render while busy rebuilt the hit list — tap the CURRENT Confirm button, as a player would.
    confirmHit(scene)();
    void scene.network.doCreateFamily(); // and the action itself, not just the button, refuses
    expect(createFamily).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(scene.core.orgSending).toBe(false));
    expect(scene.core.familySubview).toBe('info');
    expect(createFamily).toHaveBeenCalledWith('Iron Quill', 'IRQ');
    scene.destroy();
  });

  it('the lock is shared: a sect create cannot start while a family request is still in flight', () => {
    const createFamily = vi.fn(() => new Promise<void>(() => {}));
    const createSect = vi.fn(async () => {});
    const scene = buildScene({ createFamily, createSect });
    onFamilyCreateForm(scene);
    confirmHit(scene)();

    scene.core.sectCreateName = 'Ink Order';
    scene.core.sectCreateTag = 'INK';
    void scene.network.doCreateSect();
    expect(createSect).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('a request that never answers times out: the lock releases and the shared timeout toast shows', async () => {
    vi.useFakeTimers();
    const createFamily = vi.fn(() => new Promise<void>(() => {}));
    const scene = buildScene({ createFamily });
    const toast = vi.spyOn(scene.core, 'toast');
    onFamilyCreateForm(scene);
    confirmHit(scene)();
    expect(scene.core.orgSending).toBe(true);

    await vi.advanceTimersByTimeAsync(BUSY_TIMEOUT_MS);
    expect(scene.core.orgSending).toBe(false);
    expect(toast).toHaveBeenCalledWith('common.networkTimeout');
    expect(toast).not.toHaveBeenCalledWith('social.family.createFail');
    expect(scene.core.familySubview).toBe('create'); // nothing was created — the form stays up
    scene.destroy();
  });

  it('a real failure still shows the action-specific toast and releases the lock', async () => {
    const createSect = vi.fn(async () => { throw new Error('INSUFFICIENT_FUNDS'); });
    const scene = buildScene({ createSect });
    const toast = vi.spyOn(scene.core, 'toast');
    scene.core.sectCreateName = 'Ink Order';
    scene.core.sectCreateTag = 'INK';
    await scene.network.doCreateSect();
    expect(toast).toHaveBeenCalledWith('social.sect.createFail');
    expect(scene.core.orgSending).toBe(false);
    scene.destroy();
  });

  it('joinFamily keeps its ALREADY_REQUESTED special case under the lock', async () => {
    const { WorldApiError } = await import('../../src/net/WorldApiClient');
    const joinFamily = vi.fn(async () => { throw new WorldApiError('ALREADY_REQUESTED', 'already'); });
    const scene = buildScene({ joinFamily });
    const toast = vi.spyOn(scene.core, 'toast');
    await scene.network.doJoinFamily('fam:AAA');
    expect(scene.core.familyJoinPending).toBe(true);
    expect(toast).toHaveBeenCalledWith('social.family.joinRequested', 'success');
    expect(scene.core.orgSending).toBe(false);
    scene.destroy();
  });
});
