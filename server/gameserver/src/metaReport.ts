// gameserver → meta 局末上报（M19，S1-M3）。把 {room_id, seed, mode, 双方 hash/winner,
// reason, 非空帧录像} POST 到 meta /internal/match/report（内部密钥、room_id 幂等）。
// meta 比对 + 算 ELO 写 saves.pvp + 归档 matches；ranked 把每方 ELO 变化回给 game →
// 转进 match_over.elo。meta 不可用时排队重试（进行中对局不依赖 meta 实时在线，M16）。
import { internalHeaders } from '@nw/shared';
import type { EloBySide, MatchReport } from './Room';

interface QueuedReport {
  body: unknown;
  attempts: number;
}

export class MetaReporter {
  private readonly queue: QueuedReport[] = [];
  private draining = false;

  constructor(
    private readonly baseUrl: string | null, // 形如 http://meta:8080（内部直连，无 /api 前缀）
    private readonly internalKey: string,
  ) {}

  /**
   * 上报一局。返回每方 ELO 变化（ranked 结算成功时）；friendly / 失败 / meta 不可用 → null。
   * 失败时把 body 入队后台重试（幂等键 room_id，重发不重复结算）。
   */
  async report(r: MatchReport): Promise<EloBySide | null> {
    const body = {
      room_id: r.roomId,
      seed: String(r.seed),
      mode: r.mode,
      reason: r.reason,
      winner_side: r.winnerSide,
      hash_ok: r.hashOk,
      players: r.players,
      results: r.results.map((x) => ({
        side: x.side,
        state_hash: x.stateHash,
        winner_side: x.winnerSide,
      })),
      // 非空帧录像（M19/S1-RP）。opaque command bytes 经 internal HTTP JSON 传输 →
      // base64 编码（meta 原样存 matches.replay，回放时 base64 解码；commands 不解码 M12）。
      replay: {
        engineVersion: r.replay.engineVersion,
        mode: r.replay.mode,
        seed: String(r.replay.seed),
        endFrame: r.replay.endFrame,
        frames: r.replay.frames.map((f) => ({
          frame: f.frame,
          cmds: f.cmds.map((c) => ({ side: c.side, commands: Buffer.from(c.commands).toString('base64') })),
        })),
        meta: r.replay.meta,
      },
    };
    if (!this.baseUrl) return null;
    try {
      const res = await this.post(body);
      if (!res) {
        this.enqueue(body);
        return null;
      }
      return res.elo ?? null;
    } catch {
      this.enqueue(body);
      return null;
    }
  }

  private async post(body: unknown): Promise<{ ok: boolean; elo?: EloBySide } | null> {
    if (!this.baseUrl) return null;
    const res = await fetch(`${this.baseUrl}/internal/match/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('gameserver', this.internalKey) },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as { ok: boolean; elo?: EloBySide };
  }

  private enqueue(body: unknown): void {
    this.queue.push({ body, attempts: 0 });
    void this.drain();
  }

  /** 后台重试队列（指数退避，幂等键 room_id 保证不重复结算）。 */
  private async drain(): Promise<void> {
    if (this.draining || !this.baseUrl) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const item = this.queue[0]!;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(item.attempts, 5));
      await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await this.post(item.body);
        if (res) {
          this.queue.shift();
          continue;
        }
      } catch {
        /* retry */
      }
      item.attempts++;
    }
    this.draining = false;
  }
}
