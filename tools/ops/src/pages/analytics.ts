// Analytics page (OPS_DESIGN §7): monitoring overview + DAU/retention/region/OS/login-hour/funnel/event-count.
//
// DOM assembly only — every pivot, share and "does this section have data" test lives in
// src/logic/analytics.ts (ADR-070 Phase 4e). The five `*_dist` sections used to be five verbatim
// copies of the same table-building block; they are now five calls to `distributionCard` over
// `distribution()`, which is what pulling the arithmetic out made visible.
import { clear, h, pill } from '../dom';
import {
  analyticsUnavailable, badgeModes, badgePivot, barRatio, barWidthPx, distribution, eventCountGrid,
  funnelPivot, funnelPlatforms, levelFunnelRows, loginHourRows, metricRows, ONBOARDING_LABELS,
  retentionCell, RETENTION_OFFSETS, retentionRows, sectionRows, sectionValue, type ShareRow,
  stepFunnelRows, TUTORIAL_LABELS,
} from '../logic/analytics';
import { pct } from '../logic/shared';
import { showErr, sparkline, type Ctx } from './shared';

export async function pageAnalytics(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Analytics'));
  const err = h('div', { class: 'err' });
  const body = h('div', {});
  const daysSel = h('select', { style: 'margin-left:8px' },
    h('option', { value: '1' }, 'Today'),
    h('option', { value: '7', selected: 'selected' }, 'Last 7 days'),
    h('option', { value: '30' }, 'Last 30 days'),
  ) as HTMLSelectElement;
  const refreshBtn = h('button', { class: 'ghost' }, 'Refresh');

  root.append(
    h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Time range'), daysSel, refreshBtn),
    body,
    err,
  );

  const reload = async (): Promise<void> => {
    err.textContent = '';
    clear(body);
    const days = Number(daysSel.value);

    const [
      summary, evCounts, dau, funnel, regions, osDist, loginHour, retention, firstSession,
      levelFunnel, tutorialFunnel, sceneFunnel, featureGuideFunnel, browserDist, deviceTypeDist, geoDist, badgeDist,
    ] = await Promise.allSettled([
      api.analyticsSummary(),
      api.analyticsEvents('event_counts', days),
      api.analyticsEvents('dau', days),
      api.analyticsEvents('funnel', days),
      api.analyticsEvents('region_dist', days),
      api.analyticsEvents('os_dist', days),
      api.analyticsEvents('login_hour', days),
      api.analyticsEvents('retention', days),
      api.analyticsEvents('first_session', days),
      api.analyticsEvents('level_funnel', days),
      api.analyticsEvents('tutorial_funnel', days),
      api.analyticsEvents('scene_funnel', days),
      api.analyticsEvents('feature_guide_funnel', days),
      api.analyticsEvents('browser_dist', days),
      api.analyticsEvents('device_type_dist', days),
      api.analyticsEvents('geo_dist', days),
      api.analyticsEvents('badge_dist', days),
    ]);

    // Monitoring overview (self-collected metrics + tickets)
    if (summary.status === 'fulfilled') {
      const s = summary.value;
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Metric'), h('th', {}, '24h avg'), h('th', {}, '24h peak'), h('th', {}, 'Samples')));
      for (const m of metricRows(s.last24h)) {
        t.append(h('tr', {}, h('td', {}, m.key), h('td', {}, m.avg), h('td', {}, String(m.peak)), h('td', {}, String(m.samples))));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Self-collected metrics (last 24h)'), t));

      const tk = h('table', {}, h('tr', {}, h('th', {}, 'Ticket status'), h('th', {}, 'Count')));
      for (const [k, v] of Object.entries(s.tickets)) {
        tk.append(h('tr', {}, h('td', {}, pill(k, k)), h('td', {}, String(v))));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Compensation tickets overview'), tk));
    }

    // Analytics service unavailable notice (shown at most once)
    if (analyticsUnavailable(evCounts)) {
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Analytics service not configured (NW_ANALYTICS_BASE_URL)')));
      return;
    }

    // DAU trend
    const dauPts = sectionRows(dau, (v) => v.dau);
    if (dauPts.length) {
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'DAU (daily active devices)')));
      for (const p of dauPts) t.append(h('tr', {}, h('td', {}, p.date), h('td', { style: 'text-align:right' }, String(p.dau))));
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `DAU trend (last ${days} days)`), sparkline(dauPts.map((p) => p.dau)), t));
    }

    // D1–D7 retention
    const cohorts = retentionRows(sectionRows(retention, (v) => v.retention));
    if (cohorts.length > 0) {
      const t = h('table', {},
        h('tr', {},
          h('th', {}, 'Date'),
          h('th', { style: 'text-align:right' }, 'Cohort'),
          ...RETENTION_OFFSETS.map((n) => h('th', { style: 'text-align:right' }, `D${n}%`)),
        ),
      );
      for (const r of cohorts) {
        t.append(h('tr', {},
          h('td', {}, r.date),
          h('td', { style: 'text-align:right' }, String(r.cohort_size)),
          // Cell shows the rate; hover reveals the returning device count.
          ...RETENTION_OFFSETS.map((n) => {
            const c = retentionCell(r, n);
            return h('td', { style: 'text-align:right', title: c.title }, c.text);
          }),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Retention cohorts (last ${days} days, D1–D7 return, — = insufficient data)`), t));
    }

    // First-session onboarding funnel + action breakdown (new users only)
    const fs = sectionValue(firstSession, (v) => v.first_session);
    if (fs && fs.cohort_size > 0) {
      body.append(stepFunnelCard(
        `Onboarding funnel — new users' first session (${fs.cohort_size} new devices, last ${days} days)`,
        stepFunnelRows(fs.funnel, fs.cohort_size, ONBOARDING_LABELS),
      ));

      // First-session action / scene breakdown
      if (fs.actions.length > 0) {
        const at = h('table', {},
          h('tr', {}, h('th', {}, 'Scene / action'), h('th', {}, 'Type'), h('th', { style: 'text-align:right' }, 'Users'), h('th', {}, 'Reach')),
        );
        for (const a of fs.actions) {
          at.append(h('tr', {},
            h('td', {}, a.key),
            h('td', {}, pill(a.kind, a.kind)),
            h('td', { style: 'text-align:right' }, String(a.devices)),
            h('td', {}, bar(barRatio(a.devices, fs.cohort_size))),
          ));
        }
        body.append(h('div', { class: 'card' },
          h('div', { class: 'muted' }, `First-session activity — which scenes & actions new users hit (share of ${fs.cohort_size} new devices; scene rows are screen_view-sampled, so under-counted)`),
          at,
        ));
      }
    }

    // Tutorial step-level funnel — where inside the tutorial new players quit (A9-9)
    const tf = sectionValue(tutorialFunnel, (v) => v.tutorial_funnel);
    if (tf && tf.cohort_size > 0) {
      body.append(stepFunnelCard(
        `Tutorial step funnel — where players quit inside the tutorial (${tf.cohort_size} sessions, last ${days} days)`,
        stepFunnelRows(tf.funnel, tf.cohort_size, TUTORIAL_LABELS),
      ));
    }

    // Scene/page-level funnel — login → intro/tutorial gate → lobby → pick level → prep → battle (A9-9)
    const sf = sectionValue(sceneFunnel, (v) => v.scene_funnel);
    if (sf && sf.cohort_size > 0) {
      body.append(stepFunnelCard(
        `Scene funnel — core new-user navigation path (${sf.cohort_size} sessions, last ${days} days)`,
        stepFunnelRows(sf.funnel, sf.cohort_size),
      ));
    }

    // Level funnel — which specific level players get stuck on / quit (A9-9)
    const levels = levelFunnelRows(sectionRows(levelFunnel, (v) => v.level_funnel));
    if (levels.length) {
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
      body.append(h('div', { class: 'card' },
        h('div', { class: 'muted' }, `Level funnel — 20 levels with the lowest completion rate (last ${days} days)`),
        t,
      ));
    }

    // First-time feature-guide funnel (design-doc-audit-2026-07) — shown/closed/replay per feature.
    // "replays" stays 0 for every row until the per-page "?" re-open button is wired (ONBOARDING_DESIGN §8/§10).
    const guides = sectionRows(featureGuideFunnel, (v) => v.feature_guide_funnel);
    if (guides.length) {
      const t2 = h('table', {},
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
        t2.append(h('tr', {},
          h('td', {}, r.feature),
          h('td', { style: 'text-align:right' }, String(r.shown)),
          h('td', { style: 'text-align:right' }, String(r.closed)),
          h('td', { style: 'text-align:right' }, String(r.replays)),
          h('td', { style: 'text-align:right' }, r.close_rate !== undefined ? pct(r.close_rate) : '—'),
          h('td', {}, bar(r.close_rate ?? 0)),
        ));
      }
      body.append(h('div', { class: 'card' },
        h('div', { class: 'muted' }, `First-time feature guide — shown/closed/replay per feature (last ${days} days)`),
        t2,
      ));
    }

    // Post-match badge/title distribution (ANALYTICS_DESIGN §5.8) — per mode, which "hero" badge
    // players actually get. A single badge with a near-100% share = the calibration is degenerate
    // (everyone gets the same title). One pivot table per mode: badge rows × win/loss/draw + total.
    const badges = sectionRows(badgeDist, (v) => v.badge_dist);
    for (const mode of badgeModes(badges)) {
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
      body.append(h('div', { class: 'card' },
        h('div', { class: 'muted' }, `Result badge distribution — ${mode} (${pivot.grandTotal} matches, last ${days} days; one badge near 100% = miscalibrated)`),
        t,
      ));
    }

    // The five share tables. Locale is a language code, not a place — Geo below is the actual country,
    // server-derived from the request IP via geoip-lite (A9-9); raw IPs are never stored.
    const shareTables: [ShareRow[], string, string][] = [
      [distribution(sectionRows(regions, (v) => v.region_dist), 'locale'), 'Locale', `Locale distribution (last ${days} days)`],
      [distribution(sectionRows(geoDist, (v) => v.geo_dist), 'country'), 'Country', `Geo (country) distribution (last ${days} days, IP-derived)`],
      [distribution(sectionRows(osDist, (v) => v.os_dist), 'os'), 'OS', `OS distribution (last ${days} days, session_start)`],
      [distribution(sectionRows(browserDist, (v) => v.browser_dist), 'browser'), 'Browser', `Browser distribution (last ${days} days, session_start)`],
      [distribution(sectionRows(deviceTypeDist, (v) => v.device_type_dist), 'device_type'), 'Device type', `Device type distribution (last ${days} days, session_start)`],
    ];
    for (const [rows, header, caption] of shareTables) {
      if (rows.length) body.append(shareCard(caption, header, 'Devices', rows));
    }

    // Login time distribution (UTC) — same three columns, but each bar is scaled against the busiest
    // hour rather than the total, so this one is a shape and not a share.
    const hours = loginHourRows(sectionRows(loginHour, (v) => v.login_hour));
    if (hours.length) {
      body.append(shareCard(`Login hour distribution (last ${days} days, session_start)`, 'Hour (UTC)', 'Sessions', hours, 'Distribution', 'font-variant-numeric:tabular-nums'));
    }

    // Funnel conversion
    const funnelRows = sectionRows(funnel, (v) => v.funnel);
    for (const plat of funnelPlatforms(funnelRows)) {
      const { latestDate, cells } = funnelPivot(funnelRows, plat);
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Funnel step'), h('th', {}, 'Count'), h('th', {}, 'Conversion rate')));
      for (const c of cells) {
        t.append(h('tr', {},
          h('td', {}, c.step),
          h('td', { style: 'text-align:right' }, c.count !== undefined ? String(c.count) : '—'),
          h('td', { style: 'text-align:right' }, c.rate !== undefined ? pct(c.rate) : '—'),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Conversion funnel (${plat}, ${latestDate})`), t));
    }

    // Event count detail
    const evRows = sectionRows(evCounts, (v) => v.event_counts);
    if (evRows.length) {
      const { events, dates, grid } = eventCountGrid(evRows);
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Date'), ...events.map((e) => h('th', {}, e))));
      dates.forEach((date, di) => {
        t.append(h('tr', {}, h('td', {}, date), ...grid[di]!.map((n) => h('td', { style: 'text-align:right' }, String(n)))));
      });
      body.append(h('div', { class: 'card', style: 'overflow-x:auto' }, h('div', { class: 'muted' }, `Event counts (last ${days} days)`), t));
    }

    if (evCounts.status === 'rejected') showErr(err, evCounts.reason);
  };

  refreshBtn.addEventListener('click', () => void reload());
  daysSel.addEventListener('change', () => void reload());
  await reload();
}

/** Shared renderer for cohort step-funnels (onboarding / tutorial / scene) — table + conversion bar per step. */
function stepFunnelCard(title: string, rows: ReturnType<typeof stepFunnelRows>): HTMLElement {
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

/** `label | count | bar` card — the six single-dimension tables (five *_dist payloads + login hour). */
function shareCard(
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

/** A proportional bar plus its percentage, from a ratio already computed in the logic layer. */
function bar(ratio: number): HTMLElement {
  const el = h('div', {
    style: `display:inline-block;width:${barWidthPx(ratio)}px;height:8px;background:#2f5fcf;vertical-align:middle;border-radius:2px`,
  });
  return h('span', {}, el, ` ${pct(ratio)}`);
}
