// Coverage for ADR-058's busy-lock + button-greying extension to FamilyScene: a mutating action
// (create/leave here, representative of dissolve/kick/setRole/join-request-response which share
// the same `if (core.bt.busy) return; ... withTimeout(...) ... finally { core.bt.stop(); render() }`
// wrapper) must not fire twice while the first request is in flight, the acting button must grey
// out (no hit rect) during that window, and a hung request must time out and recover.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import type { WorldApiClient, FamilyMemberView } from '../../src/net/WorldApiClient';
import { TimeoutError } from '../../src/ui/busyTracker';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1280, 800]; // landscape — matches SectScene's busy-lock test sizing

function stubWorldApi(overrides: Partial<WorldApiClient> = {}): WorldApiClient {
  return { ...overrides } as unknown as WorldApiClient;
}

/** Scene state (mode/family/members/bt/hitRects/…) lives on `scene.core`; mutating actions
 *  (doCreate/doLeave/…) live on `scene.actions` — see FamilyScene/core.ts's file-header comment
 *  (2026-08-11 mixin→composition conversion). */
function buildCreateScene(worldApi: WorldApiClient): any {
  const scene: any = new FamilyScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'Tester',
    getFriendPublicIds: async () => new Set<string>(),
    addFriend: async () => {}, openChat: () => {},
  });
  scene.core.mode = 'create';
  scene.core.createName = 'Iron Quill';
  scene.core.createTag = 'IRQ';
  scene.render();
  return scene;
}

/** Parks the scene in 'myFamily' with a fixed member list — bypasses loadData()'s network
 *  round-trip (same reasoning as SectScene/sectCreateCost.ui.ts's buildNoSectScene). */
function buildMyFamilyScene(worldApi: WorldApiClient, members: FamilyMemberView[], myAccountId: string): any {
  const scene: any = new FamilyScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId, playerName: 'Tester',
    getFriendPublicIds: async () => new Set<string>(),
    addFriend: async () => {}, openChat: () => {},
  });
  scene.core.family = { familyId: 'fam1', name: 'Iron Quill', tag: 'IRQ', leaderId: members.find((m) => m.role === 'leader')?.accountId ?? 'me', memberCount: members.length, prosperity: 0 };
  scene.core.members = members;
  scene.core.messages = [];
  scene.core.mode = 'myFamily';
  scene.render();
  return scene;
}

function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === label) { found = { x: node.x, y: node.y }; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };
function hitUnder(hits: Hit[], pos: { x: number; y: number }): Hit | undefined {
  return hits.find(({ rect: r }) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h);
}

describe('FamilyScene — busy lock prevents duplicate requests', () => {
  it('doCreate: a second call while the first is in flight does not re-issue the request', async () => {
    const createFamily = vi.fn(() => new Promise<never>(() => {})); // never resolves
    const scene = buildCreateScene(stubWorldApi({ createFamily }));

    void scene.actions.doCreate();
    void scene.actions.doCreate(); // busy — must short-circuit before touching worldApi
    await Promise.resolve();

    expect(createFamily).toHaveBeenCalledTimes(1);
    expect(scene.core.bt.busy).toBe(true);
  });

  it('doCreate: unlocks and switches to myFamily once the request resolves', async () => {
    const createFamily = vi.fn(async () => ({ familyId: 'fam1', name: 'Iron Quill', tag: 'IRQ', leaderId: 'me', memberCount: 1, prosperity: 0, members: [] }));
    const scene = buildCreateScene(stubWorldApi({ createFamily }));

    await scene.actions.doCreate();

    expect(createFamily).toHaveBeenCalledTimes(1);
    expect(scene.core.bt.busy).toBe(false);
    expect(scene.core.mode).toBe('myFamily');
  });
});

describe('FamilyScene — Create button greys out while busy', () => {
  it('has a hit rect when idle, none while the request is pending', async () => {
    const createFamily = vi.fn(() => new Promise<never>(() => {}));
    const scene = buildCreateScene(stubWorldApi({ createFamily }));

    const pos = findLabelPos(scene.container, t('family.create'));
    expect(pos).not.toBeNull();
    expect(hitUnder(scene.core.hitRects, pos!)).toBeDefined(); // idle: clickable

    void scene.actions.doCreate();
    expect(hitUnder(scene.core.hitRects, pos!)).toBeUndefined(); // busy: greyed out, no hit rect
  });
});

describe('FamilyScene — own-row Leave button greys out while busy', () => {
  it('a member (non-leader) sees a clickable Leave button that greys out mid-request', async () => {
    const leaveFamily = vi.fn(() => new Promise<{ ok: true }>(() => {}));
    const members: FamilyMemberView[] = [
      { accountId: 'me', role: 'member', joinedAt: 0, displayName: 'tao', publicId: '1' },
      { accountId: 'lead', role: 'leader', joinedAt: 0, displayName: 'Boss', publicId: '2' },
    ];
    const scene = buildMyFamilyScene(stubWorldApi({ leaveFamily }), members, 'me');

    const pos = findLabelPos(scene.container, t('family.leave'));
    expect(pos).not.toBeNull();
    expect(hitUnder(scene.core.hitRects, pos!)).toBeDefined();

    void scene.actions.doLeave();
    expect(hitUnder(scene.core.hitRects, pos!)).toBeUndefined();
    expect(leaveFamily).toHaveBeenCalledTimes(1);
  });
});

describe('FamilyScene — network timeout recovers cleanly', () => {
  it('a hung leaveFamily() times out after 10s, toasts common.networkTimeout, and unlocks', async () => {
    vi.useFakeTimers();
    try {
      const leaveFamily = vi.fn(() => new Promise<{ ok: true }>(() => {}));
      const members: FamilyMemberView[] = [
        { accountId: 'me', role: 'member', joinedAt: 0, displayName: 'tao', publicId: '1' },
        { accountId: 'lead', role: 'leader', joinedAt: 0, displayName: 'Boss', publicId: '2' },
      ];
      const scene = buildMyFamilyScene(stubWorldApi({ leaveFamily }), members, 'me');
      const showToast = vi.spyOn(scene.core, 'showToast');

      const pending = scene.actions.doLeave();
      await vi.advanceTimersByTimeAsync(10_001);
      await pending;

      expect(showToast).toHaveBeenCalledWith(t('common.networkTimeout'), expect.anything());
      expect(scene.core.bt.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FamilyScene — errorMsg() classifies TimeoutError', () => {
  it('maps TimeoutError to the common.networkTimeout i18n key instead of falling through to String(e)', () => {
    const scene = buildCreateScene(stubWorldApi({}));
    expect(scene.core.errorMsg(new TimeoutError())).toBe(t('common.networkTimeout'));
  });
});
