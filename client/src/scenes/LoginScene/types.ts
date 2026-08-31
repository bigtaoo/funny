// Pure types + constants shared by LoginScene.ts and forms.ts (claudedocs/client-modules.md
// "单文件 500 行收敛") — split out so forms.ts doesn't need to import LoginScene.ts itself.
import { TranslationKey } from '../../i18n';

export type AuthOutcome =
  | { ok: true }
  | { ok: false; errorKey: TranslationKey; detail?: string };

export interface LoginSceneCallbacks {
  onLogin(loginId: string, password: string): Promise<AuthOutcome>;
  onRegister(loginId: string, password: string, displayName?: string): Promise<AuthOutcome>;
  /** Continue without an account (offline single-player). */
  onPlayOffline(): void;
}

// Mirror the server's account rules (server/shared/src/password.ts) so the client
// validates live before submitting. Keep in sync if the server limits change.
export const MIN_PASSWORD_LEN = 6;
export const MIN_LOGIN_ID_LEN = 3;

export type View = 'landing' | 'password' | 'register' | 'submitting';
export type Field = 'loginId' | 'password' | 'confirmPassword' | 'displayName';

