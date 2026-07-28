import { fetchInternalJson, type CompAttachment, type CompTarget } from '@nw/shared';

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
    // Global compensation mail fans out to every account (synchronous on the meta side)
    // → long deadline. No retries: the ticket layer retries with the same dispatchKey.
    const r = await fetchInternalJson<MailSendRes>(`${this.metaBaseUrl}/internal/mail/system/send`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body: req,
      timeoutMs: 60000,
      label: 'meta /internal/mail/system/send',
    });
    if (r.status === 404 || r.status === 501) {
      return { ok: false, error: 'mail endpoint not yet available (S6-3)' };
    }
    if (!r.ok || !r.body) return { ok: false, error: r.status ? `mail send failed: HTTP ${r.status}` : r.error ?? 'network error' };
    return r.body;
  }

  async preview(req: MailPreviewReq): Promise<MailPreviewRes> {
    if (!this.metaBaseUrl) return { ok: false, recipientCount: 0, error: 'mail backend unavailable' };
    const r = await fetchInternalJson<MailPreviewRes>(`${this.metaBaseUrl}/internal/mail/system/preview`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body: req,
      timeoutMs: 10000,
      label: 'meta /internal/mail/system/preview',
    });
    if (r.status === 404 || r.status === 501) {
      return { ok: false, recipientCount: 0, error: 'mail endpoint not yet available (S6-3)' };
    }
    if (!r.ok || !r.body) return { ok: false, recipientCount: 0, error: r.status ? `preview failed: HTTP ${r.status}` : r.error ?? 'network error' };
    return r.body;
  }
}
