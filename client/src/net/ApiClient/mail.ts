// Social: mail (S6-3, requires login token). Claim goes through commercial + inventory, pushes back authoritative save.
import type { SaveData } from '../../game/meta/SaveData';
import { type Constructor, type ApiClientBaseCtor } from './base';
import type { MailView } from './types';

export interface MailApi {
  getMail(): Promise<{ mail: MailView[]; unread: number }>;
  readMail(mailId: string): Promise<void>;
  claimMail(mailId: string): Promise<{ save: SaveData }>;
  deleteMail(mailId: string): Promise<void>;
  sendMail(toPublicId: string, subject: string, body: string): Promise<string>;
}

export function MailMixin<TBase extends ApiClientBaseCtor>(Base: TBase): TBase & Constructor<MailApi> {
  return class extends Base {
    /** Inbox (mail list + unread count). */
    async getMail(): Promise<{ mail: MailView[]; unread: number }> {
      return this.request<{ mail: MailView[]; unread: number }>('GET', '/mail');
    }

    /** Mark a mail as read. */
    async readMail(mailId: string): Promise<void> {
      await this.post<{ ok: boolean }>(`/mail/${encodeURIComponent(mailId)}/read`, {});
    }

    /** Claim attachment (grants coins/items, idempotent) → pushes back authoritative save. Already claimed → ApiError('ALREADY_CLAIMED'); no attachment → 'NO_ATTACHMENT'. */
    async claimMail(mailId: string): Promise<{ save: SaveData }> {
      return this.post<{ save: SaveData }>(`/mail/${encodeURIComponent(mailId)}/claim`, {});
    }

    /** Delete a mail. */
    async deleteMail(mailId: string): Promise<void> {
      await this.request<{ ok: boolean }>('DELETE', `/mail/${encodeURIComponent(mailId)}`);
    }

    /** Send mail between players (gated to friends only, no attachments). Not friends → ApiError('NOT_FRIEND'). */
    async sendMail(toPublicId: string, subject: string, body: string): Promise<string> {
      const data = await this.post<{ mailId: string }>('/mail/send', { toPublicId, subject, body });
      return data.mailId;
    }
  };
}
