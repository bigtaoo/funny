import { fetchInternalJson } from '@nw/shared';
import { log } from './shared';

// ── hash mismatch query (C3) ──────────────────────────────────
export interface MismatchRow {
  roomId: string;
  mode: string;
  players: { side: number; accountId: string }[];
  reason: string;
  ts: number;
}

export interface MismatchClient {
  readonly available: boolean;
  listMismatches(): Promise<MismatchRow[]>;
}

export class HttpMismatchClient implements MismatchClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async listMismatches(): Promise<MismatchRow[]> {
    if (!this.metaBaseUrl) return [];
    // Degrades to [] on any failure, as before.
    const r = await fetchInternalJson<{ matches?: MismatchRow[] }>(`${this.metaBaseUrl}/internal/mismatches`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      log,
      label: 'meta /internal/mismatches',
    });
    if (!r.ok || !r.body) return [];
    return r.body.matches ?? [];
  }
}
