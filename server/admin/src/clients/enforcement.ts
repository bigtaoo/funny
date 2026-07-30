import { fetchInternalJson } from '@nw/shared';
import { log } from './shared';

// ── Content-moderation enforcement execution (metaserver /internal/accounts/:id/penalty, CM7) ──────────
// The single reputation-score/penalty execution path — see moderation.ts (metaserver) applyPenalty. admin
// calls this whenever a governance source (today: report resolution) confirms a violation; never writes
// flags.reputationScore/mutedUntil/bannedUntil itself.
export type PenaltyAction = 'none' | 'warn' | 'mute' | 'tempban' | 'ban';

export interface PenaltyResult {
  reputationScore: number;
  action: PenaltyAction;
  mutedUntil?: number;
  bannedUntil?: number;
  banned?: boolean;
}

export interface EnforcementClient {
  readonly available: boolean;
  /** Apply a reputation delta (negative for a confirmed report) and return the resulting enforcement state. */
  applyPenalty(accountId: string, delta: number): Promise<{ ok: boolean; result?: PenaltyResult }>;
}

export class HttpEnforcementClient implements EnforcementClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async applyPenalty(accountId: string, delta: number): Promise<{ ok: boolean; result?: PenaltyResult }> {
    if (!this.metaBaseUrl) return { ok: false };
    const r = await fetchInternalJson<PenaltyResult & { ok?: boolean }>(
      `${this.metaBaseUrl}/internal/accounts/${encodeURIComponent(accountId)}/penalty`,
      {
        caller: 'admin',
        key: this.internalKey,
        method: 'POST',
        body: { delta },
        timeoutMs: 10000,
        log,
        label: 'meta /internal/accounts/:id/penalty',
      },
    );
    if (!r.ok || !r.body) return { ok: false };
    const { ok: _ok, ...result } = r.body;
    return { ok: true, result };
  }
}
