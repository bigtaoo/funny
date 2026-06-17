// 运维后台各页面渲染（OPS_DESIGN §7）。纯 DOM；按 capabilities 已在 app.ts 决定可见性。
import type { Api } from './api';
import { ApiError } from './api';
import { clear, fmtTime, h, pill } from './dom';
import type {
  AdminAccountView,
  CompAttachment,
  CompScope,
  CompTarget,
  CompTicketView,
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

    // ── 并行拉三种数据 + 监控概览 ──
    const [summary, evCounts, dau, funnel] = await Promise.allSettled([
      api.analyticsSummary(),
      api.analyticsEvents('event_counts', days),
      api.analyticsEvents('dau', days),
      api.analyticsEvents('funnel', days),
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

    // 事件计数
    if (evCounts.status === 'fulfilled' && evCounts.value.available && evCounts.value.event_counts?.length) {
      const rows = evCounts.value.event_counts;
      // 收集所有事件类型（列）和日期（行）。
      const events = [...new Set(rows.map((r) => r.event))].sort();
      const dates = [...new Set(rows.map((r) => r.date))].sort();
      const lookup = new Map(rows.map((r) => [`${r.date}:${r.event}`, r.count]));

      const header = h('tr', {}, h('th', {}, '日期'), ...events.map((e) => h('th', {}, e)));
      const t = h('table', {}, header);
      for (const date of dates) {
        t.append(h('tr', {}, h('td', {}, date), ...events.map((e) => h('td', { style: 'text-align:right' }, String(lookup.get(`${date}:${e}`) ?? 0)))));
      }
      body.append(h('div', { class: 'card', style: 'overflow-x:auto' }, h('div', { class: 'muted' }, `事件计数（近 ${days} 天）`), t));
    } else if (evCounts.status === 'fulfilled' && !evCounts.value.available) {
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, '埋点服务未配置（NW_ANALYTICS_BASE_URL）')));
    }

    // DAU 趋势
    if (dau.status === 'fulfilled' && dau.value.available && dau.value.dau?.length) {
      const pts = dau.value.dau;
      const t = h('table', {}, h('tr', {}, h('th', {}, '日期'), h('th', {}, 'DAU（日活设备）')));
      for (const p of pts) t.append(h('tr', {}, h('td', {}, p.date), h('td', { style: 'text-align:right' }, String(p.dau))));
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `DAU 趋势（近 ${days} 天）`), sparkline(pts.map((p) => p.dau)), t));
    }

    // 漏斗转化
    if (funnel.status === 'fulfilled' && funnel.value.available && funnel.value.funnel?.length) {
      const rows = funnel.value.funnel;
      const platforms = [...new Set(rows.map((r) => r.platform))].sort();
      const steps = ['session_start', 'game_start', 'level_attempt', 'level_complete'];

      for (const plat of platforms) {
        const platRows = rows.filter((r) => r.platform === plat);
        // 最新一天的漏斗（取最大 date）。
        const latestDate = platRows.reduce((m, r) => (r.date > m ? r.date : m), '');
        const latest = platRows.filter((r) => r.date === latestDate);
        const byStep = new Map(latest.map((r) => [r.funnel_step, r]));

        const t = h('table', {}, h('tr', {}, h('th', {}, '步骤'), h('th', {}, '人次'), h('th', {}, '转化率')));
        for (const step of steps) {
          const row = byStep.get(step);
          t.append(h('tr', {},
            h('td', {}, step),
            h('td', { style: 'text-align:right' }, row ? String(row.count) : '—'),
            h('td', { style: 'text-align:right' }, row?.conversion_rate !== undefined ? (row.conversion_rate * 100).toFixed(1) + '%' : '—'),
          ));
        }
        body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `漏斗转化（${plat}，${latestDate}）`), t));
      }
    }

    if (evCounts.status === 'rejected') showErr(err, evCounts.reason);
  };

  refreshBtn.addEventListener('click', () => void reload());
  daysSel.addEventListener('change', () => void reload());
  await reload();
}

// ───────────────────────── 玩家查询 ─────────────────────────
export function pagePlayer(ctx: Ctx): void {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, '玩家查询'));
  const input = h('input', { placeholder: '9 位公开 id', maxlength: '9' });
  const err = h('div', { class: 'err' });
  const out = h('div', { class: 'card' });
  out.style.display = 'none';
  const go = async (): Promise<void> => {
    err.textContent = '';
    out.style.display = 'none';
    try {
      const p = await api.player(input.value.trim());
      clear(out);
      const rows: [string, string][] = [
        ['公开 id', '#' + p.publicId],
        ['昵称', p.displayName ?? '—'],
        ['段位', p.rank ?? '—'],
        ['ELO', p.elo !== undefined ? String(p.elo) : '—'],
        ['胜 / 负', p.wins !== undefined ? `${p.wins} / ${p.losses ?? 0}` : '—'],
      ];
      const t = h('table', {});
      for (const [k, v] of rows) t.append(h('tr', {}, h('th', {}, k), h('td', {}, v)));
      out.append(t);
      out.style.display = '';
    } catch (e) {
      showErr(err, e);
    }
  };
  root.append(h('div', { class: 'card' }, h('div', { class: 'row' }, input, h('button', { onclick: go }, '查询')), err), out);
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
  const canApprove = caps.includes(approveCap as never) && !isMine;
  if (tk.status === 'pending') {
    if (canApprove) {
      buttons.push(h('button', { onclick: () => void act('approve') }, '批准'));
      buttons.push(h('button', { class: 'warn', onclick: () => void act('reject', prompt('拒绝原因？') ?? '') }, '拒绝'));
    }
    if (isMine || session.admin.role === 'super') buttons.push(h('button', { class: 'ghost', onclick: () => void act('cancel') }, '撤销'));
  }
  if (tk.status === 'failed' && canApprove) buttons.push(h('button', { class: 'warn', onclick: () => void act('retry') }, '重试'));

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
