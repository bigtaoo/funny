// Card builders for pages/analytics.ts (ADR-070 Phase 4e treatment, extended 2026-09-24 when
// analytics.ts hit the 500-line gate): each function takes rows already shaped by logic/analytics.ts
// and returns the finished `<div class="card">` element, or null when there is nothing to show — the
// same "hide, don't show empty" rule pageAnalytics already applies to every other section. Kept out of
// pages/analytics.ts (rather than folded into logic/analytics.ts) because these build DOM, not data.
import { h } from '../dom';
import {
  badgeModes, badgePivot, barWidthPx, type BadgeRow, type BootFunnelDisplayRow,
  LOAD_TIME_PHASE_LABELS, type LoadTimeDisplayRow, type ShareRow, type StepFunnelRow,
} from '../logic/analytics';
import { pct } from '../logic/shared';

/** A proportional bar plus its percentage, from a ratio already computed in the logic layer. */
export function bar(ratio: number): HTMLElement {
  const el = h('div', {
    style: `display:inline-block;width:${barWidthPx(ratio)}px;height:8px;background:#2f5fcf;vertical-align:middle;border-radius:2px`,
  });
  return h('span', {}, el, ` ${pct(ratio)}`);
}

/** `label | count | bar` card — the six single-dimension tables (five *_dist payloads + login hour). */
export function shareCard(
  caption: string,
  labelHeader: string,
  valueHeader: string,
  rows: readonly ShareRow[],
  shareHeader = 'Share',
  labelStyle?: string,
): HTMLElement {
  const t = h('table', {},
    h('tr', {}, h('th', {}, labelHeader), h('th', { style: 'text-align:right' }, valueHeader), h('th', {}, shareHeader)),
  );
  for (const r of rows) {
    t.append(h('tr', {},
      h('td', labelStyle ? { style: labelStyle } : {}, r.label),
      h('td', { style: 'text-align:right' }, String(r.value)),
      h('td', {}, bar(r.share)),
    ));
  }
  return h('div', { class: 'card' }, h('div', { class: 'muted' }, caption), t);
}

/** Shared renderer for cohort step-funnels (onboarding / tutorial / scene) — table + conversion bar per step. */
export function stepFunnelCard(title: string, rows: StepFunnelRow[]): HTMLElement {
  const t = h('table', {},
    h('tr', {},
      h('th', {}, 'Step'),
      h('th', { style: 'text-align:right' }, 'Reached'),
      h('th', { style: 'text-align:right' }, 'Step conv.'),
      h('th', { style: 'text-align:right' }, 'Of cohort'),
      h('th', {}, ''),
    ),
  );
  for (const r of rows) {
    t.append(h('tr', {},
      h('td', {}, r.label),
      h('td', { style: 'text-align:right' }, String(r.count)),
      h('td', { style: 'text-align:right' }, r.stepRate !== undefined ? pct(r.stepRate) : '—'),
      h('td', { style: 'text-align:right' }, pct(r.ofCohort)),
      h('td', {}, bar(r.ofCohort)),
    ));
  }
  return h('div', { class: 'card' }, h('div', { class: 'muted' }, title), t);
}

// Launch funnel (ANALYTICS_DESIGN §3.6b). The only card on this page whose denominator is not an
// analytics event: `Launches` is the unauthenticated counter on GET /analytics/config, which
// every client hits before the age and consent gates. `Lost` is therefore the one measurement of
// the players who open the game and leave without a single event being recorded about them —
// every other card on this page starts counting at session_start and cannot see them at all.
// `Declined` is carved out of that gap (§3.6c): those players did answer and did stay — they
// just refused telemetry — and leaving them inside `Lost` made the gate bounce look worse than
// it is, in a way that grows with every refusal the game keeps.
export function launchFunnelCard(launches: BootFunnelDisplayRow[], days: number): HTMLElement | null {
  if (!launches.length) return null;
  const t = h('table', {},
    h('tr', {},
      h('th', {}, 'Date'),
      h('th', {}, 'Platform'),
      h('th', { style: 'text-align:right' }, 'Launches'),
      h('th', { style: 'text-align:right' }, 'Sessions'),
      h('th', { style: 'text-align:right', title: 'Launches by players who chose "essentials only" — they are playing, they just report nothing (ANALYTICS_DESIGN §3.6c)' }, 'Declined'),
      h('th', { style: 'text-align:right', title: 'Launches that never reported anything and were not refusals — left at the age or consent gate' }, 'Lost'),
      h('th', { style: 'text-align:right', title: 'gdpr_consent — first-time acceptances' }, 'Consents'),
      // `bar()` prints the percentage next to the bar, so this column needs no separate pct cell.
      h('th', {}, 'Reached'),
    ),
  );
  for (const r of launches) {
    t.append(h('tr', {},
      h('td', {}, r.date),
      h('td', {}, r.platform),
      h('td', { style: 'text-align:right' }, String(r.boots)),
      h('td', { style: 'text-align:right' }, String(r.sessions)),
      h('td', { style: 'text-align:right' }, String(r.declinedCount)),
      h('td', { style: 'text-align:right' }, String(r.lost)),
      h('td', { style: 'text-align:right' }, String(r.consents)),
      h('td', {}, bar(r.reachRate)),
    ));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'muted' }, `Launch funnel — launches vs sessions that reported anything (last ${days} days)`),
    t,
  );
}

