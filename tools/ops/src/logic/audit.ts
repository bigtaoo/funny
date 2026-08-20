// Pure layer for the audit log page (ADR-070 Phase 4e): turning three form fields into a query, and
// one entry into six strings.
import type { AuditEntryView } from '../types';
import { adminLabel } from './shared';

const DAY_MS = 24 * 3600 * 1000;

/**
 * The `/admin/audit` query for what the operator typed. Each field is omitted rather than sent
 * empty, because the backend treats a missing `actor` as "my own actions" — sending `actor: ''`
 * would be a different request.
 *
 * `canAll` gates the actor field: without `audit.view.all` the input is not even rendered, and the
 * capability is re-checked here so a stale value in a hidden input cannot widen the query. The `to`
 * date is pushed to the END of the selected day, so picking the same date twice covers that one day
 * inclusively instead of returning nothing.
 */
export function auditQuery(input: {
  canAll: boolean;
  actor: string;
  from: string;
  to: string;
}): { actor?: string; from?: number; to?: number } {
  const actor = input.actor.trim();
  const fromMs = input.from ? Date.parse(input.from) : NaN;
  const toMs = input.to ? Date.parse(input.to) + DAY_MS : NaN;
  return {
    ...(input.canAll && actor ? { actor } : {}),
    ...(Number.isFinite(fromMs) ? { from: fromMs } : {}),
    ...(Number.isFinite(toMs) ? { to: toMs } : {}),
  };
}

/** One row's text cells (`ts` stays a number — formatting a timestamp is the DOM half's job). */
export function auditCells(e: AuditEntryView): {
  operator: string;
  action: string;
  target: string;
  summary: string;
  ip: string;
} {
  return {
    operator: adminLabel(e.actorName, e.actor),
    action: e.action,
    target: e.target ?? '—',
    summary: e.summary ?? '—',
    ip: e.ip ?? '—',
  };
}
