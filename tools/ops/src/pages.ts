// Ops admin page renderers (OPS_DESIGN §7). Pure DOM; visibility is determined by capabilities in app.ts.
import type { Api } from './api';
import { ApiError } from './api';
import { clear, fmtTime, h, pill } from './dom';
import type {
  AdminAccountView,
  AntiCheatReviewView,
  AuctionAnomaly,
  CompAttachment,
  CompScope,
  CompTarget,
  CompTicketView,
  EventDoc,
  EventInput,
  EventRewardDef,
  EventTaskDef,
  AdminGachaPool,
  CustomPoolCategory,
  GachaCategory,
  GachaCatalogItem,
  FeatureFlagRow,
  FlagPlatform,
  FlagRollout,
  PlayerProfile,
  PlayerSummary,
  Session,
  SlgWorldSummary,
  TradeAuditTicketView,
} from './types';

type Ctx = { api: Api; session: Session; root: HTMLElement; onTeardown: (fn: () => void) => void };

// Self-collected metrics → display labels (same order as the backend METRIC_KEYS).
const METRICS: [string, string][] = [
  ['online', 'Online connections'],
  ['queue', 'Matchmaking queue'],
  ['rooms', 'Active rooms'],
  ['gameInstances', 'Game instances'],
  ['gameLoad', 'Game load'],
];

function showErr(el: HTMLElement, e: unknown): void {
  const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message;
  el.textContent = msg;
  el.className = 'err';
}
function showOk(el: HTMLElement, msg: string): void {
  el.textContent = msg;
  el.className = 'err ok';
}

// ───────────────────────── Monitor ─────────────────────────
export async function pageMonitor(ctx: Ctx): Promise<void> {
  const { api, root, onTeardown } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Live monitor'));

  const metricSel = h('select', {}, ...METRICS.map(([v, label]) => h('option', { value: v }, label)));
  const autoChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const grid = h('div', { class: 'grid' });
  const err = h('div', { class: 'err' });
  const trendBox = h('div', { class: 'card' });

  const refreshLive = async (): Promise<void> => {
    try {
      const live = await api.monitorLive();
      clear(grid);
      const cells: [string, number][] = [
        ['Online connections', live.online],
        ['Matchmaking queue', live.queue],
        ['Active rooms', live.rooms],
        ['Game instances', live.gameInstances],
        ['Game load', live.gameLoad ?? 0],
      ];
      for (const [k, v] of cells) {
        grid.append(h('div', { class: 'stat' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k)));
      }
      err.textContent = live.available ? '' : 'Note: stats backend not configured, showing 0.';
    } catch (e) {
      showErr(err, e);
    }
  };
  const refreshTrend = async (): Promise<void> => {
    const metric = metricSel.value;
    const label = METRICS.find(([v]) => v === metric)?.[1] ?? metric;
    try {
      const pts = await api.trend(metric, Date.now() - 6 * 3600 * 1000);
      clear(trendBox);
      trendBox.append(h('div', { class: 'muted' }, `${label} trend (last 6h, ${pts.length} samples)`));
      trendBox.append(sparkline(pts.map((p) => p.value)));
    } catch {
      /* trend may be empty */
    }
  };
  const refresh = async (): Promise<void> => {
    await Promise.all([refreshLive(), refreshTrend()]);
  };

  metricSel.addEventListener('change', () => void refreshTrend());

  // Auto-refresh (10s polling, toggle-controlled); onTeardown stops it when leaving the page or the session expires.
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  autoChk.addEventListener('change', () => {
    stop();
    if (autoChk.checked) timer = setInterval(() => void refresh(), 10_000);
  });
  onTeardown(stop);

  root.append(
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'ghost', onclick: refresh }, 'Refresh'),
      h('span', { class: 'muted' }, 'Trend metric'),
      metricSel,
      h('label', { style: 'display:inline-flex;align-items:center;gap:4px;margin:0' }, autoChk, 'Auto-refresh 10s'),
    ),
    grid,
    err,
    trendBox,
  );
  await refresh();
}

function sparkline(values: number[]): HTMLElement {
  if (values.length === 0) return h('div', { class: 'muted' }, 'No data');
  const w = 600;
  const ht = 80;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(ht - (v / max) * (ht - 6) - 3).toFixed(1)}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${ht}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(ht));
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', pts);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', '#2f5fcf');
  poly.setAttribute('stroke-width', '2');
  svg.append(poly);
  return svg as unknown as HTMLElement;
}

// ───────────────────────── Analytics ─────────────────────────
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

// ───────────────────────── Player lookup ─────────────────────────
export function pagePlayer(ctx: Ctx): void {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Player lookup'));
  const input = h('input', { placeholder: 'Display name / login / publicId / accountId (≥2 chars)' });
  const err = h('div', { class: 'err' });
  const listOut = h('div', { class: 'card' });
  listOut.style.display = 'none';
  const detailOut = h('div', { class: 'card' });
  detailOut.style.display = 'none';

  // Select a row → fetch detail. Prefer publicId (consistent with the old path); fall back to accountId if absent.
  const showDetail = async (row: PlayerSummary): Promise<void> => {
    err.textContent = '';
    detailOut.style.display = 'none';
    try {
      const p: PlayerProfile = row.publicId
        ? await api.player(row.publicId)
        : await api.playerByAccount(row.accountId);
      clear(detailOut);
      const rows: [string, string][] = [
        ['Public ID', p.publicId ? '#' + p.publicId : '—'],
        ['accountId', p.accountId ?? row.accountId],
        ['Display name', p.displayName ?? '—'],
        ['Rank', p.rank ?? '—'],
        ['ELO', p.elo !== undefined ? String(p.elo) : '—'],
        ['Wins / Losses', p.wins !== undefined ? `${p.wins} / ${p.losses ?? 0}` : '—'],
      ];
      const t = h('table', {});
      for (const [k, v] of rows) t.append(h('tr', {}, h('th', {}, k), h('td', {}, v)));
      detailOut.append(h('h3', {}, 'Player details'), t);
      detailOut.style.display = '';
    } catch (e) {
      showErr(err, e);
    }
  };

  const go = async (): Promise<void> => {
    err.textContent = '';
    listOut.style.display = 'none';
    detailOut.style.display = 'none';
    try {
      const hits = await api.searchPlayers(input.value.trim());
      clear(listOut);
      if (hits.length === 0) {
        listOut.append(h('div', { class: 'muted' }, 'No matching players.'));
        listOut.style.display = '';
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {}, h('th', {}, 'Public ID'), h('th', {}, 'Display name'), h('th', {}, 'Login'), h('th', {}, '')),
      );
      for (const row of hits) {
        t.append(
          h(
            'tr',
            {},
            h('td', {}, row.publicId ? '#' + row.publicId : '—'),
            h('td', {}, row.displayName ?? '—'),
            h('td', {}, row.loginId ?? '—'),
            h('td', {}, h('button', { onclick: () => void showDetail(row) }, 'Details')),
          ),
        );
      }
      listOut.append(h('div', { class: 'muted' }, `${hits.length} result${hits.length === 1 ? '' : 's'}`), t);
      listOut.style.display = '';
    } catch (e) {
      showErr(err, e);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void go();
  });
  root.append(
    h('div', { class: 'card' }, h('div', { class: 'row' }, input, h('button', { onclick: go }, 'Search')), err),
    listOut,
    detailOut,
  );
}

// ───────────────────────── Anti-cheat review queue (S9-7) ─────────────────────────
/** Render a statKey→count map as compact text (empty → —). */
function fmtStats(m: Record<string, number> | undefined): string {
  const ks = Object.keys(m ?? {});
  if (ks.length === 0) return '—';
  return ks.map((k) => `${k}:${m![k]}`).join(', ');
}

