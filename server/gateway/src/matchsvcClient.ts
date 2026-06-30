// gateway → matchsvc internal HTTP client (S1-M5, after matchsvc was split into a separate process).
// Decoded player control commands are forwarded to matchsvc via this client;
// matchsvc pushes events back to gateway via /gw/push (internalHttp.ts).
// All calls are fire-and-forget — matchsvc results are delivered asynchronously via push; room state is not returned in the HTTP response.
// Internal auth: X-Internal-Key (shared NW_INTERNAL_KEY).
//
// PushMsg / PlayerView here are JSON mirrors of the identically-named types in matchsvc
// (the wire contract across processes is JSON; each side holds a locally-typed copy of the same structure,
// consistent with the REST/JSON internal communication convention — see META_DESIGN §6.7).

import { createLogger, postInternal } from '@nw/shared';

const log = createLogger('gateway:matchsvc');

export interface PlayerView {
  side: number;
  name: string;
  ready: boolean;
  connected: boolean;
  /** 9-digit public ID (used for player communication / reporting; defaults to empty string). */
  publicId: string;
}
export type PushMsg =
  | { kind: 'room_state'; code: string; players: PlayerView[]; phase: number }
  | { kind: 'match_found'; gameUrl: string; ticket: string }
  // Matchmaking timeout fallback to AI (feature flag match_bot_fallback): client starts a local AI game; no ticket/gameUrl.
  | { kind: 'match_bot'; seed: number; opponentName: string; elo: number; difficulty: string }
  | { kind: 'room_error'; code: string; message: string }
  // —— Social real-time pushes (S6, meta calls via /gw/push, sharing this channel with matchsvc) ——
  | { kind: 'friend_presence'; publicId: string; online: boolean }
  | { kind: 'friend_request'; requestId: string; fromPublicId: string; fromName: string; message: string }
  | { kind: 'friend_update'; publicId: string; added: boolean }
  | { kind: 'chat_message'; convId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { kind: 'mail_new'; mailId: string; hasAttachment: boolean }
  // —— SLG world real-time pushes (S8-2, worldsvc calls via /gw/push, sharing this channel with matchsvc/meta) ——
  | {
      kind: 'march_update';
      marchId: string;
      marchKind: string;
      fromTile: string;
      toTile: string;
      arriveAt: number;
      status: string;
    }
  | {
      kind: 'tile_update';
      tileId: string;
      type: string;
      level: number;
      ownerPublicId: string;
      ownerName: string;
      familyId: string;
      protectedUntil: number;
    }
  | {
      kind: 'under_attack';
      tile: string;
      attackerName: string;
      attackerPublicId: string;
      arriveAt: number;
      troopsHint: number;
    }
  | {
      kind: 'siege_result';
      siegeId: string;
      tile: string;
      outcome: string;
      lootSummary: string;
      replayRef: string;
    }
  // Family channel message (S8-4, worldsvc delivers via /gw/push targeted push; ≤30 members, O(n) is acceptable).
  | { kind: 'family_msg'; familyId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  // Sect channel message (S8-4b, worldsvc fans out via Redis pub/sub → gateway delivers to online members; ≤900 members).
  | { kind: 'sect_msg'; sectId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  // Nation / world public channel (B7, worldsvc fans out via Redis pub/sub → gateway delivers to online players in the same world).
  | { kind: 'nation_msg'; worldId: string; fromPublicId: string; fromName: string; body: string; ts: number };

export class MatchsvcClient {
  constructor(
    private readonly baseUrl: string | null, // e.g. http://matchsvc:8091 (internal direct connection)
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  // fire-and-forget: the real result comes back asynchronously over /gw/push, not in
  // the HTTP response. `retries` is reserved for the non-self-healing, idempotent-on-
  // receiver commands (enqueue / leave) — see postInternal's header for why.
  private post(path: string, body: Record<string, unknown>, retries = 0): void {
    if (!this.baseUrl) {
      log.warn('matchsvc not configured: command dropped', { path });
      return;
    }
    void postInternal(`${this.baseUrl}${path}`, body, {
      caller: 'gateway',
      key: this.internalKey,
      retries,
      log,
      label: path,
    });
  }

  // roomCreate / roomJoin are NOT idempotent on the matchsvc side (a re-landed dup
  // would create a second room / push ALREADY_IN_ROOM), so they stay retries=0 — the
  // player can simply click again. They still get the body-drain + timeout fix.
  roomCreate(accountId: string, name: string, publicId: string, equippedTitle = '', deck: string[] = []): void {
    this.post('/mm/room/create', { accountId, name, publicId, equippedTitle, deck });
  }
  roomJoin(accountId: string, name: string, publicId: string, code: string, equippedTitle = '', deck: string[] = []): void {
    this.post('/mm/room/join', { accountId, name, publicId, code, equippedTitle, deck });
  }
  roomReady(accountId: string, ready: boolean): void {
    this.post('/mm/room/ready', { accountId, ready });
  }
  roomStart(accountId: string): void {
    this.post('/mm/room/start', { accountId });
  }
  // leave is idempotent (no-op if not in room/queue) and non-self-healing (a lost
  // leave strands a zombie queue entry / room) → retry.
  roomLeave(accountId: string): void {
    this.post('/mm/room/leave', { accountId }, 2);
  }
  // enqueue is idempotent (matchsvc dedups by accountId) and non-self-healing (a lost
  // enqueue strands the player on "searching") → retry. This is the 0/20 fix.
  enqueue(accountId: string, name: string, publicId: string, elo: number, equippedTitle = '', platform = '', deck: string[] = []): void {
    this.post('/mm/queue/enqueue', { accountId, name, publicId, elo, equippedTitle, platform, deck }, 2);
  }
  connected(accountId: string): void {
    this.post('/mm/conn/connected', { accountId });
  }
  disconnected(accountId: string): void {
    this.post('/mm/conn/disconnected', { accountId });
  }
}
