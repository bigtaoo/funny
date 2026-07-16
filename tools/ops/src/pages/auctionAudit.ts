// SLG anomalous trade audit page (G7 anti-RMT, §17.7; slg.audit.view / slg.audit.manage):
// scan for suspicious seller→buyer pairs, file audit tickets, then adjudicate.
import { clear, fmtTime, h, pill } from '../dom';
import type { AuctionAnomaly, TradeAuditTicketView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageAuctionAudit(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  const canManage = session.capabilities.includes('slg.audit.manage');
  clear(root);
  root.append(
    h('h2', {}, 'SLG Auction anomaly audit'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Anti-RMT: scan for suspicious seller→buyer pairs, file audit tickets, then adjudicate (dismiss = false positive; action = confirmed violation). ' +
      'Actioning a ticket automatically bans both parties (best-effort); the result is shown per ticket below.'),
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
    if (tk.enforcement) {
      const { sellerBanned, buyerBanned } = tk.enforcement;
      buttons.push(h('div', { class: 'muted', style: 'font-size:12px' },
        `Enforcement: seller ${sellerBanned ? 'banned' : 'ban failed'}, buyer ${buyerBanned ? 'banned' : 'ban failed'}`));
    }
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
