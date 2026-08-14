// Pure types shared by SettingsScene.ts and its form① sibling modules (panels.ts/avatarPicker.ts/
// overlays.ts) — split out so none of them needs to import SettingsScene.ts itself (claudedocs/
// client-modules.md "单文件 500 行收敛").
import { Rect } from '../../layout/ILayout';
import { TranslationKey } from '../../i18n';
import type { AvatarCategory } from '../../render/avatar';

/** Outcome of a rename attempt — ok with the accepted name, or a message key to toast. */
export type RenameOutcome =
  | { ok: true; name: string }
  | { ok: false; key: TranslationKey };

export interface SettingsSceneCallbacks {
  onBack(): void;
  /** Display name shown next to the avatar. */
  playerName: string;
  /**
   * 9-digit public id — DISPLAY ONLY (player-facing identifier for chat / reports).
   * Never used as an identifier anywhere else; all interactions key off the uuid
   * (accountId). Absent → no id line. Shown here, on the profile screen, only.
   */
  publicId?: string;
  /** Ladder standing (logged-in only) for a small rank line under the name. */
  pvp?: { rank: string; elo: number };
  /** SA-4 offline mode — show a login entry instead of logout. */
  offline?: boolean;
  onLogin?(): void;
  onLogout?(): void;
  /**
   * Delete account (C5-b, Apple 5.1.1(v)). Only available when logged in online; called after a second confirmation.
   * On success, core clears local state and jumps to the login page, so no navigation return value is needed —
   * on failure returns ok:false to trigger a toast.
   */
  onDeleteAccount?(): Promise<{ ok: boolean }>;
  /** Replay the onboarding tutorial (ONBOARDING_DESIGN §3.4); absent = not shown. */
  onReplayTutorial?(): void;
  /** Currently selected avatar id (composite "<category>:<key>", see render/avatar.ts); absent = letter-initial fallback. */
  avatarId?: string;
  /** Called when the player picks a new avatar; absent = picker is read-only. */
  onSetAvatar?(id: string): void;
  /** Owned title ids (save.titles) — unlocks the title tab's items. */
  ownedTitles?: string[];
  /** Currently owned skin ids (save.inventory.skins) — unlocks the skin tab's items alongside everOwned.skin. */
  ownedSkins?: string[];
  /** Currently owned hero def ids (save.cardInv[*].defId) — unlocks the hero tab's items alongside everOwned.hero; needed because everOwned wasn't backfilled for pre-existing rosters when the ledger shipped. */
  ownedHeroes?: string[];
  /** Currently owned equipment def ids (save.equipmentInv[*].defId) — unlocks the equip tab's items alongside everOwned.equipment; see ownedHeroes for why the fallback is needed. */
  ownedEquipment?: string[];
  /** Currently held material kinds (save.materials, count > 0) — unlocks the material tab's items alongside everOwned.material; see ownedHeroes for why the fallback is needed. */
  ownedMaterials?: string[];
  /** Lifetime-owned ledger (save.everOwned) — unlocks the hero/equipment/material/skin tabs' items even after the item itself is gone from inventory. */
  everOwned?: { hero?: string[]; equipment?: string[]; material?: string[]; skin?: string[] };
  // ── rename (online only; absent → no rename UI) ──
  /** Coin cost of a rename; presence enables the rename button. */
  renameCost?: number;
  /**
   * True when the player still holds their one-time free rename (their current name is a system-assigned
   * default they never chose). While true the rename button is free and always enabled regardless of balance.
   */
  freeRename?: boolean;
  /** Current server-authoritative coin balance. */
  getCoins?(): number;
  /** Subscribe to SaveManager writes; re-renders this scene when the wallet changes elsewhere. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
  /** Spend coins to change the display name. */
  onRename?(name: string): Promise<RenameOutcome>;
}

export interface Hit { rect: Rect; fn: () => void; }

/** One selectable item in the avatar picker grid, regardless of category. */
export interface AvatarPickerItem {
  id: string;
  locked: boolean;
}

export const AVATAR_TABS: AvatarCategory[] = ['preset', 'title', 'hero', 'equip', 'material', 'skin'];
export const AVATAR_TAB_LABEL_KEY: Record<AvatarCategory, TranslationKey> = {
  preset: 'settings.avatarTab.preset',
  title: 'settings.avatarTab.title',
  hero: 'settings.avatarTab.hero',
  equip: 'settings.avatarTab.equip',
  material: 'settings.avatarTab.material',
  skin: 'settings.avatarTab.skin',
};
export const AVATAR_LOCKED_KEY: Record<Exclude<AvatarCategory, 'preset'>, TranslationKey> = {
  title: 'settings.avatarLocked.title',
  hero: 'settings.avatarLocked.hero',
  equip: 'settings.avatarLocked.equip',
  material: 'settings.avatarLocked.material',
  skin: 'settings.avatarLocked.skin',
};
