// Room domain layer 2 (2026-08-11 split, see Room.ts's header) — end-of-match reporting to meta
// (results comparison, ELO await/dispatch, replay assembly) + room teardown. Depends on base.ts
// (broadcast) and metronome.ts (stopMetronome); connections.ts depends on this file, not the reverse.
import { broadcast } from './base';
import { stopMetronome } from './metronome';
import { MatchMode, RoomPhase } from '../proto/transport';
import type { EloBySide, MatchReplay, MatchReport, RoomCtx } from './types';

export function reportResult(ctx: RoomCtx, side: number, stateHash: string, winnerSide: number, stats?: Record<string, number>): void {
  if (ctx.phase !== RoomPhase.IN_MATCH || ctx.settled) return;
  if (!ctx.slots.some((s) => s.side === side)) return;
  ctx.results.set(side, { hash: stateHash, winner: winnerSide, ...(stats ? { stats } : {}) });
  if (ctx.results.size < ctx.slots.length) return;

  const reports = [...ctx.results.values()];
  const hashOk = reports.every((r) => r.hash === reports[0]!.hash);
  if (ctx.mode === MatchMode.RANKED) {
    const winnersAgree = reports.every((r) => r.winner === reports[0]!.winner);
    if (hashOk && winnersAgree) {
      void endMatch(ctx, { winnerSide: reports[0]!.winner, reason: 'base', hashOk: true });
    } else {
      void endMatch(ctx, { winnerSide: -1, reason: 'mismatch', hashOk: false });
    }
    return;
  }
  // friendly: winner is determined authoritatively by client simulation; meta only audits/archives.
  void endMatch(ctx, { winnerSide: -1, reason: hashOk ? 'base' : 'mismatch', hashOk });
}

export async function endMatch(ctx: RoomCtx, opts: {
  winnerSide: number;
  reason: string;
  hashOk: boolean;
}): Promise<void> {
  if (ctx.settled) return;
  ctx.settled = true;
  stopMetronome(ctx);
  if (ctx.graceTimer) {
    clearTimeout(ctx.graceTimer);
    ctx.graceTimer = null;
  }
  ctx.phase = RoomPhase.OVER;

  const report: MatchReport = {
    roomId: ctx.roomId,
    seed: ctx.seed,
    mode: ctx.mode === MatchMode.RANKED ? 'ranked' : 'friendly',
    reason: opts.reason,
    winnerSide: opts.winnerSide,
    hashOk: opts.hashOk,
    players: ctx.roster,
    results: [...ctx.results.entries()].map(([side, r]) => ({
      side,
      stateHash: r.hash,
      winnerSide: r.winner,
      ...(r.stats ? { stats: r.stats } : {}),
    })),
    replay: buildReplay(ctx, opts.winnerSide),
  };

  // ranked: wait for meta to return ELO before dispatching match_over; friendly: dispatch immediately, report fire-and-forget.
  let eloBySide: EloBySide | null = null;
  if (ctx.mode === MatchMode.RANKED) {
    try {
      eloBySide = await ctx.deps.report(report);
    } catch (e) {
      console.error('[gameserver] meta report (ranked) failed:', e);
    }
  } else {
    void ctx.deps.report(report).catch((e) =>
      console.error('[gameserver] meta report (friendly) failed:', e),
    );
  }

  broadcast(ctx, (c) => {
    const elo = eloBySide ? eloBySide[c.side] : undefined;
    c.send({
      case: 'match_over',
      winnerSide: opts.winnerSide < 0 ? 0 : opts.winnerSide,
      reason: opts.reason,
      mismatch: !opts.hashOk,
      ...(elo ? { elo } : {}),
    });
  });

  destroy(ctx);
}

function buildReplay(ctx: RoomCtx, winnerSide: number): MatchReplay {
  // Decks are identical across both slots (same ticket payload); use whichever slot has them.
  const decks = ctx.slots.find((s) => s.decks)?.decks;
  return {
    engineVersion: 0,
    mode: 'netplay',
    seed: ctx.seed,
    endFrame: ctx.curFrame,
    frames: ctx.log.map((fc) => ({
      frame: fc.frame,
      cmds: fc.cmds.map((sc) => ({ side: sc.side, commands: Buffer.from(sc.commands) })),
    })),
    meta: { recordedAt: Date.now(), winner: winnerSide },
    ...(decks ? { decks } : {}),
  };
}

export function destroy(ctx: RoomCtx): void {
  stopMetronome(ctx);
  if (ctx.graceTimer) {
    clearTimeout(ctx.graceTimer);
    ctx.graceTimer = null;
  }
  if (ctx.launchTimer) {
    clearTimeout(ctx.launchTimer);
    ctx.launchTimer = null;
  }
  ctx.deps.onDestroy(ctx.roomId);
}
