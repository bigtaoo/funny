// Regression coverage for splitting the family-browse row's single "tap joins" action
// (18.07.2026) into two distinct affordances: a dedicated "Join" button that joins
// directly, and tapping the rest of the row to preview the family via a new
// cb.viewFamily(familyId) callback before committing.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene, type FriendsSceneCallbacks } from '../../src/scenes/FriendsScene';
import type { FamilyView, FamilyDetailView } from '../../src/net/WorldApiClient';

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

function fam(id: string, name: string, tag: string, memberCount = 5, prosperity = 10): FamilyView {
  return { familyId: id, name, tag, leaderId: 'someone', memberCount, prosperity };
}

function famDetail(id: string, name: string, tag: string, extra: Partial<FamilyDetailView> = {}): FamilyDetailView {
  return {
    familyId: id, name, tag, leaderId: 'acc-leader', memberCount: 5, prosperity: 10,
    members: [{ accountId: 'acc-leader', role: 'leader', joinedAt: 0, displayName: 'TaoWang' }],
    ...extra,
  };
}

function buildScene(cb: Partial<FriendsSceneCallbacks> = {}): any {
  return new FriendsScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenRoom() {},
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '233784986', displayName: 'Bob' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {},
    openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    loadSLGStatus: async () => ({ worldId: 'world:1:0', isLeader: false }),
    ...cb,
  });
}

/** Same trick as familyJoinSearch.ui.ts: drives the real "Join Family" button (not a
 * direct field flip), since the browse-list fetch is kicked off from that click handler. */
function enterJoinSubview(scene: any): void {
  scene.tab = 'family';
  scene.slgLoaded = true;
  scene.slgStatus = { worldId: 'world:1:0', isLeader: false };
  scene.render();
  const hits = scene.hits as Array<{ fn: () => void }>;
  hits[hits.length - 1]!.fn();
}

/** drawFamilyBrowseList pushes exactly [joinButtonHit, rowHit] per family, in that
 * order, as the very last thing drawFamilyJoinForm renders — so the trailing
 * `2 * count` hits in scene.hits are the row pairs, in list order. */
function rowHits(scene: any, count: number): Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }> {
  const hits = scene.hits as Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
  return hits.slice(hits.length - 2 * count);
}

