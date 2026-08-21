// Where the family/sect hub hand-off is allowed to happen — and where it must not.
//
// History. The family/sect tabs are a shortcut into FamilyScene/SectScene once the player already
// belongs to one, and drawFamilyTab()/drawSectTab() (orgForm.ts) used to take that shortcut from
// inside render(): a synchronous `cb.openFamilyHub?.()` mid-tree-walk, which in the real app
// destroys the current FriendsScene (incl. popup.destroy(), nulling popup.container.transform)
// while render() is still building it. Execution then fell through to
// `container.addChild(popup.container)` on a destroyed container and threw
// `can't access property "_parentID", e.transform is null` (06.07.2026). That was patched by
// bailing out of render() if the scene died mid-call.
//
// The jump itself was the real cost though (social-tab-switch-cost, 2026-08-20): tapping the tab
// painted a whole throwaway FriendsScene frame and only then tore it all down for a scene swap.
// The hand-off now lives in core.autoJumpOrgHub(), called from exactly the two moments the answer
// can change — switchTab() (status already known) and loadSLGStatus()'s completion (status just
// arrived) — and never from a draw method.
//
// So these tests pin two things: render() must NOT navigate (the frame it would have thrown away is
// the bug), and the two legitimate entry points must. The mid-render crash guard in endRender()
// stays as a backstop and is still exercised via the loadSLGStatus path.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 1280];

function buildScene(openFamilyHub: () => boolean, openSectHub: () => boolean): any {
  return new FriendsScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenRoom() {},
    myPublicId: '',
    getProfileExtra: async () => ({}),
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
    loadConversations: async () => [],
    openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    loadSLGStatus: async () => null,
    openFamilyHub,
    openSectHub,
  });
}

describe('FriendsScene — the family/sect hub hand-off never happens from inside render()', () => {
  it('drawFamilyTab does not navigate: rendering the family tab of a player who has one is inert', () => {
    let jumps = 0;
    const scene = buildScene(() => { jumps++; return true; }, () => true);

    scene.core.tab = 'family';
    scene.core.slgLoaded = true;
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: false, familyId: 'fam_1' };

    expect(() => scene.render()).not.toThrow();
    expect(jumps).toBe(0);
    expect(scene.core.dead).toBe(false);
    scene.destroy();
  });

  it('drawSectTab does not navigate either', () => {
    let jumps = 0;
    const scene = buildScene(() => true, () => { jumps++; return true; });

    scene.core.tab = 'sect';
    scene.core.slgLoaded = true;
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: true, familyId: 'fam_1', sectId: 'sect_1' };

    expect(() => scene.render()).not.toThrow();
    expect(jumps).toBe(0);
    expect(scene.core.dead).toBe(false);
    scene.destroy();
  });

  it('switchTab jumps straight to the family hub without painting a frame first', () => {
    let scene: any;
    let jumps = 0;
    let renders = 0;
    let rendersAtJump = -1;
    scene = buildScene(
      () => { jumps++; rendersAtJump = renders; scene.destroy(); return true; },
      () => true,
    );
    scene.core.slgLoaded = true;
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: false, familyId: 'fam_1' };

    // Count renders from here on, so the constructor's own initial render doesn't muddy the check.
    const realRender = scene.render.bind(scene);
    scene.render = () => { renders++; realRender(); };
    scene.core.render = scene.render;

    scene.core.switchTab('family');

    expect(jumps).toBe(1);
    // The whole point: no throwaway FriendsScene frame between the tap and the scene swap.
    expect(rendersAtJump).toBe(0);
    expect(renders).toBe(0);
  });

  it('switchTab still paints the family tab when the player has no family (nothing to jump into)', () => {
    let jumps = 0;
    const scene = buildScene(() => { jumps++; return true; }, () => true);
    scene.core.slgLoaded = true;
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: false };

    scene.core.switchTab('family');

    expect(jumps).toBe(0);
    expect(scene.core.tab).toBe('family');
    expect(scene.core.dead).toBe(false);
    scene.destroy();
  });

  it('a hub callback that reports it could not navigate (shard unresolved) leaves the tab rendering', () => {
    let scene: any;
    // Mirrors createSocialNav's openFamilyHub returning false while slgWorldId is still null.
    scene = buildScene(() => false, () => false);
    scene.core.slgLoaded = true;
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: false, familyId: 'fam_1' };

    let renders = 0;
    const realRender = scene.render.bind(scene);
    scene.render = () => { renders++; realRender(); };
    scene.core.render = scene.render;

    scene.core.switchTab('family');

    expect(renders).toBe(1);
    expect(scene.core.dead).toBe(false);
    scene.destroy();
  });

  it('switchTab jumps to the sect hub too, and only when there is actually a sect', () => {
    let scene: any;
    let sectJumps = 0;
    scene = buildScene(() => true, () => { sectJumps++; scene.destroy(); return true; });
    scene.core.slgLoaded = true;
    // In a family, but that family has no sect — the tab is a create/join page, not a shortcut.
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: true, familyId: 'fam_1' };
    scene.core.switchTab('sect');
    expect(sectJumps).toBe(0);
    expect(scene.core.tab).toBe('sect');
    expect(scene.core.dead).toBe(false);

    // Now the family belongs to a sect. Re-tapping the active tab is a no-op, so come back via
    // another tab first — mirroring how a player actually gets there.
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: true, familyId: 'fam_1', sectId: 'sect_1' };
    scene.core.switchTab('friends');
    scene.core.switchTab('sect');
    expect(sectJumps).toBe(1);
  });

  it('the sect tab does not jump when the player has no family at all', () => {
    let jumps = 0;
    const scene = buildScene(() => true, () => { jumps++; return true; });
    scene.core.slgLoaded = true;
    // sectId without familyId shouldn't happen server-side, but autoJumpOrgHub requires the family
    // anyway — sect membership hangs off it, so there is nothing to open without one.
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: false, sectId: 'sect_1' };
    scene.core.switchTab('sect');
    expect(jumps).toBe(0);
    expect(scene.core.dead).toBe(false);
    scene.destroy();
  });

  it('loadSLGStatus resolving into a family jumps on completion, and does not re-render a dead scene', async () => {
    let scene: any;
    let jumps = 0;
    scene = buildScene(
      () => { jumps++; scene.destroy(); return true; },
      () => true,
    );

    scene.core.tab = 'family';
    scene.core.slgLoaded = false;
    scene.core.slgStatus = null;
    // slgLoaded is false → drawFamilyTab kicks off loadSLGStatus() itself, which resolves to a
    // familyId — the jump then happens in its finally, not mid-render. Still must not throw even
    // though the callback destroys the scene (the endRender `dead` backstop).
    (scene as { core: { cb: { loadSLGStatus(): Promise<unknown> } } }).core.cb.loadSLGStatus =
      async () => ({ worldId: 'world:1:0', isLeader: false, familyId: 'fam_1' });

    expect(() => scene.render()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(jumps).toBe(1);
    expect(scene.core.dead).toBe(true);
  });
});
