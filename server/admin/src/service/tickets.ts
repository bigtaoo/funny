// Compensation ticket flow (OPS_DESIGN §3): initiate → approve (four-eyes) → auto-execute (system mail),
// plus reject / cancel / retry + list. Enforces initiator ≠ approver, quota → approval capability, and the
// ticket state machine. All state transitions are audited.
import { randomUUID } from 'node:crypto';
import {
  ADMIN_ROLES,
  requiredApproveCapability,
  requiredInitiateCapability,
  roleHasCapability,
  tierForAttachments,
  totalCoinValue,
  createLogger,
  type AdminCapability,
  type CompMailContent,
  type CompTarget,
  type CompTicketStatus,
  type CompTicketView,
} from '@nw/shared';
import type { CompTicketDoc } from '../db';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';
import { validateMail, validateTarget, describeTarget } from './validators';

const log = createLogger('admin:service');

export interface TicketsHandlers {
  initiateTicket(
    actor: Actor,
    input: { scope: string; target: CompTarget; mail: CompMailContent; reason: string },
  ): Promise<CompTicketView>;
  listTickets(filter: { status?: string }): Promise<CompTicketView[]>;
  approveTicket(actor: Actor, id: string): Promise<CompTicketView>;
  rejectTicket(actor: Actor, id: string, note: string): Promise<CompTicketView>;
  cancelTicket(actor: Actor, id: string): Promise<CompTicketView>;
  preview(input: { scope: string; target: CompTarget }): Promise<{ recipientCount: number; available: boolean }>;
  retryTicket(actor: Actor, id: string): Promise<CompTicketView>;
}

const ALL_TICKET_STATUS: readonly CompTicketStatus[] = [
  'pending',
  'approved',
  'executed',
  'rejected',
  'cancelled',
  'failed',
];

