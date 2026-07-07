import { internalHeaders } from '@nw/shared';
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
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/suspicious-pve`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) {
        log.warn('suspicious-pve non-2xx', { status: res.status });
        return [];
      }
      const body = (await res.json()) as {
        accounts?: { _id: string; displayName?: string; publicId?: string; flags?: { pveWarnings?: number; banned?: boolean }; createdAt: number }[];
      };
      return (body.accounts ?? []).map((a) => ({
        _id: a._id,
        displayName: a.displayName,
        publicId: a.publicId,
        pveWarnings: a.flags?.pveWarnings ?? 0,
        banned: a.flags?.banned ?? false,
        createdAt: a.createdAt,
      }));
    } catch (e) {
      log.warn('suspicious-pve fetch failed', { err: (e as Error).message });
      return [];
    }
  }

  async banAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/accounts/${encodeURIComponent(accountId)}/ban`, {
        method: 'POST',
        headers: internalHeaders('admin', this.internalKey),
      });
      return { ok: res.ok };
    } catch (e) {
      log.warn('ban-account failed', { err: (e as Error).message });
      return { ok: false };
    }
  }

  async unbanAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/accounts/${encodeURIComponent(accountId)}/unban`, {
        method: 'POST',
        headers: internalHeaders('admin', this.internalKey),
      });
      return { ok: res.ok };
    } catch (e) {
      log.warn('unban-account failed', { err: (e as Error).message });
      return { ok: false };
    }
  }
}
