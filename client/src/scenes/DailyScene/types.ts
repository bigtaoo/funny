// DailyCallbacks and DailyPanelCtx live here (form①, pure interfaces, zero logic) so DailyScene.ts
// and the panels/ modules (index.ts + checkin.ts) can all import them without one implementation
// file depending on another's.
import type * as PIXI from 'pixi.js-legacy';
import type { SaveData } from '../../game/meta/SaveData';
import type { RetentionView } from '../../net/ApiClient';
import type { TranslationKey } from '../../i18n';
import type { Hit } from '../../ui/hits';

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

/** Everything the four panel-renderers (panels/index.ts + panels/checkin.ts) need out of
 *  DailyScene — passed explicitly instead of closing over `this` (form①). `doXxx` are the scene's
 *  own busy-tracked action wrappers, not `cb.onXxx` directly (the scene still owns
 *  bt/retention/toast/reload around each action). */
export interface DailyPanelCtx {
  container: PIXI.Container;
  hits: Hit[];
  h: number;
  landscape: boolean;
  retention: RetentionView | null;
  cb: DailyCallbacks;
  doCheckin(): void;
  doClaim(): void;
  doClaimWeekly(threshold: number): void;
  doWatchAd(): void;
  /** Hands the scene the check-in grid's claimable cell (or null) so `update(dt)` can breathe it — see {@link CHECKIN_PULSE} in panels/checkin.ts. */
  setPulseTarget(cell: PIXI.Container | null): void;
}
