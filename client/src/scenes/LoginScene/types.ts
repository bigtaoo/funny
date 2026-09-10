// Pure types + constants shared by LoginScene.ts and forms.ts (claudedocs/client-modules.md
// "单文件 500 行收敛") — split out so forms.ts doesn't need to import LoginScene.ts itself.
import { TranslationKey } from '../../i18n';
import type { IPlatform } from '../../platform/IPlatform';

export type AuthOutcome =
  | { ok: true }
  | { ok: false; errorKey: TranslationKey; detail?: string };

export interface LoginSceneCallbacks {
  /** Free-text entry surface (ASSET_PACKAGING §4.3/§4.4 item 1) — see IPlatform.openTextInput. */
  openTextInput: IPlatform['openTextInput'];
  /**
   * Message to show on the landing view the moment the scene opens, for the paths that navigate
   * here on their own rather than because the player tapped something: today only the forced
   * logout after a token expiry (nav/auth.ts's forceLogout, ACCOUNT_DESIGN §5). Reuses the scene's
   * existing errorKey line — it clears on the first field edit / view change like any other error,
   * which is exactly the wanted behaviour for a notice ("you were sent back here, here's why").
   */
  initialNotice?: TranslationKey;
  onLogin(loginId: string, password: string): Promise<AuthOutcome>;
  onRegister(loginId: string, password: string, displayName?: string): Promise<AuthOutcome>;
  /** Continue without an account (offline single-player). */
  onPlayOffline(): void;
}

// Mirror the server's account rules (server/shared/src/password.ts) so the client
// validates live before submitting. Keep in sync if the server limits change.
export const MIN_PASSWORD_LEN = 6;
export const MIN_LOGIN_ID_LEN = 3;
// Character caps for the hidden-input fields (IPlatform.openTextInput requires one). loginId/
// displayName mirror the server's MAX_LOGIN_ID_LEN/MAX_DISPLAY_NAME_LEN (server/shared/src/
// password.ts — not imported, same curated-browser-subset reason every other scene's send-box
// hardcodes its own max, see FamilyScene/input.ts). Password has no server-side max (scrypt takes
// any length); this is just a sane client-side stop, not a validated rule.
export const MAX_LOGIN_ID_LEN = 64;
export const MAX_PASSWORD_LEN = 64;
export const MAX_DISPLAY_NAME_LEN = 24;

export type View = 'landing' | 'password' | 'register' | 'submitting';
export type Field = 'loginId' | 'password' | 'confirmPassword' | 'displayName';

