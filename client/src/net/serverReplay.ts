// 服务端 opaque 录像 → 客户端 Replay 解码适配（S1-RP）。
// 服务端把对局非空帧日志按 game.proto opaque bytes 持久化（base64 over REST），逻辑无关、
// engineVersion=0。客户端取回后在此解码成可回放的 Replay：base64 → PlayerCommands.decode →
// 引擎 PlayerCommand，engineVersion 用本机 ENGINE_VERSION（回放正确性由客户端引擎自负，
// 与 NetInputSource.ingestFrame / judgeRunner.buildReplay 同套解码）。
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

/** base64 → Uint8Array（浏览器 atob / Node 18+ 全局 atob 均可用）。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** game.proto PlayerCommand → 引擎 PlayerCommand（与 NetInputSource.fromProto 同逻辑）。 */
function fromProto(pc: ProtoPlayerCommand, owner: OwnerId, frame: number): PlayerCommand {
  if (pc.upgradeBase) return { type: 'upgrade_base', owner, tick: frame };
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
 * 服务端录像 → 客户端可回放 Replay。命令 base64 解码 + proto 解析，帧顺序 / side 顺序原样保留
 * （服务器是唯一排序者）。engineVersion 取本机 ENGINE_VERSION（服务端恒 0 无意义）。
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
