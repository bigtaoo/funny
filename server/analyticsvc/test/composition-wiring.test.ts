// Regression coverage for the 2026-08-11 mixin-chain-to-composition pass (claudedocs/server.md):
// AnalyticsService used to be a 4-mixin linear inheritance chain — every domain mixin shared `this`
// (and so the same `cols`/`now`) by construction. Composition removes that guarantee: the constructor
// now explicitly passes the same `(cols, now)` pair into 4 separate `new XService(cols, now)` calls —
// a copy-paste that passed a fresh `() => Date.now()` to one sibling instead of the shared `now`
// closure would silently desync that one domain's clock from the others (most visible in tests that
// pin `now` to a fake value, exactly the pattern analytics.e2e.test.ts/leaderboard-style tests rely on
// throughout this codebase).
import { describe, expect, it } from 'vitest';
import { AnalyticsService } from '../src/service';
import type { AnalyticsCollections } from '../src/db';

describe('AnalyticsService composition wiring: one shared (cols, now) pair (2026-08-11 chain→composition pass)', () => {
  it('every domain instance holds the exact same cols/now the facade was constructed with', () => {
    const cols = {} as AnalyticsCollections;
    const now = () => 12345;
    const svc = new AnalyticsService(cols, now);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = svc as any;
    for (const field of ['traffic', 'funnel', 'dist', 'ingest']) {
      expect(s[field].cols, `${field}.cols should be the shared cols`).toBe(cols);
      expect(s[field].now, `${field}.now should be the shared now`).toBe(now);
    }
  });
});
