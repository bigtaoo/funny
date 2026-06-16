// 客户端 Replay → 上传帧（PVE_INTEGRITY §8.6 L1 抽检复算）。
// PvE 通关被服务器抽中时，客户端把本地录像（RecordingInputSource 产出的玩家指令流）按与
// 裁判管线（gateway → judge_request → judgeRunner.buildReplay）同构的 game.proto opaque bytes
// 帧上传。命令编码 / base64 与 net/serverReplay 的解码逆向对应（owner→side、PlayerCommand→proto）。

import type { PlayerCommand, Replay } from '../game';
import { PlayerCommands, type PlayerCommand as ProtoPlayerCommand } from './proto/game';

/** 与 /pve/verify 请求体 + JudgeRequest 帧同构（command bytes 用 base64，JSON 安全）。 */
export interface UploadFrame {
  frame: number;
  cmds: { side: number; commands: string }[];
}

/** Uint8Array → base64（浏览器 btoa / Node 18+ 全局 btoa 均可用）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** 引擎 PlayerCommand → game.proto PlayerCommand（与 NetInputSource.toProto 同逻辑）。 */
function toProto(cmd: PlayerCommand): ProtoPlayerCommand {
  if (cmd.type === 'upgrade_base') return { upgradeBase: {}, playCard: undefined };
  return {
    playCard: { handIndex: cmd.handIndex, col: cmd.col ?? 0, row: cmd.row ?? 0 },
    upgradeBase: undefined,
  };
}

/**
 * Replay 的非空帧 → 上传帧。每帧按 owner 分组（PvE 录像只含玩家 owner 0，但仍按通用分组），
 * 每组的命令打成一个 PlayerCommands proto bytes 再 base64。帧顺序原样保留（裁判按 frame 重放）。
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
