// gateway → matchsvc internal HTTP client (S1-M5, after matchsvc was split into a separate process).
// Decoded player control commands are forwarded to matchsvc via this client;
// matchsvc pushes events back to gateway via /gw/push (internalHttp.ts).
// All calls are fire-and-forget — matchsvc results are delivered asynchronously via push; room state is not returned in the HTTP response.
// Internal auth: X-Internal-Key (shared NW_INTERNAL_KEY).
//
// PushMsg / PlayerView here are JSON mirrors of the identically-named types in matchsvc
// (the wire contract across processes is JSON; each side holds a locally-typed copy of the same structure,
// consistent with the REST/JSON internal communication convention — see META_DESIGN §6.7).

import { createLogger, internalHeaders } from '@nw/shared';

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

  private post(path: string, body: Record<string, unknown>): void {
    if (!this.baseUrl) {
      log.warn('matchsvc not configured: command dropped', { path });
      return;
    }
    void fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('gateway', this.internalKey) },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (!res.ok) log.warn('matchsvc returned non-OK', { path, status: res.status });
      })
      .catch((e) => {
        // Command lost: the player can retry (create room / join / start are all idempotent to a second click), but this must be visible during integration testing.
        log.error('matchsvc POST failed', { path, url: this.baseUrl, err: (e as Error).message });
      });
  }

  roomCreate(accountId: string, name: string, publicId: string, equippedTitle = ''): void {
    this.post('/mm/room/create', { accountId, name, publicId, equippedTitle });
  }
  roomJoin(accountId: string, name: string, publicId: string, code: string, equippedTitle = ''): void {
    this.post('/mm/room/join', { accountId, name, publicId, code, equippedTitle });
  }
  roomReady(accountId: string, ready: boolean): void {
    this.post('/mm/room/ready', { accountId, ready });
  }
  roomStart(accountId: string): void {
    this.post('/mm/room/start', { accountId });
  }
  roomLeave(accountId: string): void {
    this.post('/mm/room/leave', { accountId });
  }
  enqueue(accountId: string, name: string, publicId: string, elo: number, equippedTitle = ''): void {
    this.post('/mm/queue/enqueue', { accountId, name, publicId, elo, equippedTitle });
  }
  connected(accountId: string): void {
    this.post('/mm/conn/connected', { accountId });
  }
  disconnected(accountId: string): void {
    this.post('/mm/conn/disconnected', { accountId });
  }
}
