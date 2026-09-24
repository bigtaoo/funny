/**
 * analyticsEventConfig.test.ts — every event the client emits must be in analyticsvc's sampling
 * table, and every entry in that table must have an emitter.
 *
 * This is a FILE assertion across two workspaces, same species as adFailureTelemetry.test.ts, and
 * for the same reason: the two lists drift SILENTLY. An event missing from `DEFAULT_CONFIG` is not
 * rejected — `shouldTrack` falls back to `defaultSample` (0.1), so it keeps arriving, just at a
 * tenth of the volume. Nothing logs, nothing warns, and the dashboards keep drawing plausible bars.
 *
 * On 2026-09-20 that had happened to 22 events, including every purchase (`iap_purchase`,
 * `starter_buy`, `battlepass_buy`, …) and every retention claim (`daily_checkin`, …). Because the
 * funnel queries de-duplicate by device, a 10% sample does not shrink the bars proportionally — it
 * randomises whether a given device looks like it ever checked in. The same drift left two entries
 * (`upgrade`, `recharge`) configured years after their call sites had been refactored away, while
 * ANALYTICS_DESIGN §12.1 still described them as wired.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLIENT_DIR = path.resolve(__dirname, '..');
const SRC = path.resolve(CLIENT_DIR, 'src');
// DEFAULT_CONFIG lives in eventConfig.ts (split out of defs.ts 2026-09-24, defs.ts hit the 500-line
// gate); re-exported from defs.ts, but this test greps raw source text, not the module graph.
const DEFS = path.resolve(CLIENT_DIR, '../server/analyticsvc/src/service/eventConfig.ts');

/**
 * Events the table carries on purpose without a live emitter. Keep this list short and justified —
 * it is the only legitimate reason for an entry to have no call site.
 */
const INTENTIONALLY_UNEMITTED = new Set([
  // Explicitly disabled (`enabled: false`) rather than sampled: per-card telemetry was judged too
  // high-volume for the value. The entry documents the decision.
  'card_play',
  // Reserved ahead of the UI: the per-page "?" re-open button is still unwired
  // (ONBOARDING_DESIGN §8/§10). Configured early so it is not forgotten when that lands.
  'feature_guide_replay',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Event names passed to `analytics.track('x')` / `track('x')` anywhere under client/src. */
function emittedEvents(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\btrack\(\s*'([a-z0-9_]+)'/g)) found.add(m[1]!);
    // The one ternary call site: track(skipped ? 'intro_skip' : 'intro_complete', {}). Anchored to
    // the FIRST argument — a loose pattern also matches ternaries in the props object
    // (`result: won ? 'win' : 'loss'`) and reports the prop values as event names.
    for (const m of text.matchAll(/\btrack\(\s*[A-Za-z0-9_.!]+\s*\?\s*'([a-z0-9_]+)'\s*:\s*'([a-z0-9_]+)'/g)) {
      found.add(m[1]!);
      found.add(m[2]!);
    }
  }
  // analytics.click() is a fixed wrapper around this event name (its `id` argument is a prop,
  // not an event), so it can never be found by the scan above.
  found.add('ui_click');
  return found;
}

/** Keys of analyticsvc's DEFAULT_CONFIG.events map. */
function configuredEvents(): Set<string> {
  const text = fs.readFileSync(DEFS, 'utf8');
  const block = text.match(/export const DEFAULT_CONFIG[\s\S]*?\n {2}events: \{([\s\S]*?)\n {2}\},/);
  expect(block, 'DEFAULT_CONFIG.events block not found — did defs.ts move?').toBeTruthy();
  return new Set([...block![1]!.matchAll(/^\s{4}([a-z0-9_]+):\s*\{/gm)].map((m) => m[1]!));
}

describe('analytics event names and the analyticsvc sampling table agree', () => {
  it('every event the client emits has an explicit sampling entry', () => {
    const missing = [...emittedEvents()].filter((e) => !configuredEvents().has(e)).sort();
    expect(
      missing,
      `these events fall back to defaultSample (0.1) — add them to DEFAULT_CONFIG in ${path.relative(CLIENT_DIR, DEFS)}`,
    ).toEqual([]);
  });

  it('every sampling entry has a client call site', () => {
    const emitted = emittedEvents();
    const orphans = [...configuredEvents()]
      .filter((e) => !emitted.has(e) && !INTENTIONALLY_UNEMITTED.has(e))
      .sort();
    expect(orphans, 'configured but never emitted — remove the entry or wire the event').toEqual([]);
  });

  it('the funnel-critical events are sampled at 1.0, not merely present', () => {
    // These are the steps of the onboarding / economy / churn funnels. A rate below 1.0 on any one
    // of them does not add noise, it moves the cliff: the counts of adjacent steps stop being
    // comparable, which is how shop_open (0.5) vs shop_buy (1.0) showed double the real conversion.
    const text = fs.readFileSync(DEFS, 'utf8');
    for (const event of [
      'session_start', 'session_end', 'churn_signal', 'nav_checkpoint',
      'intro_complete', 'intro_skip', 'tutorial_start', 'tutorial_complete', 'tutorial_step',
      'game_start', 'level_attempt', 'level_complete', 'level_abandon',
      'shop_open', 'shop_buy', 'shop_close', 'iap_purchase',
      'login_submit', 'login_ok', 'login_fail', 'login_skip',
    ]) {
      const m = text.match(new RegExp(`^\\s{4}${event}:\\s*\\{([^}]*)\\}`, 'm'));
      expect(m, `${event} missing from DEFAULT_CONFIG`).toBeTruthy();
      expect(m![1], `${event} must be sample: 1.0`).toContain('sample: 1.0');
    }
  });
});
