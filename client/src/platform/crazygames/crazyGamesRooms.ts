// CrazyGames multiplayer rooms (design/game/CRAZYGAMES_LAUNCH.md §4.2): the portal's own invite UI
// for our friend rooms. The game keeps its six-digit room code; the portal only ever sees it as the
// `room` invite parameter, so the rest of the game knows nothing about the portal.
//
//  * `inviteLink({ room })` is the link a friend opens; the portal forwards `room` into our iframe.
//  * `updateRoom` / `leftRoom` tell the portal where the player is, which drives its own "join"
//    button on the player's profile and the invite button it shows while the room is joinable.
//  * `?instantJoin=true` is the portal's "play with friends" launch: open a room straight away.
//  * `addJoinRoomListener` fires when an invite is accepted while the game is already running.
import type { PlatformRooms, RoomIntent } from '../IPlatform';

/** The part of the v3 SDK this file uses (`window.CrazyGames.SDK.game`). */
export interface CrazyGamesRoomSdk {
  inviteLink(params: Record<string, string>): string;
  showInviteButton(params: Record<string, string>): string;
  hideInviteButton(): void;
  updateRoom(room: { roomId: string; isJoinable: boolean; inviteParams?: Record<string, string> }): void;
  leftRoom(): void;
  addJoinRoomListener(cb: (params: Record<string, string> | null | undefined) => void): void;
}

/** The invite parameter carrying the room code. */
export const ROOM_PARAM = 'room';

/** The SDK throws when `updateRoom`/`leftRoom` are called within 250 ms of the previous call. */
const ROOM_CALL_GAP_MS = 300;
const MAX_RETRIES = 3;

type RoomPresence = { code: string; joinable: boolean } | null;

export class CrazyGamesRooms implements PlatformRooms {
  /** Where the player is now, as the game last reported it. */
  private wanted: RoomPresence = null;
  /** What the portal was last told. */
  private told: RoomPresence = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastCallAt = 0;
  private launchRead = false;
  private failures = 0;

  constructor(
    private readonly sdk: () => CrazyGamesRoomSdk | null,
    private readonly initDone: Promise<void>,
    private readonly search: () => string = () => window.location.search,
  ) {}

  inviteLink(code: string): string | null {
    const game = this.sdk();
    if (!game) return null;
    try { return game.inviteLink({ [ROOM_PARAM]: code }); } catch { return null; }
  }

  update(code: string, joinable: boolean): void {
    this.wanted = { code, joinable };
    this.failures = 0;
    this.schedule();
  }

  left(): void {
    this.wanted = null;
    this.failures = 0;
    this.schedule();
  }

  launchIntent(): RoomIntent | null {
    if (this.launchRead) return null;
    this.launchRead = true;
    const q = new URLSearchParams(this.search());
    const code = q.get(ROOM_PARAM);
    if (code) return { kind: 'join', code };
    // The SDK's own `isInstantMultiplayer` is exactly this test, available before init resolves.
    if (q.get('instantJoin') === 'true') return { kind: 'create' };
    return null;
  }

  onJoinRequest(cb: (code: string) => void): void {
    void this.initDone.then(() => {
      try {
        this.sdk()?.addJoinRoomListener((params) => {
          const code = params?.[ROOM_PARAM];
          if (code) cb(code);
        });
      } catch { /* no portal: nothing to listen to */ }
    });
  }

  /**
   * Room state changes in bursts (create → joined → ready → start within a second), and the SDK
   * rejects calls closer than 250 ms. Only the latest state matters, so calls are coalesced and
   * sent no faster than that.
   */
  private schedule(): void {
    if (this.timer) return;
    void this.initDone.then(() => {
      if (this.timer) return;
      const wait = Math.max(0, this.lastCallAt + ROOM_CALL_GAP_MS - Date.now());
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
    });
  }

  private flush(): void {
    const want = this.wanted;
    const told = this.told;
    if (want?.code === told?.code && want?.joinable === told?.joinable) return;
    const game = this.sdk();
    if (!game) return;
    try {
      if (want) {
        const params = { [ROOM_PARAM]: want.code };
        game.updateRoom({ roomId: want.code, isJoinable: want.joinable, ...(want.joinable ? { inviteParams: params } : {}) });
        if (want.joinable) game.showInviteButton(params);
        else game.hideInviteButton();
      } else {
        game.leftRoom();
        game.hideInviteButton();
      }
      this.told = want;
      this.failures = 0;
    } catch {
      // Throttled (or rejected): retry a few times, so a burst's final state still reaches the portal.
      this.lastCallAt = Date.now();
      if (++this.failures <= MAX_RETRIES) this.schedule();
      return;
    }
    this.lastCallAt = Date.now();
  }
}