export function TicketsMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<TicketsHandlers> {
  return class extends Base {
    // ───────────────────────── Compensation tickets ─────────────────────────

    async initiateTicket(
      actor: Actor,
      input: { scope: string; target: CompTarget; mail: CompMailContent; reason: string },
    ): Promise<CompTicketView> {
      const scope = input.scope;
      if (scope !== 'single' && scope !== 'global') {
        throw new AdminError(400, 'bad_request', 'scope must be single|global');
      }
      // Validate initiation capability (single player vs. all players).
      this.requireCap(actor, requiredInitiateCapability(scope));

      const reason = (input.reason ?? '').trim();
      if (!reason) throw new AdminError(400, 'bad_request', 'reason required');
      const mail = validateMail(input.mail);
      const target = validateTarget(scope, input.target);

      // Single-player compensation is tiered by total attachment value; global compensation always requires super-admin approval (amountTier is audit semantics only; the capability is determined by scope).
      const amountTier = scope === 'global' ? 'overquota' : tierForAttachments(mail.attachments);

      const doc: CompTicketDoc = {
        _id: randomUUID(),
        scope,
        target,
        mail,
        reason,
        status: 'pending',
        amountTier,
        initiatedBy: actor.adminId,
        initiatedAt: this.now(),
        dispatchKey: randomUUID(),
      };
      await this.cols.compTickets.insertOne(doc);
      await this.audit(actor.adminId, 'comp.initiate', {
        target: doc._id,
        summary: `${scope} ${describeTarget(target)} value=${totalCoinValue(mail.attachments)} tier=${amountTier}`,
      });
      return this.toTicketView(doc);
    }

    async listTickets(filter: { status?: string }): Promise<CompTicketView[]> {
      const q: Partial<Record<'status', CompTicketStatus>> = {};
      if (filter.status) {
        if (!ALL_TICKET_STATUS.includes(filter.status as CompTicketStatus)) {
          throw new AdminError(400, 'bad_request', 'invalid status');
        }
        q.status = filter.status as CompTicketStatus;
      }
      const docs = await this.cols.compTickets.find(q).sort({ initiatedAt: -1 }).limit(200).toArray();
      return Promise.all(docs.map((d) => this.toTicketView(d)));
    }

    /**
     * Approve → auto-execute (OPS_DESIGN §3.3). Validates: ① ticket is pending; ② approver ≠ initiator;
     * ③ approver has the capability required for this scope/tier. On passing, sets status to approved and immediately executes (dispatches the system mail).
     */
    async approveTicket(actor: Actor, id: string): Promise<CompTicketView> {
      const doc = await this.cols.compTickets.findOne({ _id: id });
      if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
      if (doc.status !== 'pending') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
      const cap = requiredApproveCapability(doc.scope, doc.amountTier);
      // Four-eyes principle: the initiator must not approve their own ticket. However, if there are no other eligible approvers for this ticket
      // (typical case: only one super admin exists, and global/over-quota tickets can only be approved by super), strict four-eyes would cause permanent deadlock.
      // Therefore, self-approval is only blocked when another eligible approver exists; otherwise self-approval is permitted and explicitly flagged (selfApproved).
      // TODO(single-super-exception): remove this exception once a second operator with the corresponding approval capability is on-boarded, restoring hard initiator ≠ approver enforcement.
      let selfApproved = false;
      if (doc.initiatedBy === actor.adminId) {
        if (await this.hasOtherEligibleApprover(doc.initiatedBy, cap)) {
          throw new AdminError(403, 'forbidden', 'initiator cannot approve own ticket');
        }
        selfApproved = true;
      }
      this.requireCap(actor, cap);

      const res = await this.cols.compTickets.findOneAndUpdate(
        { _id: id, status: 'pending' },
        { $set: { status: 'approved', approvedBy: actor.adminId, approvedAt: this.now() } },
        { returnDocument: 'after' },
      );
      if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
      await this.audit(actor.adminId, 'comp.approve', {
        target: id,
        summary: selfApproved ? `${doc.scope} [SELF-APPROVED:no-other-approver]` : doc.scope,
      });

      return this.execute(res);
    }

    /**
     * Whether there is another admin — other than the initiator, currently active (not disabled), and possessing the given approval capability.
     * Determines whether four-eyes can be enforced: present → another person must approve; absent → self-approval allowed (single-super exception, see approveTicket).
     */
    private async hasOtherEligibleApprover(initiatorId: string, cap: AdminCapability): Promise<boolean> {
      const eligibleRoles = ADMIN_ROLES.filter((r) => roleHasCapability(r, cap));
      const count = await this.cols.adminAccounts.countDocuments({
        _id: { $ne: initiatorId },
        disabled: { $ne: true },
        // Seed super-admins are dormant backup/bootstrap accounts, not active operators; exclude them (otherwise the seed would always block a single super from self-approving).
        seed: { $ne: true },
        role: { $in: eligibleRoles },
      });
      return count > 0;
    }

    async rejectTicket(actor: Actor, id: string, note: string): Promise<CompTicketView> {
      const doc = await this.cols.compTickets.findOne({ _id: id });
      if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
      if (doc.status !== 'pending') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
      if (doc.initiatedBy === actor.adminId) {
        throw new AdminError(403, 'forbidden', 'initiator cannot reject own ticket');
      }
      this.requireCap(actor, requiredApproveCapability(doc.scope, doc.amountTier));
      const res = await this.cols.compTickets.findOneAndUpdate(
        { _id: id, status: 'pending' },
        { $set: { status: 'rejected', approvedBy: actor.adminId, approvedAt: this.now(), error: note } },
        { returnDocument: 'after' },
      );
      if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
      await this.audit(actor.adminId, 'comp.reject', { target: id, summary: note });
      return this.toTicketView(res);
    }

    /** Cancel a ticket (pending only; initiator or super admin). */
    async cancelTicket(actor: Actor, id: string): Promise<CompTicketView> {
      const doc = await this.cols.compTickets.findOne({ _id: id });
      if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
      if (doc.status !== 'pending') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
      if (doc.initiatedBy !== actor.adminId && actor.role !== 'super') {
        throw new AdminError(403, 'forbidden', 'only initiator or super can cancel');
      }
      const res = await this.cols.compTickets.findOneAndUpdate(
        { _id: id, status: 'pending' },
        { $set: { status: 'cancelled', approvedBy: actor.adminId, approvedAt: this.now() } },
        { returnDocument: 'after' },
      );
      if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
      await this.audit(actor.adminId, 'comp.cancel', { target: id });
      return this.toTicketView(res);
    }

    /** Dry-run preview of how many players a global compensation would reach (OPS_DESIGN §3.3 safety valve). */
    async preview(input: { scope: string; target: CompTarget }): Promise<{ recipientCount: number; available: boolean }> {
      if (input.scope !== 'single' && input.scope !== 'global') {
        throw new AdminError(400, 'bad_request', 'scope must be single|global');
      }
      const target = validateTarget(input.scope, input.target);
      if (input.scope === 'single') return { recipientCount: 1, available: true };
      const r = await this.mail.preview({ scope: 'global', target });
      return { recipientCount: r.recipientCount, available: r.ok };
    }

    /** Retry a failed ticket execution (failed → re-dispatch; dispatchKey is unchanged, so the mail backend prevents duplicates). */
    async retryTicket(actor: Actor, id: string): Promise<CompTicketView> {
      const doc = await this.cols.compTickets.findOne({ _id: id });
      if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
      if (doc.status !== 'failed') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
      this.requireCap(actor, requiredApproveCapability(doc.scope, doc.amountTier));
      return this.execute(doc);
    }

    /**
     * Executor: calls the meta system-mail endpoint (idempotent via dispatchKey). On success sets status to executed (backfills recipientCount);
     * on failure sets status to failed (retryable). Execution ≠ credit — it only delivers the mail to the player's inbox; the reward is credited via commercial/inventory when the player claims it.
     */
    private async execute(doc: CompTicketDoc): Promise<CompTicketView> {
      const res = await this.mail.send({
        dispatchKey: doc.dispatchKey,
        scope: doc.scope,
        target: doc.target,
        subject: doc.mail.subject,
        body: doc.mail.body,
        attachments: doc.mail.attachments,
        expireDays: doc.mail.expireDays,
      });
      if (res.ok) {
        const updated = await this.cols.compTickets.findOneAndUpdate(
          { _id: doc._id },
          {
            $set: {
              status: 'executed',
              executedAt: this.now(),
              ...(typeof res.recipientCount === 'number' ? { recipientCount: res.recipientCount } : {}),
            },
            $unset: { error: '' },
          },
          { returnDocument: 'after' },
        );
        await this.audit(doc.initiatedBy, 'comp.execute', {
          target: doc._id,
          summary: `recipients=${res.recipientCount ?? '?'}`,
        });
        return this.toTicketView(updated ?? doc);
      }
      const err = res.error ?? 'mail dispatch failed';
      const updated = await this.cols.compTickets.findOneAndUpdate(
        { _id: doc._id },
        { $set: { status: 'failed', error: err } },
        { returnDocument: 'after' },
      );
      log.warn('ticket execute failed', { ticketId: doc._id, err });
      await this.audit(doc.initiatedBy, 'comp.execute.failed', { target: doc._id, summary: err });
      return this.toTicketView(updated ?? { ...doc, status: 'failed', error: err });
    }

    private async toTicketView(doc: CompTicketDoc): Promise<CompTicketView> {
      const names = await this.actorNames(
        [doc.initiatedBy, doc.approvedBy].filter((x): x is string => !!x),
      );
      return {
        id: doc._id,
        scope: doc.scope,
        target: doc.target,
        mail: doc.mail,
        reason: doc.reason,
        status: doc.status,
        amountTier: doc.amountTier,
        initiatedBy: doc.initiatedBy,
        ...(names.get(doc.initiatedBy) ? { initiatedByName: names.get(doc.initiatedBy)! } : {}),
        initiatedAt: doc.initiatedAt,
        ...(doc.approvedBy ? { approvedBy: doc.approvedBy } : {}),
        ...(doc.approvedBy && names.get(doc.approvedBy) ? { approvedByName: names.get(doc.approvedBy)! } : {}),
        ...(doc.approvedAt ? { approvedAt: doc.approvedAt } : {}),
        ...(doc.executedAt ? { executedAt: doc.executedAt } : {}),
        ...(typeof doc.recipientCount === 'number' ? { recipientCount: doc.recipientCount } : {}),
        ...(doc.error ? { error: doc.error } : {}),
      };
    }
  };
}
