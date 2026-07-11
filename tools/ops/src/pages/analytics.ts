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

    const [summary, evCounts, dau, funnel, regions, osDist, loginHour, retention, firstSession] = await Promise.allSettled([
      api.analyticsSummary(),
      api.analyticsEvents('event_counts', days),
      api.analyticsEvents('dau', days),
      api.analyticsEvents('funnel', days),
      api.analyticsEvents('region_dist', days),
      api.analyticsEvents('os_dist', days),
      api.analyticsEvents('login_hour', days),
      api.analyticsEvents('retention', days),
      api.analyticsEvents('first_session', days),
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
        // Onboarding drop-off funnel
        const ft = h('table', {},
          h('tr', {},
            h('th', {}, 'Onboarding step'),
            h('th', { style: 'text-align:right' }, 'Users'),
            h('th', { style: 'text-align:right' }, 'Step conv.'),
            h('th', { style: 'text-align:right' }, 'Of cohort'),
            h('th', {}, ''),
          ),
        );
        for (const step of fs.funnel) {
          ft.append(h('tr', {},
            h('td', {}, ONBOARDING_LABELS[step.step] ?? step.step),
            h('td', { style: 'text-align:right' }, String(step.count)),
            h('td', { style: 'text-align:right' }, step.conversion_rate !== undefined ? pct(step.conversion_rate) : '—'),
            h('td', { style: 'text-align:right' }, pct(fs.cohort_size > 0 ? step.count / fs.cohort_size : 0)),
            h('td', {}, barCell(step.count, fs.cohort_size)),
          ));
        }
        body.append(h('div', { class: 'card' },
          h('div', { class: 'muted' }, `Onboarding funnel — new users' first session (${fs.cohort_size} new devices, last ${days} days)`),
          ft,
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

    // Region distribution
    if (regions.status === 'fulfilled' && regions.value.available && regions.value.region_dist?.length) {
      const rows = regions.value.region_dist;
      const total = rows.reduce((s, r) => s + r.devices, 0);
      const t = h('table', {},
        h('tr', {}, h('th', {}, 'Region'), h('th', { style: 'text-align:right' }, 'Devices'), h('th', {}, 'Share')),
      );
      for (const r of rows) {
        t.append(h('tr', {},
          h('td', {}, r.locale),
          h('td', { style: 'text-align:right' }, String(r.devices)),
          h('td', {}, barCell(r.devices, total)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Region distribution (last ${days} days)`), t));
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
