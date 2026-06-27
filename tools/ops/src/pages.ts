// 运维后台各页面渲染（OPS_DESIGN §7）。纯 DOM；按 capabilities 已在 app.ts 决定可见性。
import type { Api } from './api';
import { ApiError } from './api';
import { clear, fmtTime, h, pill } from './dom';
import type {
  AdminAccountView,
  AntiCheatReviewView,
  CompAttachment,
  CompScope,
  CompTarget,
  CompTicketView,
  EventDoc,
  EventInput,
  EventRewardDef,
  EventTaskDef,
  FeatureFlagRow,
  FlagPlatform,
  FlagRollout,
  PlayerProfile,
  PlayerSummary,
  Session,
} from './types';

type Ctx = { api: Api; session: Session; root: HTMLElement; onTeardown: (fn: () => void) => void };

// 自采指标 → 中文标签（与后端 METRIC_KEYS 同序）。
const METRICS: [string, string][] = [
  ['online', '在线连接'],
  ['queue', '匹配队列'],
  ['rooms', '活跃房间'],
  ['gameInstances', 'game 实例'],
  ['gameLoad', 'game 负载'],
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

// ───────────────────────── 监控 ─────────────────────────
export async function pageMonitor(ctx: Ctx): Promise<void> {
  const { api, root, onTeardown } = ctx;
  clear(root);
  root.append(h('h2', {}, '在线监控'));

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
        ['在线连接', live.online],
        ['匹配队列', live.queue],
        ['活跃房间', live.rooms],
        ['game 实例', live.gameInstances],
        ['game 负载', live.gameLoad ?? 0],
      ];
      for (const [k, v] of cells) {
        grid.append(h('div', { class: 'stat' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k)));
      }
      err.textContent = live.available ? '' : '提示：stats 后端未配置，显示 0。';
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
      trendBox.append(h('div', { class: 'muted' }, `${label}趋势（近 6h，${pts.length} 采样点）`));
      trendBox.append(sparkline(pts.map((p) => p.value)));
    } catch {
      /* 趋势可空 */
    }
  };
  const refresh = async (): Promise<void> => {
    await Promise.all([refreshLive(), refreshTrend()]);
  };

  metricSel.addEventListener('change', () => void refreshTrend());

  // 自动刷新（10s 轮询，开关控制）；离开页面/会话失效时 onTeardown 停掉。
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
      h('button', { class: 'ghost', onclick: refresh }, '刷新'),
      h('span', { class: 'muted' }, '趋势指标'),
      metricSel,
      h('label', { style: 'display:inline-flex;align-items:center;gap:4px;margin:0' }, autoChk, '自动刷新 10s'),
    ),
    grid,
    err,
    trendBox,
  );
  await refresh();
}

