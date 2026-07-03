// Live monitor page (OPS_DESIGN §7). Self-collected metrics + 6h trend sparkline.
import { clear, h } from '../dom';
import { showErr, sparkline, type Ctx } from './shared';

// Self-collected metrics → display labels (same order as the backend METRIC_KEYS).
const METRICS: [string, string][] = [
  ['online', 'Online connections'],
  ['queue', 'Matchmaking queue'],
  ['rooms', 'Active rooms'],
  ['gameInstances', 'Game instances'],
  ['gameLoad', 'Game load'],
];

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
