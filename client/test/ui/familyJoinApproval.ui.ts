// Regression coverage for the family join-approval feature (18.07.2026): joining a family no
// longer adds membership immediately — it submits a request that a leader/elder must approve.
// Covers: the leader-only "Pending Requests" button only shows up when there are requests,
// opening it renders Approve/Reject rows, approving refetches the roster (and clears the modal),
// and rejecting removes just that row without touching membership.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { WorldApiError } from '../../src/net/WorldApiClient';
import type { FamilyDetailView, FamilyMemberView, FamilyJoinRequestView, FamilyView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makeFamily(overrides: Partial<FamilyDetailView> = {}): FamilyDetailView {
  const members: FamilyMemberView[] = [{ accountId: 'me', role: 'leader', joinedAt: 0, displayName: 'tao', publicId: '1' }];
  return {
    familyId: 'fam1', name: 'Iron Quill', tag: 'IRQ', leaderId: 'me',
    memberCount: 1, prosperity: 480, members,
    ...overrides,
  };
}

function textsOf(scene: any): string[] {
  return scene.bodyLayer.children
    .filter((c: unknown) => c instanceof PIXI.Text)
    .map((c: PIXI.Text) => c.text);
}

function buildScene(family: FamilyDetailView, requests: FamilyJoinRequestView[], overrides: Record<string, unknown> = {}): any {
  const worldApi = {
    getMyFamily: async () => family,
    getFamilyChannel: async () => [],
    listJoinRequests: vi.fn(async () => requests),
    respondJoinRequest: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  const cb = {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
  };
  return new FamilyScene(createLayout(390, 844), new InputManager(), cb as any);
}

async function flush(scene: any): Promise<void> {
  await scene.loadData();
}

describe('FamilyScene — pending join-request approval', () => {
  it('leader with no pending requests: button is not shown, listJoinRequests still called', async () => {
    const scene = buildScene(makeFamily(), []);
    await flush(scene);
    scene.render();

    expect(scene.cb.worldApi.listJoinRequests).toHaveBeenCalled();
    expect(textsOf(scene).some((s: string) => s.includes('Pending'))).toBe(false);
    scene.destroy();
  });

  it('leader with pending requests: shows the count button; a plain member sees nothing', async () => {
    const requests: FamilyJoinRequestView[] = [
      { requestId: 'r1', accountId: 'applicant1', displayName: 'Newbie', createdAt: 0 },
    ];
    const scene = buildScene(makeFamily(), requests);
    await flush(scene);
    scene.render();

    expect(textsOf(scene)).toContain('Pending Requests (1)');

    // A plain member must never see the button or fetch the (leader/elder-only) request list.
    const memberFamily = makeFamily({
      members: [
        { accountId: 'me', role: 'member', joinedAt: 0, displayName: 'tao', publicId: '1' },
        { accountId: 'lead', role: 'leader', joinedAt: 0, displayName: 'Boss', publicId: '2' },
      ],
    });
    const memberScene = buildScene(memberFamily, requests);
    await flush(memberScene);
    memberScene.render();
    expect(memberScene.cb.worldApi.listJoinRequests).not.toHaveBeenCalled();
    expect(textsOf(memberScene).some((s: string) => s.includes('Pending'))).toBe(false);

    scene.destroy();
    memberScene.destroy();
  });

  it('the pending button is a real hit rect that opens the same modal as openJoinRequests()', async () => {
    const requests: FamilyJoinRequestView[] = [
      { requestId: 'r1', accountId: 'applicant1', displayName: 'Newbie', createdAt: 0 },
    ];
    const scene = buildScene(makeFamily(), requests);
    await flush(scene);
    scene.render();

    // The button is the only hit rect landing exactly at contentY (tab bar + info band bottom) —
    // every other hit (back pill, rail tabs, tab-switch bar, per-member row) sits at a different y.
    const contentY = scene.headerH + Math.round(scene.h * 0.05) + scene.infoBandH;
    const btnHit = scene.hitRects.find((h: any) => h.rect.y === contentY + 2);
    expect(btnHit).toBeTruthy();
    expect(scene.modalOpen).toBe(false);
    btnHit.action();

    expect(scene.modalOpen).toBe(true);
    const modalTexts = scene.modalLayer.children
      .filter((c: unknown) => c instanceof PIXI.Text)
      .map((c: PIXI.Text) => c.text);
    expect(modalTexts).toContain('Newbie');
    expect(modalTexts).toContain('Approve');
    expect(modalTexts).toContain('Reject');
    scene.destroy();
  });

  it('approving calls respondJoinRequest(id, true), refetches the family, and closes the modal', async () => {
    const requests: FamilyJoinRequestView[] = [
      { requestId: 'r1', accountId: 'applicant1', displayName: 'Newbie', createdAt: 0 },
    ];
    const joinedFamily = makeFamily({
      memberCount: 2,
      members: [
        { accountId: 'me', role: 'leader', joinedAt: 0, displayName: 'tao', publicId: '1' },
        { accountId: 'applicant1', role: 'member', joinedAt: 1, displayName: 'Newbie', publicId: '3' },
      ],
    });
    let getFamilyCalls = 0;
    const scene = buildScene(makeFamily(), requests, {
      getFamily: async () => { getFamilyCalls++; return joinedFamily; },
    });
    await flush(scene);
    scene.render();
    scene.openJoinRequests();

    // Approve sits left of Reject — the two 56-wide buttons in the (single) request row.
    // (Hits fire-and-forget the async handler — `action()` returns void, not a promise — so call
    // the underlying handler directly to await it deterministically; the rect count above already
    // proves the button wiring exists.)
    const rowHits = scene.modalHits.filter((h: any) => h.rect.w === 112);
    expect(rowHits).toHaveLength(2);
    await scene.doRespondJoinRequest('r1', true);

    expect(scene.cb.worldApi.respondJoinRequest).toHaveBeenCalledWith('r1', true);
    expect(getFamilyCalls).toBe(1);
    expect(scene.modalOpen).toBe(false);
    expect(scene.members.map((m: FamilyMemberView) => m.accountId)).toContain('applicant1');
    scene.destroy();
  });

  it('rejecting calls respondJoinRequest(id, false) and removes just that row, leaving membership untouched', async () => {
    const requests: FamilyJoinRequestView[] = [
      { requestId: 'r1', accountId: 'applicant1', displayName: 'Newbie', createdAt: 0 },
      { requestId: 'r2', accountId: 'applicant2', displayName: 'Second', createdAt: 1 },
    ];
    const getFamily = vi.fn(async () => makeFamily());
    const scene = buildScene(makeFamily(), requests, { getFamily });
    await flush(scene);
    scene.render();
    scene.openJoinRequests();

    const rowHits = scene.modalHits.filter((h: any) => h.rect.w === 112);
    expect(rowHits).toHaveLength(4); // 2 requests × (approve + reject)
    await scene.doRespondJoinRequest('r1', false);

    expect(scene.cb.worldApi.respondJoinRequest).toHaveBeenCalledWith('r1', false);
    expect(getFamily).not.toHaveBeenCalled(); // rejection doesn't touch the roster
    expect(scene.joinRequests.map((r: FamilyJoinRequestView) => r.requestId)).toEqual(['r2']);
    expect(scene.modalOpen).toBe(true); // one request remains → modal stays open, refreshed
    scene.destroy();
  });
});

/** Builds a not-yet-in-a-family FamilyScene (mode 'noFamily') for the applicant-side flow:
 *  openJoinList() → pick a family → doJoin() submits a request instead of joining outright.
 *  `getFamily` is deliberately omitted from the default worldApi stub — the pre-approval code
 *  called `loadMyFamily()` (→ `worldApi.getFamily`) right after joining, so a regression back to
 *  that behavior would throw here (`getFamily` undefined) instead of silently passing. */
function buildApplicantScene(overrides: Record<string, unknown> = {}): any {
  const worldApi = {
    getMyFamily: async () => null,
    listFamilies: vi.fn(async (): Promise<FamilyView[]> => [
      { familyId: 'fam:AAA', name: 'Alpha', tag: 'AAA', leaderId: 'someone', memberCount: 3, prosperity: 10 },
    ]),
    ...overrides,
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

describe('FamilyScene — applicant side (join a family submits a request, not membership)', () => {
  it('doJoin: submits a request, shows a confirmation toast, and stays in noFamily (no re-fetch of the roster)', async () => {
    const requestJoinFamily = vi.fn(async () => ({ requestId: 'req1' }));
    const scene = buildApplicantScene({ requestJoinFamily });
    await flush(scene);
    expect(scene.mode).toBe('noFamily');

    await scene.doJoin('fam:AAA');

    expect(requestJoinFamily).toHaveBeenCalledWith('fam:AAA');
    expect(scene.mode).toBe('noFamily'); // still not a member — approval is pending
    expect(scene.modalOpen).toBe(false); // the pick modal closed
    expect(scene.toasts).toEqual([{ msg: 'Request submitted — waiting for approval', color: expect.any(Number) }]);
  });

  it('openJoinList renders one clickable row per browsable family (via listFamilies)', async () => {
    const scene = buildApplicantScene();
    await flush(scene);

    await scene.openJoinList();

    expect(scene.cb.worldApi.listFamilies).toHaveBeenCalled();
    expect(scene.modalOpen).toBe(true);
    const modalTexts = scene.modalLayer.children
      .filter((c: unknown) => c instanceof PIXI.Text)
      .map((c: PIXI.Text) => c.text);
    expect(modalTexts.some((s: string) => s.includes('Alpha'))).toBe(true);
  });

  it('a failed join request surfaces the mapped ALREADY_REQUESTED error as a toast', async () => {
    const requestJoinFamily = vi.fn(async () => { throw new WorldApiError('ALREADY_REQUESTED', 'dup'); });
    const scene = buildApplicantScene({ requestJoinFamily });
    await flush(scene);

    await scene.doJoin('fam:AAA');

    expect(scene.toasts).toEqual([
      { msg: 'You already applied — waiting for approval', color: expect.any(Number) },
    ]);
  });
});