describe('FriendsScene — family browse row: Join button vs info preview', () => {
  it('tapping the Join button joins immediately and never calls viewFamily', async () => {
    const joinFamily = vi.fn(async () => {});
    const viewFamily = vi.fn(async () => famDetail('fam:AAA', 'Alpha', 'AAA'));
    const results = [fam('fam:AAA', 'Alpha', 'AAA'), fam('fam:BBB', 'Beta', 'BBB')];
    const scene = buildScene({ browseFamilies: async () => results, joinFamily, viewFamily });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    const [btnA, rowA, btnB] = rowHits(scene, 2);
    // Join-button rect sits at the row's right edge, narrower than the row itself.
    expect(btnA!.rect.x).toBeGreaterThan(rowA!.rect.x);
    expect(btnA!.rect.w).toBeLessThan(rowA!.rect.w);

    btnB!.fn();
    await Promise.resolve();
    expect(joinFamily).toHaveBeenCalledWith('fam:BBB');
    expect(viewFamily).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('tapping the rest of the row opens the info preview and never joins', async () => {
    const joinFamily = vi.fn(async () => {});
    const detail = famDetail('fam:AAA', 'Alpha', 'AAA', { memberCount: 7, prosperity: 42 });
    const viewFamily = vi.fn(async () => detail);
    const results = [fam('fam:AAA', 'Alpha', 'AAA')];
    const scene = buildScene({ browseFamilies: async () => results, joinFamily, viewFamily });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    const [, rowA] = rowHits(scene, 1);
    rowA!.fn();
    expect(scene.familyDetailLoading).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(viewFamily).toHaveBeenCalledWith('fam:AAA');
    expect(joinFamily).not.toHaveBeenCalled();
    expect(scene.familyDetailLoading).toBe(false);
    expect(scene.familyDetailView).toEqual(detail);
    scene.destroy();
  });

  it('the info preview renders Cancel + Join; Cancel closes it without joining', async () => {
    const joinFamily = vi.fn(async () => {});
    const viewFamily = vi.fn(async () => famDetail('fam:AAA', 'Alpha', 'AAA'));
    const scene = buildScene({ browseFamilies: async () => [fam('fam:AAA', 'Alpha', 'AAA')], joinFamily, viewFamily });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();
    rowHits(scene, 1)[1]!.fn();
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    const hits = scene.hits as Array<{ fn: () => void }>;
    const [cancelHit, joinHit] = hits.slice(-2);
    cancelHit!.fn();
    expect(scene.familyDetailView).toBeNull();
    expect(joinFamily).not.toHaveBeenCalled();
    void joinHit;
    scene.destroy();
  });

  it('the info preview\'s Join button joins directly and the popup closes on success', async () => {
    const joinFamily = vi.fn(async () => {});
    const viewFamily = vi.fn(async () => famDetail('fam:AAA', 'Alpha', 'AAA'));
    const scene = buildScene({ browseFamilies: async () => [fam('fam:AAA', 'Alpha', 'AAA')], joinFamily, viewFamily });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();
    rowHits(scene, 1)[1]!.fn();
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    const hits = scene.hits as Array<{ fn: () => void }>;
    const [, joinHit] = hits.slice(-2);
    joinHit!.fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(joinFamily).toHaveBeenCalledWith('fam:AAA');
    expect(scene.familyDetailView).toBeNull();
    scene.destroy();
  });

  it('a fetch failure clears the loading flag, toasts, and leaves the browse list usable', async () => {
    const viewFamily = vi.fn(async () => { throw new Error('NOT_FOUND'); });
    const scene = buildScene({ browseFamilies: async () => [fam('fam:AAA', 'Alpha', 'AAA')], viewFamily });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    rowHits(scene, 1)[1]!.fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(scene.familyDetailLoading).toBe(false);
    expect(scene.familyDetailView).toBeNull();
    expect(() => scene.render()).not.toThrow();
    scene.destroy();
  });

  it('the Back button closes the info preview instead of leaving the social hub', async () => {
    const onBack = vi.fn();
    const viewFamily = vi.fn(async () => famDetail('fam:AAA', 'Alpha', 'AAA'));
    const scene = buildScene({ onBack, browseFamilies: async () => [fam('fam:AAA', 'Alpha', 'AAA')], viewFamily });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();
    rowHits(scene, 1)[1]!.fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(scene.familyDetailView).not.toBeNull();
    scene.onBack();
    expect(scene.familyDetailView).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('without a viewFamily callback, tapping the row does nothing (no crash, no detail view)', async () => {
    const scene = buildScene({ browseFamilies: async () => [fam('fam:AAA', 'Alpha', 'AAA')] });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    expect(() => rowHits(scene, 1)[1]!.fn()).not.toThrow();
    expect(scene.familyDetailView).toBeNull();
    scene.destroy();
  });

  it('every row-pair hit rect (join button + info area) stays within the design bounds and does not overlap', async () => {
    const results = Array.from({ length: 6 }, (_, i) => fam(`fam:${i}`, `Family${i}`, `TAG${i}`));
    const scene = buildScene({ browseFamilies: async () => results, viewFamily: async () => famDetail('fam:0', 'Family0', 'TAG0') });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    for (const [btn, row] of chunk2(rowHits(scene, results.length))) {
      expect(btn.rect.x).toBeGreaterThanOrEqual(0);
      expect(btn.rect.x + btn.rect.w).toBeLessThanOrEqual(scene.w);
      expect(row.rect.x).toBeGreaterThanOrEqual(0);
      expect(row.rect.x + row.rect.w).toBeLessThanOrEqual(scene.w);
      // No overlap: the row (info-tap) area ends at or before the button starts.
      expect(row.rect.x + row.rect.w).toBeLessThanOrEqual(btn.rect.x);
    }
    scene.destroy();
  });
});

function chunk2<T>(arr: T[]): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  for (let i = 0; i < arr.length; i += 2) out.push([arr[i]!, arr[i + 1]!]);
  return out;
}
