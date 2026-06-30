// Client Replay → upload frames (PVE_INTEGRITY §8.6 L1 spot-check recompute).
// When a PvE clear is selected for spot-checking by the server, the client uploads its local
// recording (the player command stream produced by RecordingInputSource) as game.proto opaque
// bytes frames — isomorphic to the judge pipeline (gateway → judge_request → judgeRunner.buildReplay).
// Command encoding / base64 is the mirror-inverse of the decoding in net/serverReplay
// (owner→side, PlayerCommand→proto).

import type { PlayerCommand, Replay } from '../game';
import { PlayerCommands, type PlayerCommand as ProtoPlayerCommand } from './proto/game';

/** Isomorphic to the /pve/verify request body + JudgeRequest frames (command bytes as base64, JSON-safe). */
export interface UploadFrame {
  frame: number;
  cmds: { side: number; commands: string }[];
}

/** Uint8Array → base64 (browser btoa / Node 18+ global btoa both work). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Engine PlayerCommand → game.proto PlayerCommand (same logic as NetInputSource.toProto). */
function toProto(cmd: PlayerCommand): ProtoPlayerCommand {
  if (cmd.type === 'upgrade_base') return { upgradeBase: {}, playCard: undefined, refreshHand: undefined };
  if (cmd.type === 'refresh_hand') return { refreshHand: {}, playCard: undefined, upgradeBase: undefined };
  return {
    playCard: { handIndex: cmd.handIndex, col: cmd.col ?? 0, row: cmd.row ?? 0 },
    upgradeBase: undefined,
    refreshHand: undefined,
  };
}

/**
 * Non-empty Replay frames → upload frames. Each frame is grouped by owner (PvE recordings
 * only contain player owner 0, but the general grouping is still applied). Each group's
 * commands are packed into a single PlayerCommands proto byte buffer and then base64-encoded.
 * Frame order is preserved as-is (the judge replays by frame number).
 */
export function replayToUploadFrames(replay: Replay): UploadFrame[] {
  return replay.frames.map((f) => {
    const byOwner = new Map<number, ProtoPlayerCommand[]>();
    for (const c of f.commands) {
      const arr = byOwner.get(c.owner) ?? [];
      arr.push(toProto(c));
      byOwner.set(c.owner, arr);
    }
    const cmds = [...byOwner.entries()].map(([side, commands]) => ({
      side,
      commands: bytesToBase64(PlayerCommands.encode(PlayerCommands.fromPartial({ commands })).finish()),
    }));
    return { frame: f.tick, cmds };
  });
}