export async function pageSuspicions(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Anti-cheat review (achievement stat overclaim)'));
  const err = h('div', { class: 'err' });
  const acct = h('input', { placeholder: 'Filter by accountId (optional)' });
  const statusSel = h(
    'select',
    {},
    h('option', { value: 'open' }, 'Pending (open)'),
    h('option', { value: 'reviewed' }, 'Reviewed'),
    h('option', { value: 'all' }, 'All'),
  ) as HTMLSelectElement;
  const out = h('div', { class: 'card' });

  const load = async (): Promise<void> => {
    err.textContent = '';
    clear(out);
    try {
      const rows = await api.antiCheatReviews({
        ...(acct.value.trim() ? { accountId: acct.value.trim() } : {}),
        status: statusSel.value,
        limit: 100,
      });
      if (rows.length === 0) {
        out.append(h('div', { class: 'muted' }, 'No review records.'));
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {},
          h('th', {}, 'Time'),
          h('th', {}, 'Player'),
          h('th', {}, 'Room'),
          h('th', {}, 'Reported'),
          h('th', {}, 'Authoritative'),
          h('th', {}, 'Overclaim'),
          h('th', {}, 'Rolled back'),
          h('th', {}, 'suspicion'),
          h('th', {}, 'Status'),
        ),
      );
      for (const r of rows as AntiCheatReviewView[]) {
        t.append(
          h('tr', {},
            h('td', {}, fmtTime(r.ts)),
            h('td', {}, r.publicId ? '#' + r.publicId : r.accountId),
            h('td', {}, r.roomId + ` (side ${r.side})`),
            h('td', {}, fmtStats(r.reported)),
            h('td', {}, fmtStats(r.authoritative)),
            h('td', {}, fmtStats(r.overclaim)),
            h('td', {}, fmtStats(r.rolledBack)),
            h('td', {}, String(r.suspicionAfter)),
            h('td', {}, pill(r.status, r.status === 'open' ? 'warn' : 'ok')),
          ),
        );
      }
      out.append(t);
    } catch (e) {
      showErr(err, e);
    }
  };

  root.append(
    h('div', { class: 'card' }, h('div', { class: 'row' }, acct, statusSel, h('button', { onclick: load }, 'Query')), err),
    out,
  );
  await load();
}

// ───────────────────────── Compensation tickets ─────────────────────────
export async function pageTickets(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  const caps = session.capabilities;
  clear(root);
  root.append(h('h2', {}, 'Compensation tickets'));

  const canInitiateSingle = caps.includes('comp.initiate.single');
  const canInitiateGlobal = caps.includes('comp.initiate.global');

  if (canInitiateSingle || canInitiateGlobal) root.append(ticketForm(ctx, () => void reload()));

  const filterSel = h('select', {}, ...['', 'pending', 'approved', 'executed', 'rejected', 'cancelled', 'failed'].map((s) => h('option', { value: s }, s || 'All')));
  const listBox = h('div', { class: 'card' });
  const err = h('div', { class: 'err' });
  root.append(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Status filter'), filterSel, h('button', { class: 'ghost', onclick: () => void reload() }, 'Refresh')), err, listBox);
  filterSel.addEventListener('change', () => void reload());

  const reload = async (): Promise<void> => {
    err.textContent = '';
    try {
      const tickets = await api.tickets(filterSel.value || undefined);
      clear(listBox);
      if (tickets.length === 0) {
        listBox.append(h('div', { class: 'muted' }, 'No tickets'));
        return;
      }
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Status'), h('th', {}, 'Scope'), h('th', {}, 'Target'), h('th', {}, 'Attachments'), h('th', {}, 'Reason'), h('th', {}, 'Initiated'), h('th', {}, 'Approved'), h('th', {}, 'Actions')));
      for (const tk of tickets) t.append(ticketRow(ctx, tk, () => void reload()));
      listBox.append(t);
    } catch (e) {
      showErr(err, e);
    }
  };
  await reload();
}

function describeTarget(target: CompTarget): string {
  return 'publicId' in target ? '#' + target.publicId : `all-server(${target.filter.kind})`;
}
function describeAttachments(att: CompAttachment[]): string {
  return att.map((a) => (a.kind === 'coins' ? `${a.count ?? 0} coins` : `${a.kind}:${a.id ?? '?'}×${a.count ?? 1}`)).join(', ') || 'none';
}

function ticketRow(ctx: Ctx, tk: CompTicketView, onChange: () => void): HTMLElement {
  const { api, session } = ctx;
  const caps = session.capabilities;
  const err = h('div', { class: 'err' });
  const act = async (action: 'approve' | 'reject' | 'cancel' | 'retry', note?: string): Promise<void> => {
    err.textContent = '';
    try {
      await api.ticketAction(tk.id, action, note);
      onChange();
    } catch (e) {
      showErr(err, e);
    }
  };
  const buttons: HTMLElement[] = [];
  const isMine = tk.initiatedBy === session.admin.id;
  // Approval capability (mirrors the backend): global→approve.global; overquota→approve.single.overquota; otherwise approve.single.
  const approveCap =
    tk.scope === 'global'
      ? 'comp.approve.global'
      : tk.amountTier === 'overquota'
        ? 'comp.approve.single.overquota'
        : 'comp.approve.single';
  const hasApproveCap = caps.includes(approveCap as never);
  if (tk.status === 'pending') {
    if (hasApproveCap && !isMine) {
      buttons.push(h('button', { onclick: () => void act('approve') }, 'Approve'));
      buttons.push(h('button', { class: 'warn', onclick: () => void act('reject', prompt('Rejection reason?') ?? '') }, 'Reject'));
    } else if (hasApproveCap && isMine) {
      // Single-super-admin self-approval transitional mode: the UI optimistically shows "Approve"; the backend
      // makes the final call — a 403 is returned if a second qualified approver exists (restoring four-eyes).
      // Rejection has no self-approval exemption (use cancel instead), so "Reject" is not shown during self-approval.
      buttons.push(
        h(
          'button',
          { title: 'Self-approval allowed when no other qualified approver exists (backend decides, audit trail kept)', onclick: () => void act('approve') },
          'Approve (self)',
        ),
      );
    }
    if (isMine || session.admin.role === 'super') buttons.push(h('button', { class: 'ghost', onclick: () => void act('cancel') }, 'Cancel'));
  }
  if (tk.status === 'failed' && hasApproveCap) buttons.push(h('button', { class: 'warn', onclick: () => void act('retry') }, 'Retry'));

  return h(
    'tr',
    {},
    h('td', {}, pill(tk.status, tk.status), tk.amountTier === 'overquota' ? h('div', { class: 'muted' }, 'overquota') : null),
    h('td', {}, tk.scope),
    h('td', {}, describeTarget(tk.target)),
    h('td', {}, describeAttachments(tk.mail.attachments)),
    h('td', {}, tk.reason),
    h('td', {}, tk.initiatedByName ?? tk.initiatedBy.slice(0, 8), h('div', { class: 'muted' }, fmtTime(tk.initiatedAt))),
    h('td', {}, tk.approvedByName ?? (tk.approvedBy ? tk.approvedBy.slice(0, 8) : '—'), tk.recipientCount !== undefined ? h('div', { class: 'muted' }, `${tk.recipientCount} recipients`) : null, tk.error ? h('div', { class: 'err' }, tk.error) : null),
    h('td', {}, ...buttons, err),
  );
}

function ticketForm(ctx: Ctx, onCreated: () => void): HTMLElement {
  const { api, session } = ctx;
  const caps = session.capabilities;
  const err = h('div', { class: 'err' });

  const scopeSel = h('select', {}, h('option', { value: 'single' }, 'Individual compensation'), ...(caps.includes('comp.initiate.global') ? [h('option', { value: 'global' }, 'Global compensation')] : []));
  const publicIdInput = h('input', { placeholder: 'Recipient 9-digit public ID', maxlength: '9' });
  const subjectInput = h('input', { placeholder: 'Mail subject' });
  const bodyInput = h('textarea', { placeholder: 'Mail body' });
  const coinsInput = h('input', { type: 'number', value: '0', min: '0' });
  const reasonInput = h('input', { placeholder: 'Reason (required, for audit)' });
  const expireInput = h('input', { type: 'number', value: '30', min: '1' });
  const previewOut = h('span', { class: 'muted' });

  const targetRow = h('div', {}, h('label', {}, 'Recipient public ID'), publicIdInput);
  scopeSel.addEventListener('change', () => {
    targetRow.style.display = scopeSel.value === 'single' ? '' : 'none';
  });

  const buildTarget = (): CompTarget =>
    scopeSel.value === 'single' ? { publicId: publicIdInput.value.trim() } : { filter: { kind: 'all' } };

  const submit = async (): Promise<void> => {
    err.textContent = '';
    const coins = Number(coinsInput.value) || 0;
    const attachments: CompAttachment[] = coins > 0 ? [{ kind: 'coins', count: coins }] : [];
    try {
      await api.initiate({
        scope: scopeSel.value as CompScope,
        target: buildTarget(),
        mail: { subject: subjectInput.value.trim(), body: bodyInput.value.trim(), attachments, expireDays: Number(expireInput.value) || 30 },
        reason: reasonInput.value.trim(),
      });
      showOk(err, 'Ticket created, awaiting approval');
      subjectInput.value = '';
      bodyInput.value = '';
      coinsInput.value = '0';
      reasonInput.value = '';
      onCreated();
    } catch (e) {
      showErr(err, e);
    }
  };
  const doPreview = async (): Promise<void> => {
    err.textContent = '';
    try {
      const r = await api.preview(scopeSel.value as CompScope, buildTarget());
      previewOut.textContent = `Estimated ${r.recipientCount} recipient${r.recipientCount === 1 ? '' : 's'}${r.available ? '' : ' (mail backend not ready, estimate unavailable)'}`;
    } catch (e) {
      showErr(err, e);
    }
  };

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'muted' }, 'Create compensation ticket (initiator ≠ approver; overquota/global requires super-admin approval)'),
    h('label', {}, 'Scope'),
    scopeSel,
    targetRow,
    h('label', {}, 'Mail subject'),
    subjectInput,
    h('label', {}, 'Mail body'),
    bodyInput,
    h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Coins attachment'), coinsInput), h('div', {}, h('label', {}, 'Expire days'), expireInput)),
    h('label', {}, 'Reason'),
    reasonInput,
    h('div', { class: 'row' }, h('button', { onclick: submit }, 'Submit ticket'), h('button', { class: 'ghost', onclick: doPreview }, 'dry-run preview'), previewOut),
    err,
  );
}

