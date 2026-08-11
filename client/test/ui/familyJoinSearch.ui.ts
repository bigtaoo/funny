// Regression coverage for the family "join" subview after it switched from a raw
// family-ID text field to a name search + browse list (18.07.2026): default view
// shows the top-prosperity/open-slot families from cb.browseFamilies(''), typing +
// Enter re-queries with the fuzzy query, and tapping a result row joins that family
// directly (no separate confirm step) via cb.joinFamily(familyId).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene, type FriendsSceneCallbacks } from '../../src/scenes/FriendsScene';
import { WorldApiError, type FamilyView } from '../../src/net/WorldApiClient';

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

function buildScene(cb: Partial<FriendsSceneCallbacks> = {}): any {
  return new FriendsScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenRoom() {},
    myPublicId: '',
    getProfileExtra: async () => ({}),
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '233784986', displayName: 'Bob' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
    openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    loadSLGStatus: async () => ({ worldId: 'world:1:0', isLeader: false }),
    ...cb,
  });
}

/** Drives the real "Join Family" button click (not just flipping `familySubview`
 * directly) — the browse-list fetch is kicked off from that click handler in
 * orgForm.ts, not from drawFamilyJoinForm itself. */
function enterJoinSubview(scene: any): void {
  scene.core.tab = 'family';
  scene.core.slgLoaded = true;
  scene.core.slgStatus = { worldId: 'world:1:0', isLeader: false };
  scene.render();
  // drawFamilyTab's 'info' branch pushes Create then Join Family last, in that
  // render-tree order — so the last hit registered is the Join Family button.
  const hits = scene.core.hits as Array<{ fn: () => void }>;
  hits[hits.length - 1]!.fn();
}

describe('FriendsScene — family join subview (search + browse list)', () => {
  it('opening the subview loads the default (query="") browse list exactly once', async () => {
    const browseFamilies = vi.fn(async () => [fam('fam:AAA', 'Alpha', 'AAA')]);
    const scene = buildScene({ browseFamilies });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();

    expect(browseFamilies).toHaveBeenCalledTimes(1);
    expect(browseFamilies).toHaveBeenCalledWith('');
    expect(scene.core.familyBrowseResults).toEqual([fam('fam:AAA', 'Alpha', 'AAA')]);
    scene.destroy();
  });

  it('re-entering the subview does not refetch once already loaded', async () => {
    const browseFamilies = vi.fn(async () => []);
    const scene = buildScene({ browseFamilies });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();

    scene.core.familySubview = 'info';
    scene.render();
    enterJoinSubview(scene);
    await Promise.resolve();

    expect(browseFamilies).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('renders one clickable row per result, and tapping it joins that family directly', async () => {
    const joinFamily = vi.fn(async () => {});
    const results = [fam('fam:AAA', 'Alpha', 'AAA'), fam('fam:BBB', 'Beta', 'BBB')];
    const scene = buildScene({ browseFamilies: async () => results, joinFamily });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    await scene.network.doJoinFamily('fam:BBB');
    expect(joinFamily).toHaveBeenCalledWith('fam:BBB');
    // A successful join returns to the info subview and clears the browse cache so
    // re-opening "Join" later fetches fresh (post-join) data instead of stale results.
    expect(scene.core.familySubview).toBe('info');
    expect(scene.core.familyBrowseResults).toEqual([]);
    expect(scene.core.familyBrowseLoaded).toBe(false);
    scene.destroy();
  });

  it('a failed join keeps the subview open (so the user can retry) and does not clear results', async () => {
    const joinFamily = vi.fn(async () => { throw new Error('FAMILY_FULL'); });
    const results = [fam('fam:AAA', 'Alpha', 'AAA')];
    const scene = buildScene({ browseFamilies: async () => results, joinFamily });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();

    await scene.network.doJoinFamily('fam:AAA');
    expect(scene.core.familySubview).toBe('joinById');
    scene.destroy();
  });

  it('a successful join drops the Create/Join-by-search buttons from the info subview', async () => {
    const joinFamily = vi.fn(async () => {});
    const results = [fam('fam:AAA', 'Alpha', 'AAA'), fam('fam:BBB', 'Beta', 'BBB')];
    const scene = buildScene({ browseFamilies: async () => results, joinFamily });
    scene.core.tab = 'family';
    scene.core.slgLoaded = true;
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: false };
    scene.render();
    const hitsBefore = scene.core.hits.length; // tab bar + Create + Join-by-search

    await scene.network.doJoinFamily('fam:BBB');
    expect(scene.core.familyJoinPending).toBe(true);
    // Success bounces back to the 'info' subview — re-requesting while a request is
    // outstanding is pointless (server-side ALREADY_REQUESTED), so both entry buttons go away.
    scene.render();
    expect(scene.core.hits.length).toBe(hitsBefore - 2);
    scene.destroy();
  });

  it('ALREADY_REQUESTED from the server greys out the row Join buttons instead of showing a raw failure', async () => {
    const joinFamily = vi.fn(async () => { throw new WorldApiError('ALREADY_REQUESTED', 'already requested'); });
    const results = [fam('fam:AAA', 'Alpha', 'AAA')];
    const scene = buildScene({ browseFamilies: async () => results, joinFamily });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();

    await scene.network.doJoinFamily('fam:AAA');
    expect(scene.core.familyJoinPending).toBe(true);
    // Stays on the browse list (unlike the success path) so the now-greyed row is visible.
    expect(scene.core.familySubview).toBe('joinById');
    scene.render();

    // Row hits push in pairs (Join button, then row-tap-for-detail) — with one result the
    // Join button is second-to-last, the row-detail tap is last.
    const hits = scene.core.hits as Array<{ fn: () => void }>;
    const before = joinFamily.mock.calls.length;
    hits[hits.length - 2]!.fn();
    expect(joinFamily.mock.calls.length).toBe(before);
    scene.destroy();
  });

  it('pressing Enter / Search re-queries browseFamilies with the typed name', async () => {
    const browseFamilies = vi.fn(async (q?: string) => (q === 'alp' ? [fam('fam:AAA', 'Alpha', 'AAA')] : []));
    const scene = buildScene({ browseFamilies });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();

    scene.core.familyBrowseQuery = 'alp';
    await scene.network.loadFamilyBrowse('alp');

    expect(browseFamilies).toHaveBeenLastCalledWith('alp');
    expect(scene.core.familyBrowseResults).toEqual([fam('fam:AAA', 'Alpha', 'AAA')]);
    scene.destroy();
  });

  it('an empty result set does not throw and leaves the row-hit list empty (no phantom join targets)', async () => {
    const scene = buildScene({ browseFamilies: async () => [] });
    expect(() => enterJoinSubview(scene)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(() => scene.render()).not.toThrow();
    expect(scene.core.familyBrowseResults).toEqual([]);
    scene.destroy();
  });

  it('every result-row hit rect stays within the design bounds', async () => {
    const results = Array.from({ length: 6 }, (_, i) => fam(`fam:${i}`, `Family${i}`, `TAG${i}`));
    const scene = buildScene({ browseFamilies: async () => results });
    enterJoinSubview(scene);
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    for (const hit of scene.core.hits as Array<{ rect: { x: number; y: number; w: number; h: number } }>) {
      expect(hit.rect.x).toBeGreaterThanOrEqual(0);
      expect(hit.rect.x + hit.rect.w).toBeLessThanOrEqual(scene.core.w);
    }
    scene.destroy();
  });
});
