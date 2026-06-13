// NetSession (S1-8) — ties the gameserver transport (NetClient) to the lockstep
// input pipeline (NetInputSource) and exposes a small surface for RoomScene /
// app.ts to drive a friendly online match end to end.
//
// Lifetime: created once when the player first opens the friend room, and kept
// alive across the RoomScene → GameScene transition (the NetInputSource must
// keep ingesting frame_batch while the engine plays). One match at a time, so a
// single subscriber per event is enough.
//
// Responsibilities:
//   • build NetClient (transport) + NetInputSource (sink = client.submitCmd);
//   • route every ServerMsg to the input source AND surface the room-level ones
//     (room_state / room_error / peer_dc / match_over / match_start) to the UI;
//   • on reconnect, resume the match (conn_resume{roomId, resumeFrame}) — S1-4.
//
// It does NOT build the engine or own scenes; app.ts does that on match_start
// using `session.input` as the engine's InputSource.

import type { AuthCredential, IPlatform } from '../platform/IPlatform';
import { NetClient, type NetState } from './NetClient';
import { MatchMode, type MatchOver, type PeerDc, type RoomError, type RoomState, type ServerMsg } from './proto/transport';
import { NetInputSource, type MatchStartInfo } from '../game';
import type { ApiClient } from './ApiClient';

export interface NetSessionHandlers {
  onRoomState?(s: RoomState): void;
  onRoomError?(e: RoomError): void;
  onPeerDc?(p: PeerDc): void;
  onMatchOver?(m: MatchOver): void;
  /** Fired once the server confirms the match — app builds the engine here. */
  onMatchStart?(info: MatchStartInfo): void;
  onNetState?(s: NetState): void;
}

export class NetSession {
  readonly client: NetClient;
  readonly input: NetInputSource;

  /** Swapped by whoever is currently driving the session (RoomScene, then app). */
  handlers: NetSessionHandlers = {};

  /** Set when this client created the room (side 0 = host) vs joined (side 1). */
  private roomId = '';
  private localSide = -1;

  constructor(platform: IPlatform, url: string, api: ApiClient, getCredential: () => Promise<AuthCredential>) {
    this.input = new NetInputSource(
      { submitCmd: (bytes) => this.client.submitCmd(bytes) },
      {
        onMatchStart: (info) => {
          this.roomId = info.roomId;
          this.localSide = info.localSide;
          this.handlers.onMatchStart?.(info);
        },
      },
    );

    this.client = new NetClient(platform, {
      url,
      tokenProvider: async () => {
        // Re-auth on every (re)connect: device/wx auth is idempotent (upsert →
        // stable accountId) and hands back a fresh JWT, so token expiry is moot.
        const res = await api.auth(await getCredential());
        return res.token;
      },
      handlers: {
        onServerMsg: (msg) => this.route(msg),
        onStateChange: (s) => this.handlers.onNetState?.(s),
        // Reconnected mid-match → ask the server to replay frames past our
        // watermark and resume the metronome (S1-4).
        onReconnect: () => {
          if (this.roomId) this.client.resume(this.roomId, this.input.resumeFrame());
        },
      },
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  connect(): void { this.client.connect(); }

  /** Leave the room (if any) and tear down the socket. */
  close(): void {
    this.client.leaveRoom();
    this.client.disconnect();
    this.roomId = '';
    this.localSide = -1;
  }

  // ── Room actions ───────────────────────────────────────────────────────────────

  createRoom(): void { this.client.createRoom(MatchMode.FRIENDLY); }
  joinRoom(code: string): void { this.client.joinRoom(code); }
  setReady(ready: boolean): void { this.client.setReady(ready); }
  startMatch(): void { this.client.startMatch(); }
  reportResult(stateHash: string): void { this.client.reportResult(stateHash); }

  /** Which side this client controls once the match starts (-1 until then). */
  getLocalSide(): number { return this.localSide; }

  // ── Routing ──────────────────────────────────────────────────────────────────

  private route(msg: ServerMsg): void {
    // The input source consumes match_start / frame_batch / conn_resync and
    // ignores the rest — feed it everything.
    this.input.handleServerMsg(msg);

    if (msg.roomState) this.handlers.onRoomState?.(msg.roomState);
    else if (msg.roomError) this.handlers.onRoomError?.(msg.roomError);
    else if (msg.peerDc) this.handlers.onPeerDc?.(msg.peerDc);
    else if (msg.matchOver) this.handlers.onMatchOver?.(msg.matchOver);
    // match_start is surfaced via NetInputSource.onMatchStart (above) so the
    // app sees it only after the input source has captured seed/startFrame.
  }
}