// ───────────────────────── Audit ─────────────────────────
export async function pageAudit(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Audit log'));
  const canAll = session.capabilities.includes('audit.view.all');
  const actorInput = h('input', { placeholder: 'actor adminId (super-admin only: query other operators)' });
  const fromInput = h('input', { type: 'date' }) as HTMLInputElement;
  const toInput = h('input', { type: 'date' }) as HTMLInputElement;
  const err = h('div', { class: 'err' });
  const box = h('div', { class: 'card' });
  root.append(
    h(
      'div',
      { class: 'row' },
      canAll ? actorInput : h('span', { class: 'muted' }, 'You can only view your own actions'),
      h('span', { class: 'muted' }, 'From'),
      fromInput,
      h('span', { class: 'muted' }, 'To'),
      toInput,
      h('button', { class: 'ghost', onclick: () => void reload() }, 'Refresh'),
    ),
    err,
    box,
  );
  const reload = async (): Promise<void> => {
    err.textContent = '';
    try {
      const fromMs = fromInput.value ? Date.parse(fromInput.value) : NaN;
      const toMs = toInput.value ? Date.parse(toInput.value) + 24 * 3600 * 1000 : NaN; // include the full selected day
      const entries = await api.audit({
        ...(canAll && actorInput.value.trim() ? { actor: actorInput.value.trim() } : {}),
        ...(Number.isFinite(fromMs) ? { from: fromMs } : {}),
        ...(Number.isFinite(toMs) ? { to: toMs } : {}),
      });
      clear(box);
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Operator'), h('th', {}, 'Action'), h('th', {}, 'Target'), h('th', {}, 'Summary'), h('th', {}, 'IP')));
      for (const e of entries) {
        t.append(h('tr', {}, h('td', {}, fmtTime(e.ts)), h('td', {}, e.actorName ?? e.actor.slice(0, 8)), h('td', {}, e.action), h('td', {}, e.target ?? '—'), h('td', {}, e.summary ?? '—'), h('td', {}, e.ip ?? '—')));
      }
      box.append(entries.length ? t : h('div', { class: 'muted' }, 'No records'));
    } catch (e) {
      showErr(err, e);
    }
  };
  await reload();
}

// ───────────────────────── Account management ─────────────────────────
export async function pageAccounts(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Account management'));
  const err = h('div', { class: 'err' });

  // Create account
  const uName = h('input', { placeholder: 'Username (≥3)' });
  const uPass = h('input', { type: 'password', placeholder: 'Initial password (≥6)' });
  const uDisp = h('input', { placeholder: 'Display name' });
  const uRole = h('select', {}, ...['viewer', 'support', 'ops', 'super'].map((r) => h('option', { value: r }, r)));
  const create = async (): Promise<void> => {
    err.textContent = '';
    try {
      await api.createAccount({ username: uName.value.trim(), password: uPass.value, role: uRole.value, displayName: uDisp.value.trim() || uName.value.trim() });
      uName.value = '';
      uPass.value = '';
      uDisp.value = '';
      await reload();
      showOk(err, 'Account created');
    } catch (e) {
      showErr(err, e);
    }
  };
  root.append(
    h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Create ops account'), h('div', { class: 'row' }, uName, uPass, uDisp, uRole, h('button', { onclick: create }, 'Create')), err),
  );

  const box = h('div', { class: 'card' });
  root.append(box);
  const reload = async (): Promise<void> => {
    try {
      const accts = await api.accounts();
      clear(box);
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Username'), h('th', {}, 'Display name'), h('th', {}, 'Role'), h('th', {}, 'Status'), h('th', {}, 'Last login'), h('th', {}, 'Actions')));
      for (const a of accts) t.append(accountRow(ctx, a, () => void reload()));
      box.append(t);
    } catch (e) {
      showErr(err, e);
    }
  };
  await reload();
}

function accountRow(ctx: Ctx, a: AdminAccountView, onChange: () => void): HTMLElement {
  const { api, session } = ctx;
  const self = a.id === session.admin.id;
  const err = h('div', { class: 'err' });
  const roleSel = h('select', {}, ...['viewer', 'support', 'ops', 'super'].map((r) => h('option', { value: r, ...(r === a.role ? { selected: 'selected' } : {}) }, r)));
  const saveRole = async (): Promise<void> => {
    err.textContent = '';
    try {
      await api.updateAccount(a.id, { role: roleSel.value });
      onChange();
    } catch (e) {
      showErr(err, e);
    }
  };
  const toggleDisable = async (): Promise<void> => {
    err.textContent = '';
    try {
      await api.updateAccount(a.id, { disabled: !a.disabled });
      onChange();
    } catch (e) {
      showErr(err, e);
    }
  };
  const reset = async (): Promise<void> => {
    const pw = prompt(`Set new password for ${a.username} (≥6)`);
    if (!pw) return;
    err.textContent = '';
    try {
      await api.resetPassword(a.id, pw);
      showOk(err, 'Password reset');
    } catch (e) {
      showErr(err, e);
    }
  };
  return h(
    'tr',
    {},
    h('td', {}, a.username, self ? h('span', { class: 'muted' }, '(you)') : null),
    h('td', {}, a.displayName),
    h('td', {}, roleSel, h('button', { class: 'ghost', onclick: saveRole }, 'Save')),
    h('td', {}, a.disabled ? pill('disabled', 'failed') : pill('active', 'executed')),
    h('td', {}, fmtTime(a.lastLoginAt ?? 0)),
    h('td', {}, h('button', { class: a.disabled ? 'ghost' : 'danger', disabled: self, onclick: toggleDisable }, a.disabled ? 'Enable' : 'Disable'), h('button', { class: 'ghost', onclick: reset }, 'Reset password'), err),
  );
}

