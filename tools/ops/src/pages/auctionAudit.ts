// SLG anomalous trade audit page (G7 anti-RMT, §17.7; slg.audit.view / slg.audit.manage):
// look up individual auction listings, scan for suspicious seller→buyer pairs, file audit tickets, then adjudicate.
// Query assembly, the pill palettes and every derived label live in src/logic/auctionAudit.ts (4e).
import { clear, fmtTime, h, pill } from '../dom';
import {
  anomaliesFoundText, auditResolvedByText, auditTicketFiledBy, auditTicketStatusCls, canAdjudicate,
  completedText, enforcementText, listingCloseTs, listingItemText, listingPriceLabel, listingQuery,
  listingSettlementCls, listingSettlementText, listingsFoundText, listingStatusCls, noAnomaliesText,
  noSettlementsText, owedSummary, resolvePrompt, scanWindowSec, sellerBuyerText, settlementAttemptsText,
  settlementCycleText, settlementPhaseText, settlementQuery, settlementRowCls, settlementsFoundText,
  settlementTimingText, severityCls, snapshotOf,
} from '../logic/auctionAudit';
import type {
  AuctionAnomaly, AuctionListingAdminView, AuctionSettlementDebtView, TradeAuditTicketView,
} from '../types';
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

  // ── Listing lookup (any status: open/sold/cancelled/expired) ──
  const lookupSellerInput = h('input', { placeholder: 'sellerId' }) as HTMLInputElement;
  const lookupItemTypeSel = h('select', {},
    h('option', { value: '' }, 'Any item type'),
    h('option', { value: 'material' }, 'material'),
    h('option', { value: 'equipment' }, 'equipment'),
    h('option', { value: 'card' }, 'card'),
    h('option', { value: 'skin' }, 'skin'),
  ) as HTMLSelectElement;
  const lookupStatusSel = h('select', {},
    h('option', { value: '' }, 'Any status'),
    h('option', { value: 'open' }, 'open'),
    h('option', { value: 'sold' }, 'sold'),
    h('option', { value: 'cancelled' }, 'cancelled'),
    h('option', { value: 'expired' }, 'expired'),
  ) as HTMLSelectElement;
  const lookupItemNameInput = h('input', { placeholder: 'item name (material / defId / skinId, substring)' }) as HTMLInputElement;
  const lookupErr = h('div', { class: 'err' });
  const lookupOut = h('div', { class: 'card' });
  lookupOut.style.display = 'none';

  const runLookup = async (): Promise<void> => {
    const query = listingQuery({
      sellerId: lookupSellerInput.value,
      itemType: lookupItemTypeSel.value,
      status: lookupStatusSel.value,
      itemName: lookupItemNameInput.value,
    });
    if (!query.ok) {
      showErr(lookupErr, new Error(query.error));
      return;
    }
    lookupErr.textContent = '';
    clear(lookupOut);
    try {
      const listings = await api.slgQueryAuctionListings(query.filter);
      lookupOut.style.display = '';
      if (listings.length === 0) {
        lookupOut.append(h('div', { class: 'muted' }, 'No matching listings.'));
        return;
      }
      lookupOut.append(h('div', { class: 'muted' }, listingsFoundText(listings.length)));
      const t = h('table', {},
        h('tr', {},
          h('th', {}, 'Auction ID'),
          h('th', {}, 'Seller'),
          h('th', {}, 'Item'),
          h('th', {}, 'Qty'),
          h('th', {}, 'Price'),
          h('th', {}, 'Sale mode'),
          h('th', {}, 'Status'),
          h('th', {}, 'Designated buyer'),
          h('th', {}, 'Buyer'),
          h('th', {}, 'Settled'),
          h('th', {}, 'Expire / closed'),
        ),
      );
      for (const l of listings) t.append(listingRow(l));
      lookupOut.append(t);
    } catch (e) {
      showErr(lookupErr, e);
      lookupOut.style.display = 'none';
    }
  };

  root.append(
    h('div', { class: 'card', style: 'margin-bottom:12px' },
      h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Look up listings (any status) by seller / item type / item name'),
      h('div', { class: 'row' },
        h('div', {}, h('label', {}, 'Seller ID'), lookupSellerInput),
        h('div', {}, h('label', {}, 'Item type'), lookupItemTypeSel),
        h('div', {}, h('label', {}, 'Status'), lookupStatusSel),
        h('div', {}, h('label', {}, 'Item name'), lookupItemNameInput),
        h('button', { onclick: runLookup }, 'Search'),
      ),
      lookupErr,
    ),
    lookupOut,
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
      const anomalies = await api.slgScanAnomalies(worldId, scanWindowSec(windowInput.value));
      scanOut.style.display = '';
      if (anomalies.length === 0) {
        scanOut.append(h('div', { class: 'muted' }, noAnomaliesText(worldId)));
        return;
      }
      scanOut.append(h('div', { class: 'muted' }, anomaliesFoundText(anomalies.length, worldId)));
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

  // ── Owed settlements (U13 close-out) ──
  // The one auction state that used to exist only in a log line: a settlement that closed the listing but
  // has not managed to hand the item or the coins over. auctionsvc retries these forever on its own
  // backoff, so this table is deliberately read-only — a "retry now" button would just race the sweep.
  const owedAuctionInput = h('input', { placeholder: 'auctionId (optional)' }) as HTMLInputElement;
  const owedAccountInput = h('input', { placeholder: 'accountId (actor or anyone owed, optional)' }) as HTMLInputElement;
  const owedMinAttemptsInput = h('input', { type: 'number', min: '0', style: 'width:120px', placeholder: 'min attempts' }) as HTMLInputElement;
  const owedErr = h('div', { class: 'err' });
  const owedOut = h('div', { class: 'card' });
  owedOut.style.display = 'none';

  const runOwed = async (): Promise<void> => {
    const query = settlementQuery({
      auctionId: owedAuctionInput.value,
      accountId: owedAccountInput.value,
      minAttempts: owedMinAttemptsInput.value,
    });
    if (!query.ok) {
      showErr(owedErr, new Error(query.error));
      return;
    }
    owedErr.textContent = '';
    clear(owedOut);
    try {
      const debts = await api.slgListSettlementDebts(query.filter);
      owedOut.style.display = '';
      if (debts.length === 0) {
        owedOut.append(h('div', { class: 'muted' }, noSettlementsText(Object.keys(query.filter).length > 0)));
        return;
      }
      owedOut.append(h('div', { class: 'muted' }, settlementsFoundText(debts.length)));
      const t = h('table', {},
        h('tr', {},
          h('th', {}, 'Order ID'),
          h('th', {}, 'Flow'),
          h('th', {}, 'Actor'),
          h('th', {}, 'Still owed'),
          h('th', {}, 'Already done'),
          h('th', {}, 'Attempts'),
          h('th', {}, 'Cycle'),
          h('th', {}, 'Timing'),
        ),
      );
      for (const d of debts) t.append(settlementRow(d));
      owedOut.append(t);
    } catch (e) {
      showErr(owedErr, e);
      owedOut.style.display = 'none';
    }
  };

  root.append(
    h('div', { class: 'card', style: 'margin-bottom:12px' },
      h('div', { class: 'muted', style: 'margin-bottom:6px' },
        'Unfinished settlements — a listing that closed but whose item or proceeds have not been handed over yet. ' +
        'auctionsvc retries every one of these on its own backoff, so this is a read-only view; the rows worth ' +
        'acting on are the ones marked stuck (retried many times and still failing).'),
      h('div', { class: 'row' },
        h('div', {}, h('label', {}, 'Auction ID'), owedAuctionInput),
        h('div', {}, h('label', {}, 'Account ID'), owedAccountInput),
        h('div', {}, h('label', {}, 'Min attempts'), owedMinAttemptsInput),
        h('button', { onclick: runOwed }, 'List owed'),
      ),
      owedErr,
    ),
    owedOut,
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

function listingRow(l: AuctionListingAdminView): HTMLElement {
  return h('tr', {},
    h('td', { class: 'muted', style: 'font-size:12px' }, l.auctionId),
    h('td', {}, l.sellerId),
    h('td', {}, listingItemText(l)),
    h('td', { style: 'text-align:right' }, String(l.qty)),
    h('td', { style: 'text-align:right' }, listingPriceLabel(l)),
    h('td', {}, l.saleMode),
    h('td', {}, pill(l.status, listingStatusCls(l.status))),
    h('td', {}, l.designatedBuyerId ?? '—'),
    h('td', {}, l.buyerId ?? '—'),
    // A closed listing with no settledAt still owes its hand-over — see the owed-settlements table below
    // for what exactly, and to whom.
    h('td', {}, pill(listingSettlementText(l), listingSettlementCls(l))),
    h('td', { class: 'muted', style: 'font-size:12px' }, fmtTime(listingCloseTs(l))),
  );
}

/**
 * One unfinished settlement. `orderId` is the row a human actually acts on: every downstream key for this
 * settlement is derived from it, so it is what gets pasted into a commercial order or meta mail lookup.
 */
function settlementRow(d: AuctionSettlementDebtView): HTMLElement {
  return h('tr', {},
    h('td', { class: 'muted', style: 'font-size:12px' }, d.orderId),
    h('td', {}, settlementPhaseText(d)),
    h('td', {}, d.actorId),
    h('td', {}, owedSummary(d)),
    h('td', { class: 'muted', style: 'font-size:12px' }, completedText(d)),
    h('td', { style: 'text-align:right' }, pill(settlementAttemptsText(d), settlementRowCls(d))),
    h('td', { class: 'muted', style: 'font-size:12px' }, settlementCycleText(d)),
    h('td', { class: 'muted', style: 'font-size:12px' }, settlementTimingText(d, fmtTime)),
  );
}

function anomalyRow(ctx: Ctx, a: AuctionAnomaly, worldId: string, onTicketFiled: () => Promise<void>): HTMLElement {
  const { api, session } = ctx;
  const canManage = session.capabilities.includes('slg.audit.manage');
  const fileErr = h('span', { class: 'err' });
  const fileBtn = canManage
    ? h('button', {
        onclick: async (): Promise<void> => {
          fileErr.textContent = '';
          try {
            await api.slgFileAuditTicket(snapshotOf(a, worldId));
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
    h('td', {}, pill(a.severity, severityCls(a.severity))),
    h('td', {}, a.reasons.join(', ')),
    h('td', { class: 'muted', style: 'font-size:12px' }, `${fmtTime(a.firstTs)} – ${fmtTime(a.lastTs)}`),
    canManage ? h('td', {}, fileBtn, fileErr) : null,
  );
}

function auditTicketRow(ctx: Ctx, tk: TradeAuditTicketView, onRefresh: () => Promise<void>): HTMLElement {
  const { api, session } = ctx;
  const canManage = session.capabilities.includes('slg.audit.manage');
  const resolveErr = h('span', { class: 'err' });

  const resolve = async (disposition: 'dismissed' | 'actioned'): Promise<void> => {
    const note = prompt(resolvePrompt(disposition)) ?? '';
    resolveErr.textContent = '';
    try {
      await api.slgResolveAuditTicket(tk.id, disposition, note);
      await onRefresh();
    } catch (e) {
      showErr(resolveErr, e);
    }
  };

  const buttons: HTMLElement[] = [];
  if (canAdjudicate(canManage, tk.status)) {
    buttons.push(
      h('button', { class: 'ghost', onclick: () => void resolve('dismissed') }, 'Dismiss'),
      h('button', { class: 'danger', onclick: () => void resolve('actioned') }, 'Action'),
    );
  } else if (tk.status !== 'open') {
    buttons.push(h('span', { class: 'muted', style: 'font-size:12px' }, auditResolvedByText(tk, fmtTime)));
    if (tk.note) buttons.push(h('div', { class: 'muted', style: 'font-size:12px' }, tk.note));
    if (tk.enforcement) {
      buttons.push(h('div', { class: 'muted', style: 'font-size:12px' }, enforcementText(tk.enforcement)));
    }
  }

  const snap = tk.snapshot;
  return h('tr', {},
    h('td', { class: 'muted', style: 'font-size:12px' }, fmtTime(tk.filedAt)),
    h('td', {}, snap.worldId),
    h('td', {}, sellerBuyerText(snap)),
    h('td', { style: 'text-align:right' }, String(snap.trades)),
    h('td', { style: 'text-align:right' }, snap.totalCoins.toLocaleString()),
    h('td', {}, pill(snap.severity, severityCls(snap.severity))),
    h('td', {}, snap.reasons.join(', ')),
    h('td', {}, pill(tk.status, auditTicketStatusCls(tk.status))),
    h('td', { class: 'muted', style: 'font-size:12px' }, auditTicketFiledBy(tk)),
    canManage ? h('td', {}, ...buttons, resolveErr) : null,
  );
}