function sparkline(values: number[]): HTMLElement {
  if (values.length === 0) return h('div', { class: 'muted' }, '暂无数据');
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

// ───────────────────────── 数据分析 ─────────────────────────
export async function pageAnalytics(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, '数据分析'));
  const err = h('div', { class: 'err' });
  const body = h('div', {});
  const daysSel = h('select', { style: 'margin-left:8px' },
    h('option', { value: '1' }, '今天'),
    h('option', { value: '7', selected: 'selected' }, '近 7 天'),
    h('option', { value: '30' }, '近 30 天'),
  ) as HTMLSelectElement;
  const refreshBtn = h('button', { class: 'ghost' }, '刷新');

  root.append(
    h('div', { class: 'row' }, h('span', { class: 'muted' }, '时间范围'), daysSel, refreshBtn),
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

    // 监控概览（自采指标 + 工单）
    if (summary.status === 'fulfilled') {
      const s = summary.value;
      const t = h('table', {}, h('tr', {}, h('th', {}, '指标'), h('th', {}, '24h 均值'), h('th', {}, '24h 峰值'), h('th', {}, '采样数')));
      for (const [k, v] of Object.entries(s.last24h)) {
        t.append(h('tr', {}, h('td', {}, k), h('td', {}, v.avg.toFixed(1)), h('td', {}, String(v.peak)), h('td', {}, String(v.samples))));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, '近 24 小时自采监控'), t));

      const tk = h('table', {}, h('tr', {}, h('th', {}, '工单状态'), h('th', {}, '数量')));
      for (const [k, v] of Object.entries(s.tickets)) {
        tk.append(h('tr', {}, h('td', {}, pill(k, k)), h('td', {}, String(v))));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, '补偿工单概览'), tk));
    }

    // 埋点服务不可用提示（仅显示一次）
    const analyticsUnavailable =
      evCounts.status === 'fulfilled' && !evCounts.value.available;
    if (analyticsUnavailable) {
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, '埋点服务未配置（NW_ANALYTICS_BASE_URL）')));
      return;
    }

    // DAU 趋势
    if (dau.status === 'fulfilled' && dau.value.available && dau.value.dau?.length) {
      const pts = dau.value.dau;
      const t = h('table', {}, h('tr', {}, h('th', {}, '日期'), h('th', {}, 'DAU（日活设备）')));
      for (const p of pts) t.append(h('tr', {}, h('td', {}, p.date), h('td', { style: 'text-align:right' }, String(p.dau))));
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `DAU 趋势（近 ${days} 天）`), sparkline(pts.map((p) => p.dau)), t));
    }

    // D1/D7 留存
    if (retention.status === 'fulfilled' && retention.value.available && retention.value.retention?.length) {
      const rows = retention.value.retention.filter((r) => r.cohort_size > 0);
      if (rows.length > 0) {
        const t = h('table', {},
          h('tr', {},
            h('th', {}, '日期'),
            h('th', { style: 'text-align:right' }, '队列'),
            h('th', { style: 'text-align:right' }, 'D1 留存'),
            h('th', { style: 'text-align:right' }, 'D1%'),
            h('th', { style: 'text-align:right' }, 'D7 留存'),
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
        body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `D1/D7 滚动留存（近 ${days} 天，—=数据不足）`), t));
      }
    }

    // 地区分布
    if (regions.status === 'fulfilled' && regions.value.available && regions.value.region_dist?.length) {
      const rows = regions.value.region_dist;
      const total = rows.reduce((s, r) => s + r.devices, 0);
      const t = h('table', {},
        h('tr', {}, h('th', {}, '语言/地区'), h('th', { style: 'text-align:right' }, '设备数'), h('th', {}, '占比')),
      );
      for (const r of rows) {
        t.append(h('tr', {},
          h('td', {}, r.locale),
          h('td', { style: 'text-align:right' }, String(r.devices)),
          h('td', {}, barCell(r.devices, total)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `地区分布（近 ${days} 天）`), t));
    }

    // 设备/OS 分布
    if (osDist.status === 'fulfilled' && osDist.value.available && osDist.value.os_dist?.length) {
      const rows = osDist.value.os_dist;
      const total = rows.reduce((s, r) => s + r.devices, 0);
      const t = h('table', {},
        h('tr', {}, h('th', {}, '操作系统'), h('th', { style: 'text-align:right' }, '设备数'), h('th', {}, '占比')),
      );
      for (const r of rows) {
        t.append(h('tr', {},
          h('td', {}, r.os),
          h('td', { style: 'text-align:right' }, String(r.devices)),
          h('td', {}, barCell(r.devices, total)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `设备分布（近 ${days} 天，session_start）`), t));
    }

    // 登录时段（UTC）
    if (loginHour.status === 'fulfilled' && loginHour.value.available && loginHour.value.login_hour?.length) {
      const rows = loginHour.value.login_hour;
      const maxCount = Math.max(1, ...rows.map((r) => r.count));
      const t = h('table', {},
        h('tr', {}, h('th', {}, 'UTC 时'), h('th', { style: 'text-align:right' }, 'session 数'), h('th', {}, '分布')),
      );
      for (const r of rows) {
        const label = `${String(r.hour).padStart(2, '0')}:00`;
        t.append(h('tr', {},
          h('td', { style: 'font-variant-numeric:tabular-nums' }, label),
          h('td', { style: 'text-align:right' }, String(r.count)),
          h('td', {}, barCell(r.count, maxCount)),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `登录时段（UTC，近 ${days} 天，session_start）`), t));
    }

    // 漏斗转化
    if (funnel.status === 'fulfilled' && funnel.value.available && funnel.value.funnel?.length) {
      const rows = funnel.value.funnel;
      const platforms = [...new Set(rows.map((r) => r.platform))].sort();
      const steps = ['session_start', 'game_start', 'level_attempt', 'level_complete'];

      for (const plat of platforms) {
        const platRows = rows.filter((r) => r.platform === plat);
        const latestDate = platRows.reduce((m, r) => (r.date > m ? r.date : m), '');
        const latest = platRows.filter((r) => r.date === latestDate);
        const byStep = new Map(latest.map((r) => [r.funnel_step, r]));

        const t = h('table', {}, h('tr', {}, h('th', {}, '步骤'), h('th', {}, '人次'), h('th', {}, '转化率')));
        for (const step of steps) {
          const row = byStep.get(step);
          t.append(h('tr', {},
            h('td', {}, step),
            h('td', { style: 'text-align:right' }, row ? String(row.count) : '—'),
            h('td', { style: 'text-align:right' }, row?.conversion_rate !== undefined ? pct(row.conversion_rate) : '—'),
          ));
        }
        body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `漏斗转化（${plat}，${latestDate}）`), t));
      }
    }

    // 事件计数明细
    if (evCounts.status === 'fulfilled' && evCounts.value.available && evCounts.value.event_counts?.length) {
      const rows = evCounts.value.event_counts;
      const events = [...new Set(rows.map((r) => r.event))].sort();
      const dates = [...new Set(rows.map((r) => r.date))].sort();
      const lookup = new Map(rows.map((r) => [`${r.date}:${r.event}`, r.count]));

      const header = h('tr', {}, h('th', {}, '日期'), ...events.map((e) => h('th', {}, e)));
      const t = h('table', {}, header);
      for (const date of dates) {
        t.append(h('tr', {}, h('td', {}, date), ...events.map((e) => h('td', { style: 'text-align:right' }, String(lookup.get(`${date}:${e}`) ?? 0)))));
      }
      body.append(h('div', { class: 'card', style: 'overflow-x:auto' }, h('div', { class: 'muted' }, `事件计数明细（近 ${days} 天）`), t));
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

// ───────────────────────── 玩家查询 ─────────────────────────
export function pagePlayer(ctx: Ctx): void {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, '玩家查询'));
  const input = h('input', { placeholder: '昵称 / 登录账号 / 公开 id / accountId（≥2 字符）' });
  const err = h('div', { class: 'err' });
  const listOut = h('div', { class: 'card' });
  listOut.style.display = 'none';
  const detailOut = h('div', { class: 'card' });
  detailOut.style.display = 'none';

  // 选中某行 → 拉详情。优先按 publicId（与旧路径一致），无 publicId 则按 accountId。
  const showDetail = async (row: PlayerSummary): Promise<void> => {
    err.textContent = '';
    detailOut.style.display = 'none';
    try {
      const p: PlayerProfile = row.publicId
        ? await api.player(row.publicId)
        : await api.playerByAccount(row.accountId);
      clear(detailOut);
      const rows: [string, string][] = [
        ['公开 id', p.publicId ? '#' + p.publicId : '—'],
        ['accountId', p.accountId ?? row.accountId],
        ['昵称', p.displayName ?? '—'],
        ['段位', p.rank ?? '—'],
        ['ELO', p.elo !== undefined ? String(p.elo) : '—'],
        ['胜 / 负', p.wins !== undefined ? `${p.wins} / ${p.losses ?? 0}` : '—'],
      ];
      const t = h('table', {});
      for (const [k, v] of rows) t.append(h('tr', {}, h('th', {}, k), h('td', {}, v)));
      detailOut.append(h('h3', {}, '玩家详情'), t);
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
        listOut.append(h('div', { class: 'muted' }, '无匹配玩家。'));
        listOut.style.display = '';
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {}, h('th', {}, '公开 id'), h('th', {}, '昵称'), h('th', {}, '登录账号'), h('th', {}, '')),
      );
      for (const row of hits) {
        t.append(
          h(
            'tr',
            {},
            h('td', {}, row.publicId ? '#' + row.publicId : '—'),
            h('td', {}, row.displayName ?? '—'),
            h('td', {}, row.loginId ?? '—'),
            h('td', {}, h('button', { onclick: () => void showDetail(row) }, '详情')),
          ),
        );
      }
      listOut.append(h('div', { class: 'muted' }, `命中 ${hits.length} 条`), t);
      listOut.style.display = '';
    } catch (e) {
      showErr(err, e);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void go();
  });
  root.append(
    h('div', { class: 'card' }, h('div', { class: 'row' }, input, h('button', { onclick: go }, '搜索')), err),
    listOut,
    detailOut,
  );
}

