// Pure layer for the UGC report review queue (CONTENT_MODERATION_DESIGN.md CM9/CM11; ADR-070 4e).
import type { ReportView } from '../types';

/** Pill colour per status: open needs attention, upheld ended in a penalty, dismissed is benign. */
export function reportStatusCls(status: string): string {
  return status === 'open' ? 'warn' : status === 'upheld' ? 'failed' : 'ok';
}

/**
 * Whether this row gets Dismiss/Uphold buttons. Both halves matter: the capability (a `reports.view`
 * operator reads the queue but cannot act on it) and the status (an already-resolved report is not
 * re-resolvable — the backend rejects it, so offering the button would only produce an error).
 */
export function canResolveReport(canAction: boolean, status: string): boolean {
  return canAction && status === 'open';
}

/** Spelled out because it is destructive and asymmetric: upholding costs the target reputation, dismissing costs nothing. */
export function upholdConfirm(targetId: string): string {
  return `Uphold this report against accountId ${targetId}? This deducts 20 reputation points and may mute/ban depending on the resulting score.`;
}

/**
 * What the operator is told after resolving. The uphold branch echoes the resulting score and the
 * enforcement action the metaserver actually applied — the point of the -20 is the threshold it may
 * cross, and that outcome is not predictable from this page.
 */
export function resolveMessage(
  resolution: 'dismissed' | 'upheld',
  res: { reputationScore?: number; action?: string },
): string {
  return resolution === 'upheld'
    ? `Upheld → score ${res.reputationScore ?? '—'} (${res.action ?? 'none'}).`
    : 'Dismissed.';
}

/** "by <admin>" for a resolved row, or null when there is nothing to attribute. */
export function resolvedByText(r: Pick<ReportView, 'status' | 'resolvedBy'>): string | null {
  return r.status !== 'open' && r.resolvedBy ? `by ${r.resolvedBy}` : null;
}
