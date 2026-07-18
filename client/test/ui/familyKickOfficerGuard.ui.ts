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
  };
  const scene = new FamilyScene(createLayout(390, 844), new InputManager(), cb as any) as any;
  const toasts: { msg: string; color: number }[] = [];
  scene.showToast = (msg: string, color: number) => toasts.push({ msg, color });
  scene.toasts = toasts;
  return scene;
}

async function flush(scene: any): Promise<void> {
  await scene.loadData();
  scene.render();
}

describe('FamilyScene — elder cannot be kicked without demoting first', () => {
  it('the elder row Kick hit shows a toast and never opens the confirm dialog', async () => {
    const scene = buildScene();
    await flush(scene);

    const elder = scene.members.find((m: FamilyMemberView) => m.accountId === 'elderAcc');
    expect(elder.role).toBe('elder');

    // Kick hits are the narrowest per-row action rects; the elder row's sits above the member row's.
    const kickHits = scene.hitRects
      .filter((h: any) => h.rect.w < 150 && h.rect.h === scene.hitRects.find((k: any) => k.rect.w < 150)?.rect.h)
      .sort((a: any, b: any) => a.rect.y - b.rect.y);
    expect(kickHits.length).toBe(2);

    const [elderKick, memberKick] = kickHits;

    elderKick.action();
    expect(scene.modalOpen).toBe(false);
    expect(scene.toasts).toEqual([
      { msg: 'This member holds an office — demote them first before kicking', color: expect.any(Number) },
    ]);

    scene.toasts.length = 0;
    memberKick.action();
    expect(scene.modalOpen).toBe(true);
    expect(scene.toasts).toEqual([]);

    scene.destroy();
  });

  it('after demoting the elder to member, their Kick hit opens the normal confirm-kick dialog', async () => {
    const scene = buildScene();
    await flush(scene);

    await scene.doSetRole('elderAcc', 'member');
    scene.render();

    const kickHits = scene.hitRects
      .filter((h: any) => h.rect.w < 150)
      .sort((a: any, b: any) => a.rect.y - b.rect.y);
    // Both rows are now plain members — either Kick hit should open the confirm dialog.
    kickHits[0].action();
    expect(scene.modalOpen).toBe(true);
    expect(scene.toasts).toEqual([]);

    scene.destroy();
  });
});
