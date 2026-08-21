import { fetchInternalJson } from '@nw/shared';
import { log } from './shared';

// ── hash mismatch query (C3) ──────────────────────────────────
/**
 * One `matches` doc with `hashMismatch: true`, as projected by meta's `/internal/mismatches`
 * (roomId/mode/players/reason/ts, last 24 h, newest first, 200 max).
 *
 * `players` is `MatchDoc.players` verbatim, so it carries the identity snapshot taken at archive time —
 * `displayName`/`publicId` are declared here because they really are on the wire (the projection takes
 * the whole `players` array); leaving them off the type would have the ops table showing raw accountIds
 * while the human-readable pair sat unused in the response.
 */
export interface MismatchRow {
  roomId: string;
  mode: string;
  players: { side: number; accountId: string; displayName?: string; publicId?: string }[];
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