// Load time (ANALYTICS_DESIGN §5.1b). Percentiles, not averages: startup is long-tailed and a
// mean describes nobody. `Gave up` counts sessions that emitted `boot` and never `load_time`.
export function loadTimeCard(loads: LoadTimeDisplayRow[], days: number): HTMLElement | null {
  if (!loads.length) return null;
  const t = h('table', {},
    h('tr', {},
      h('th', {}, 'Platform'),
      h('th', { style: 'text-align:right' }, 'Launches'),
      h('th', { style: 'text-align:right' }, 'p50'),
      h('th', { style: 'text-align:right' }, 'p75'),
      h('th', { style: 'text-align:right' }, 'p90'),
      h('th', { style: 'text-align:right' }, 'p95'),
      ...LOAD_TIME_PHASE_LABELS.map((p) => h('th', { style: 'text-align:right', title: p.title }, p.label)),
      h('th', { style: 'text-align:right', title: 'Sessions that started loading and closed the page before the first screen' }, 'Gave up'),
    ),
  );
  for (const r of loads) {
    t.append(h('tr', {},
      h('td', {}, r.platform),
      h('td', { style: 'text-align:right' }, String(r.samples)),
      h('td', { style: 'text-align:right' }, ms(r.p50_ms)),
      h('td', { style: 'text-align:right' }, ms(r.p75_ms)),
      h('td', { style: 'text-align:right' }, ms(r.p90_ms)),
      h('td', { style: 'text-align:right' }, ms(r.p95_ms)),
      ...r.phases.map((v) => h('td', { style: 'text-align:right' }, ms(v))),
      h('td', { style: 'text-align:right' }, r.abandoned > 0 ? `${r.abandoned} (${pct(r.abandonRate)})` : '0'),
    ));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'muted' }, `Load time — total percentiles and the mean of each phase (last ${days} days)`),
    t,
  );
}

/** ms as a player would say it: `820ms` under a second, `3.4s` above. Local copy — logic/analytics.ts's
 *  `ms`/`sec` are display formatting, not data shaping, and this is the only file that renders them. */
