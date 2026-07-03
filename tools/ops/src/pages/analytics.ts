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

    const [summary, evCounts, dau, funnel, regions, osDist, loginHour, retention] = await Promise.allSettled([
      api.analyticsSummary(),
      api.analyticsEvents('event_counts', days),
      api.analyticsEvents('dau', days),
      api.analyticsEvents('funnel', days),
      api.analyticsEvents('region_dist', days),
      api.analyticsEvents('os_dist', days),
      api.analyticsEvents('login_hour', days),
      api.analyticsEvents('retention', days),
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

    // D1/D7 retention
    if (retention.status === 'fulfilled' && retention.value.available && retention.value.retention?.length) {
      const rows = retention.value.retention.filter((r) => r.cohort_size > 0);
      if (rows.length > 0) {
        const t = h('table', {},
          h('tr', {},
            h('th', {}, 'Date'),
            h('th', { style: 'text-align:right' }, 'Cohort'),
            h('th', { style: 'text-align:right' }, 'D1 ret'),
            h('th', { style: 'text-align:right' }, 'D1%'),
            h('th', { style: 'text-align:right' }, 'D7 ret'),
            h('th', { style: 'text-align:right' }, 'D7%'),
          ),
        );
        for (const r of rows) {
          t.append(h('tr', {},
            h('td', {}, r.date),
            h('td', { style: 'text-align:right' }, String(r.cohort_size)),
            h('td', { style: 'text-align:right' }, r.d1 !== undefined ? String(r.d1) : '—'),
            h('td', { style: 'text-align:right' }, r.d1_rate !== undefined ? pct(r.d1_rate) : '—'),
            h('td', { style: 'text-align:right' }, r.d7 !== undefined ? String(r.d7) : '—'),
            h('td', { style: 'text-align:right' }, r.d7_rate !== undefined ? pct(r.d7_rate) : '—'),
          ));
        }
        body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Retention cohorts (last ${days} days, — = insufficient data)`), t));
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
