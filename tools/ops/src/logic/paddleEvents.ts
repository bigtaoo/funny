// Pure layer for the Paddle webhook event log (support/CS lookup, COMMERCIAL_DESIGN §10.4;
// ADR-070 Phase 4e).
import type { PaddleEventView } from '../types';

/**
 * Search filter for what the operator typed. Both fields blank is legal and deliberate — it means
 * "the most recent events", which is the useful default when someone has neither id to hand.
 */
export function paddleQuery(accountId: string, transactionId: string): { accountId?: string; transactionId?: string } {
  const a = accountId.trim();
  const t = transactionId.trim();
  return {
    ...(a ? { accountId: a } : {}),
    ...(t ? { transactionId: t } : {}),
  };
}

/**
 * The raw webhook body, re-indented for reading. Paddle sends valid JSON, but this row may be the
 * only record of a body that was NOT (a truncated write, a future format) — so an unparseable value
 * is shown verbatim rather than swallowed, since being unreadable is itself the finding.
 */
export function prettyRawEvent(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function detailTitle(e: Pick<PaddleEventView, 'eventType' | 'transactionId'>): string {
  return `${e.eventType} — ${e.transactionId}`;
}

/** One row's text cells; `ts` stays a number for the DOM half to format. */
export function paddleCells(e: PaddleEventView): { eventType: string; status: string; transactionId: string; accountId: string } {
  return {
    eventType: e.eventType,
    status: e.status ?? '—',
    transactionId: e.transactionId,
    accountId: e.accountId ?? '—',
  };
}