// ───────────────────────── 反作弊审查队列（S9-7）─────────────────────────
/** 把 statKey→数量 map 渲染成紧凑文本（空 → —）。 */
function fmtStats(m: Record<string, number> | undefined): string {
  const ks = Object.keys(m ?? {});
  if (ks.length === 0) return '—';
  return ks.map((k) => `${k}:${m![k]}`).join(', ');
}

export async function pageSuspicions(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, '反作弊审查（成就统计超报）'));
  const err = h('div', { class: 'err' });
  const acct = h('input', { placeholder: '按 accountId 过滤（可空）' });
  const statusSel = h(
    'select',
    {},
    h('option', { value: 'open' }, '待复核 (open)'),
    h('option', { value: 'reviewed' }, '已复核 (reviewed)'),
    h('option', { value: 'all' }, '全部'),
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
        out.append(h('div', { class: 'muted' }, '无审查记录。'));
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {},
          h('th', {}, '时间'),
          h('th', {}, '玩家'),
          h('th', {}, '对局'),
          h('th', {}, '上报'),
          h('th', {}, '复算'),
          h('th', {}, '超报'),
          h('th', {}, '已回滚'),
          h('th', {}, 'suspicion'),
          h('th', {}, '状态'),
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
    h('div', { class: 'card' }, h('div', { class: 'row' }, acct, statusSel, h('button', { onclick: load }, '查询')), err),
    out,
  );
  await load();
}

