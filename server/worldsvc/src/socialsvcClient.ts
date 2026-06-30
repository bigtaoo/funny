// worldsvc → socialsvc client (SOCIAL_SVC_DESIGN §4.2 / P1).
// Internal API (/internal/*): X-Internal-Key, used to look up familyId and delegate channel pushes.
import { internalHeaders } from '@nw/shared';

/** Push channel descriptor (the channel field in the /internal/push request body). */
export type SocialsvcChannel =
  | { kind: 'account'; accountId: string }
  | { kind: 'family';  familyId: string }
  | { kind: 'sect';    sectId: string }
  | { kind: 'world';   worldId: string };

export interface WorldSocialsvcClient {
  readonly available: boolean;
  /** Internal: look up the player's current familyId (null if not in a family). */
  getFamilyId(accountId: string): Promise<string | null>;
  /**
   * Internal: delegate a channel push.
   * targets is an explicit recipient list (passed when worldsvc already knows the members, skipping a Redis lookup on the socialsvc side);
   * if omitted, socialsvc routes by channel itself (targets can be removed once P3 Redis pub/sub is fully implemented).
   */
  push(channel: SocialsvcChannel, event: string, payload: unknown, targets?: string[]): Promise<void>;
}

export class HttpWorldSocialsvcClient implements WorldSocialsvcClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async getFamilyId(accountId: string): Promise<string | null> {
    if (!this.baseUrl) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/family/by-account/${encodeURIComponent(accountId)}`,
        { headers: internalHeaders('worldsvc', this.internalKey) },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { familyId?: string | null } };
      return json.data?.familyId ?? null;
    } catch {
      return null;
    }
  }

  async push(channel: SocialsvcChannel, event: string, payload: unknown, targets?: string[]): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ channel, event, payload, ...(targets ? { targets } : {}) }),
      });
    } catch {
      // best-effort: push failure does not affect messages already persisted to the DB; clients can fetch via REST.
    }
  }
}

export const nullWorldSocialsvcClient: WorldSocialsvcClient = {
  available: false,
  async getFamilyId() { return null; },
  async push() { /* no-op */ },
};
