import { fetchInternalJson } from '@nw/shared';
import { log } from './shared';

// ── C4 suspicious PvE accounts (/internal/suspicious-pve) ───────────
export interface SuspiciousPveRow {
  _id: string;
  displayName?: string;
  publicId?: string;
  pveWarnings: number;
  banned: boolean;
  createdAt: number;
}

export interface SuspiciousPveClient {
  readonly available: boolean;
  listSuspiciousPve(): Promise<SuspiciousPveRow[]>;
  banAccount(accountId: string): Promise<{ ok: boolean }>;
  unbanAccount(accountId: string): Promise<{ ok: boolean }>;
}

export class HttpSuspiciousPveClient implements SuspiciousPveClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async listSuspiciousPve(): Promise<SuspiciousPveRow[]> {
    if (!this.metaBaseUrl) return [];
    // Degrades to [] on any failure, as before.
    const r = await fetchInternalJson<{
      accounts?: { _id: string; displayName?: string; publicId?: string; flags?: { pveWarnings?: number; banned?: boolean }; createdAt: number }[];
    }>(`${this.metaBaseUrl}/internal/suspicious-pve`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      log,
      label: 'meta /internal/suspicious-pve',
    });
    if (!r.ok || !r.body) return [];
    return (r.body.accounts ?? []).map((a) => ({
      _id: a._id,
      displayName: a.displayName,
      publicId: a.publicId,
      pveWarnings: a.flags?.pveWarnings ?? 0,
      banned: a.flags?.banned ?? false,
      createdAt: a.createdAt,
    }));
  }

  async banAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    // Failure (network / non-2xx) reports {ok:false}, as before.
    const r = await fetchInternalJson<{ ok?: boolean }>(`${this.metaBaseUrl}/internal/accounts/${encodeURIComponent(accountId)}/ban`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      timeoutMs: 10000,
      log,
      label: 'meta /internal/accounts/:id/ban',
    });
    return { ok: r.ok };
  }

  async unbanAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    const r = await fetchInternalJson<{ ok?: boolean }>(`${this.metaBaseUrl}/internal/accounts/${encodeURIComponent(accountId)}/unban`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      timeoutMs: 10000,
      log,
      label: 'meta /internal/accounts/:id/unban',
    });
    return { ok: r.ok };
  }
}
