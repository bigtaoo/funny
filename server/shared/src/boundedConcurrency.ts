// Bounded-concurrency fan-out for internal-service call storms (comm-audit-internal-2026-07-28
// batch E). Several call sites used to fire one fire-and-forget internal HTTP request PER
// RECIPIENT with no concurrency cap — worldsvc season settlement mailing/titling every account in
// a 10,000-player region, meta's ladder season roll mailing every participant. That's the exact
// failure mode documented in internalFetch.ts's header comment (a burst of concurrent unconsumed
// requests wedges undici's connection pool), just at a much larger scale (thousands, not dozens).
//
// This isn't a job queue: no persistence, no retry beyond what the underlying call already does.
// It exists purely to cap in-flight concurrency so a large fan-out degrades to "slower" instead of
// "wedges the pool for every other request sharing it".
export async function runBounded<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}
