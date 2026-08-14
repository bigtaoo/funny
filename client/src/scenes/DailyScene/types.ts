// DailyCallbacks lives here (form①, pure interface, zero logic) so both DailyScene.ts and
// panels.ts can import it without one depending on the other's implementation file.
import type { SaveData } from '../../game/meta/SaveData';
import type { RetentionView } from '../../net/ApiClient';
import type { TranslationKey } from '../../i18n';

export interface DailyCallbacks {
  onBack(): void;
  getSave?(): SaveData | undefined;
  getRetention?(): Promise<RetentionView>;
  /**
   * Subscribe to local save changes (SaveManager.subscribe), same convention as every other
   * post-lobby scene (ShopScene/GachaScene/CardScene/.../LobbyScene — see their `onSaveChanged`).
   * DailyScene had been missing this wire-up: goDaily() fires `saveManager.refresh()` on entry so
   * retention progress from a just-finished PvE/PvP match shows immediately, but that refresh
   * resolves independently of (and can land after) this scene's own getRetention() round trip —
   * without a subscription, the calendar/tasks/weekly tabs render once against whatever `save` was
   * still in memory at that moment and then never update, even though the lobby's red dot (which
   * re-fetches its own badges fresh on every lobby entry) already shows something claimable.
   */
  onSaveChanged?(listener: () => void): () => void;
  onCheckin?(): Promise<{ day: number; reward: { kind: string; count: number; id?: string; bonusCoins?: number } }>;
  onClaimDaily?(): Promise<{ coins: number }>;
  onClaimWeekly?(threshold: number): Promise<{ reward: { kind: string; count: number; id?: string } }>;
  /** Always resolves (never throws) — `ok: false` covers both "no ad available" and server rejection (cooldown/cap/error), distinguished by `key`. */
  onWatchAd?(): Promise<{ ok: true; coins: number } | { ok: false; key: TranslationKey }>;
}
