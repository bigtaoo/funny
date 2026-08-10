// Split from matchReport.ts (2026-08-10, independent function module range 6, part 3/6).
import type { MatchReplayDoc } from '@nw/shared';
import type { GatewayClient } from '../../gatewayClient.js';
import type { ReportBody } from './types.js';

/**
 * Peer judge (Phase C): sends the full match replay to gateway to pick a third-party headless re-computation, and determines which side is honest based on the judge's hash.
 * Returns { honest side, cheating side, judge accountId }; if the judge cannot adjudicate (no candidates / timeout / re-computation failure / result does not match either side) → null.
 */
export async function judgeMismatch(
  gateway: GatewayClient,
  body: ReportBody,
  replayDoc: MatchReplayDoc,
): Promise<{
  honest: { side: number; accountId: string };
  cheater: { side: number; accountId: string };
  judgeAccountId?: string;
} | null> {
  if (body.results.length !== 2) return null;
  const verdict = await gateway.judge({
    seed: Number(body.seed),
    mode: 1, // RANKED (judge client re-computes as netplay; mode is audit-semantic only)
    endFrame: replayDoc.endFrame,
    // command bytes are already base64 (stored as `unknown` in MatchReplayDoc — BSON binary shape); coerce to string, passed through as-is otherwise.
    frames: replayDoc.frames.map((f) => ({
      frame: f.frame,
      cmds: f.cmds.map((c) => ({ side: c.side, commands: String(c.commands) })),
    })),
    exclude: body.players.map((p) => p.accountId),
    ...(replayDoc.decks ? { decks: replayDoc.decks } : {}),
  });
  if (!verdict.ok || !verdict.stateHash) return null;

  // Whichever side matches the judge's hash is honest; the other side (hash mismatch) is the cheater. The two sides' hashes are different from each other,
  // so at most one side can match; if neither matches (judge result does not correspond to either side), adjudication fails → void.
  const honestRes = body.results.find((r) => r.state_hash === verdict.stateHash);
  const cheaterRes = body.results.find((r) => r.state_hash !== verdict.stateHash);
  if (!honestRes || !cheaterRes) return null;
  const honest = body.players.find((p) => p.side === honestRes.side);
  const cheater = body.players.find((p) => p.side === cheaterRes.side);
  if (!honest || !cheater) return null;
  return {
    honest,
    cheater,
    ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
  };
}
