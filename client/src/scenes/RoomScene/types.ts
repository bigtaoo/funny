// Pure types + constants shared by RoomScene.ts and views.ts (claudedocs/client-modules.md
// "单文件 500 行收敛") — split out so views.ts doesn't need to import RoomScene.ts itself.
import { ProfileExtra } from '../../ui/dialogs/ProfilePopup';

/**
 * Server room-code charset — MUST stay identical to matchsvc Matchsvc.ts, or the
 * server can hand out a code containing a character the keypad can't type.
 * 10 digits + 11 letters = 21 chars → exactly 3 rows of 7 on the keypad (fits one
 * screen). Letters skip I/O/L so they don't read as 0/1.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKM';
export const CODE_LEN = 6;

export interface RoomSceneCallbacks {
  onBack(): void;
  createRoom(): void;
  joinRoom(code: string): void;
  setReady(ready: boolean): void;
  startMatch(): void;
  /** Enter ranked matchmaking queue (S1-R). */
  createRanked(): void;
  /** Cancel ranked search. */
  cancelQueue(): void;
  /** False when no online server is configured → actions surface "unavailable". */
  available: boolean;
  /**
   * Open directly in the ranked searching view (the lobby match button jumped
   * here for real PvP). The actual queue join is driven by app once the gateway
   * connects; this only sets the initial view.
   */
  autoRanked?: boolean;
  /** Unified profile-popup extras (rank/ELO + family/sect) — see ProfilePopup's `fetchExtra`. Omitted offline. */
  getProfileExtra?(publicId: string): Promise<ProfileExtra>;
}

export type View = 'idle' | 'codeEntry' | 'connecting' | 'searching' | 'inRoom';

