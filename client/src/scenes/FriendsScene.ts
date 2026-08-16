// FriendsScene — Social Hub (S6-1/S6-2/S6-3/S6-4). Thin assembly file.
//
// The scene is split by domain — each part lives in ./FriendsScene/*.ts and is composed here over
// FriendsSceneCore (./FriendsScene/core.ts, which owns all instance state + pointer-input dispatch +
// tab switching + toast + the confirm modal + inbound-push handlers, but NOT the render() dispatcher
// or the chrome/render primitives — see core.ts's header comment). To add a handler: find the
// matching domain class (friendsList / search / orgForm / worldChat / mail / network) or add a new
// one — do NOT grow this file. SLGSocialStatus / FriendsSceneCallbacks are re-exported so existing
// importers (`from './FriendsScene'`) keep resolving to this file, not the directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher lives here since
// only this assembly knows about all five tab-domain classes (Core takes a `render` callback
// instead of owning render() itself); the initial render()/refresh()/triggerTabLoads calls also
// move here, since NetworkPanel (needed by refresh/triggerTabLoads) doesn't exist until after Core.
import { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { FriendsSceneCore } from './FriendsScene/core';
import type { FriendsSceneCallbacks } from './FriendsScene/core';
import { NetworkPanel } from './FriendsScene/network';
import { FriendsListPanel } from './FriendsScene/friendsList';
import { SearchPanel } from './FriendsScene/search';
import { OrgFormPanel } from './FriendsScene/orgForm';
import { WorldChatPanel } from './FriendsScene/worldChat';
import { MailPanel } from './FriendsScene/mail';
import { beginRender, drawTabBar, endRender } from './FriendsScene/chrome';

export type { SLGSocialStatus, FriendsSceneCallbacks } from './FriendsScene/core';

/**
 * FriendsScene — the social hub scene registered against SceneManager, thin assembly over the
 * per-domain composition (see the file-header comment above).
 */
export class FriendsScene implements Scene {
  readonly container;

  private readonly core: FriendsSceneCore;
  private readonly network: NetworkPanel;
  private readonly friendsList: FriendsListPanel;
  private readonly search: SearchPanel;
  private readonly orgForm: OrgFormPanel;
  private readonly worldChat: WorldChatPanel;
  private readonly mail: MailPanel;

  constructor(layout: ILayout, input: InputManager, cb: FriendsSceneCallbacks) {
    this.core = new FriendsSceneCore(layout, input, cb, () => this.render());
    this.container = this.core.container;
    this.network = new NetworkPanel(this.core);
    this.core.net = this.network; // wire the lazy `net` hook now that NetworkPanel exists
    this.search = new SearchPanel(this.core, this.network);
    this.friendsList = new FriendsListPanel(this.core, this.network, this.search);
    this.orgForm = new OrgFormPanel(this.core, this.network);
    this.worldChat = new WorldChatPanel(this.core, this.network);
    this.mail = new MailPanel(this.core, this.network);

    this.render();
    void this.network.refresh();
    this.core.triggerTabLoads(this.core.tab);
  }

  update(dt: number): void {
    this.core.update(dt);
  }

  destroy(): void {
    this.core.destroy();
  }

  // ── Inbound pushes (forwarded to Core — see core.ts's apply* methods) ─────────
  applyFriendPresence(p: Parameters<FriendsSceneCore['applyFriendPresence']>[0]): void { this.core.applyFriendPresence(p); }
  applyFriendRequest(r: Parameters<FriendsSceneCore['applyFriendRequest']>[0]): void { this.core.applyFriendRequest(r); }
  applyFriendUpdate(u: Parameters<FriendsSceneCore['applyFriendUpdate']>[0]): void { this.core.applyFriendUpdate(u); }
  applyChatMessage(m: Parameters<FriendsSceneCore['applyChatMessage']>[0]): void { this.core.applyChatMessage(m); }
  applyMailNew(m: Parameters<FriendsSceneCore['applyMailNew']>[0]): void { this.core.applyMailNew(m); }
  applyDuelInvited(d: Parameters<FriendsSceneCore['applyDuelInvited']>[0]): void { this.core.applyDuelInvited(d); }
  applyDuelCancelled(d: Parameters<FriendsSceneCore['applyDuelCancelled']>[0]): void { this.core.applyDuelCancelled(d); }

  private render(): void {
    const core = this.core;
    // Deferred redraws (fetch completions, mail card art's texture 'loaded' hook) can land after
    // teardown; beginRender would then removeChild/tearDownChildren on a destroyed container.
    if (core.dead) return;
    beginRender(core);

    if (core.tab === 'friends' && core.view === 'search') {
      this.search.drawSearch();
    } else if (core.openMailItem) {
      drawTabBar(core);
      this.mail.drawMailDetail(core.openMailItem);
    } else {
      drawTabBar(core);
      if (core.tab === 'friends') this.friendsList.drawList();
      else if (core.tab === 'family') this.orgForm.drawFamilyTab();
      else if (core.tab === 'sect') this.orgForm.drawSectTab();
      else if (core.tab === 'world') this.worldChat.drawWorldTab();
      else this.mail.drawMailList();
    }

    endRender(core);
  }
}
