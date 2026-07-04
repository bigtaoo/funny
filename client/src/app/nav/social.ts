// Social navigation: friends list, mail, direct chat (S6). Extracted from createAppCore.
import * as analytics from '../../analytics';
import { WorldApiClient } from '../../net/WorldApiClient';
import type { FriendsView, ChatView } from '../AppViews';
import type { AppCtx, Nav } from '../appCtx';
import { FALLBACK_SEASON, PLAYER_PUBLIC_ID_KEY } from '../appConstants';

export function createSocialNav(ctx: AppCtx): Pick<Nav, 'goFriends' | 'goMail' | 'goChat'> {
  const { api, saveManager, platform, state, views, nav, getNetSession } = ctx;

  function goFriends(opts?: { defaultTab?: 'friends' | 'mail' }): void {
    // Social needs a server account; offline / no API → bounce to login.
    if (!api) { analytics.track('login_gate_hit', { scene: 'FriendsScene' }); nav.goLogin(); return; }
    analytics.track('screen_view', { scene: 'FriendsScene' });
    const client = api;
    state.inLobby = false;
    const session = getNetSession();
    // Restore the default match-start handler when leaving (mirrors goRoom).
    const restore = (): void => {
      if (session) session.handlers = { onMatchStart: (info) => nav.goGameNet(info) };
    };

    // SLG world API — lazy worldId resolved on first SLG-tab visit.
    // getWorldBaseUrl() returns '' in Docker/prod (same-origin nginx proxy) — falsy
    // but still valid. Do NOT guard on empty string; worldsvc is always reachable.
    const worldApi = new WorldApiClient(platform.storage);
    let slgWorldId: string | null = null;
    const ensureWorldId = async (): Promise<string> => {
      if (slgWorldId) return slgWorldId;
      if (!worldApi) throw new Error('no world api');
      const season = await worldApi.getActiveSeason().then((r) => r.season).catch(() => FALLBACK_SEASON);
      const w = await worldApi.resolveSeason(season);
      slgWorldId = w.worldId;
      return slgWorldId;
    };

    const view: FriendsView = views.showFriends({
      onBack() { restore(); nav.goLobby(); },
      onOpenRoom() { nav.goRoom(); },
      ...(opts?.defaultTab ? { defaultTab: opts.defaultTab } : {}),
      loadFriends: () => client.getFriends(),
      loadRequests: () => client.getFriendRequests(),
      search: (publicId) => client.searchFriend(publicId),
      addFriend: async (publicId) => { await client.requestFriend(publicId); },
      respond: async (requestId, accept) => {
        const r = await client.respondFriend(requestId, accept);
        if (accept) analytics.track('friend_add', {});
        return r;
      },
      removeFriend: (publicId) => client.removeFriend(publicId),
      blockUser: (publicId) => client.blockUser(publicId),
      // Direct messages (entry point is the friend profile popup)
      loadConversations: () => client.getConversations(),
      openChat: (peerPublicId, peerName) => goChat(peerPublicId, peerName),
      // mail (S6-3)
      loadMail: () => client.getMail(),
      markMailRead: (mailId) => client.readMail(mailId),
      async claimMail(mailId) {
        const { save } = await client.claimMail(mailId);
        saveManager.adoptServer(save);
        return true;
      },
      deleteMail: (mailId) => client.deleteMail(mailId),
      // SLG social tab (S6-4)
      ...(worldApi ? {
        async loadSLGStatus() {
          const wid = await ensureWorldId();
          const me = await worldApi.getMe(wid);
          const myAccountId = platform.storage.getItem('nw_account_id') ?? '';
          const status: import('../../scenes/FriendsScene').SLGSocialStatus = {
            worldId: wid,
            familyId: me.familyId,
            isLeader: false,
          };
          if (me.familyId) {
            try {
              const fam = await worldApi.getFamily(me.familyId);
              status.familyName = fam.name;
              status.familyTag = fam.tag;
              status.isLeader = !!myAccountId && fam.leaderId === myAccountId;
              if (fam.sectId) {
                status.sectId = fam.sectId;
                try {
                  const sect = await worldApi.getSect(fam.sectId);
                  status.sectName = sect?.name;
                } catch { /* sect lookup best-effort; sectId alone is still useful to the caller */ }
              }
            } catch { /* missing family is non-fatal */ }
          }
          return status;
        },
        createFamily: async (name, tag) => { await worldApi.createFamily(name, tag); },
        joinFamily:   async (familyId) => { await worldApi.joinFamily(familyId); },
        createSect:   async (name, tag) => { const wid = await ensureWorldId(); await worldApi.createSect(wid, name, tag); },
        joinSect:     async (sectId) => { const wid = await ensureWorldId(); await worldApi.joinSect(wid, sectId); },
        openFamilyHub: () => { if (slgWorldId) nav.goFamilyHub(worldApi, slgWorldId); },
        openSectHub:   () => { if (slgWorldId) nav.goSectHub(worldApi, slgWorldId); },
        loadWorldChat: async (before) => { const wid = await ensureWorldId(); return worldApi.getWorldChannel(wid, { before }); },
        sendWorldChat: async (body, senderName) => { const wid = await ensureWorldId(); await worldApi.sendWorldChannelMessage(wid, body, senderName); },
        playerName: () => platform.storage.getItem(PLAYER_PUBLIC_ID_KEY) ?? '',
      } : {}),
    });
    // Live social pushes (presence / request / friend add-remove / chat / mail)
    // arrive over the gateway control plane; forward them so the tabs stay fresh.
    if (session) {
      session.handlers = {
        onMatchStart: (info) => nav.goGameNet(info),
        onFriendPresence: (p) => view.applyFriendPresence(p),
        onFriendRequest:  (r) => view.applyFriendRequest(r),
        onFriendUpdate:   (u) => view.applyFriendUpdate(u),
        onChatMessage:    (m) => view.applyChatMessage(m),
        onMailNew:        (m) => view.applyMailNew(m),
      };
      session.connect();
    }
  }

  /** Right-column mail shortcut → opens FriendsScene directly on the mail tab. */
  function goMail(): void { goFriends({ defaultTab: 'mail' }); }

  function goChat(peerPublicId: string, peerName: string): void {
    if (!api) { nav.goLogin(); return; }
    const client = api;
    state.inLobby = false;
    const session = getNetSession();
    const myPublicId = platform.storage.getItem(PLAYER_PUBLIC_ID_KEY) ?? '';
    const restore = (): void => {
      if (session) session.handlers = { onMatchStart: (info) => nav.goGameNet(info) };
    };
    const view: ChatView = views.showChat({
      peerName,
      peerPublicId,
      myPublicId,
      onBack() { restore(); goFriends(); },
      async resolveConvId(pid) {
        const convs = await client.getConversations();
        return convs.find((c) => c.peer.publicId === pid)?.convId ?? null;
      },
      loadMessages: (convId, before) => client.getMessages(convId, before),
      send: (body) => client.sendChat(peerPublicId, body),
      markRead: (convId) => client.readChat(convId),
    });
    // Forward inbound chat pushes to the open window (others ignored here).
    if (session) {
      session.handlers = {
        onMatchStart: (info) => nav.goGameNet(info),
        onChatMessage: (m) => view.applyIncoming(m),
      };
      session.connect();
    }
  }

  return { goFriends, goMail, goChat };
}
