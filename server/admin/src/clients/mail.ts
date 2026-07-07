import { internalHeaders, type CompAttachment, type CompTarget } from '@nw/shared';

// ── Mail delivery (meta system mail endpoint, OPS_DESIGN §4.1 / §3.3) ─────
// Compensation execution = create a system mail (wallet is never touched). Endpoint implemented per SOCIAL_DESIGN S6-3, mail backend built in parallel;
// admin wires the contract shape first. When available=false (not configured) or the endpoint is absent (404/501), execution fails → ticket
// marked as failed and retryable, to be re-run after the mail backend is ready for integration.
export interface MailSendReq {
  /** Idempotency key (ticket dispatchKey) — prevents duplicate execution. */
  dispatchKey: string;
  scope: 'single' | 'global';
  target: CompTarget;
  subject: string;
  body: string;
  attachments: CompAttachment[];
  expireDays: number;
}
export interface MailSendRes {
  ok: boolean;
  recipientCount?: number;
  error?: string;
}
export interface MailPreviewReq {
  scope: 'single' | 'global';
  target: CompTarget;
}
export interface MailPreviewRes {
  ok: boolean;
  recipientCount: number;
  error?: string;
}

export interface MailDispatcher {
  readonly available: boolean;
  send(req: MailSendReq): Promise<MailSendRes>;
  preview(req: MailPreviewReq): Promise<MailPreviewRes>;
}

export class HttpMailDispatcher implements MailDispatcher {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async send(req: MailSendReq): Promise<MailSendRes> {
    if (!this.metaBaseUrl) return { ok: false, error: 'mail backend unavailable' };
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/mail/system/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
        body: JSON.stringify(req),
      });
      if (res.status === 404 || res.status === 501) {
        return { ok: false, error: 'mail endpoint not yet available (S6-3)' };
      }
      if (!res.ok) return { ok: false, error: `mail send failed: HTTP ${res.status}` };
      return (await res.json()) as MailSendRes;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async preview(req: MailPreviewReq): Promise<MailPreviewRes> {
    if (!this.metaBaseUrl) return { ok: false, recipientCount: 0, error: 'mail backend unavailable' };
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/mail/system/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
        body: JSON.stringify(req),
      });
      if (res.status === 404 || res.status === 501) {
        return { ok: false, recipientCount: 0, error: 'mail endpoint not yet available (S6-3)' };
      }
      if (!res.ok) return { ok: false, recipientCount: 0, error: `preview failed: HTTP ${res.status}` };
      return (await res.json()) as MailPreviewRes;
    } catch (e) {
      return { ok: false, recipientCount: 0, error: (e as Error).message };
    }
  }
}
