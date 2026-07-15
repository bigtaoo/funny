// Entry / authentication / settings navigation (SA-3, C5-b). Extracted from createAppCore.
import * as analytics from '../../analytics';
import { ApiError, type AuthResult } from '../../net/ApiClient';
import type { AuthOutcome } from '../../scenes/LoginScene';
import type { RenameOutcome } from '../../scenes/SettingsScene';
import type { TranslationKey } from '../../i18n';
import type { AppCtx, Nav } from '../appCtx';
import {
  SEEN_INTRO_FLAG, TOKEN_KEY, PLAYER_NAME_KEY, PLAYER_PUBLIC_ID_KEY, PLAYER_AVATAR_KEY, RENAME_COST,
  FREE_RENAME_KEY,
} from '../appConstants';

export function createAuthNav(ctx: AppCtx): Pick<Nav, 'goIntro' | 'goLogin' | 'doLogout' | 'resolveEntry' | 'goSettings'> {
  const { api, saveManager, platform, views, state, nav, playerName, avatarId, gateConsent, applyGatewayUrl, featureFlags, getNetSession } = ctx;

  /**
   * Login-reconnect-prompt: if SaveManager just picked up an activeMatch from GET /save, show the
   * "resume your match?" dialog. `afterDecline` restores whatever screen the caller was on before this
   * ran (a no-op for doAuth, which hasn't navigated yet; nav.goLobby() for the entry paths that already
   * did). Returns true if the prompt was shown (caller should skip its own navigation).
   */
  function offerResume(afterDecline: () => void): boolean {
    const m = saveManager.consumeActiveMatch();
    if (!m) return false;
    views.showReconnectPrompt({
      onReconnect: () => getNetSession()?.rejoinMatch(m.gameUrl, m.ticket),
      onDecline: afterDecline,
    });
    return true;
  }

  function goIntro(): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'IntroScene' });
    views.showIntro({
      onFinish(skipped) {
        if (skipped) analytics.track('tutorial_skip', { step: 'intro' });
        saveManager.setFlag(SEEN_INTRO_FLAG, true);
        gateConsent(() => void resolveEntry());
      },
    });
  }

  function goSettings(): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'SettingsScene' });
    const pvp = saveManager.get().pvp;
    const loggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const canRename = !state.offlineMode && !!api && loggedIn;
    views.showSettings({
      onBack() { nav.goLobby(); },
      playerName: playerName(),
      avatarId: avatarId(),
      onSetAvatar: (id) => { platform.storage.setItem(PLAYER_AVATAR_KEY, id); },
      ...(platform.storage.getItem(PLAYER_PUBLIC_ID_KEY)
        ? { publicId: platform.storage.getItem(PLAYER_PUBLIC_ID_KEY)! }
        : {}),
      pvp: { rank: pvp.rank, elo: pvp.elo },
      offline: state.offlineMode,
      onLogin: () => goLogin(),
      onLogout: loggedIn ? () => doLogout() : undefined,
      ...(canRename
        ? {
            renameCost: RENAME_COST,
            freeRename: platform.storage.getItem(FREE_RENAME_KEY) === '1',
            getCoins: () => saveManager.get().wallet.coins,
            onRename: doRename,
          }
        : {}),
      // Account deletion (C5-b): only available when logged in online (no account to delete when offline).
      ...(loggedIn && !!api ? { onDeleteAccount: doDeleteAccount } : {}),
      // Replay tutorial (ONBOARDING_DESIGN §3.4): directly re-runs the dedicated tutorial level (never fails, can be skipped again).
      onReplayTutorial: () => nav.goTutorial(),
    });
  }

  /**
   * Delete account (C5-b, Apple 5.1.1(v)): call the soft-delete endpoint → clear the local
   * token / display name / public id → return to the login screen. (Accounts can be recovered
   * within a 7-day grace period by logging in again; the confirmation dialog explains this.)
   * On failure, return ok:false so the settings screen can show a toast.
   */
  async function doDeleteAccount(): Promise<{ ok: boolean }> {
    if (!api) return { ok: false };
    try {
      await api.deleteAccount();
      analytics.track('account_delete', {});
      platform.storage.removeItem(TOKEN_KEY);
      platform.storage.removeItem(PLAYER_NAME_KEY);
      platform.storage.removeItem(PLAYER_PUBLIC_ID_KEY);
      api.setToken(null);
      goLogin();
      return { ok: true };
    } catch (e) {
      console.error('[account] delete failed', e);
      return { ok: false };
    }
  }

  async function doRename(name: string): Promise<RenameOutcome> {
    if (!api) return { ok: false, key: 'settings.renameFail' };
    try {
      const { save, displayName, freeRename } = await api.rename(name);
      saveManager.adoptServer(save);
      platform.storage.setItem(PLAYER_NAME_KEY, displayName);
      // Free rename is consumed on first success; server returns freeRename:false so the button reverts to the paid state.
      if (freeRename !== undefined) platform.storage.setItem(FREE_RENAME_KEY, freeRename ? '1' : '0');
      return { ok: true, name: displayName };
    } catch (e) {
      console.error('[rename] failed', e);
      return {
        ok: false,
        key: e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS'
          ? 'settings.renameInsufficient' : 'settings.renameFail',
      };
    }
  }

  function goLogin(): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'LoginScene' });
    views.showLogin({
      onPlayOffline() { nav.goLobby({ offline: true }); },
      onLogin: (loginId, password) => doAuth(() => api!.login(loginId, password), loginId),
      onRegister: (loginId, password, displayName) =>
        doAuth(() => api!.register(loginId, password, displayName), displayName || loginId),
    });
  }

  async function doAuth(call: () => Promise<AuthResult>, name?: string): Promise<AuthOutcome> {
    if (!api) {
      console.error('[auth] no API base configured (__NW_API_BASE__ empty) — request not sent');
      return { ok: false, errorKey: 'auth.err.network', detail: 'API base not configured' };
    }
    try {
      const res = await call();
      platform.storage.setItem(TOKEN_KEY, res.token);
      applyGatewayUrl(res.gatewayUrl);
      const resolvedName = res.displayName || name;
      if (resolvedName) platform.storage.setItem(PLAYER_NAME_KEY, resolvedName);
      if (res.publicId) platform.storage.setItem(PLAYER_PUBLIC_ID_KEY, res.publicId);
      // Immediately re-fetch the bootstrap after receiving publicId so targeted log capture
      // takes effect without waiting for the next 120-second polling cycle (best-effort).
      void featureFlags?.refresh();
      await saveManager.adoptSession(res.accountId);
      if (!offerResume(() => nav.goLobby({ offline: false }))) nav.goLobby({ offline: false });
      return { ok: true };
    } catch (e) {
      console.error('[auth] request failed', e);
      const detail =
        e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      return { ok: false, errorKey: mapAuthError(e), detail };
    }
  }

  function doLogout(): void {
    platform.storage.removeItem(TOKEN_KEY);
    platform.storage.removeItem(PLAYER_NAME_KEY);
    platform.storage.removeItem(PLAYER_PUBLIC_ID_KEY);
    api?.setToken(null);
    goLogin();
  }

  async function resolveEntry(): Promise<void> {
    let cred: { kind: string } | null = null;
    try { cred = await platform.getAuthCredential(); } catch { cred = null; }
    if (cred?.kind === 'wx') {
      // Lobby shows immediately (no network wait); if the bootstrap pull later turns up an
      // activeMatch, the resume prompt pops in over the lobby (same "arrives late" pattern as
      // onProfile's `if (state.inLobby) nav.goLobby()` refresh).
      void saveManager.bootstrap().then(() => offerResume(() => nav.goLobby({ offline: false })));
      nav.goLobby({ offline: false });
      return;
    }
    if (!api) { nav.goLobby({ offline: true }); return; }
    const token = platform.storage.getItem(TOKEN_KEY);
    if (token) {
      api.setToken(token);
      void saveManager
        .adoptSession(saveManager.get().accountId)
        .then(() => offerResume(() => nav.goLobby({ offline: false })));
      nav.goLobby({ offline: false });
      return;
    }
    goLogin();
  }

  return { goIntro, goLogin, doLogout, resolveEntry, goSettings };
}

/** Map a server auth error code to a LoginScene message key (SA-3). */
export function mapAuthError(e: unknown): TranslationKey {
  const code = e instanceof ApiError ? e.code : '';
  switch (code) {
    case 'LOGIN_ID_TAKEN':      return 'auth.err.taken';
    case 'INVALID_CREDENTIALS': return 'auth.err.invalid';
    case 'WEAK_PASSWORD':       return 'auth.err.weak';
    case 'BAD_REQUEST':         return 'auth.err.loginId';
    default:                    return 'auth.err.network';
  }
}
