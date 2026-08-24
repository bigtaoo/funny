// types.ts — the CardScene domain's shared types + layout constants, split out of ./core.ts
// (2026-08-24) so the shared-state root stays under the 500-line convention. Same seam
// EquipmentScene already has (../EquipmentScene/types.ts), and the same rule: nothing here may
// reference CardSceneCore's instance state — these are the declarations every domain class and
// every *caller* of the scene needs, not behaviour.
//
// core.ts re-exports all of it, so importers keep using `from './core'` unchanged.
import type { TranslationKey } from '../../i18n';
import type { SaveData, EquipSlot } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import type { UnitType } from '@nw/engine/types';
export type CardActionResult = { ok: true } | { ok: false; key: TranslationKey };

/** A batch fuse's outcome. Partial success is still `ok`: the server commits rounds in order and stops
 *  at the first failure, so `completed` is the honest count and `failKey` says why it stopped. */
export type CardBatchResult = { ok: true; completed: number; failKey?: TranslationKey } | { ok: false; key: TranslationKey };

export type CardSceneTab = 'list' | 'skins';

export interface CardCallbacks {
  onBack(): void;
  getSave(): SaveData;
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene changes the save (wallet/inventory/...). Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
  /** SLG per-card state (troops/injury/teamId); undefined when outside SLG. */
  getCardState?(): Record<string, CardSLGState> | undefined;
  /** Human-readable name for an SLG team id; undefined when outside SLG or the team can't be resolved. */
  getTeamName?(teamId: string): string | undefined;
  /** Fuse cards: consumes exactly 5 materialCardIds (same faction+level as target), targetCardId +1 level. */
  fuseCards(targetCardId: string, materialCardIds: string[]): Promise<CardActionResult>;
  /** Run a whole planned run of fuses as ONE request — see POST /cards/fuse-batch. */
  fuseCardsBatch(rounds: { targetId: string; materialIds: string[] }[]): Promise<CardBatchResult>;
  /** Toggle card lock. */
  setCardLock(cardInstanceId: string, locked: boolean): Promise<CardActionResult>;
  /** Recover an injured card by spending coins. Only present when in SLG context. */
  recoverCard?(cardInstanceId: string): Promise<CardActionResult>;
  /**
   * Navigate to equipment scene for a specific card. Absent offline (E5 is server-authoritative).
   * `slot`, when given (a specific gear-slot tap), pre-selects the matching filter tab instead of "All".
   */
  openEquipment?(cardInstanceId: string, slot?: EquipSlot): void;
  /**
   * Open the equipment bag as a peer of the roster (LOBBY_IA_REDESIGN). When injected, a
   * [Cards|Equipment] group tab strip is shown; tapping Equipment enters the bag (no active card).
   * Absent offline.
   */
  openEquipmentBag?(): void;
  /** Owned skin ids (server-authoritative inventory; readable offline from the local mirror). */
  getOwnedSkins(): string[];
  /** Currently equipped skin id for a character, or null for the default look (LOBBY_IA_REDESIGN §15). */
  getEquippedSkin(unitType: UnitType): string | null;
  /** Equip a skin on a character, or null to revert to the default look. */
  equipSkin(unitType: UnitType, skinId: string | null): void;
  /**
   * Content tab to open on first paint; defaults to the roster grid ('list'). Lets a caller land
   * directly on the Skins wardrobe — e.g. tapping the Skins peer from EquipmentScene's sidebar rail
   * (the [Cards | Equipment | Skins] growth group, LOBBY_IA_REDESIGN §15).
   */
  initialTab?: CardSceneTab;
}

/**
 * Handle returned by AppViews.showCardRoster, letting the caller push a late-arriving SLG fetch
 * (getCardState/getTeamName data resolving after the roster already opened without it) into an
 * already-open roster — see game.ts goCardRoster.
 */
export interface CardRosterView {
  /** Re-render just the SLG-derived bits of already-visible cells; see ListPanel.applyCardState. */
  applyCardState(): void;
}

export const MODAL_DIM = 0x000000;

// Roster grid: icon-card cells — a full-height portrait on the left with all the
// hero info (name / level / power / troops / gear) stacked immediately to its right.
// Narrower than the equipment cells so hero cards pack denser and don't read as empty.
export const CELL_GAP = 12;
// Taller than EquipmentScene's EQUIP_CELL_H (they used to be unified at 177): hero cards carry a
// full-height character portrait that reads better with more vertical room, so the roster grid is
// deliberately taller. Width is still deliberately narrower so hero cards pack denser.
export const CARD_CELL_H = 266; // 1.5x the previous 177 (taller hero cards)
export const CARD_CELL_W_TARGET = 300;

export interface Rect { x: number; y: number; w: number; h: number; }

export interface Hit { rect: Rect; action: () => void; owner?: string; }

/** feed.ts's fuse-confirm button call signature — see the file-header comment on {@link CardSceneCore.doFuse}. */
export type DoFuseFn = (targetId: string, materialIds: string[], onSettled?: (success: boolean) => void) => Promise<void>;

/** One fuse of a prep batch. See {@link DoPrepBatchFn}. */
export type PrepRound = { targetId: string; materialIds: string[] };

/**
 * feed.ts's batch-prep button call signature (2026-08-18; single-request since 2026-08-20). The run
 * is planned up front by the caller (feedPlan.planPrepRounds) and shipped as ONE POST
 * /cards/fuse-batch rather than a fuse-per-round loop — five round-trips, each returning a fully
 * reassembled cardInv, is the stall this replaces. The server still validates each round and stops at
 * the first failure, so `onSettled` gets how many landed, as the sequential version reported it.
 */
export type DoPrepBatchFn = (
  rounds: PrepRound[],
  onSettled: (completed: number) => void,
) => Promise<void>;
