// meta → gateway internal call (Phase C peer judge). When a ranked match has a hash mismatch, meta sends
// the full replay to gateway, which selects a high-resource idle online player to headlessly re-compute
// the match and reports back the final hash + winner.
// Internal auth: X-Internal-Key (shared NW_INTERNAL_KEY). gateway not configured → judge unavailable (verdict voided).
//
// Same shape as commercialClient: HTTP implementation + interface (makes it easy to inject a fake judge in tests).

import { internalHeaders } from '@nw/shared';

/** Replay frame (command bytes are base64-encoded for JSON safety; gateway decodes back to bytes and pushes to the judge client). */
export interface JudgeFrame {
  frame: number;
  cmds: { side: number; commands: string }[];
}

export interface JudgeReq {
  seed: number;
  /** MatchMode numeric value (ranked = 1). */
  mode: number;
  endFrame: number;
  frames: JudgeFrame[];
  /** accountIds of both competitors — a player cannot judge their own match (PvE excludes only the player themselves). */
  exclude: string[];
  /** PvE spot-check re-computation (PVE_INTEGRITY §8.6 L1): non-empty → judge re-computes this level in campaign mode. */
  levelId?: string;
  /** Server-authoritative blueprint snapshot (upgrade levels), ensures PvE re-computation is deterministic. */
  pveUpgrades?: Record<string, number>;
}

export interface JudgeRes {
  ok: boolean;
  stateHash?: string;
  winnerSide?: number;
  /** Stars obtained by the PvE re-computation (PVE_INTEGRITY §8.6 L1). */
  stars?: number;
  /** PvE feed-in (S9-3b, ACHIEVEMENT_DESIGN §6.2): JSON of the player's per-match achievement counters derived from re-computation; always empty for PvP/siege. */
  statsJson?: string;
  judgeAccountId?: string;
}

/**
 * Social real-time push (S6, SOCIAL_DESIGN §4.2): meta → gateway /gw/push, targeted delivery by accountId.
 * Same shape as the gateway-side PushMsg social branch (JSON wire contract, camelCase discriminator=kind).
 */
export type SocialPushMsg =
  | { kind: 'friend_request'; requestId: string; fromPublicId: string; fromName: string; message: string }
  | { kind: 'friend_update'; publicId: string; added: boolean }
  | { kind: 'chat_message'; convId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { kind: 'mail_new'; mailId: string; hasAttachment: boolean };

export interface GatewayClient {
  readonly available: boolean;
  judge(req: JudgeReq): Promise<JudgeRes>;
  /** Push a targeted social message by accountId (dropped if gateway is offline). Best-effort, does not throw. */
  push(accountId: string, msg: SocialPushMsg): Promise<void>;
  /** Batch presence query (marks the online flag in friend lists); returns all-false if gateway is unavailable or errors. */
  presence(accountIds: string[]): Promise<Record<string, boolean>>;
  /** Invalidate gateway's friend cache after a friendship change (forces presence broadcast scope to be re-fetched). Best-effort. */
  invalidateFriends(accountId: string): Promise<void>;
}

export class HttpGatewayClient implements GatewayClient {
  constructor(
    private readonly baseUrl: string | null, // e.g. http://gateway:8090 (internal HTTP port)
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  /** Error / not configured / no candidate → {ok:false} (meta falls back to voiding the verdict, not convicting). */
  async judge(req: JudgeReq): Promise<JudgeRes> {
    if (!this.baseUrl) return { ok: false };
    try {
      const res = await fetch(`${this.baseUrl}/gw/judge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('meta', this.internalKey) },
        body: JSON.stringify(req),
      });
      if (!res.ok) return { ok: false };
      return (await res.json()) as JudgeRes;
    } catch {
      return { ok: false };
    }
  }

  async push(accountId: string, msg: SocialPushMsg): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/gw/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('meta', this.internalKey) },
        body: JSON.stringify({ accountId, msg }),
      });
    } catch {
      // best-effort: push failure does not affect already-persisted data; client pulls on next login.
    }
  }

  async presence(accountIds: string[]): Promise<Record<string, boolean>> {
    if (!this.baseUrl || accountIds.length === 0) return {};
    try {
      const qs = encodeURIComponent(accountIds.join(','));
      const res = await fetch(`${this.baseUrl}/gw/presence?accounts=${qs}`, {
        headers: internalHeaders('meta', this.internalKey),
      });
      if (!res.ok) return {};
      return (await res.json()) as Record<string, boolean>;
    } catch {
      return {};
    }
  }

  async invalidateFriends(accountId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/gw/social/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('meta', this.internalKey) },
        body: JSON.stringify({ accountId }),
      });
    } catch {
      // best-effort: cache is eventually consistent; failure only causes a brief delay in presence scope refresh.
    }
  }
}
