// Server opaque replay → client Replay decode adapter (S1-RP).
// The server persists non-empty frame logs from a match as game.proto opaque bytes
// (base64 over REST), logic-agnostic, engineVersion=0. After the client fetches them,
// this module decodes them into a playable Replay: base64 → PlayerCommands.decode →
// engine PlayerCommand. engineVersion is set to the local ENGINE_VERSION (replay
// correctness is the client engine's responsibility; uses the same decode path as
// NetInputSource.ingestFrame / judgeRunner.buildReplay).
import {
  ENGINE_VERSION,
  type GameMode,
  type OwnerId,
  type PlayerCommand,
  type Replay,
  type ReplayFrame,
} from '../game';
import { PlayerCommands, type PlayerCommand as ProtoPlayerCommand } from './proto/game';
import type { ServerReplay } from './ApiClient';

/** base64 → Uint8Array (browser atob / Node 18+ global atob both work). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** game.proto PlayerCommand → engine PlayerCommand (same logic as NetInputSource.fromProto). */
function fromProto(pc: ProtoPlayerCommand, owner: OwnerId, frame: number): PlayerCommand {
  if (pc.upgradeBase) return { type: 'upgrade_base', owner, tick: frame };
  if (pc.refreshHand) return { type: 'refresh_hand', owner, tick: frame };
  const card = pc.playCard;
  return {
    type: 'play_card',
    owner,
    tick: frame,
    handIndex: card?.handIndex ?? 0,
    col: card?.col ?? 0,
    row: card?.row ?? 0,
  };
}

/**
 * Server replay → client playable Replay. Commands are base64-decoded then proto-parsed;
 * frame order / side order are preserved exactly as received (the server is the sole sorter).
 * engineVersion is set to the local ENGINE_VERSION (the server always stores 0, which is meaningless).
 */
export function serverReplayToReplay(sr: ServerReplay): Replay {
  const frames: ReplayFrame[] = sr.frames.map((fc) => {
    const commands: PlayerCommand[] = [];
    for (const sc of fc.cmds) {
      const decoded = PlayerCommands.decode(base64ToBytes(sc.commands));
      for (const pc of decoded.commands) commands.push(fromProto(pc, sc.side as OwnerId, fc.frame));
    }
    return { tick: fc.frame, commands };
  });
  return {
    engineVersion: ENGINE_VERSION,
    mode: (sr.mode as GameMode) ?? 'netplay',
    seed: Number(sr.seed),
    frames,
    endFrame: sr.endFrame,
  };
}
