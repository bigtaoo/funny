// worldsvc → socialsvc client (SOCIAL_SVC_DESIGN §4.2 / P1, §8.2 sect follow-up).
// Internal API (/internal/*): X-Internal-Key, used to look up familyId/membership, delegate channel pushes,
// and (sect follow-up) mirror sectId + refresh prosperity — worldsvc no longer keeps its own family/familyMembers
// mirror (dead since the P4 family→socialsvc migration; see SLG_DESIGN §8.2 note).
import { internalHeaders, type FamilyRole } from '@nw/shared';

/** Push channel descriptor (the channel field in the /internal/push request body). */
export type SocialsvcChannel =
  | { kind: 'account'; accountId: string }
  | { kind: 'family';  familyId: string }
  | { kind: 'sect';    sectId: string }
  | { kind: 'world';   worldId: string };

/** Membership + family identity in one round trip (mirrors socialsvc's FamilyMembershipView). */
export interface FamilyMembership {
  familyId: string;
  role: FamilyRole;
  leaderId: string;
  name: string;
  tag: string;
  memberCount: number;
}

/** Family identity + SLG mirror fields (mirrors socialsvc's FamilyView). */
export interface FamilySummary {
  familyId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  prosperity: number;
  prosperityUpdatedAt?: number;
  territoryCount?: number;
  sectId?: string;
  sectName?: string;
}

export interface WorldSocialsvcClient {
  readonly available: boolean;
  /** Internal: look up the player's current familyId (null if not in a family). */
  getFamilyId(accountId: string): Promise<string | null>;
  /** Internal: membership + family identity in one round trip (null if not in a family). */
  getMember(accountId: string): Promise<FamilyMembership | null>;
  /** Internal: batch fetch families by id (missing ids are silently skipped). */
  getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]>;
  /** Internal: all families currently pointing at the given sectId. */
  getFamiliesBySect(sectId: string): Promise<FamilySummary[]>;
  /** Internal: set/clear the sect a family belongs to (worldsvc is authoritative; best-effort mirror write). */
  setSect(familyId: string, sectId: string | null, sectName?: string | null): Promise<void>;
  /** Internal: increment a family's season activity score (occupation / battle). */
  bumpActivity(familyId: string, delta: number): Promise<void>;
  /** Internal: recompute + persist prosperity from a worldsvc-supplied territoryCount. Returns the new value (0 on failure/unknown family). */
  refreshProsperity(familyId: string, territoryCount: number): Promise<number>;
  /** Internal: zero all SLG season state (territory/prosperity/activity/sect) on world reset; family identity/membership is untouched. */
  resetSlgState(familyId: string): Promise<void>;
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

  async getMember(accountId: string): Promise<FamilyMembership | null> {
    if (!this.baseUrl) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/family/member/${encodeURIComponent(accountId)}`,
        { headers: internalHeaders('worldsvc', this.internalKey) },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { member?: FamilyMembership | null } };
      return json.data?.member ?? null;
    } catch {
      return null;
    }
  }

  async getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]> {
    if (!this.baseUrl || familyIds.length === 0) return [];
    try {
      const res = await fetch(`${this.baseUrl}/internal/family/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ familyIds }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: { families?: FamilySummary[] } };
      return json.data?.families ?? [];
    } catch {
      return [];
    }
  }

  async getFamiliesBySect(sectId: string): Promise<FamilySummary[]> {
    if (!this.baseUrl) return [];
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/family/by-sect/${encodeURIComponent(sectId)}`,
        { headers: internalHeaders('worldsvc', this.internalKey) },
      );
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: { families?: FamilySummary[] } };
      return json.data?.families ?? [];
    } catch {
      return [];
    }
  }

  async setSect(familyId: string, sectId: string | null, sectName?: string | null): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/family/${encodeURIComponent(familyId)}/sect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ sectId, sectName }),
      });
    } catch {
      // best-effort: worldsvc remains authoritative for sectId; a failed mirror write only stales the client-facing socialsvc copy.
    }
  }

  async bumpActivity(familyId: string, delta: number): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/family/activity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ familyId, delta }),
      });
    } catch {
      // best-effort: activity is a soft prosperity input, not worth failing the caller's main flow.
    }
  }

  async refreshProsperity(familyId: string, territoryCount: number): Promise<number> {
    if (!this.baseUrl) return 0;
    try {
      const res = await fetch(`${this.baseUrl}/internal/family/${encodeURIComponent(familyId)}/prosperity/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ territoryCount }),
      });
      if (!res.ok) return 0;
      const json = (await res.json()) as { data?: { prosperity?: number } };
      return json.data?.prosperity ?? 0;
    } catch {
      return 0;
    }
  }

  async resetSlgState(familyId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/family/${encodeURIComponent(familyId)}/slg-reset`, {
        method: 'POST',
        headers: internalHeaders('worldsvc', this.internalKey),
      });
    } catch {
      // best-effort: a failed reset only leaves stale season stats on socialsvc's mirror until the next refresh.
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
  async getMember() { return null; },
  async getFamiliesByIds() { return []; },
  async getFamiliesBySect() { return []; },
  async setSect() { /* no-op */ },
  async bumpActivity() { /* no-op */ },
  async refreshProsperity() { return 0; },
  async resetSlgState() { /* no-op */ },
  async push() { /* no-op */ },
};
