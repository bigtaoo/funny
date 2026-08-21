// Pure layer for the compensation ticket page (OPS_DESIGN §7; ADR-070 Phase 4e).
//
// The interesting half of this file is `ticketActions`: which buttons a ticket offers is the ops
// console's most involved permission decision (four-eyes approval, the single-super-admin transitional
// exemption, who may cancel), it mirrors rules the backend also enforces, and it was previously a
// twenty-line `if` cascade inside a row builder where nothing could reach it. It is UX only — the
// backend re-decides every one of these, and deliberately gets the last word on self-approval.
import type { AdminCapability, CompAttachment, CompScope, CompTarget, CompTicketView, Session } from '../types';
import { adminLabel, plural } from './shared';

/** The status filter's options; '' means "All" and is sent as no filter at all. */
export const TICKET_STATUSES = ['', 'pending', 'approved', 'executed', 'rejected', 'cancelled', 'failed'];

/** Not `publicIdLabel`: the discriminator here is which SHAPE the target has, not whether an id is set. */
export function describeTarget(target: CompTarget): string {
  return 'publicId' in target ? '#' + target.publicId : `all-server(${target.filter.kind})`;
}

export function describeAttachments(att: CompAttachment[]): string {
  return att.map((a) => (a.kind === 'coins' ? `${a.count ?? 0} coins` : `${a.kind}:${a.id ?? '?'}×${a.count ?? 1}`)).join(', ') || 'none';
}

/**
 * Which approval capability this particular ticket needs — mirrors the backend: a global-scope
 * payout needs `comp.approve.global`, an over-quota single needs the over-quota variant, everything
 * else the plain single one.
 */
export function approveCapFor(tk: Pick<CompTicketView, 'scope' | 'amountTier'>): AdminCapability {
  if (tk.scope === 'global') return 'comp.approve.global';
  return tk.amountTier === 'overquota' ? 'comp.approve.single.overquota' : 'comp.approve.single';
}

export type TicketAction = 'approve' | 'approve-self' | 'reject' | 'cancel' | 'retry';

/**
 * The actions this ticket offers the given operator, in button order.
 *
 * - `approve` + `reject` — a qualified approver who did NOT initiate it: ordinary four-eyes.
 * - `approve-self` — a qualified approver who DID initiate it. Shown optimistically for the
 *   single-super-admin transitional mode; the backend makes the final call and returns 403 if a
 *   second qualified approver exists, restoring four-eyes. `reject` is deliberately absent: rejection
 *   has no self-approval exemption, and cancelling is the initiator's route to the same outcome.
 * - `cancel` — the initiator, or any super-admin.
 * - `retry` — a failed execution, for anyone who could have approved it.
 */
export function ticketActions(tk: CompTicketView, session: Session): TicketAction[] {
  const caps: readonly string[] = session.capabilities;
  const hasApproveCap = caps.includes(approveCapFor(tk));
  const isMine = tk.initiatedBy === session.admin.id;
  const actions: TicketAction[] = [];
  if (tk.status === 'pending') {
    if (hasApproveCap && !isMine) actions.push('approve', 'reject');
    else if (hasApproveCap && isMine) actions.push('approve-self');
    if (isMine || session.admin.role === 'super') actions.push('cancel');
  }
  if (tk.status === 'failed' && hasApproveCap) actions.push('retry');
  return actions;
}

/** Whether the create form is worth rendering at all. */
export function canInitiate(session: Session): boolean {
  const caps: readonly string[] = session.capabilities;
  return caps.includes('comp.initiate.single') || caps.includes('comp.initiate.global');
}

/** The initiator/approver columns. `approvedBy` is absent until someone approves, hence the em dash. */
export function ticketPeople(tk: CompTicketView): { initiated: string; approved: string } {
  return {
    initiated: adminLabel(tk.initiatedByName, tk.initiatedBy),
    approved: adminLabel(tk.approvedByName, tk.approvedBy),
  };
}

/** `undefined` for the "All" option — the endpoint takes no filter rather than an empty one. */
export function statusFilter(value: string): string | undefined {
  return value || undefined;
}

// ── Create form ──

export const DEFAULT_EXPIRE_DAYS = 30;

/**
 * The ticket payload from raw form values. Zero (or unparseable) coins attaches nothing rather than a
 * zero-coin attachment, which would render as "0 coins" in the player's mail for no reason.
 */
export function ticketInput(fields: {
  scope: string;
  publicId: string;
  subject: string;
  body: string;
  coins: string;
  expireDays: string;
  reason: string;
}): { scope: CompScope; target: CompTarget; mail: { subject: string; body: string; attachments: CompAttachment[]; expireDays: number }; reason: string } {
  const coins = Number(fields.coins) || 0;
  return {
    scope: fields.scope as CompScope,
    target: buildTarget(fields.scope, fields.publicId),
    mail: {
      subject: fields.subject.trim(),
      body: fields.body.trim(),
      attachments: coins > 0 ? [{ kind: 'coins', count: coins }] : [],
      expireDays: Number(fields.expireDays) || DEFAULT_EXPIRE_DAYS,
    },
    reason: fields.reason.trim(),
  };
}

export function buildTarget(scope: string, publicId: string): CompTarget {
  return scope === 'single' ? { publicId: publicId.trim() } : { filter: { kind: 'all' } };
}

/** The dry-run readout. "not ready" is its own case: 0 recipients and "cannot tell" differ. */
export function previewText(r: { recipientCount: number; available: boolean }): string {
  return `Estimated ${plural(r.recipientCount, 'recipient')}${r.available ? '' : ' (mail backend not ready, estimate unavailable)'}`;
}