// ───────────────────────── Ladder season (SE-3) ─────────────────────────
export async function pageLadderSeason(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Ladder season'));

  const info = h('div', { class: 'card' }, 'Loading...');
  const rollErr = h('div', { class: 'err' });
  const rollBtn = h('button', {}, 'Roll season') as HTMLButtonElement;

  const MS_PER_DAY = 86400_000;
  const WARNING_DAYS = 3;

  const refresh = async (): Promise<void> => {
    try {
      const s = await api.ladderGetCurrentSeason();
      if (!s) {
        info.textContent = 'Meta unreachable, cannot read season info.';
        return;
      }
      const now = Date.now();
      const daysLeft = Math.ceil((s.endAt - now) / MS_PER_DAY);
      const near = daysLeft <= WARNING_DAYS;
      clear(info);
      info.append(
        h('table', {},
          h('tr', {}, h('th', {}, 'Season'), h('td', {}, `Season ${s.seasonNo}`)),
          h('tr', {}, h('th', {}, 'Start'), h('td', {}, fmtTime(s.startAt))),
          h('tr', {}, h('th', {}, 'End'), h('td', {}, fmtTime(s.endAt))),
          h('tr', {}, h('th', {}, 'State'), h('td', {}, s.state)),
          h('tr', {}, h('th', {}, 'Remaining'), h('td', { style: near ? 'color:var(--warn)' : '' },
            daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? '' : 's'}${near ? ' ⚠ ending soon' : ''}` : 'Expired')),
        ),
      );
    } catch (e) {
      info.textContent = (e as Error).message;
    }
  };

  rollBtn.onclick = async (): Promise<void> => {
    rollErr.textContent = '';
    rollBtn.disabled = true;
    try {
      const s = await api.ladderRollSeason();
      showOk(rollErr, `Advanced to Season ${s.seasonNo}`);
      await refresh();
    } catch (e) {
      showErr(rollErr, e);
    } finally {
      rollBtn.disabled = false;
    }
  };

  root.append(info, h('div', { class: 'card' }, rollBtn, rollErr));
  await refresh();
}

// ── Feature flags (FEATURE_FLAGS_DESIGN §5) ──
const FLAG_PLATFORMS: FlagPlatform[] = ['web', 'wechat', 'crazygames'];

/** Comma- or newline-separated string → trimmed, non-empty array. */
function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function pageFlags(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'Feature flags'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Global ops toggle + targeting (percentage / region / platform / allow-deny lists). Master off = off for everyone; server propagates within 30s.'),
  );
  const list = h('div', {}, 'Loading...');
  root.append(list);

  const buildCard = (row: FeatureFlagRow): HTMLElement => {
    const doc = row.doc;
    const r: FlagRollout = doc?.rollout ?? {};
    const enabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
    enabled.checked = doc ? doc.enabled : false;
    const pct = h('input', { type: 'number', min: '0', max: '100', style: 'width:80px',
      value: r.pct !== undefined ? String(r.pct) : '' }) as HTMLInputElement;
    const regions = h('input', { style: 'width:100%', value: (r.regions ?? []).join(', '),
      placeholder: 'e.g. eu, us, cn (empty = all)' }) as HTMLInputElement;
    const platBoxes = FLAG_PLATFORMS.map((p) => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = (r.platforms ?? []).includes(p);
      return { p, cb };
    });
    const allow = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: 'accountId comma/newline separated (match = on)' }, (r.allowAccounts ?? []).join('\n')) as HTMLTextAreaElement;
    const deny = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: 'accountId comma/newline separated (match = off)' }, (r.denyAccounts ?? []).join('\n')) as HTMLTextAreaElement;
    const allowPublicIds = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: '9-digit publicId comma/newline separated (match = on)' }, (r.allowPublicIds ?? []).join('\n')) as HTMLTextAreaElement;

    const status = h('span', {});
    const saveBtn = h('button', {}, 'Save') as HTMLButtonElement;
    saveBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      status.className = '';
      saveBtn.disabled = true;
      try {
        const rollout: FlagRollout = {};
        if (pct.value.trim() !== '') rollout.pct = Math.max(0, Math.min(100, Number(pct.value)));
        const reg = parseList(regions.value);
        if (reg.length) rollout.regions = reg;
        const plats = platBoxes.filter((b) => b.cb.checked).map((b) => b.p);
        if (plats.length) rollout.platforms = plats;
        const al = parseList(allow.value);
        if (al.length) rollout.allowAccounts = al;
        const dn = parseList(deny.value);
        if (dn.length) rollout.denyAccounts = dn;
        const apid = parseList(allowPublicIds.value);
        if (apid.length) rollout.allowPublicIds = apid;
        await api.upsertFlag(row.key, {
          enabled: enabled.checked,
          ...(Object.keys(rollout).length ? { rollout } : {}),
          ...(row.desc ? { desc: row.desc } : {}),
        });
        showOk(status, 'Saved (server propagates within 30s)');
      } catch (e) {
        showErr(status, e);
      } finally {
        saveBtn.disabled = false;
      }
    };

    const meta = doc
      ? h('div', { class: 'muted', style: 'font-size:12px' },
          `Last modified: ${doc.updatedBy || '—'} · ${fmtTime(doc.updatedAt)}`)
      : h('div', { class: 'muted', style: 'font-size:12px' }, `Not overridden, using default (${row.default ? 'on' : 'off'})`);

    const fieldRow = (label: string, control: Node): HTMLElement =>
      h('div', { style: 'margin:6px 0' }, h('label', { style: 'display:block;font-size:13px;color:var(--muted)' }, label), control);

    return h('div', { class: 'card', style: 'margin-bottom:12px' },
      h('div', { style: 'display:flex;align-items:center;gap:8px' },
        h('strong', {}, row.key),
        pill(row.side, 'info'),
        h('span', { class: 'muted' }, row.desc),
      ),
      meta,
      h('div', { style: 'margin:6px 0' }, h('label', {}, enabled, ' Master on (off = off for everyone)')),
      fieldRow('Rollout % (empty = no percentage targeting)', pct),
      fieldRow('Regions (comma-separated, empty = all)', regions),
      fieldRow('Platforms (empty = all)',
        h('span', {}, ...platBoxes.flatMap((b) => [h('label', { style: 'margin-right:12px' }, b.cb, ' ' + b.p)]))),
      fieldRow('Allow accounts (match = on, overrides targeting)', allow),
      fieldRow('Deny accounts (match = off, overrides everything)', deny),
      fieldRow('Allow publicIds (9-digit player id, match = on)', allowPublicIds),
      ...(row.key.startsWith('client_log_')
        ? [h('div', { class: 'muted', style: 'font-size:12px;color:var(--muted)' },
            'Target a single player: set rollout % to 0 (off for everyone else), add only their 9-digit publicId to allowPublicIds above. ' +
            'Client uploads the most verbose enabled level (debug>info>warn>error). Query: Grafana {source="client"} | logfmt | publicId="..."')]
        : []),
      h('div', { style: 'margin-top:8px' }, saveBtn, ' ', status),
    );
  };

  try {
    const rows = await api.flags();
    clear(list);
    if (!rows.length) {
      list.append(h('div', { class: 'muted' }, 'No registered flags.'));
      return;
    }
    for (const row of rows) list.append(buildCard(row));
  } catch (e) {
    showErr(list, e);
  }
}

// ── Timed event management (B6, events.manage; ADR-014) ──
/** ms ↔ datetime-local ("YYYY-MM-DDTHH:mm", local timezone). */
function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToMs(v: string): number {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}
function eventStatus(ev: { windowStart: number; windowEnd: number }): { label: string; cls: string } {
  const now = Date.now();
  if (now < ev.windowStart) return { label: 'Not started', cls: 'info' };
  if (now >= ev.windowEnd) return { label: 'Ended', cls: '' };
  return { label: 'Active', cls: 'ok' };
}

export async function pageEvents(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'Event management'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Create/edit timed events (B6). Players see the event only during the active window. Task kinds: pve.clear / pvp.win / ad.watch; ' +
      'reward kinds: coins (requires positive integer count) / material / skin (requires id).'),
  );

  const formBox = h('div', { class: 'card', style: 'margin-bottom:12px' });
  const list = h('div', {}, 'Loading...');
  root.append(formBox, list);

  // Default task/reward examples (operators should use these as a template).
  const SAMPLE_TASKS: EventTaskDef[] = [
    { taskId: 'pve3', kind: 'pve.clear', target: 3, points: 1 },
    { taskId: 'pvp1', kind: 'pvp.win', target: 1, points: 2 },
  ];
  const SAMPLE_REWARDS: EventRewardDef[] = [
    { rewardId: 'r1', cost: 3, kind: 'coins', count: 2, maxClaims: 1 },
    { rewardId: 'r2', cost: 6, kind: 'material', id: 'ink_blue', count: 5, maxClaims: 3 },
  ];

  // Editing state: null = create new; otherwise edit the given event.
  let editing: EventDoc | null = null;

  const renderForm = (): void => {
    clear(formBox);
    const isEdit = editing !== null;
    const idInput = h('input', { style: 'width:100%', placeholder: 'Leave blank to auto-generate UUID',
      value: editing?._id ?? '' }) as HTMLInputElement;
    if (isEdit) idInput.disabled = true;
    const titleInput = h('input', { style: 'width:100%', value: editing?.title ?? '' }) as HTMLInputElement;
    const descInput = h('input', { style: 'width:100%', value: editing?.description ?? '' }) as HTMLInputElement;
    const now = Date.now();
    const startInput = h('input', { type: 'datetime-local',
      value: msToLocalInput(editing?.windowStart ?? now) }) as HTMLInputElement;
    const endInput = h('input', { type: 'datetime-local',
      value: msToLocalInput(editing?.windowEnd ?? now + 7 * 86400_000) }) as HTMLInputElement;
    const tasksTa = h('textarea', { rows: '6', style: 'width:100%;font-family:monospace' },
      JSON.stringify(editing?.tasks ?? SAMPLE_TASKS, null, 2)) as HTMLTextAreaElement;
    const rewardsTa = h('textarea', { rows: '6', style: 'width:100%;font-family:monospace' },
      JSON.stringify(editing?.rewards ?? SAMPLE_REWARDS, null, 2)) as HTMLTextAreaElement;
    const status = h('span', {});
    const saveBtn = h('button', {}, isEdit ? 'Save changes' : 'Create event') as HTMLButtonElement;

    const fieldRow = (label: string, control: Node): HTMLElement =>
      h('div', { style: 'margin:6px 0' },
        h('label', { style: 'display:block;font-size:13px;color:var(--muted)' }, label), control);

    saveBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      status.className = '';
      let tasks: EventTaskDef[];
      let rewards: EventRewardDef[];
      try {
        tasks = JSON.parse(tasksTa.value) as EventTaskDef[];
        rewards = JSON.parse(rewardsTa.value) as EventRewardDef[];
      } catch (e) {
        showErr(status, new Error(`Tasks/rewards JSON parse error: ${(e as Error).message}`));
        return;
      }
      const windowStart = localInputToMs(startInput.value);
      const windowEnd = localInputToMs(endInput.value);
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
        showErr(status, new Error('Invalid start/end time'));
        return;
      }
      const input: EventInput = {
        title: titleInput.value.trim(),
        ...(descInput.value.trim() ? { description: descInput.value.trim() } : {}),
        windowStart,
        windowEnd,
        tasks,
        rewards,
      };
      if (!isEdit && idInput.value.trim()) input.id = idInput.value.trim();
      saveBtn.disabled = true;
      try {
        if (isEdit) await api.updateEvent(editing!._id, input);
        else await api.createEvent(input);
        editing = null;
        renderForm();
        await refresh();
      } catch (e) {
        showErr(status, e);
      } finally {
        saveBtn.disabled = false;
      }
    };

    formBox.append(
      h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px' },
        h('strong', {}, isEdit ? `Edit event ${editing!._id}` : 'New event'),
        isEdit && h('button', { class: 'ghost', onclick: () => { editing = null; renderForm(); } }, 'Cancel edit'),
      ),
      fieldRow('eventId', idInput),
      fieldRow('Event title (≤80)', titleInput),
      fieldRow('Description (optional)', descInput),
      h('div', { style: 'display:flex;gap:16px' },
        fieldRow('Start time', startInput),
        fieldRow('End time', endInput),
      ),
      fieldRow('Tasks (JSON array: {taskId,kind,target,points})', tasksTa),
      fieldRow('Rewards (JSON array: {rewardId,cost,kind,id?,count?,maxClaims?})', rewardsTa),
      h('div', { style: 'margin-top:8px' }, saveBtn, ' ', status),
    );
  };

  const refresh = async (): Promise<void> => {
    try {
      const events = await api.events();
      clear(list);
      if (!events.length) {
        list.append(h('div', { class: 'muted' }, 'No events. Use the form above to create one.'));
        return;
      }
      for (const ev of events) {
        const st = eventStatus(ev);
        const delErr = h('span', {});
        const editBtn = h('button', { class: 'ghost', onclick: () => { editing = ev; renderForm(); window.scrollTo(0, 0); } }, 'Edit');
        const delBtn = h('button', { class: 'ghost danger' }, 'Delete') as HTMLButtonElement;
        delBtn.onclick = async (): Promise<void> => {
          if (!confirm(`Delete event "${ev.title}"? Participation history is kept but the event becomes immediately invisible to players.`)) return;
          delBtn.disabled = true;
          try {
            await api.deleteEvent(ev._id);
            await refresh();
          } catch (e) {
            showErr(delErr, e);
            delBtn.disabled = false;
          }
        };
        list.append(
          h('div', { class: 'card', style: 'margin-bottom:10px' },
            h('div', { style: 'display:flex;align-items:center;gap:8px' },
              h('strong', {}, ev.title),
              pill(st.label, st.cls),
              h('span', { class: 'muted', style: 'font-size:12px' }, ev._id),
            ),
            ev.description && h('div', { class: 'muted', style: 'font-size:13px' }, ev.description),
            h('div', { class: 'muted', style: 'font-size:12px' },
              `${fmtTime(ev.windowStart)} → ${fmtTime(ev.windowEnd)}`),
            h('div', { style: 'font-size:13px;margin-top:4px' },
              `Tasks: ${ev.tasks.length} · Rewards: ${ev.rewards.length}`),
            h('div', { style: 'margin-top:6px' }, editBtn, ' ', delBtn, ' ', delErr),
          ),
        );
      }
    } catch (e) {
      showErr(list, e);
    }
  };

  renderForm();
  await refresh();
}

// ── SLG season management (G7/§17.7; slg.season.view / slg.season.manage) ──

const SLG_WORLD_STATUS_CLS: Record<string, string> = {
  open: 'ok',
  settling: 'warn',
  resetting: 'warn',
  closed: '',
};

function slgWorldStatusPill(status: string): HTMLElement {
  return pill(status, SLG_WORLD_STATUS_CLS[status] ?? 'info');
}

export async function pageSLGSeason(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  const canManage = session.capabilities.includes('slg.season.manage');
  clear(root);
  root.append(
    h('h2', {}, 'SLG Season management'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'View world operational status and run lifecycle transitions. Operational sequence: open → settle → reset → (re-open or close). ' +
      'Reset requires the world to be in settling/resetting status (backend enforces this guard as well).'),
  );

  const err = h('div', { class: 'err' });
  const worldsBox = h('div', { class: 'card' }, 'Loading...');
  let worlds: SlgWorldSummary[] = [];

  const refresh = async (): Promise<void> => {
    err.textContent = '';
    try {
      worlds = await api.slgListWorlds();
      clear(worldsBox);
      if (worlds.length === 0) {
        worldsBox.append(h('div', { class: 'muted' }, 'No worlds found (worldsvc offline or no worlds registered).'));
        return;
      }
      const t = h('table', {},
        h('tr', {},
          h('th', {}, 'World ID'),
          h('th', {}, 'Season / Shard'),
          h('th', {}, 'Status'),
          h('th', {}, 'Population'),
          h('th', {}, 'Opened'),
          canManage ? h('th', {}, 'Actions') : null,
        ),
      );
      for (const w of worlds) t.append(slgWorldRow(ctx, w, refresh, err));
      worldsBox.append(t);
    } catch (e) {
      showErr(worldsBox, e);
    }
  };

  // Open-new-world form (slg.season.manage only)
  if (canManage) {
    const wIdInput = h('input', { placeholder: 'worldId (e.g. s1-0)' }) as HTMLInputElement;
    const seasonInput = h('input', { type: 'number', value: '1', min: '1', style: 'width:80px' }) as HTMLInputElement;
    const shardInput = h('input', { type: 'number', value: '1', min: '1', style: 'width:80px' }) as HTMLInputElement;
    const capInput = h('input', { type: 'number', value: '10000', min: '1', style: 'width:100px' }) as HTMLInputElement;
    const openErr = h('div', { class: 'err' });
    const openBtn = h('button', {}, 'Open world') as HTMLButtonElement;
    openBtn.onclick = async (): Promise<void> => {
      openErr.textContent = '';
      const worldId = wIdInput.value.trim();
      if (!worldId) { showErr(openErr, new Error('worldId is required')); return; }
      if (!confirm(`Open world "${worldId}" season ${seasonInput.value} shard ${shardInput.value} cap ${capInput.value}?`)) return;
      openBtn.disabled = true;
      try {
        await api.slgOpenSeason(worldId, Number(seasonInput.value), Number(shardInput.value), Number(capInput.value));
        showOk(openErr, `World "${worldId}" opened`);
        wIdInput.value = '';
        await refresh();
      } catch (e) {
        showErr(openErr, e);
      } finally {
        openBtn.disabled = false;
      }
    };
    root.append(
      h('div', { class: 'card', style: 'margin-bottom:12px' },
        h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Open a new world'),
        h('div', { class: 'row' },
          h('div', {}, h('label', {}, 'World ID'), wIdInput),
          h('div', {}, h('label', {}, 'Season'), seasonInput),
          h('div', {}, h('label', {}, 'Shard'), shardInput),
          h('div', {}, h('label', {}, 'Capacity'), capInput),
          openBtn,
        ),
        openErr,
      ),
    );
  }

  root.append(
    h('div', { class: 'row', style: 'margin-bottom:8px' },
      h('button', { class: 'ghost', onclick: refresh }, 'Refresh'),
    ),
    err,
    worldsBox,
  );
  await refresh();
}

function slgWorldRow(ctx: Ctx, w: SlgWorldSummary, onRefresh: () => Promise<void>, pageErr: HTMLElement): HTMLElement {
  const { api, session } = ctx;
  const canManage = session.capabilities.includes('slg.season.manage');
  const rowErr = h('span', { class: 'err' });

  const doAction = async (
    label: string,
    confirmMsg: string,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    if (!confirm(confirmMsg)) return;
    rowErr.textContent = '';
    pageErr.textContent = '';
    try {
      await action();
      await onRefresh();
    } catch (e) {
      showErr(rowErr, e);
    }
  };

  const buttons: HTMLElement[] = [];
  if (canManage) {
    if (w.status === 'open') {
      buttons.push(
        h('button', { class: 'warn',
          onclick: () => void doAction('Settle', `Settle world "${w.worldId}"? This distributes rewards and marks the season as settling.`, () => api.slgSettleSeason(w.worldId)) },
          'Settle'),
        h('button', { class: 'ghost',
          onclick: () => void doAction('Close', `Archive world "${w.worldId}"? This permanently closes it.`, () => api.slgCloseSeason(w.worldId)) },
          'Close'),
      );
    } else if (w.status === 'settling' || w.status === 'resetting') {
      buttons.push(
        h('button', { class: 'danger',
          onclick: () => void doAction('Reset', `DANGER: Reset world "${w.worldId}"? This wipes all world data and re-opens it. Irreversible.`, () => api.slgResetSeason(w.worldId)) },
          'Reset'),
        h('button', { class: 'ghost',
          onclick: () => void doAction('Close', `Archive world "${w.worldId}"? This permanently closes it.`, () => api.slgCloseSeason(w.worldId)) },
          'Close'),
      );
    }
  }

  return h('tr', {},
    h('td', {}, w.worldId),
    h('td', {}, `S${w.season} · shard ${w.shard}`),
    h('td', {}, slgWorldStatusPill(w.status)),
    h('td', { style: 'text-align:right' }, `${w.population.toLocaleString()} / ${w.capacity.toLocaleString()}`),
    h('td', {}, fmtTime(w.openAt)),
    canManage ? h('td', {}, ...buttons, rowErr) : null,
  );
}

// ── SLG anomalous trade audit (G7 anti-RMT, §17.7; slg.audit.view / slg.audit.manage) ──

export async function pageAuctionAudit(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  const canManage = session.capabilities.includes('slg.audit.manage');
  clear(root);
  root.append(
    h('h2', {}, 'SLG Auction anomaly audit'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Anti-RMT: scan for suspicious seller→buyer pairs, file audit tickets, then adjudicate (dismiss = false positive; action = confirmed violation). ' +
      'Enforcement (ban/clawback) follows the external liaison process.'),
  );

  // ── Anomaly scanner ──
  const scanWorldInput = h('input', { placeholder: 'worldId (e.g. s1-0)' }) as HTMLInputElement;
  const windowInput = h('input', { type: 'number', min: '3600', style: 'width:120px', placeholder: 'window (s, default)' }) as HTMLInputElement;
  const scanErr = h('div', { class: 'err' });
  const scanOut = h('div', { class: 'card' });
  scanOut.style.display = 'none';

  const runScan = async (): Promise<void> => {
    const worldId = scanWorldInput.value.trim();
    if (!worldId) { showErr(scanErr, new Error('worldId is required')); return; }
    scanErr.textContent = '';
    clear(scanOut);
    try {
      const windowSec = windowInput.value.trim() ? Number(windowInput.value.trim()) : undefined;
      const anomalies = await api.slgScanAnomalies(worldId, windowSec);
      scanOut.style.display = '';
      if (anomalies.length === 0) {
        scanOut.append(h('div', { class: 'muted' }, `No anomalies found in world "${worldId}".`));
        return;
      }
      scanOut.append(h('div', { class: 'muted' }, `${anomalies.length} suspicious pair${anomalies.length === 1 ? '' : 's'} found in world "${worldId}"`));
      const t = h('table', {},
        h('tr', {},
          h('th', {}, 'Seller'),
          h('th', {}, 'Buyer'),
          h('th', {}, 'Trades'),
          h('th', {}, 'Designated'),
          h('th', {}, 'Total coins'),
          h('th', {}, 'Severity'),
          h('th', {}, 'Signals'),
          h('th', {}, 'Window'),
          canManage ? h('th', {}, 'File ticket') : null,
        ),
      );
      for (const a of anomalies) t.append(anomalyRow(ctx, a, worldId, ticketRefresh));
      scanOut.append(t);
    } catch (e) {
      showErr(scanErr, e);
      scanOut.style.display = 'none';
    }
  };

  root.append(
    h('div', { class: 'card', style: 'margin-bottom:12px' },
      h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Scan for anomalous pairs'),
      h('div', { class: 'row' },
        h('div', {}, h('label', {}, 'World ID'), scanWorldInput),
        h('div', {}, h('label', {}, 'Window (sec)'), windowInput),
        h('button', { onclick: runScan }, 'Scan'),
      ),
      scanErr,
    ),
    scanOut,
  );

  // ── Audit ticket queue ──
  const ticketFilterSel = h('select', {},
    h('option', { value: '' }, 'All'),
    h('option', { value: 'open' }, 'Open'),
    h('option', { value: 'dismissed' }, 'Dismissed'),
    h('option', { value: 'actioned' }, 'Actioned'),
  ) as HTMLSelectElement;
  const ticketErr = h('div', { class: 'err' });
  const ticketBox = h('div', { class: 'card' }, 'Loading...');

  const ticketRefresh = async (): Promise<void> => {
    ticketErr.textContent = '';
    try {
      const tickets = await api.slgListAuditTickets(ticketFilterSel.value || undefined);
      clear(ticketBox);
      if (tickets.length === 0) {
        ticketBox.append(h('div', { class: 'muted' }, 'No audit tickets.'));
        return;
      }
      const t = h('table', {},
        h('tr', {},
          h('th', {}, 'Filed'),
          h('th', {}, 'World'),
          h('th', {}, 'Seller → Buyer'),
          h('th', {}, 'Trades'),
          h('th', {}, 'Total coins'),
          h('th', {}, 'Severity'),
          h('th', {}, 'Signals'),
          h('th', {}, 'Status'),
          h('th', {}, 'Filed by'),
          canManage ? h('th', {}, 'Adjudicate') : null,
        ),
      );
      for (const tk of tickets) t.append(auditTicketRow(ctx, tk, ticketRefresh));
      ticketBox.append(t);
    } catch (e) {
      showErr(ticketBox, e);
    }
  };

  ticketFilterSel.addEventListener('change', () => void ticketRefresh());
  root.append(
    h('h3', { style: 'margin-top:16px' }, 'Audit ticket queue'),
    h('div', { class: 'row' },
      h('span', { class: 'muted' }, 'Status'),
      ticketFilterSel,
      h('button', { class: 'ghost', onclick: () => void ticketRefresh() }, 'Refresh'),
    ),
    ticketErr,
    ticketBox,
  );
  await ticketRefresh();
}

const SEVERITY_CLS: Record<string, string> = { high: 'failed', medium: 'warn' };

function anomalyRow(ctx: Ctx, a: AuctionAnomaly, worldId: string, onTicketFiled: () => Promise<void>): HTMLElement {
  const { api, session } = ctx;
  const canManage = session.capabilities.includes('slg.audit.manage');
  const fileErr = h('span', { class: 'err' });
  const fileBtn = canManage
    ? h('button', {
        onclick: async (): Promise<void> => {
          fileErr.textContent = '';
          try {
            await api.slgFileAuditTicket({
              worldId,
              sellerId: a.sellerId,
              buyerId: a.buyerId,
              trades: a.trades,
              designatedTrades: a.designatedTrades,
              totalCoins: a.totalCoins,
              firstTs: a.firstTs,
              lastTs: a.lastTs,
              severity: a.severity,
              reasons: a.reasons,
            });
            showOk(fileErr, 'Ticket filed');
            await onTicketFiled();
          } catch (e) {
            showErr(fileErr, e);
          }
        },
      }, 'File ticket')
    : null;
  return h('tr', {},
    h('td', {}, a.sellerId),
    h('td', {}, a.buyerId),
    h('td', { style: 'text-align:right' }, String(a.trades)),
    h('td', { style: 'text-align:right' }, String(a.designatedTrades)),
    h('td', { style: 'text-align:right' }, a.totalCoins.toLocaleString()),
    h('td', {}, pill(a.severity, SEVERITY_CLS[a.severity] ?? 'warn')),
    h('td', {}, a.reasons.join(', ')),
    h('td', { class: 'muted', style: 'font-size:12px' }, `${fmtTime(a.firstTs)} – ${fmtTime(a.lastTs)}`),
    canManage ? h('td', {}, fileBtn, fileErr) : null,
  );
}

const TICKET_STATUS_CLS: Record<string, string> = { open: 'warn', dismissed: '', actioned: 'failed' };

function auditTicketRow(ctx: Ctx, tk: TradeAuditTicketView, onRefresh: () => Promise<void>): HTMLElement {
  const { api, session } = ctx;
  const canManage = session.capabilities.includes('slg.audit.manage');
  const resolveErr = h('span', { class: 'err' });

  const resolve = async (disposition: 'dismissed' | 'actioned'): Promise<void> => {
    const note = prompt(`${disposition === 'actioned' ? 'Confirmed violation' : 'Dismiss'}: add a note (optional)`) ?? '';
    resolveErr.textContent = '';
    try {
      await api.slgResolveAuditTicket(tk.id, disposition, note);
      await onRefresh();
    } catch (e) {
      showErr(resolveErr, e);
    }
  };

  const buttons: HTMLElement[] = [];
  if (canManage && tk.status === 'open') {
    buttons.push(
      h('button', { class: 'ghost', onclick: () => void resolve('dismissed') }, 'Dismiss'),
      h('button', { class: 'danger', onclick: () => void resolve('actioned') }, 'Action'),
    );
  } else if (tk.status !== 'open') {
    const resolvedBy = tk.resolvedByName ?? (tk.resolvedBy ? tk.resolvedBy.slice(0, 8) : '—');
    buttons.push(h('span', { class: 'muted', style: 'font-size:12px' }, `by ${resolvedBy}${tk.resolvedAt ? ` · ${fmtTime(tk.resolvedAt)}` : ''}`));
    if (tk.note) buttons.push(h('div', { class: 'muted', style: 'font-size:12px' }, tk.note));
  }

  const snap = tk.snapshot;
  return h('tr', {},
    h('td', { class: 'muted', style: 'font-size:12px' }, fmtTime(tk.filedAt)),
    h('td', {}, snap.worldId),
    h('td', {}, `${snap.sellerId} → ${snap.buyerId}`),
    h('td', { style: 'text-align:right' }, String(snap.trades)),
    h('td', { style: 'text-align:right' }, snap.totalCoins.toLocaleString()),
    h('td', {}, pill(snap.severity, SEVERITY_CLS[snap.severity] ?? 'warn')),
    h('td', {}, snap.reasons.join(', ')),
    h('td', {}, pill(tk.status, TICKET_STATUS_CLS[tk.status] ?? '')),
    h('td', { class: 'muted', style: 'font-size:12px' }, tk.filedByName ?? tk.filedBy.slice(0, 8)),
    canManage ? h('td', {}, ...buttons, resolveErr) : null,
  );
}

// ── Custom gacha pool management (GACHA_DESIGN §12, gacha.pools.manage) ──
// Category taxonomy mirrors @nw/shared economy.GachaCategory (§11.2; equipment split by tier).
const GACHA_CATEGORY_ORDER: GachaCategory[] = ['material', 'card', 'equip_t1', 'equip_t2', 'equip_t3', 'skin'];
const GACHA_CATEGORY_LABEL: Record<GachaCategory, string> = {
  material: 'Materials',
  card: 'Character Cards',
  equip_t1: 'Equipment T1 (fine)',
  equip_t2: 'Equipment T2 (rare)',
  equip_t3: 'Equipment T3 (epic)',
  skin: 'Skins',
};

interface DraftItem {
  itemId: string;
  weight: number;
}
interface DraftCat {
  enabled: boolean;
  weight: number;
  items: DraftItem[];
}
type Draft = Record<GachaCategory, DraftCat>;

function emptyDraft(): Draft {
  return Object.fromEntries(
    GACHA_CATEGORY_ORDER.map((c) => [c, { enabled: false, weight: 1, items: [] as DraftItem[] }]),
  ) as Draft;
}

/** Rebuild a draft from a stored custom pool (for editing). */
function draftFromPool(pool: AdminGachaPool): Draft {
  const d = emptyDraft();
  for (const cat of pool.categories ?? []) {
    d[cat.category] = { enabled: true, weight: cat.weight, items: cat.items.map((it) => ({ ...it })) };
  }
  return d;
}

function poolStatus(pool: { startAt: number; endAt: number; closedAt?: number }): { label: string; cls: string } {
  const now = Date.now();
  if (pool.closedAt || now >= pool.endAt) return { label: 'Ended', cls: '' };
  if (now < pool.startAt) return { label: 'Not started', cls: 'info' };
  return { label: 'Active', cls: 'ok' };
}

export async function pageGachaPools(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'Custom Gacha Pools'),
    h(
      'div',
      { class: 'muted', style: 'margin-bottom:8px' },
      'Ops-authored festival pools (GACHA_DESIGN §12): pick categories and items with relative weights, set the coin ' +
        'cost and the active window. Weights are relative — the normalized probability is shown live. No pity / no Fate Points.',
    ),
  );

  // Catalogue (items an operator may place, grouped by category). Loaded once.
  let catalog: Record<GachaCategory, GachaCatalogItem[]> = Object.fromEntries(
    GACHA_CATEGORY_ORDER.map((c) => [c, [] as GachaCatalogItem[]]),
  ) as Record<GachaCategory, GachaCatalogItem[]>;
  try {
    catalog = await api.gachaCatalog();
  } catch (e) {
    root.append(h('div', { class: 'err' }, e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message));
    return;
  }

  let editingId: string | null = null; // non-null = editing an existing pool (id locked)
  let draft = emptyDraft();

  const formBox = h('div', { class: 'card', style: 'margin-bottom:12px' });
  const list = h('div', {}, 'Loading…');
  root.append(formBox, list);

  const nameInput = h('input', { style: 'width:100%' }) as HTMLInputElement;
  const idInput = h('input', { style: 'width:100%', placeholder: 'festival_2026_summer' }) as HTMLInputElement;
  const costSingleInput = h('input', { type: 'number', min: '1', value: '150', style: 'width:120px' }) as HTMLInputElement;
  const costTenInput = h('input', { type: 'number', min: '1', placeholder: 'auto (×10)', style: 'width:120px' }) as HTMLInputElement;
  const startInput = h('input', { type: 'datetime-local' }) as HTMLInputElement;
  const endInput = h('input', { type: 'datetime-local' }) as HTMLInputElement;

  const resetForm = (): void => {
    editingId = null;
    draft = emptyDraft();
    nameInput.value = '';
    idInput.value = '';
    idInput.disabled = false;
    costSingleInput.value = '150';
    costTenInput.value = '';
    startInput.value = msToLocalInput(Date.now());
    endInput.value = msToLocalInput(Date.now() + 14 * 86400_000);
    renderForm();
  };

  const loadForEdit = (pool: AdminGachaPool): void => {
    editingId = pool.id;
    draft = draftFromPool(pool);
    nameInput.value = pool.name;
    idInput.value = pool.id;
    idInput.disabled = true;
    costSingleInput.value = String(pool.costSingle ?? 150);
    costTenInput.value = pool.costTen != null ? String(pool.costTen) : '';
    startInput.value = msToLocalInput(pool.startAt);
    endInput.value = msToLocalInput(pool.endAt);
    renderForm();
    formBox.scrollIntoView({ behavior: 'smooth' });
  };

  // Live category-weight total (enabled cats only) for the normalized-% readout.
  const enabledCatWeight = (): number =>
    GACHA_CATEGORY_ORDER.reduce((s, c) => s + (draft[c].enabled && draft[c].weight > 0 ? draft[c].weight : 0), 0);

  const status = h('span', {});

  function renderCategory(cat: GachaCategory): HTMLElement {
    const dc = draft[cat];
    const catTotal = enabledCatWeight();
    const catPct = dc.enabled && catTotal > 0 ? ((dc.weight / catTotal) * 100).toFixed(1) : '0';
    const itemTotal = dc.items.reduce((s, it) => s + Math.max(0, it.weight), 0);

    const toggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
    toggle.checked = dc.enabled;
    toggle.onchange = (): void => {
      dc.enabled = toggle.checked;
      renderForm();
    };

    const weightInput = h('input', { type: 'number', min: '0', step: 'any', value: String(dc.weight), style: 'width:80px' }) as HTMLInputElement;
    weightInput.disabled = !dc.enabled;
    weightInput.oninput = (): void => {
      dc.weight = Number(weightInput.value) || 0;
      // Refresh only the % readouts cheaply by re-rendering the form.
      renderForm();
    };

    // Item rows
    const itemRows = dc.items.map((it, idx) => {
      const meta = catalog[cat].find((c) => c.itemId === it.itemId);
      const w = h('input', { type: 'number', min: '0', step: 'any', value: String(it.weight), style: 'width:70px' }) as HTMLInputElement;
      w.oninput = (): void => {
        it.weight = Number(w.value) || 0;
        renderForm();
      };
      const overall = dc.enabled && catTotal > 0 && itemTotal > 0
        ? (((dc.weight / catTotal) * (it.weight / itemTotal)) * 100).toFixed(2)
        : '0';
      const rm = h('button', { class: 'ghost' }, '✕') as HTMLButtonElement;
      rm.onclick = (): void => {
        dc.items.splice(idx, 1);
        renderForm();
      };
      return h(
        'div',
        { style: 'display:flex;align-items:center;gap:8px;margin:2px 0' },
        h('span', { style: 'min-width:180px' }, `${meta?.name ?? it.itemId} `, h('span', { class: 'muted', style: 'font-size:11px' }, `(${it.itemId}, ${meta?.rarity ?? '?'})`)),
        h('span', { class: 'muted', style: 'font-size:12px' }, 'weight'),
        w,
        h('span', { class: 'muted', style: 'font-size:12px' }, `→ ${overall}% overall`),
        rm,
      );
    });

    // Add-item picker: dropdown of catalogued items in this category not yet added.
    const added = new Set(dc.items.map((it) => it.itemId));
    const available = catalog[cat].filter((c) => !added.has(c.itemId));
    const picker = h('select', { style: 'width:220px' }) as HTMLSelectElement;
    for (const c of available) picker.append(h('option', { value: c.itemId }, `${c.name} (${c.rarity})`));
    const addBtn = h('button', { class: 'ghost' }, '+ Add item') as HTMLButtonElement;
    addBtn.disabled = !dc.enabled || available.length === 0;
    addBtn.onclick = (): void => {
      if (picker.value) {
        dc.items.push({ itemId: picker.value, weight: 1 });
        renderForm();
      }
    };

    return h(
      'div',
      { class: 'card', style: `margin:6px 0;${dc.enabled ? '' : 'opacity:0.55'}` },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:8px' },
        h('label', { style: 'display:flex;align-items:center;gap:6px;font-weight:600' }, toggle, GACHA_CATEGORY_LABEL[cat]),
        h('span', { class: 'muted', style: 'font-size:12px' }, 'category weight'),
        weightInput,
        h('span', { class: 'muted', style: 'font-size:12px' }, `→ ${catPct}% of pulls`),
      ),
      dc.enabled ? h('div', { style: 'margin-top:6px' }, ...itemRows, h('div', { style: 'margin-top:4px' }, picker, ' ', addBtn)) : null,
    );
  }

  function collectConfig(): { id: string; name: string; costSingle: number; costTen?: number; startAt: number; endAt: number; categories: CustomPoolCategory[] } {
    const categories: CustomPoolCategory[] = GACHA_CATEGORY_ORDER.filter((c) => draft[c].enabled).map((c) => ({
      category: c,
      weight: draft[c].weight,
      items: draft[c].items.map((it) => ({ itemId: it.itemId, weight: it.weight })),
    }));
    const costTenRaw = costTenInput.value.trim();
    return {
      id: idInput.value.trim(),
      name: nameInput.value.trim(),
      costSingle: Number(costSingleInput.value) || 0,
      ...(costTenRaw ? { costTen: Number(costTenRaw) } : {}),
      startAt: localInputToMs(startInput.value),
      endAt: localInputToMs(endInput.value),
      categories,
    };
  }

  const saveBtn = h('button', {}, 'Create pool') as HTMLButtonElement;
  saveBtn.onclick = async (): Promise<void> => {
    status.textContent = '';
    status.className = '';
    const cfg = collectConfig();
    // Light client-side guard (the server re-validates authoritatively).
    if (!cfg.id || !cfg.name) return showErr(status, new Error('id and name are required'));
    if (!(cfg.endAt > cfg.startAt)) return showErr(status, new Error('end time must be after start time'));
    if (cfg.categories.length === 0) return showErr(status, new Error('enable at least one category'));
    for (const c of cfg.categories) {
      if (c.items.length === 0) return showErr(status, new Error(`category "${GACHA_CATEGORY_LABEL[c.category]}" needs at least one item`));
    }
    saveBtn.disabled = true;
    try {
      await api.createCustomPool(cfg);
      showOk(status, editingId ? 'Pool updated.' : 'Pool created.');
      resetForm();
      await refresh();
    } catch (e) {
      showErr(status, e);
    } finally {
      saveBtn.disabled = false;
    }
  };

  function renderForm(): void {
    clear(formBox);
    saveBtn.textContent = editingId ? `Save pool "${editingId}"` : 'Create pool';
    formBox.append(
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px' },
        h('strong', {}, editingId ? `Edit pool ${editingId}` : 'New custom pool'),
        editingId ? h('button', { class: 'ghost', onclick: () => resetForm() }, 'Cancel edit') : null,
      ),
      h('div', { style: 'display:flex;gap:16px;flex-wrap:wrap' },
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Pool id'), idInput),
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Name'), nameInput),
      ),
      h('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;margin-top:6px' },
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Cost / single (coins)'), costSingleInput),
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Cost / ten (coins)'), costTenInput),
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Start'), startInput),
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'End'), endInput),
      ),
      h('div', { style: 'margin-top:10px;font-weight:600' }, 'Categories & items'),
      ...GACHA_CATEGORY_ORDER.map(renderCategory),
      h('div', { style: 'margin-top:8px' }, saveBtn, ' ', status),
    );
  }

  const refresh = async (): Promise<void> => {
    try {
      const pools = (await api.gachaPools()).filter((p) => p.kind === 'custom');
      clear(list);
      list.append(h('h3', {}, 'Existing custom pools'));
      if (pools.length === 0) {
        list.append(h('div', { class: 'muted' }, 'No custom pools yet. Create one above.'));
        return;
      }
      for (const pool of pools) {
        const st = poolStatus(pool);
        const editBtn = h('button', { class: 'ghost', onclick: () => loadForEdit(pool) }, 'Edit') as HTMLButtonElement;
        const closeBtn = h('button', { class: 'ghost' }, pool.closedAt ? 'Closed' : 'Close early') as HTMLButtonElement;
        closeBtn.disabled = !!pool.closedAt || Date.now() >= pool.endAt;
        const rowErr = h('span', {});
        closeBtn.onclick = async (): Promise<void> => {
          if (!confirm(`Close pool "${pool.name}" now?`)) return;
          closeBtn.disabled = true;
          try {
            await api.closeGachaPool(pool.id);
            await refresh();
          } catch (e) {
            showErr(rowErr, e);
            closeBtn.disabled = false;
          }
        };
        const itemCount = (pool.categories ?? []).reduce((s, c) => s + c.items.length, 0);
        list.append(
          h(
            'div',
            { class: 'card', style: 'margin-bottom:10px' },
            h('div', { style: 'display:flex;align-items:center;gap:8px' }, h('strong', {}, pool.name), pill(st.label, st.cls), h('span', { class: 'muted', style: 'font-size:12px' }, pool.id)),
            h('div', { class: 'muted', style: 'font-size:12px' }, `${(pool.categories ?? []).length} categories · ${itemCount} items · single ${pool.costSingle ?? '?'} / ten ${pool.costTen ?? (pool.costSingle != null ? pool.costSingle * 10 : '?')} coins`),
            h('div', { class: 'muted', style: 'font-size:12px' }, `${fmtTime(pool.startAt)} → ${fmtTime(pool.endAt)}`),
            h('div', { style: 'margin-top:6px' }, editBtn, ' ', closeBtn, ' ', rowErr),
          ),
        );
      }
    } catch (e) {
      clear(list);
      list.append(h('div', { class: 'err' }, e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message));
    }
  };

  resetForm();
  await refresh();
}
