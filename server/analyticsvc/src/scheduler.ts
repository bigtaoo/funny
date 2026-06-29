// analyticsvc ETL scheduler (A9-7).
// Recomputes "today + yesterday" funnel pre-aggregation data every hour and writes it to funnels_daily.
// Re-runs are idempotent (upsert); no persistent scheduler state is needed.
import type { AnalyticsService } from './service';

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function utcDateStr(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function startEtlScheduler(svc: AnalyticsService): () => void {
  let running = false;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Today + yesterday (today's data accumulates over time; yesterday's data patches any missed reports).
      await Promise.all([
        svc.runFunnelEtl(utcDateStr(0)),
        svc.runFunnelEtl(utcDateStr(-1)),
      ]);
    } catch (e) {
      console.error('[analyticsvc] ETL failed', e);
    } finally {
      running = false;
    }
  };

  // Run once on startup, then every hour.
  void run();
  const timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref(); // does not block process exit.

  return () => clearInterval(timer);
}
