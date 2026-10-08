import { fetchInternalJson } from '@nw/shared';
import { log } from './shared';

// ── Consent-free server retention report (meta /internal/retention) ─────────────
// Built by metaserver from data it keeps to run the game (signup time, save progress, activity windows);
// players who turned analytics off, deleted accounts and bots are excluded there (metaserver retentionReport.ts).

/** One signup cohort (UTC day of account creation). Mirror of metaserver's RetentionCohort. */
export interface RetentionCohortRow {
  date: string;
  signups: number;
  tutorialDone: number;
  cleared: { ch1_lv1: number; ch1_lv2: number; ch1_lv3: number };
  /** null = the cohort is too young for that window to be final yet. */
  retained: { d1: number | null; d3: number | null; d7: number | null; d14: number | null; d30: number | null };
}

export interface RetentionClient {
  readonly available: boolean;
  /** Newest cohort first. null = the call failed (network / non-2xx). */
  getRetention(days: number): Promise<RetentionCohortRow[] | null>;
}

/** Stand-in for deployments/tests without metaserver: reports unavailable. */
export const nullRetentionClient: RetentionClient = {
  available: false,
  getRetention: async () => null,
};

export class HttpRetentionClient implements RetentionClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async getRetention(days: number): Promise<RetentionCohortRow[] | null> {
    if (!this.metaBaseUrl) return null;
    const r = await fetchInternalJson<{ cohorts?: RetentionCohortRow[] }>(
      `${this.metaBaseUrl}/internal/retention?days=${encodeURIComponent(String(days))}`,
      {
        caller: 'admin',
        key: this.internalKey,
        // One aggregation over up to 90 days of signups — allow it more time than a point lookup.
        timeoutMs: 20000,
        log,
        label: 'meta /internal/retention',
      },
    );
    if (!r.ok || !r.body) return null;
    return r.body.cohorts ?? [];
  }
}
