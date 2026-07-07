import { internalHeaders } from '@nw/shared';
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
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/mismatches`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) {
        log.warn('mismatches non-2xx', { status: res.status });
        return [];
      }
      const body = (await res.json()) as { matches?: MismatchRow[] };
      return body.matches ?? [];
    } catch (e) {
      log.warn('mismatches fetch failed', { err: (e as Error).message });
      return [];
    }
  }
}