// ───────────────────────── 补偿工单 ─────────────────────────
export async function pageTickets(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  const caps = session.capabilities;
  clear(root);
  root.append(h('h2', {}, '补偿工单'));

  const canInitiateSingle = caps.includes('comp.initiate.single');
  const canInitiateGlobal = caps.includes('comp.initiate.global');

  if (canInitiateSingle || canInitiateGlobal) root.append(ticketForm(ctx, () => void reload()));

  const filterSel = h('select', {}, ...['', 'pending', 'approved', 'executed', 'rejected', 'cancelled', 'failed'].map((s) => h('option', { value: s }, s || '全部')));
  const listBox = h('div', { class: 'card' });
  const err = h('div', { class: 'err' });
  root.append(h('div', { class: 'row' }, h('span', { class: 'muted' }, '状态过滤'), filterSel, h('button', { class: 'ghost', onclick: () => void reload() }, '刷新')), err, listBox);
  filterSel.addEventListener('change', () => void reload());

  const reload = async (): Promise<void> => {
    err.textContent = '';
    try {
      const tickets = await api.tickets(filterSel.value || undefined);
      clear(listBox);
      if (tickets.length === 0) {
        listBox.append(h('div', { class: 'muted' }, '暂无工单'));
        return;
      }
      const t = h('table', {}, h('tr', {}, h('th', {}, '状态'), h('th', {}, '范围'), h('th', {}, '目标'), h('th', {}, '附件'), h('th', {}, '事由'), h('th', {}, '发起'), h('th', {}, '审批'), h('th', {}, '操作')));
      for (const tk of tickets) t.append(ticketRow(ctx, tk, () => void reload()));
      listBox.append(t);
    } catch (e) {
      showErr(err, e);
    }
  };
  await reload();
}

function describeTarget(target: CompTarget): string {
  return 'publicId' in target ? '#' + target.publicId : `全服(${target.filter.kind})`;
}
function describeAttachments(att: CompAttachment[]): string {
  return att.map((a) => (a.kind === 'coins' ? `${a.count ?? 0}币` : `${a.kind}:${a.id ?? '?'}×${a.count ?? 1}`)).join(', ') || '无';
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
  // 审批能力（与后端同义）：global→approve.global；overquota→approve.single.overquota；否则 approve.single。
  const approveCap =
    tk.scope === 'global'
      ? 'comp.approve.global'
      : tk.amountTier === 'overquota'
        ? 'comp.approve.single.overquota'
        : 'comp.approve.single';
  const hasApproveCap = caps.includes(approveCap as never);
  if (tk.status === 'pending') {
    if (hasApproveCap && !isMine) {
      buttons.push(h('button', { onclick: () => void act('approve') }, '批准'));
      buttons.push(h('button', { class: 'warn', onclick: () => void act('reject', prompt('拒绝原因？') ?? '') }, '拒绝'));
    } else if (hasApproveCap && isMine) {
      // 单超管自批过渡：UI 乐观显示「批准」；后端最终裁决——若存在第二合格审批人会 403（恢复四眼）。
      // 拒绝无自批例外（用撤销代替），故自批时不显示「拒绝」。
      buttons.push(
        h(
          'button',
          { title: '无其他合格审批人时可自批（后端裁决，会留痕）', onclick: () => void act('approve') },
          '批准（自批）',
        ),
      );
    }
    if (isMine || session.admin.role === 'super') buttons.push(h('button', { class: 'ghost', onclick: () => void act('cancel') }, '撤销'));
  }
  if (tk.status === 'failed' && hasApproveCap) buttons.push(h('button', { class: 'warn', onclick: () => void act('retry') }, '重试'));

  return h(
    'tr',
    {},
    h('td', {}, pill(tk.status, tk.status), tk.amountTier === 'overquota' ? h('div', { class: 'muted' }, '超额') : null),
    h('td', {}, tk.scope),
    h('td', {}, describeTarget(tk.target)),
    h('td', {}, describeAttachments(tk.mail.attachments)),
    h('td', {}, tk.reason),
    h('td', {}, tk.initiatedByName ?? tk.initiatedBy.slice(0, 8), h('div', { class: 'muted' }, fmtTime(tk.initiatedAt))),
    h('td', {}, tk.approvedByName ?? (tk.approvedBy ? tk.approvedBy.slice(0, 8) : '—'), tk.recipientCount !== undefined ? h('div', { class: 'muted' }, `命中 ${tk.recipientCount}`) : null, tk.error ? h('div', { class: 'err' }, tk.error) : null),
    h('td', {}, ...buttons, err),
  );
}

