// worldsvc → socialsvc client (SOCIAL_SVC_DESIGN §4.2 / P1, §8.2 sect follow-up).
// Internal API (/internal/*): X-Internal-Key, used to look up familyId/membership, delegate channel pushes,
// and (sect follow-up) mirror sectId + refresh prosperity — worldsvc no longer keeps its own family/familyMembers
// mirror (dead since the P4 family→socialsvc migration; see SLG_DESIGN §8.2 note).
import { fetchInternalJson, type FamilyRole, type EmblemKey } from '@nw/shared';

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
  /** Sect the family belongs to, if any (comm-audit batch F item 8 — lets callers read sectId straight off
   *  getMember instead of a separate getFamiliesByIds([familyId]) round trip). */
  sectId?: string;
  /** Family badge (family-emblem-art-prompts.md, 2026-08-14); absent = no badge chosen yet. */
  emblemKey?: EmblemKey;
  /** Accent colour the emblem art is tinted with; absent while emblemKey is absent. */
  emblemColor?: number;
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
  /** Family badge (family-emblem-art-prompts.md, 2026-08-14); absent = no badge chosen yet. */
  emblemKey?: EmblemKey;
  /** Accent colour the emblem art is tinted with; absent while emblemKey is absent. */
  emblemColor?: number;
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
  /**
   * Internal: bumpActivity + refreshProsperity in one round trip (comm-audit batch F item 9) — the only caller
   * (bumpFamilyActivity) always did both back-to-back for the same familyId. Returns the new prosperity value
   * (0 on failure/unknown family, same as refreshProsperity).
   */
  bumpActivityAndProsperity(familyId: string, delta: number, territoryCount: number): Promise<number>;
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

  private opts(label: string) {
    return { caller: 'worldsvc' as const, key: this.internalKey, timeoutMs: 5000, label };
  }

  async getFamilyId(accountId: string): Promise<string | null> {
    if (!this.baseUrl) return null;
    const res = await fetchInternalJson<{ data?: { familyId?: string | null } }>(
      `${this.baseUrl}/internal/family/by-account/${encodeURIComponent(accountId)}`,
      this.opts('/internal/family/by-account'),
    );
    if (!res.ok) return null;
    return res.body?.data?.familyId ?? null;
  }

  async getMember(accountId: string): Promise<FamilyMembership | null> {
    if (!this.baseUrl) return null;
    const res = await fetchInternalJson<{ data?: { member?: FamilyMembership | null } }>(
      `${this.baseUrl}/internal/family/member/${encodeURIComponent(accountId)}`,
      this.opts('/internal/family/member'),
    );
    if (!res.ok) return null;
    return res.body?.data?.member ?? null;
  }

  async getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]> {
    if (!this.baseUrl || familyIds.length === 0) return [];
    const res = await fetchInternalJson<{ data?: { families?: FamilySummary[] } }>(
      `${this.baseUrl}/internal/family/batch`,
      { ...this.opts('/internal/family/batch'), method: 'POST', body: { familyIds } },
    );
    if (!res.ok) return [];
    return res.body?.data?.families ?? [];
  }

  async getFamiliesBySect(sectId: string): Promise<FamilySummary[]> {
    if (!this.baseUrl) return [];
    const res = await fetchInternalJson<{ data?: { families?: FamilySummary[] } }>(
      `${this.baseUrl}/internal/family/by-sect/${encodeURIComponent(sectId)}`,
      this.opts('/internal/family/by-sect'),
    );
    if (!res.ok) return [];
    return res.body?.data?.families ?? [];
  }

  async setSect(familyId: string, sectId: string | null, sectName?: string | null): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(
      `${this.baseUrl}/internal/family/${encodeURIComponent(familyId)}/sect`,
      { ...this.opts('/internal/family/:id/sect'), method: 'POST', body: { sectId, sectName } },
    );
    if (!res.ok) {
      // best-effort: worldsvc remains authoritative for sectId; a failed mirror write only stales the client-facing socialsvc copy.
      console.error('[worldsvc] socialsvc.setSect failed', { familyId, sectId, status: res.status, err: res.error });
    }
  }

  async bumpActivity(familyId: string, delta: number): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(
      `${this.baseUrl}/internal/family/activity`,
      { ...this.opts('/internal/family/activity'), method: 'POST', body: { familyId, delta } },
    );
    if (!res.ok) {
      // best-effort: activity is a soft prosperity input, not worth failing the caller's main flow.
      console.error('[worldsvc] socialsvc.bumpActivity failed', { familyId, delta, status: res.status, err: res.error });
    }
  }

  async refreshProsperity(familyId: string, territoryCount: number): Promise<number> {
    if (!this.baseUrl) return 0;
    const res = await fetchInternalJson<{ data?: { prosperity?: number } }>(
      `${this.baseUrl}/internal/family/${encodeURIComponent(familyId)}/prosperity/refresh`,
      { ...this.opts('/internal/family/:id/prosperity/refresh'), method: 'POST', body: { territoryCount } },
    );
    if (!res.ok) return 0;
    return res.body?.data?.prosperity ?? 0;
  }

  async bumpActivityAndProsperity(familyId: string, delta: number, territoryCount: number): Promise<number> {
    if (!this.baseUrl) return 0;
    const res = await fetchInternalJson<{ data?: { prosperity?: number } }>(
      `${this.baseUrl}/internal/family/${encodeURIComponent(familyId)}/activity-and-prosperity`,
      { ...this.opts('/internal/family/:id/activity-and-prosperity'), method: 'POST', body: { delta, territoryCount } },
    );
    if (!res.ok) {
      console.error('[worldsvc] socialsvc.bumpActivityAndProsperity failed', { familyId, delta, territoryCount, status: res.status, err: res.error });
      return 0;
    }
    return res.body?.data?.prosperity ?? 0;
  }

  async resetSlgState(familyId: string): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(
      `${this.baseUrl}/internal/family/${encodeURIComponent(familyId)}/slg-reset`,
      { ...this.opts('/internal/family/:id/slg-reset'), method: 'POST' },
    );
    if (!res.ok) {
      // best-effort: a failed reset only leaves stale season stats on socialsvc's mirror until the next refresh.
      console.error('[worldsvc] socialsvc.resetSlgState failed', { familyId, status: res.status, err: res.error });
    }
  }

  async push(channel: SocialsvcChannel, event: string, payload: unknown, targets?: string[]): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(
      `${this.baseUrl}/internal/push`,
      { ...this.opts('/internal/push'), method: 'POST', body: { channel, event, payload, ...(targets ? { targets } : {}) } },
    );
    if (!res.ok) {
      // best-effort: push failure does not affect messages already persisted to the DB; clients can fetch via REST.
      console.error('[worldsvc] socialsvc.push failed', { event, status: res.status, err: res.error });
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
  async bumpActivityAndProsperity() { return 0; },
  async resetSlgState() { /* no-op */ },
  async push() { /* no-op */ },
};
