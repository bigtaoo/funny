// Live monitor page (OPS_DESIGN §7). Self-collected metrics + 6h trend sparkline.
// The metric table, the grid's cells and both intervals live in src/logic/monitor.ts (ADR-070 4e).
import { clear, h } from '../dom';
import { AUTO_REFRESH_MS, availabilityNote, liveCells, METRICS, metricLabel, trendCaption, trendFromMs } from '../logic/monitor';
import { showErr, sparkline, type Ctx } from './shared';

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
      for (const [k, v] of liveCells(live)) {
        grid.append(h('div', { class: 'stat' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k)));
      }
      err.textContent = availabilityNote(live);
    } catch (e) {
      showErr(err, e);
    }
  };
  const refreshTrend = async (): Promise<void> => {
    const metric = metricSel.value;
    try {
      const pts = await api.trend(metric, trendFromMs(Date.now()));
      clear(trendBox);
      trendBox.append(h('div', { class: 'muted' }, trendCaption(metricLabel(metric), pts.length)));
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
    if (autoChk.checked) timer = setInterval(() => void refresh(), AUTO_REFRESH_MS);
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