function ticketForm(ctx: Ctx, onCreated: () => void): HTMLElement {
  const { api, session } = ctx;
  const caps = session.capabilities;
  const err = h('div', { class: 'err' });

  const scopeSel = h('select', {}, h('option', { value: 'single' }, '个人补偿'), ...(caps.includes('comp.initiate.global') ? [h('option', { value: 'global' }, '全服补偿')] : []));
  const publicIdInput = h('input', { placeholder: '收件人 9 位公开 id', maxlength: '9' });
  const subjectInput = h('input', { placeholder: '邮件标题' });
  const bodyInput = h('textarea', { placeholder: '邮件正文' });
  const coinsInput = h('input', { type: 'number', value: '0', min: '0' });
  const reasonInput = h('input', { placeholder: '补偿事由（必填，审计用）' });
  const expireInput = h('input', { type: 'number', value: '30', min: '1' });
  const previewOut = h('span', { class: 'muted' });

  const targetRow = h('div', {}, h('label', {}, '收件人公开 id'), publicIdInput);
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
      showOk(err, '工单已创建，等待审批');
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
      previewOut.textContent = `预计命中 ${r.recipientCount} 人${r.available ? '' : '（邮件后端未就绪，估算不可用）'}`;
    } catch (e) {
      showErr(err, e);
    }
  };

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'muted' }, '发起补偿工单（发起人 ≠ 审批人；超额/全服需超管审批）'),
    h('label', {}, '范围'),
    scopeSel,
    targetRow,
    h('label', {}, '邮件标题'),
    subjectInput,
    h('label', {}, '邮件正文'),
    bodyInput,
    h('div', { class: 'row' }, h('div', {}, h('label', {}, '金币附件'), coinsInput), h('div', {}, h('label', {}, '有效天数'), expireInput)),
    h('label', {}, '补偿事由'),
    reasonInput,
    h('div', { class: 'row' }, h('button', { onclick: submit }, '提交工单'), h('button', { class: 'ghost', onclick: doPreview }, 'dry-run 预览'), previewOut),
    err,
  );
}

// ───────────────────────── 审计 ─────────────────────────
export async function pageAudit(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  clear(root);
  root.append(h('h2', {}, '操作审计'));
  const canAll = session.capabilities.includes('audit.view.all');
  const actorInput = h('input', { placeholder: 'actor adminId（仅超管可跨人查）' });
  const fromInput = h('input', { type: 'date' }) as HTMLInputElement;
  const toInput = h('input', { type: 'date' }) as HTMLInputElement;
  const err = h('div', { class: 'err' });
  const box = h('div', { class: 'card' });
  root.append(
    h(
      'div',
      { class: 'row' },
      canAll ? actorInput : h('span', { class: 'muted' }, '仅可查看自己的操作'),
      h('span', { class: 'muted' }, '从'),
      fromInput,
      h('span', { class: 'muted' }, '至'),
      toInput,
      h('button', { class: 'ghost', onclick: () => void reload() }, '刷新'),
    ),
    err,
    box,
  );
  const reload = async (): Promise<void> => {
    err.textContent = '';
    try {
      const fromMs = fromInput.value ? Date.parse(fromInput.value) : NaN;
      const toMs = toInput.value ? Date.parse(toInput.value) + 24 * 3600 * 1000 : NaN; // 含当日全天
      const entries = await api.audit({
        ...(canAll && actorInput.value.trim() ? { actor: actorInput.value.trim() } : {}),
        ...(Number.isFinite(fromMs) ? { from: fromMs } : {}),
        ...(Number.isFinite(toMs) ? { to: toMs } : {}),
      });
      clear(box);
      const t = h('table', {}, h('tr', {}, h('th', {}, '时间'), h('th', {}, '操作人'), h('th', {}, '动作'), h('th', {}, '目标'), h('th', {}, '摘要'), h('th', {}, 'IP')));
      for (const e of entries) {
        t.append(h('tr', {}, h('td', {}, fmtTime(e.ts)), h('td', {}, e.actorName ?? e.actor.slice(0, 8)), h('td', {}, e.action), h('td', {}, e.target ?? '—'), h('td', {}, e.summary ?? '—'), h('td', {}, e.ip ?? '—')));
      }
      box.append(entries.length ? t : h('div', { class: 'muted' }, '暂无记录'));
    } catch (e) {
      showErr(err, e);
    }
  };
  await reload();
}

