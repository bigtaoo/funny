// Pure layer for the UGC report review queue (CONTENT_MODERATION_DESIGN.md CM9/CM11; ADR-070 4e).
import type { PurgeAuthorView, ReportView } from '../types';

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

/** Kind column: whether the row came from an explicit report or a block, plus the category when given. */
export function reportKindText(r: Pick<ReportView, 'source' | 'category'>): string {
  const kind = r.source === 'block' ? 'Block' : 'Report';
  return r.category ? `${kind} · ${r.category}` : kind;
}

/**
 * Content column: channel plus the snapshot, marked when the text only came from the reporter's client (a
 * server-read snapshot is authoritative; a client one could in principle be fabricated). '—' for player-level
 * reports that point at nothing.
 */
export function reportContentText(r: Pick<ReportView, 'contentRef'>): string {
  const ref = r.contentRef;
  if (!ref) return '—';
  if (ref.kind === 'name') return `name: ${ref.snapshot}`;
  if (ref.kind === 'message') return `message ${ref.messageId}`;
  if (!ref.snapshot) return ref.channel;
  const src = ref.snapshotSource === 'client' ? ' (client snapshot)' : '';
  return `${ref.channel}: "${ref.snapshot}"${src}`;
}

/**
 * Whether the row gets a "Delete message" button: the report must point at one removable thing — a message
 * id in a chat channel, or a family announcement. `name`/`mail` have nothing single to delete (purge/ban).
 * Offered in every status: removing content after an uphold is the normal order of operations.
 */
export function canDeleteReportContent(canAction: boolean, r: Pick<ReportView, 'contentRef'>): boolean {
  const ref = r.contentRef;
  if (!canAction || !ref || ref.kind !== 'content') return false;
  if (ref.channel === 'announcement') return true;
  return !!ref.messageId && ['dm', 'family', 'sect', 'world'].includes(ref.channel);
}

export function purgeConfirm(targetId: string): string {
  return `Delete EVERY chat message, family announcement and mail written by accountId ${targetId} (DM, family, sect, world)? This cannot be undone.`;
}

/** Per-backend summary after a purge; a failed half is named so the operator knows to retry it. */
export function purgeMessage(res: PurgeAuthorView): string {
  const part = (label: string, v: PurgeAuthorView['social']): string =>
    'error' in v
      ? `${label}: FAILED (${String(v.error)})`
      : `${label}: ${Object.entries(v).map(([k, n]) => `${k}=${n}`).join(', ')}`;
  return `${part('social', res.social)}; ${part('world', res.world)}`;
}

/** "by <admin>" for a resolved row, or null when there is nothing to attribute. */
export function resolvedByText(r: Pick<ReportView, 'status' | 'resolvedBy'>): string | null {
  return r.status !== 'open' && r.resolvedBy ? `by ${r.resolvedBy}` : null;
}
