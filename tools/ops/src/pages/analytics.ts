// Analytics page (OPS_DESIGN §7): monitoring overview + DAU/retention/region/OS/login-hour/funnel/event-count.
import { clear, h, pill } from '../dom';
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
      levelFunnel, tutorialFunnel, sceneFunnel, browserDist, deviceTypeDist, geoDist, badgeDist,
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
      api.analyticsEvents('browser_dist', days),
      api.analyticsEvents('device_type_dist', days),
      api.analyticsEvents('geo_dist', days),
      api.analyticsEvents('badge_dist', days),
    ]);

    // Monitoring overview (self-collected metrics + tickets)
    if (summary.status === 'fulfilled') {
      const s = summary.value;
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Metric'), h('th', {}, '24h avg'), h('th', {}, '24h peak'), h('th', {}, 'Samples')));
      for (const [k, v] of Object.entries(s.last24h)) {
        t.append(h('tr', {}, h('td', {}, k), h('td', {}, v.avg.toFixed(1)), h('td', {}, String(v.peak)), h('td', {}, String(v.samples))));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Self-collected metrics (last 24h)'), t));

      const tk = h('table', {}, h('tr', {}, h('th', {}, 'Ticket status'), h('th', {}, 'Count')));
      for (const [k, v] of Object.entries(s.tickets)) {
        tk.append(h('tr', {}, h('td', {}, pill(k, k)), h('td', {}, String(v))));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Compensation tickets overview'), tk));
    }

    // Analytics service unavailable notice (shown at most once)
    const analyticsUnavailable =
      evCounts.status === 'fulfilled' && !evCounts.value.available;
    if (analyticsUnavailable) {
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Analytics service not configured (NW_ANALYTICS_BASE_URL)')));
      return;
    }

    // DAU trend
    if (dau.status === 'fulfilled' && dau.value.available && dau.value.dau?.length) {
      const pts = dau.value.dau;
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'DAU (daily active devices)')));
      for (const p of pts) t.append(h('tr', {}, h('td', {}, p.date), h('td', { style: 'text-align:right' }, String(p.dau))));
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `DAU trend (last ${days} days)`), sparkline(pts.map((p) => p.dau)), t));
    }

    // D1–D7 retention
    if (retention.status === 'fulfilled' && retention.value.available && retention.value.retention?.length) {
      const rows = retention.value.retention.filter((r) => r.cohort_size > 0);
      if (rows.length > 0) {
        const offsets = [1, 2, 3, 4, 5, 6, 7] as const;
        const t = h('table', {},
          h('tr', {},
            h('th', {}, 'Date'),
            h('th', { style: 'text-align:right' }, 'Cohort'),
            ...offsets.map((n) => h('th', { style: 'text-align:right' }, `D${n}%`)),
          ),
        );
        for (const r of rows) {
          t.append(h('tr', {},
            h('td', {}, r.date),
            h('td', { style: 'text-align:right' }, String(r.cohort_size)),
            ...offsets.map((n) => {
              const rate = r.d_rate?.[n];
              const count = r.d?.[n];
              // Show rate; hover reveals returning device count.
              return h('td', { style: 'text-align:right', title: count !== undefined ? `${count} devices` : 'insufficient data' },
                rate !== undefined ? pct(rate) : '—');
            }),
          ));
        }
        body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Retention cohorts (last ${days} days, D1–D7 return, — = insufficient data)`), t));
      }
    }

    // First-session onboarding funnel + action breakdown (new users only)
    if (firstSession.status === 'fulfilled' && firstSession.value.available && firstSession.value.first_session) {
      const fs = firstSession.value.first_session;
      if (fs.cohort_size > 0) {
        body.append(renderStepFunnel(
          `Onboarding funnel — new users' first session (${fs.cohort_size} new devices, last ${days} days)`,
          fs.funnel, fs.cohort_size, ONBOARDING_LABELS,
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
              h('td', {}, barCell(a.devices, fs.cohort_size)),
            ));
          }
          body.append(h('div', { class: 'card' },
            h('div', { class: 'muted' }, `First-session activity — which scenes & actions new users hit (share of ${fs.cohort_size} new devices; scene rows are screen_view-sampled, so under-counted)`),
            at,
          ));
        }
      }
    }

    // Tutorial step-level funnel — where inside the tutorial new players quit (A9-9)
    if (tutorialFunnel.status === 'fulfilled' && tutorialFunnel.value.available && tutorialFunnel.value.tutorial_funnel) {
      const tf = tutorialFunnel.value.tutorial_funnel;
      if (tf.cohort_size > 0) {
        body.append(renderStepFunnel(
          `Tutorial step funnel — where players quit inside the tutorial (${tf.cohort_size} sessions, last ${days} days)`,
          tf.funnel, tf.cohort_size, TUTORIAL_LABELS,
        ));
      }
    }

    // Scene/page-level funnel — login → intro/tutorial gate → lobby → pick level → prep → battle (A9-9)
    if (sceneFunnel.status === 'fulfilled' && sceneFunnel.value.available && sceneFunnel.value.scene_funnel) {
      const sf = sceneFunnel.value.scene_funnel;
      if (sf.cohort_size > 0) {
        body.append(renderStepFunnel(
          `Scene funnel — core new-user navigation path (${sf.cohort_size} sessions, last ${days} days)`,
          sf.funnel, sf.cohort_size,
        ));
      }
    }

    // Level funnel — which specific level players get stuck on / quit (A9-9)
    if (levelFunnel.status === 'fulfilled' && levelFunnel.value.available && levelFunnel.value.level_funnel?.length) {
      const rows = levelFunnel.value.level_funnel.slice(0, 20); // worst completion rate first; cap the list, see caption
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
      for (const r of rows) {
        t.append(h('tr', {},
          h('td', {}, r.level_id),
          h('td', { style: 'text-align:right' }, String(r.attempts)),
          h('td', { style: 'text-align:right' }, String(r.completes)),
          h('td', { style: 'text-align:right' }, String(r.abandons)),
          h('td', { style: 'text-align:right' }, r.completion_rate !== undefined ? pct(r.completion_rate) : '—'),
          h('td', {}, barCell(r.completion_rate ?? 0, 1)),
        ));
      }
      body.append(h('div', { class: 'card' },
        h('div', { class: 'muted' }, `Level funnel — 20 levels with the lowest completion rate (last ${days} days)`),
        t,
      ));
    }

    // Post-match badge/title distribution (ANALYTICS_DESIGN §5.8) — per mode, which "hero" badge
    // players actually get. A single badge with a near-100% share = the calibration is degenerate
    // (everyone gets the same title). One pivot table per mode: badge rows × win/loss/draw + total.
    if (badgeDist.status === 'fulfilled' && badgeDist.value.available && badgeDist.value.badge_dist?.length) {
      const rows = badgeDist.value.badge_dist;
      const modes = [...new Set(rows.map((r) => r.mode))].sort();
      const resultsOrder = ['win', 'loss', 'draw'];
      for (const mode of modes) {
        const modeRows = rows.filter((r) => r.mode === mode);
        const results = resultsOrder.filter((rr) => modeRows.some((r) => r.result === rr))
          .concat([...new Set(modeRows.map((r) => r.result))].filter((rr) => !resultsOrder.includes(rr)));
        const badges = [...new Set(modeRows.map((r) => r.badge))];
        const cell = new Map(modeRows.map((r) => [`${r.badge}:${r.result}`, r.count]));
        const badgeTotal = (b: string) => results.reduce((s, rr) => s + (cell.get(`${b}:${rr}`) ?? 0), 0);
        badges.sort((a, b) => badgeTotal(b) - badgeTotal(a));
        const grandTotal = badges.reduce((s, b) => s + badgeTotal(b), 0);

        const t = h('table', {},
          h('tr', {},
            h('th', {}, 'Hero badge'),
            ...results.map((rr) => h('th', { style: 'text-align:right' }, rr)),
            h('th', { style: 'text-align:right' }, 'Total'),
            h('th', {}, 'Share'),
          ),
        );
        for (const b of badges) {
          const tot = badgeTotal(b);
          t.append(h('tr', {},
            h('td', {}, b),
            ...results.map((rr) => h('td', { style: 'text-align:right' }, String(cell.get(`${b}:${rr}`) ?? 0))),
            h('td', { style: 'text-align:right' }, String(tot)),
            h('td', {}, barCell(tot, grandTotal)),
          ));
        }
        body.append(h('div', { class: 'card' },
          h('div', { class: 'muted' }, `Result badge distribution — ${mode} (${grandTotal} matches, last ${days} days; one badge near 100% = miscalibrated)`),
          t,
        ));
      }
    }

    // Locale distribution (this is a language code, not a geographic region — see Geo distribution below for actual country)
    if (regions.status === 'fulfilled' && regions.value.available && regions.value.region_dist?.length) {
      const rows = regions.value.region_dist;
      const total = rows.reduce((s, r) => s + r.devices, 0);
      const t = h('table', {},
        h('tr', {}, h('th', {}, 'Locale'), h('th', { style: 'text-align:right' }, 'Devices'), h('th', {}, 'Share')),
      );
      for (const r of rows) {
        t.append(h('tr', {},
          h('td', {}, r.locale),
          h('td', { style: 'text-align:right' }, String(r.devices)),
          h('td', {}, barCell(r.devices, total)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Locale distribution (last ${days} days)`), t));
    }

    // Geo (country) distribution — server-derived from request IP via geoip-lite (A9-9); raw IPs are never stored
    if (geoDist.status === 'fulfilled' && geoDist.value.available && geoDist.value.geo_dist?.length) {
      const rows = geoDist.value.geo_dist;
      const total = rows.reduce((s, r) => s + r.devices, 0);
      const t = h('table', {},
        h('tr', {}, h('th', {}, 'Country'), h('th', { style: 'text-align:right' }, 'Devices'), h('th', {}, 'Share')),
      );
      for (const r of rows) {
        t.append(h('tr', {},
          h('td', {}, r.country),
          h('td', { style: 'text-align:right' }, String(r.devices)),
          h('td', {}, barCell(r.devices, total)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Geo (country) distribution (last ${days} days, IP-derived)`), t));
    }

    // Device/OS distribution
    if (osDist.status === 'fulfilled' && osDist.value.available && osDist.value.os_dist?.length) {
      const rows = osDist.value.os_dist;
      const total = rows.reduce((s, r) => s + r.devices, 0);
      const t = h('table', {},
        h('tr', {}, h('th', {}, 'OS'), h('th', { style: 'text-align:right' }, 'Devices'), h('th', {}, 'Share')),
      );
      for (const r of rows) {
        t.append(h('tr', {},
          h('td', {}, r.os),
          h('td', { style: 'text-align:right' }, String(r.devices)),
          h('td', {}, barCell(r.devices, total)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `OS distribution (last ${days} days, session_start)`), t));
    }

    // Browser distribution (server-derived from UA at ingest, A9-9)
    if (browserDist.status === 'fulfilled' && browserDist.value.available && browserDist.value.browser_dist?.length) {
      const rows = browserDist.value.browser_dist;
      const total = rows.reduce((s, r) => s + r.devices, 0);
      const t = h('table', {},
        h('tr', {}, h('th', {}, 'Browser'), h('th', { style: 'text-align:right' }, 'Devices'), h('th', {}, 'Share')),
      );
      for (const r of rows) {
        t.append(h('tr', {},
          h('td', {}, r.browser),
          h('td', { style: 'text-align:right' }, String(r.devices)),
          h('td', {}, barCell(r.devices, total)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Browser distribution (last ${days} days, session_start)`), t));
    }

    // Device-type distribution: mobile / tablet / desktop (server-derived from UA at ingest, A9-9)
    if (deviceTypeDist.status === 'fulfilled' && deviceTypeDist.value.available && deviceTypeDist.value.device_type_dist?.length) {
      const rows = deviceTypeDist.value.device_type_dist;
      const total = rows.reduce((s, r) => s + r.devices, 0);
      const t = h('table', {},
        h('tr', {}, h('th', {}, 'Device type'), h('th', { style: 'text-align:right' }, 'Devices'), h('th', {}, 'Share')),
      );
      for (const r of rows) {
        t.append(h('tr', {},
          h('td', {}, r.device_type),
          h('td', { style: 'text-align:right' }, String(r.devices)),
          h('td', {}, barCell(r.devices, total)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Device type distribution (last ${days} days, session_start)`), t));
    }

    // Login time distribution (UTC)
    if (loginHour.status === 'fulfilled' && loginHour.value.available && loginHour.value.login_hour?.length) {
      const rows = loginHour.value.login_hour;
      const maxCount = Math.max(1, ...rows.map((r) => r.count));
      const t = h('table', {},
        h('tr', {}, h('th', {}, 'Hour (UTC)'), h('th', { style: 'text-align:right' }, 'Sessions'), h('th', {}, 'Distribution')),
      );
      for (const r of rows) {
        const label = `${String(r.hour).padStart(2, '0')}:00`;
        t.append(h('tr', {},
          h('td', { style: 'font-variant-numeric:tabular-nums' }, label),
          h('td', { style: 'text-align:right' }, String(r.count)),
          h('td', {}, barCell(r.count, maxCount)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Login hour distribution (last ${days} days, session_start)`), t));
    }

    // Funnel conversion
    if (funnel.status === 'fulfilled' && funnel.value.available && funnel.value.funnel?.length) {
      const rows = funnel.value.funnel;
      const platforms = [...new Set(rows.map((r) => r.platform))].sort();
      const steps = ['session_start', 'game_start', 'level_attempt', 'level_complete'];

      for (const plat of platforms) {
        const platRows = rows.filter((r) => r.platform === plat);
        const latestDate = platRows.reduce((m, r) => (r.date > m ? r.date : m), '');
        const latest = platRows.filter((r) => r.date === latestDate);
        const byStep = new Map(latest.map((r) => [r.funnel_step, r]));

        const t = h('table', {}, h('tr', {}, h('th', {}, 'Funnel step'), h('th', {}, 'Count'), h('th', {}, 'Conversion rate')));
        for (const step of steps) {
          const row = byStep.get(step);
          t.append(h('tr', {},
            h('td', {}, step),
            h('td', { style: 'text-align:right' }, row ? String(row.count) : '—'),
            h('td', { style: 'text-align:right' }, row?.conversion_rate !== undefined ? pct(row.conversion_rate) : '—'),
          ));
        }
        body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Conversion funnel (${plat}, ${latestDate})`), t));
      }
    }

    // Event count detail
    if (evCounts.status === 'fulfilled' && evCounts.value.available && evCounts.value.event_counts?.length) {
      const rows = evCounts.value.event_counts;
      const events = [...new Set(rows.map((r) => r.event))].sort();
      const dates = [...new Set(rows.map((r) => r.date))].sort();
      const lookup = new Map(rows.map((r) => [`${r.date}:${r.event}`, r.count]));

      const header = h('tr', {}, h('th', {}, 'Date'), ...events.map((e) => h('th', {}, e)));
      const t = h('table', {}, header);
      for (const date of dates) {
        t.append(h('tr', {}, h('td', {}, date), ...events.map((e) => h('td', { style: 'text-align:right' }, String(lookup.get(`${date}:${e}`) ?? 0)))));
      }
      body.append(h('div', { class: 'card', style: 'overflow-x:auto' }, h('div', { class: 'muted' }, `Event counts (last ${days} days)`), t));
    }

    if (evCounts.status === 'rejected') showErr(err, evCounts.reason);
  };

  refreshBtn.addEventListener('click', () => void reload());
  daysSel.addEventListener('change', () => void reload());
  await reload();
}

// Human-readable labels for onboarding funnel step keys (must match ONBOARDING_STEPS in analyticsvc).
const ONBOARDING_LABELS: Record<string, string> = {
  session_start: 'Opened the game',
  tutorial_start: 'Started tutorial',
  tutorial_complete: 'Finished tutorial',
  first_battle: 'Started first battle',
  first_clear: 'Cleared first level',
};

// Human-readable labels for tutorial step-funnel keys (must match TUTORIAL_ORDERED_KEYS in analyticsvc).
const TUTORIAL_LABELS: Record<string, string> = {
  tutorial_start: 'Started tutorial',
  orientation_1: 'Orientation O1', orientation_2: 'Orientation O2', orientation_3: 'Orientation O3',
  orientation_4: 'Orientation O4', orientation_5: 'Orientation O5', orientation_6: 'Orientation O6',
  orientation_7: 'Orientation O7',
  beat_unit: 'Beat: deploy unit', beat_building: 'Beat: deploy building', beat_spell: 'Beat: cast spell',
  freeplay: 'Free play',
  tutorial_complete: 'Finished tutorial',
};

/** Shared renderer for cohort step-funnels (onboarding / tutorial / scene) — table + conversion bar per step. */
function renderStepFunnel(
  title: string,
  funnel: { step: string; count: number; conversion_rate?: number }[],
  cohortSize: number,
  labels?: Record<string, string>,
): HTMLElement {
  const t = h('table', {},
    h('tr', {},
      h('th', {}, 'Step'),
      h('th', { style: 'text-align:right' }, 'Reached'),
      h('th', { style: 'text-align:right' }, 'Step conv.'),
      h('th', { style: 'text-align:right' }, 'Of cohort'),
      h('th', {}, ''),
    ),
  );
  for (const step of funnel) {
    t.append(h('tr', {},
      h('td', {}, labels?.[step.step] ?? step.step),
      h('td', { style: 'text-align:right' }, String(step.count)),
      h('td', { style: 'text-align:right' }, step.conversion_rate !== undefined ? pct(step.conversion_rate) : '—'),
      h('td', { style: 'text-align:right' }, pct(cohortSize > 0 ? step.count / cohortSize : 0)),
      h('td', {}, barCell(step.count, cohortSize)),
    ));
  }
  return h('div', { class: 'card' }, h('div', { class: 'muted' }, title), t);
}

function pct(rate: number): string {
  return (rate * 100).toFixed(1) + '%';
}

function barCell(value: number, max: number): HTMLElement {
  const ratio = max > 0 ? value / max : 0;
  const bar = h('div', {
    style: `display:inline-block;width:${(ratio * 120).toFixed(0)}px;height:8px;background:#2f5fcf;vertical-align:middle;border-radius:2px`,
  });
  return h('span', {}, bar, ` ${pct(ratio)}`);
}
