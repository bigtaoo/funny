// Social navigation: friends list, mail, direct chat (S6). Extracted from createAppCore.
import * as analytics from '../../analytics';
import { WorldApiClient } from '../../net/WorldApiClient';
import type { FriendsView, ChatView } from '../AppViews';
import type { AppCtx, Nav } from '../appCtx';
import { FALLBACK_SEASON, PLAYER_PUBLIC_ID_KEY } from '../appConstants';

export function createSocialNav(ctx: AppCtx): Pick<Nav, 'goFriends' | 'goMail' | 'goChat'> {
  const { api, saveManager, platform, state, views, nav, getNetSession, playerName } = ctx;

  function goFriends(opts?: { defaultTab?: 'friends' | 'family' | 'sect' | 'world' | 'mail'; onBack?: () => void; overlay?: boolean }): void {
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
    // Where the whole social hub returns to when backed all the way out — reused by the
    // family/sect auto-jump below so `onBack` isn't lost once FriendsScene is torn down.
    const backTo = (): void => {
      restore();
      (opts?.onBack ?? nav.goLobby)();
    };

    // SLG world API — lazy worldId resolved on first SLG-tab visit.
    // getWorldBaseUrl() returns '' in Docker/prod (same-origin nginx proxy) — falsy
    // but still valid. Do NOT guard on empty string; worldsvc is always reachable.
    const worldApi = new WorldApiClient(platform.storage);
    let slgWorldId: string | null = null;
    const ensureWorldId = async (): Promise<string> => {
      if (slgWorldId) return slgWorldId;
      if (!worldApi) throw new Error('no world api');
      // Short timeout: this call has a safe fallback (FALLBACK_SEASON), so it should
      // never hold up world-tab loading waiting out the default 10s network timeout.
      const season = await worldApi.getActiveSeason(4_000).then((r) => r.season).catch((e) => {
        console.warn('[social] getActiveSeason failed, using fallback season', FALLBACK_SEASON, e);
        return FALLBACK_SEASON;
      });
      const w = await worldApi.resolveSeason(season);
      slgWorldId = w.worldId;
      return slgWorldId;
    };

    const view: FriendsView = views.showFriends({
      onBack: backTo,
      onOpenRoom() { nav.goRoom(); },
      myPublicId: platform.storage.getItem(PLAYER_PUBLIC_ID_KEY) ?? '',
      getProfileExtra: (publicId) => worldApi.getProfileExtra(publicId),
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
      // Preserve the mount context so a DM opened from the SLG-overlay social hub stays an overlay
      // (map alive) and backing out of it re-opens this same hub with the same onBack, not the lobby.
      openChat: (peerPublicId, peerName) => goChat(peerPublicId, peerName, { overlay: opts?.overlay, onBack: () => goFriends(opts) }),
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
          const myAccountId = saveManager.get().accountId;
          // Family membership lives in socialsvc and never depends on worldId, so it's
          // fetched concurrently with the world-shard resolve instead of after it.
          const [wid, fam] = await Promise.all([
            ensureWorldId(),
            worldApi.getMyFamily().catch(() => null),
          ]);
          const status: import('../../scenes/FriendsScene').SLGSocialStatus = {
            worldId: wid,
            familyId: undefined,
            isLeader: false,
          };
          if (fam) {
            status.familyId = fam.familyId;
            status.familyName = fam.name;
            status.familyTag = fam.tag;
            status.isLeader = !!myAccountId && fam.leaderId === myAccountId;
            // Leader/elder only — matches familyService's server-side approval gate — so
            // the pending-request badge never fires an extra request for regular members.
            const myRole = fam.members?.find((m) => m.accountId === myAccountId)?.role;
            if (myRole === 'leader' || myRole === 'elder') {
              try {
                const reqs = await worldApi.listJoinRequests();
                status.pendingJoinRequests = reqs.length;
              } catch { /* best-effort — badge just stays off */ }
            }
            if (fam.sectId) {
              status.sectId = fam.sectId;
              try {
                const sect = await worldApi.getSect(fam.sectId);
                status.sectName = sect?.name;
              } catch { /* sect lookup best-effort; sectId alone is still useful to the caller */ }
            }
          }
          return status;
        },
        createFamily: async (name, tag) => { await worldApi.createFamily(name, tag); },
        joinFamily:   async (familyId) => { await worldApi.requestJoinFamily(familyId); },
        browseFamilies: async (query) => worldApi.browseFamilies(query),
        viewFamily: (familyId) => worldApi.getFamily(familyId),
        createSect:   async (name, tag) => { const wid = await ensureWorldId(); await worldApi.createSect(wid, name, tag); },
        joinSect:     async (sectId) => { const wid = await ensureWorldId(); await worldApi.joinSect(wid, sectId); },
        openFamilyHub: () => { if (slgWorldId) nav.goFamilyHub(worldApi, slgWorldId, backTo, opts?.overlay); },
        openSectHub:   () => { if (slgWorldId) nav.goSectHub(worldApi, slgWorldId, backTo, opts?.overlay); },
        loadWorldChat: async (before) => { const wid = await ensureWorldId(); return worldApi.getWorldChannel(wid, { before }); },
        sendWorldChat: async (body, senderName) => { const wid = await ensureWorldId(); await worldApi.sendWorldChannelMessage(wid, body, senderName); },
        playerName: () => playerName(),
        getCoins: () => saveManager.get().wallet.coins,
        // World-chat posts are charged in the commercial service by worldsvc; GET /save
        // re-mirrors that authoritative balance so the HUD coin count reflects the spend.
        refreshWallet: async () => {
          const { save } = await client.getSave();
          saveManager.adoptServer(save);
        },
      } : {}),
    }, { overlay: opts?.overlay });
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

  function goChat(peerPublicId: string, peerName: string, opts?: { overlay?: boolean; onBack?: () => void }): void {
    if (!api) { nav.goLogin(); return; }
    const client = api;
    state.inLobby = false;
    const session = getNetSession();
    const myPublicId = platform.storage.getItem(PLAYER_PUBLIC_ID_KEY) ?? '';
    const restore = (): void => {
      if (session) session.handlers = { onMatchStart: (info) => nav.goGameNet(info) };
    };
    // Back lands on wherever the chat was opened from — the SLG-overlay social hub (map kept alive)
    // when threaded through, else the plain friends list.
    const backToFriends = opts?.onBack ?? (() => goFriends());
    const view: ChatView = views.showChat({
      peerName,
      peerPublicId,
      myPublicId,
      onBack() { restore(); backToFriends(); },
      async resolveConvId(pid) {
        const convs = await client.getConversations();
        return convs.find((c) => c.peer.publicId === pid)?.convId ?? null;
      },
      loadMessages: (convId, before) => client.getMessages(convId, before),
      send: (body) => client.sendChat(peerPublicId, body),
      markRead: (convId) => client.readChat(convId),
    }, { overlay: opts?.overlay });
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
