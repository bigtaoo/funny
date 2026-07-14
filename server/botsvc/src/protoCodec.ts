// Wire encode/decode helpers, ported from client/src/game/net/NetInputSource.ts (PlayerCommand <->
// game.proto) and client/src/net/judgeRunner.ts (matchStateHash). Botsvc generates its own proto TS
// bindings (src/generated/, npm run proto:gen) so these are plain functions over that local module,
// not a cross-package import — the logic must stay byte-identical with the client's, since a bot's
// match must hash-match a real opponent's client.
import type { PlayerCommand, PlayerStats } from '@nw/engine';
import { PlayCard, PlayerCommand as ProtoPlayerCommand, PlayerCommands } from './generated/game';
import { Envelope, type ClientMsg, type ServerMsg } from './generated/transport';

// ─── Envelope framing ───────────────────────────────────────────────────────

export function encodeEnvelope(client?: ClientMsg, server?: ServerMsg): Uint8Array {
  return Envelope.encode(Envelope.fromPartial({ client, server })).finish();
}

/** Decodes a raw WS frame; returns undefined for a malformed frame (dropped, not thrown). */
export function decodeServerMsg(data: Uint8Array): ServerMsg | undefined {
  try {
    return Envelope.decode(data).server;
  } catch {
    return undefined;
  }
}

// ─── PlayerCommand <-> game.proto (mirrors NetInputSource.ts toProto/fromProto) ─────────────

export function toProtoCommand(cmd: PlayerCommand): ProtoPlayerCommand {
  if (cmd.type === 'upgrade_base') {
    return { upgradeBase: {}, playCard: undefined, refreshHand: undefined };
  }
  if (cmd.type === 'refresh_hand') {
    return { refreshHand: {}, playCard: undefined, upgradeBase: undefined };
  }
  const card: PlayCard = { handIndex: cmd.handIndex, col: cmd.col ?? 0, row: cmd.row ?? 0 };
  return { playCard: card, upgradeBase: undefined, refreshHand: undefined };
}

export function fromProtoCommand(pc: ProtoPlayerCommand, owner: 0 | 1, tick: number): PlayerCommand {
  if (pc.upgradeBase) return { type: 'upgrade_base', owner, tick };
  if (pc.refreshHand) return { type: 'refresh_hand', owner, tick };
  const card = pc.playCard;
  return {
    type: 'play_card',
    owner,
    tick,
    handIndex: card?.handIndex ?? 0,
    col: card?.col ?? 0,
    row: card?.row ?? 0,
  };
}

/** Encodes a single outbound command as opaque `game.proto` `PlayerCommands` bytes (cmd_submit payload). */
export function encodeOutboundCommand(cmd: PlayerCommand): Uint8Array {
  return PlayerCommands.encode(PlayerCommands.fromPartial({ commands: [toProtoCommand(cmd)] })).finish();
}

/** Decodes one side's `SideCmd.commands` bytes back into engine `PlayerCommand`s for the given tick. */
export function decodeSideCommands(bytes: Uint8Array, owner: 0 | 1, tick: number): PlayerCommand[] {
  const decoded = PlayerCommands.decode(bytes);
  return decoded.commands.map((pc) => fromProtoCommand(pc, owner, tick));
}

// ─── Match-state hash (mirrors client/src/net/judgeRunner.ts matchStateHash exactly) ───────

/**
 * FNV-1a 32-bit hash of `{winner, stats}`. Must stay byte-identical with the client's
 * implementation — both sides of a real match report this, and meta compares them for
 * anti-cheat (hash mismatch triggers judge re-simulation).
 */
export function matchStateHash(winner: 0 | 1 | null, stats: [PlayerStats, PlayerStats]): string {
  const payload = JSON.stringify({ winner, stats });
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
