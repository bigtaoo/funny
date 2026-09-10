// Regression coverage for the "officers can't be kicked directly" guard (18.07.2026): a family
// leader must demote an elder to plain member before they can be kicked. The Kick button for an
// elder row renders disabled (no confirm dialog on click, just an explanatory toast) while a plain
// member's Kick button still opens the normal confirm-kick flow.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import type { FamilyDetailView, FamilyMemberView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makeFamily(): FamilyDetailView {
  const members: FamilyMemberView[] = [
    { accountId: 'me', role: 'leader', joinedAt: 0, displayName: 'tao', publicId: '1' },
    { accountId: 'elderAcc', role: 'elder', joinedAt: 0, displayName: 'zihao', publicId: '2' },
    { accountId: 'memberAcc', role: 'member', joinedAt: 0, displayName: 'plain', publicId: '3' },
  ];
  return {
    familyId: 'fam1', name: 'Iron Quill', tag: 'IRQ', leaderId: 'me',
    memberCount: members.length, prosperity: 0, members,
  };
}

function buildScene(): any {
  const worldApi = {
    getMyFamily: async () => makeFamily(),
    getFamilyChannel: async () => [],
    listJoinRequests: async () => [],
    kickMember: async () => ({ ok: true }),
    setRole: async () => ({ ok: true }),
  };
  const cb = {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
    getFriendPublicIds: async () => new Set<string>(),
  };
  const scene = new FamilyScene(createLayout(390, 844), new InputManager(), cb as any) as any;
  const toasts: { msg: string; color: number }[] = [];
  scene.core.showToast = (msg: string, color: number) => toasts.push({ msg, color });
  scene.toasts = toasts;
  return scene;
}

async function flush(scene: any): Promise<void> {
  await scene.data.loadData();
  scene.render();
}

// Kick is the rightmost button of a manageable row: the row's actions are laid out from the right
// edge inward (Kick first, then the role toggle), and both are `btnH` tall while the profile-tap
// rect covering the name/role area is noticeably taller. So: keep the button-height rects, then
// take the largest-x one per row. Picking "the narrowest rects" instead used to work only because
// "Promote to Elder" was wide enough to fall outside a width cutoff — the 2026-09-10 relabelling to
// `↑ Elder` made the role toggle just as narrow as Kick and silently doubled what that matched.
function findKickHits(scene: any): any[] {
  const rects = scene.core.hitRects.map((h: any) => h.rect);
  const btnH = Math.min(...rects.map((r: any) => r.h));
  const buttons = scene.core.hitRects.filter((h: any) => h.rect.h === btnH);
  const rightmostPerRow = new Map<number, any>();
  for (const hit of buttons) {
    const prev = rightmostPerRow.get(hit.rect.y);
    if (!prev || hit.rect.x > prev.rect.x) rightmostPerRow.set(hit.rect.y, hit);
  }
  return [...rightmostPerRow.values()].sort((a: any, b: any) => a.rect.y - b.rect.y);
}

describe('FamilyScene — elder cannot be kicked without demoting first', () => {
  it('the elder row Kick hit shows a toast and never opens the confirm dialog', async () => {
    const scene = buildScene();
    await flush(scene);

    const elder = scene.core.members.find((m: FamilyMemberView) => m.accountId === 'elderAcc');
    expect(elder.role).toBe('elder');

    // Kick hits are the narrowest per-row action rects; the elder row's sits above the member row's.
    const kickHits = findKickHits(scene);
    expect(kickHits.length).toBe(2);

    const [elderKick, memberKick] = kickHits;

    elderKick.fn();
    expect(scene.core.modalOpen).toBe(false);
    expect(scene.toasts).toEqual([
      { msg: 'This member holds an office — demote them first before kicking', color: expect.any(Number) },
    ]);

    scene.toasts.length = 0;
    memberKick.fn();
    expect(scene.core.modalOpen).toBe(true);
    expect(scene.toasts).toEqual([]);

    scene.destroy();
  });

  it('after demoting the elder to member, their Kick hit opens the normal confirm-kick dialog', async () => {
    const scene = buildScene();
    await flush(scene);

    await scene.actions.doSetRole('elderAcc', 'member');
    scene.render();

    const kickHits = findKickHits(scene);
    // Both rows are now plain members — either Kick hit should open the confirm dialog.
    kickHits[0].fn();
    expect(scene.core.modalOpen).toBe(true);
    expect(scene.toasts).toEqual([]);

    scene.destroy();
  });
});