// ───────────────────────── 账号管理 ─────────────────────────
export async function pageAccounts(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  clear(root);
  root.append(h('h2', {}, '账号管理'));
  const err = h('div', { class: 'err' });

  // 创建账号
  const uName = h('input', { placeholder: '登录名（≥3）' });
  const uPass = h('input', { type: 'password', placeholder: '初始密码（≥6）' });
  const uDisp = h('input', { placeholder: '显示名' });
  const uRole = h('select', {}, ...['viewer', 'support', 'ops', 'super'].map((r) => h('option', { value: r }, r)));
  const create = async (): Promise<void> => {
    err.textContent = '';
    try {
      await api.createAccount({ username: uName.value.trim(), password: uPass.value, role: uRole.value, displayName: uDisp.value.trim() || uName.value.trim() });
      uName.value = '';
      uPass.value = '';
      uDisp.value = '';
      await reload();
      showOk(err, '账号已创建');
    } catch (e) {
      showErr(err, e);
    }
  };
  root.append(
    h('div', { class: 'card' }, h('div', { class: 'muted' }, '新建运维账号'), h('div', { class: 'row' }, uName, uPass, uDisp, uRole, h('button', { onclick: create }, '创建')), err),
  );

  const box = h('div', { class: 'card' });
  root.append(box);
  const reload = async (): Promise<void> => {
    try {
      const accts = await api.accounts();
      clear(box);
      const t = h('table', {}, h('tr', {}, h('th', {}, '登录名'), h('th', {}, '显示名'), h('th', {}, '角色'), h('th', {}, '状态'), h('th', {}, '最后登录'), h('th', {}, '操作')));
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
    const pw = prompt(`为 ${a.username} 设置新密码（≥6）`);
    if (!pw) return;
    err.textContent = '';
    try {
      await api.resetPassword(a.id, pw);
      showOk(err, '密码已重置');
    } catch (e) {
      showErr(err, e);
    }
  };
  return h(
    'tr',
    {},
    h('td', {}, a.username, self ? h('span', { class: 'muted' }, '（你）') : null),
    h('td', {}, a.displayName),
    h('td', {}, roleSel, h('button', { class: 'ghost', onclick: saveRole }, '改')),
    h('td', {}, a.disabled ? pill('disabled', 'failed') : pill('active', 'executed')),
    h('td', {}, fmtTime(a.lastLoginAt ?? 0)),
    h('td', {}, h('button', { class: a.disabled ? 'ghost' : 'danger', disabled: self, onclick: toggleDisable }, a.disabled ? '启用' : '禁用'), h('button', { class: 'ghost', onclick: reset }, '重置密码'), err),
  );
}

// ───────────────────────── 天梯赛季（SE-3）─────────────────────────
export async function pageLadderSeason(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, '天梯赛季管理'));

  const info = h('div', { class: 'card' }, '加载中…');
  const rollErr = h('div', { class: 'err' });
  const rollBtn = h('button', {}, '开启新赛季') as HTMLButtonElement;

  const MS_PER_DAY = 86400_000;
  const WARNING_DAYS = 3;

  const refresh = async (): Promise<void> => {
    try {
      const s = await api.ladderGetCurrentSeason();
      if (!s) {
        info.textContent = 'meta 不可达，无法读取赛季信息。';
        return;
      }
      const now = Date.now();
      const daysLeft = Math.ceil((s.endAt - now) / MS_PER_DAY);
      const near = daysLeft <= WARNING_DAYS;
      clear(info);
      info.append(
        h('table', {},
          h('tr', {}, h('th', {}, '赛季'), h('td', {}, `第 ${s.seasonNo} 赛季`)),
          h('tr', {}, h('th', {}, '开始'), h('td', {}, fmtTime(s.startAt))),
          h('tr', {}, h('th', {}, '结束'), h('td', {}, fmtTime(s.endAt))),
          h('tr', {}, h('th', {}, '状态'), h('td', {}, s.state)),
          h('tr', {}, h('th', {}, '剩余'), h('td', { style: near ? 'color:var(--warn)' : '' },
            daysLeft > 0 ? `${daysLeft} 天${near ? ' ⚠ 即将结束' : ''}` : '已到期')),
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
      showOk(rollErr, `已推进至第 ${s.seasonNo} 赛季`);
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

// ── 功能开关（feature flags，FEATURE_FLAGS_DESIGN §5）──
const FLAG_PLATFORMS: FlagPlatform[] = ['web', 'wechat', 'crazygames'];

/** 逗号/换行分隔字符串 → 去空裁剪数组。 */
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
    h('h2', {}, '功能开关 Feature Flags'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      '运营全局开关 + 定向（比例/区域/平台/白黑名单）。总闸关 = 任何人都关；服务端 ≤30s 内生效。'),
  );
  const list = h('div', {}, '加载中…');
  root.append(list);

  const buildCard = (row: FeatureFlagRow): HTMLElement => {
    const doc = row.doc;
    const r: FlagRollout = doc?.rollout ?? {};
    const enabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
    enabled.checked = doc ? doc.enabled : false;
    const pct = h('input', { type: 'number', min: '0', max: '100', style: 'width:80px',
      value: r.pct !== undefined ? String(r.pct) : '' }) as HTMLInputElement;
    const regions = h('input', { style: 'width:100%', value: (r.regions ?? []).join(', '),
      placeholder: '如 eu, us, cn（空=不限）' }) as HTMLInputElement;
    const platBoxes = FLAG_PLATFORMS.map((p) => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = (r.platforms ?? []).includes(p);
      return { p, cb };
    });
    const allow = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: 'accountId 逗号/换行分隔（命中即开）' }, (r.allowAccounts ?? []).join('\n')) as HTMLTextAreaElement;
    const deny = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: 'accountId 逗号/换行分隔（命中即关）' }, (r.denyAccounts ?? []).join('\n')) as HTMLTextAreaElement;
    const allowPublicIds = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: '9 位 publicId 逗号/换行分隔（命中即开）' }, (r.allowPublicIds ?? []).join('\n')) as HTMLTextAreaElement;

    const status = h('span', {});
    const saveBtn = h('button', {}, '保存') as HTMLButtonElement;
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
        showOk(status, '已保存（服务端 ≤30s 生效）');
      } catch (e) {
        showErr(status, e);
      } finally {
        saveBtn.disabled = false;
      }
    };

    const meta = doc
      ? h('div', { class: 'muted', style: 'font-size:12px' },
          `最近修改：${doc.updatedBy || '—'} · ${fmtTime(doc.updatedAt)}`)
      : h('div', { class: 'muted', style: 'font-size:12px' }, `未覆盖，使用默认值（${row.default ? 'on' : 'off'}）`);

    const fieldRow = (label: string, control: Node): HTMLElement =>
      h('div', { style: 'margin:6px 0' }, h('label', { style: 'display:block;font-size:13px;color:var(--muted)' }, label), control);

    return h('div', { class: 'card', style: 'margin-bottom:12px' },
      h('div', { style: 'display:flex;align-items:center;gap:8px' },
        h('strong', {}, row.key),
        pill(row.side, 'info'),
        h('span', { class: 'muted' }, row.desc),
      ),
      meta,
      h('div', { style: 'margin:6px 0' }, h('label', {}, enabled, ' 总闸开启（关 = 任何人都关）')),
      fieldRow('灰度比例 %（空=不按比例）', pct),
      fieldRow('区域 regions（逗号分隔，空=不限）', regions),
      fieldRow('平台 platforms（空=不限）',
        h('span', {}, ...platBoxes.flatMap((b) => [h('label', { style: 'margin-right:12px' }, b.cb, ' ' + b.p)]))),
      fieldRow('白名单 allowAccounts（命中即开，盖过定向）', allow),
      fieldRow('黑名单 denyAccounts（命中即关，盖过一切定向）', deny),
      fieldRow('publicId 白名单 allowPublicIds（9 位玩家 id，命中即开）', allowPublicIds),
      ...(row.key.startsWith('client_log_')
        ? [h('div', { class: 'muted', style: 'font-size:12px;color:var(--muted)' },
            '定向单个玩家：灰度比例填 0（对其他人关），仅把目标 9 位 publicId 填进上面的 allowPublicIds。' +
            '客户端取最 verbose 的已开级别（debug>info>warn>error）上报。查询：Grafana {source="client"} | logfmt | publicId="..."')]
        : []),
      h('div', { style: 'margin-top:8px' }, saveBtn, ' ', status),
    );
  };

  try {
    const rows = await api.flags();
    clear(list);
    if (!rows.length) {
      list.append(h('div', { class: 'muted' }, '无登记的 flag。'));
      return;
    }
    for (const row of rows) list.append(buildCard(row));
  } catch (e) {
    showErr(list, e);
  }
}

