// Regression guard for the "enter Family/Sect tab → app crashes with
// `can't access property "_parentID", e.transform is null`" bug (06.07.2026).
//
// Root cause: FriendsSceneBase.render() (base.ts) detaches the persistent
// `popup.container` singleton before tearing down the rest of the tree, then
// re-adds it at the end of the same render() call. drawFamilyTab()/drawSectTab()
// (orgForm.ts) synchronously call `cb.openFamilyHub?.()` / `cb.openSectHub?.()`
// once the player already belongs to a family/sect — in the real app this
// navigates to FamilyScene/SectScene and destroys the current FriendsScene
// (including popup.destroy(), which nulls popup.container.transform). Because
// that destroy happens *while still inside* the same render() call, execution
// used to fall through to `this.container.addChild(this.popup.container)` on the
// now-destroyed container and throw. Fixed by bailing out of render() right
// after the tab dispatch if the scene was destroyed mid-call (base.ts).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui

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

function buildScene(openFamilyHub: () => void, openSectHub: () => void): any {
  return new FriendsScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenRoom() {},
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {},
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

describe('FriendsScene — navigating to family/sect hub mid-render does not crash', () => {
  it('drawFamilyTab: openFamilyHub destroying the scene synchronously during render() does not throw', () => {
    let scene: any;
    let destroyedDuringRender = false;
    scene = buildScene(
      () => { scene.destroy(); destroyedDuringRender = true; },
      () => {},
    );

    // Player already belongs to a family → drawFamilyTab() takes the
    // "openFamilyHub and bail" branch instead of drawing the info/create UI.
    scene.tab = 'family';
    scene.slgLoaded = true;
    scene.slgStatus = { worldId: 'world:1:0', isLeader: false, familyId: 'fam_1' };

    expect(() => scene.render()).not.toThrow();
    expect(destroyedDuringRender).toBe(true);
    expect(scene.dead).toBe(true);
  });

  it('drawSectTab: openSectHub destroying the scene synchronously during render() does not throw', () => {
    let scene: any;
    let destroyedDuringRender = false;
    scene = buildScene(
      () => {},
      () => { scene.destroy(); destroyedDuringRender = true; },
    );

    // Player already belongs to a family and a sect → drawSectTab() takes the
    // "openSectHub and bail" branch.
    scene.tab = 'sect';
    scene.slgLoaded = true;
    scene.slgStatus = { worldId: 'world:1:0', isLeader: true, familyId: 'fam_1', sectId: 'sect_1' };

    expect(() => scene.render()).not.toThrow();
    expect(destroyedDuringRender).toBe(true);
    expect(scene.dead).toBe(true);
  });

  it('loadSLGStatus resolving after the scene has already navigated away does not re-render a dead scene', async () => {
    let scene: any;
    scene = buildScene(
      () => { scene.destroy(); },
      () => {},
    );

    scene.tab = 'family';
    scene.slgLoaded = false;
    scene.slgStatus = null;
    // slgLoaded is false → render() kicks off loadSLGStatus() itself, which
    // resolves to a familyId once awaited, triggering openFamilyHub on the
    // finally-render — must not throw even though the scene destroys itself.
    (scene as { cb: { loadSLGStatus(): Promise<unknown> } }).cb.loadSLGStatus =
      async () => ({ worldId: 'world:1:0', isLeader: false, familyId: 'fam_1' });

    expect(() => scene.render()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(scene.dead).toBe(true);
  });
});