function ms(v: number | undefined): string {
  if (v === undefined) return '—';
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`;
}

function sec(v: number): string {
  return v < 60 ? `${Math.round(v)}s` : `${(v / 60).toFixed(1)}m`;
}

export interface SessionDurationDisplayRow {
  platform: string;
  samples: number;
  p50_sec: number;
  p75_sec: number;
  p90_sec: number;
  p95_sec: number;
}

// Session-length distribution (RETENTION_LAUNCH_PLAN.md §2 supplementary query): percentiles of
// `sessions.duration_sec`, same shape as the load-time card above but for how long the session
// itself lasted once it got going, not how long it took to start.
export function sessionDurationCard(durations: SessionDurationDisplayRow[], days: number): HTMLElement | null {
  if (!durations.length) return null;
  const t = h('table', {},
    h('tr', {},
      h('th', {}, 'Platform'),
      h('th', { style: 'text-align:right' }, 'Sessions'),
      h('th', { style: 'text-align:right' }, 'p50'),
      h('th', { style: 'text-align:right' }, 'p75'),
      h('th', { style: 'text-align:right' }, 'p90'),
      h('th', { style: 'text-align:right' }, 'p95'),
    ),
  );
  for (const r of durations) {
    t.append(h('tr', {},
      h('td', {}, r.platform),
      h('td', { style: 'text-align:right' }, String(r.samples)),
      h('td', { style: 'text-align:right' }, sec(r.p50_sec)),
      h('td', { style: 'text-align:right' }, sec(r.p75_sec)),
      h('td', { style: 'text-align:right' }, sec(r.p90_sec)),
      h('td', { style: 'text-align:right' }, sec(r.p95_sec)),
    ));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'muted' }, `Session length — how long a session lasted once it started (last ${days} days)`),
    t,
  );
}

export interface LevelFunnelDisplayRow {
  level_id: string;
  attempts: number;
  completes: number;
  abandons: number;
  completion_rate?: number;
}

// Level funnel — which specific level players get stuck on / quit (A9-9)
export function levelFunnelCard(levels: LevelFunnelDisplayRow[], days: number): HTMLElement | null {
  if (!levels.length) return null;
  const t = h('table', {},
    h('tr', {},
      h('th', {}, 'Level'),
      h('th', { style: 'text-align:right' }, 'Attempts'),
      h('th', { style: 'text-align:right' }, 'Completes'),
      h('th', { style: 'text-align:right' }, 'Abandons'),
      h('th', { style: 'text-align:right' }, 'Completion'),
      h('th', {}, ''),
    ),
  );
  for (const r of levels) {
    t.append(h('tr', {},
      h('td', {}, r.level_id),
      h('td', { style: 'text-align:right' }, String(r.attempts)),
      h('td', { style: 'text-align:right' }, String(r.completes)),
      h('td', { style: 'text-align:right' }, String(r.abandons)),
      h('td', { style: 'text-align:right' }, r.completion_rate !== undefined ? pct(r.completion_rate) : '—'),
      h('td', {}, bar(r.completion_rate ?? 0)),
    ));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'muted' }, `Level funnel — 20 levels with the lowest completion rate (last ${days} days)`),
    t,
  );
}

export interface FeatureGuideDisplayRow {
  feature: string;
  shown: number;
  closed: number;
  replays: number;
  close_rate?: number;
}

// First-time feature-guide funnel (design-doc-audit-2026-07) — shown/closed/replay per feature.
// "replays" stays 0 for every row until the per-page "?" re-open button is wired (ONBOARDING_DESIGN §8/§10).
export function featureGuideCard(guides: FeatureGuideDisplayRow[], days: number): HTMLElement | null {
  if (!guides.length) return null;
  const t = h('table', {},
    h('tr', {},
      h('th', {}, 'Feature'),
      h('th', { style: 'text-align:right' }, 'Shown'),
      h('th', { style: 'text-align:right' }, 'Closed'),
      h('th', { style: 'text-align:right' }, 'Replays'),
      h('th', { style: 'text-align:right' }, 'Close rate'),
      h('th', {}, ''),
    ),
  );
  for (const r of guides) {
    t.append(h('tr', {},
      h('td', {}, r.feature),
      h('td', { style: 'text-align:right' }, String(r.shown)),
      h('td', { style: 'text-align:right' }, String(r.closed)),
      h('td', { style: 'text-align:right' }, String(r.replays)),
      h('td', { style: 'text-align:right' }, r.close_rate !== undefined ? pct(r.close_rate) : '—'),
      h('td', {}, bar(r.close_rate ?? 0)),
    ));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'muted' }, `First-time feature guide — shown/closed/replay per feature (last ${days} days)`),
    t,
  );
}

// Post-match badge/title distribution (ANALYTICS_DESIGN §5.8) — per mode, which "hero" badge
// players actually get. A single badge with a near-100% share = the calibration is degenerate
// (everyone gets the same title). One pivot table per mode: badge rows × win/loss/draw + total.
export function badgeDistCards(badges: BadgeRow[], days: number): HTMLElement[] {
  return badgeModes(badges).map((mode) => {
    const pivot = badgePivot(badges, mode);
    const t = h('table', {},
      h('tr', {},
        h('th', {}, 'Hero badge'),
        ...pivot.results.map((rr) => h('th', { style: 'text-align:right' }, rr)),
        h('th', { style: 'text-align:right' }, 'Total'),
        h('th', {}, 'Share'),
      ),
    );
    for (const b of pivot.badges) {
      t.append(h('tr', {},
        h('td', {}, b.badge),
        ...b.counts.map((n) => h('td', { style: 'text-align:right' }, String(n))),
        h('td', { style: 'text-align:right' }, String(b.total)),
        h('td', {}, bar(b.share)),
      ));
    }
    return h('div', { class: 'card' },
      h('div', { class: 'muted' }, `Result badge distribution — ${mode} (${pivot.grandTotal} matches, last ${days} days; one badge near 100% = miscalibrated)`),
      t,
    );
  });
}