// ── 限时活动管理（B6，events.manage；ADR-014）──
/** ms ↔ datetime-local（"YYYY-MM-DDTHH:mm"，本地时区）。 */
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
  if (now < ev.windowStart) return { label: '未开始', cls: 'info' };
  if (now >= ev.windowEnd) return { label: '已结束', cls: '' };
  return { label: '进行中', cls: 'ok' };
}

export async function pageEvents(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, '限时活动管理'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      '创建/编辑限时活动（B6）。玩家端仅在「进行中」窗口可见。任务 kind 仅 pve.clear / pvp.win / ad.watch；' +
      '奖励 kind 仅 coins（需正整数 count）/ material / skin（需 id）。'),
  );

  const formBox = h('div', { class: 'card', style: 'margin-bottom:12px' });
  const list = h('div', {}, '加载中…');
  root.append(formBox, list);

  // 默认任务/奖励示例（运营照此改）。
  const SAMPLE_TASKS: EventTaskDef[] = [
    { taskId: 'pve3', kind: 'pve.clear', target: 3, points: 1 },
    { taskId: 'pvp1', kind: 'pvp.win', target: 1, points: 2 },
  ];
  const SAMPLE_REWARDS: EventRewardDef[] = [
    { rewardId: 'r1', cost: 3, kind: 'coins', count: 2, maxClaims: 1 },
    { rewardId: 'r2', cost: 6, kind: 'material', id: 'ink_blue', count: 5, maxClaims: 3 },
  ];

  // 编辑态：null = 新建；否则编辑该活动。
  let editing: EventDoc | null = null;

  const renderForm = (): void => {
    clear(formBox);
    const isEdit = editing !== null;
    const idInput = h('input', { style: 'width:100%', placeholder: '留空=自动生成 UUID',
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
    const saveBtn = h('button', {}, isEdit ? '保存修改' : '创建活动') as HTMLButtonElement;

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
        showErr(status, new Error(`任务/奖励 JSON 解析失败：${(e as Error).message}`));
        return;
      }
      const windowStart = localInputToMs(startInput.value);
      const windowEnd = localInputToMs(endInput.value);
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
        showErr(status, new Error('开始/结束时间无效'));
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
        h('strong', {}, isEdit ? `编辑活动 ${editing!._id}` : '新建活动'),
        isEdit && h('button', { class: 'ghost', onclick: () => { editing = null; renderForm(); } }, '取消编辑'),
      ),
      fieldRow('eventId', idInput),
      fieldRow('活动名称 title（≤80）', titleInput),
      fieldRow('简介 description（可选）', descInput),
      h('div', { style: 'display:flex;gap:16px' },
        fieldRow('开始时间', startInput),
        fieldRow('结束时间', endInput),
      ),
      fieldRow('任务 tasks（JSON 数组：{taskId,kind,target,points}）', tasksTa),
      fieldRow('奖励 rewards（JSON 数组：{rewardId,cost,kind,id?,count?,maxClaims?}）', rewardsTa),
      h('div', { style: 'margin-top:8px' }, saveBtn, ' ', status),
    );
  };

  const refresh = async (): Promise<void> => {
    try {
      const events = await api.events();
      clear(list);
      if (!events.length) {
        list.append(h('div', { class: 'muted' }, '暂无活动。用上方表单创建。'));
        return;
      }
      for (const ev of events) {
        const st = eventStatus(ev);
        const delErr = h('span', {});
        const editBtn = h('button', { class: 'ghost', onclick: () => { editing = ev; renderForm(); window.scrollTo(0, 0); } }, '编辑');
        const delBtn = h('button', { class: 'ghost danger' }, '删除') as HTMLButtonElement;
        delBtn.onclick = async (): Promise<void> => {
          if (!confirm(`确认删除活动「${ev.title}」？参与历史保留，但活动立即对玩家不可见。`)) return;
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
              `任务 ${ev.tasks.length} · 奖励 ${ev.rewards.length}`),
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
