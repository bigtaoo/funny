// gateway/Gateway.ts split (2026-08-10, ≤500-line convention, composition layer #4 — Phase C peer judge):
// picks an eligible idle online player to headlessly re-compute a match and report the verdict back to meta.
// Depends only on connRegistry's `ConnLookup.values()` (to enumerate judge candidates) — never the WS
// handshake/heartbeat internals.
import { activeMatchKey, createLogger, type RedisLike } from '@nw/shared';
import { encodeServer } from '../proto';
import { JUDGE_TIMEOUT_MS, type ConnLookup, type GwConn, type JudgeArgs, type JudgeResult, type PendingJudge } from './types';

const log = createLogger('gateway');

export interface PeerJudgeDeps {
  conns: ConnLookup;
}

export class PeerJudgeService {
  /** In-flight judge requests (requestId → pending). Cleared when a verdict arrives or on timeout. */
  private readonly pendingJudges = new Map<string, PendingJudge>();
  private judgeSeq = 0;
  /** Redis holding matchsvc's `activeMatch` records (Gateway.setPresenceStore); null = only the client's canJudge flag gates. */
  private activeMatchStore: RedisLike | null = null;

  constructor(private readonly deps: PeerJudgeDeps) {}

  setActiveMatchStore(store: RedisLike): void {
    this.activeMatchStore = store;
  }

  /**
   * Called by meta (via /gw/judge): picks an eligible idle online player to headlessly re-compute the match and report the final-state hash.
   * No eligible candidate / timeout / re-computation failed → {ok:false}; meta voids the result (no penalty).
   */
  async judge(args: JudgeArgs): Promise<JudgeResult> {
    const candidate = await this.pickJudge(args.exclude);
    if (!candidate) return { ok: false };

    const requestId = `j${++this.judgeSeq}:${Date.now()}`;
    return new Promise<JudgeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingJudges.delete(requestId);
        resolve({ ok: false });
      }, JUDGE_TIMEOUT_MS);
      timer.unref?.();
      this.pendingJudges.set(requestId, { resolve, accountId: candidate.accountId, timer });
      try {
        candidate.ws.send(
          encodeServer({
            case: 'judge_request',
            requestId,
            seed: args.seed,
            mode: args.mode,
            endFrame: args.endFrame,
            frames: args.frames,
            levelId: args.levelId ?? '',
            cardInstancesJson: args.cardInstancesJson ?? '',
            equipmentInvJson: args.equipmentInvJson ?? '',
            topDeck: args.decks?.top ?? [],
            bottomDeck: args.decks?.bottom ?? [],
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pendingJudges.delete(requestId);
        resolve({ ok: false });
      }
    });
  }

  /** Resolves the pending judge for `msg.requestId` — dispatcher's judge_verdict case. Only accepts the
   *  verdict from the designated judge (prevents another player from forging a verdict). */
  resolveVerdict(
    accountId: string,
    msg: { requestId: string; ok: boolean; stateHash?: string; winnerSide?: number; stars?: number; statsJson?: string },
  ): void {
    const pending = this.pendingJudges.get(msg.requestId);
    if (!pending || pending.accountId !== accountId) return;
    clearTimeout(pending.timer);
    this.pendingJudges.delete(msg.requestId);
    pending.resolve(
      msg.ok
        ? {
            ok: true,
            stateHash: msg.stateHash,
            winnerSide: msg.winnerSide,
            stars: msg.stars,
            statsJson: msg.statsJson,
            judgeAccountId: accountId,
          }
        : { ok: false },
    );
  }

  /** If this account was acting as a judge, immediately cancel its in-flight requests (no need to wait for
   *  timeout) — wired to connRegistry's unconditional per-socket-close hook (see connRegistry.ts). */
  cancelPendingFor(accountId: string): void {
    for (const [id, p] of this.pendingJudges) {
      if (p.accountId !== accountId) continue;
      clearTimeout(p.timer);
      this.pendingJudges.delete(id);
      p.resolve({ ok: false });
    }
  }

  /**
   * Picks one online player who has canJudge set, is not in the exclude list and is not in an online
   * match (single-judge model). Uniformly random among candidates (comm-audit-internal-2026-07-28 P0-10):
   * the old "first match in conns iteration order" both over-drafted long-lived connections and let a
   * colluder park an early connection to reliably occupy the judge seat for an accomplice's disputes.
   *
   * "Not in a match" has two sources: the client withdraws canJudge while a battle is on screen
   * (covers local bot/campaign battles too), and matchsvc's activeMatch record covers online matches
   * server-side, so an old or misbehaving client can't be handed a recompute mid-match — which is what
   * made live PvP stall once bot PvE spot-checks began (2026-09-27). Redis unavailable → the flag alone.
   */
  private async pickJudge(exclude: string[]): Promise<GwConn | null> {
    const candidates: GwConn[] = [];
    for (const conn of this.deps.conns.values()) {
      if (!conn.canJudge) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      if (exclude.includes(conn.accountId)) continue;
      candidates.push(conn);
    }
    const idle = await this.withoutActiveMatch(candidates);
    if (idle.length === 0) return null;
    const pick = idle[Math.floor(Math.random() * idle.length)]!;
    // The await above may have spanned a disconnect.
    return pick.ws.readyState === pick.ws.OPEN ? pick : null;
  }

  private async withoutActiveMatch(candidates: GwConn[]): Promise<GwConn[]> {
    if (!this.activeMatchStore || candidates.length === 0) return candidates;
    try {
      const records = await this.activeMatchStore.mget(...candidates.map((c) => activeMatchKey(c.accountId)));
      return candidates.filter((_, i) => !records[i]);
    } catch (e) {
      log.warn('activeMatch lookup failed; judging on canJudge alone', { err: (e as Error).message });
      return candidates;
    }
  }
}
