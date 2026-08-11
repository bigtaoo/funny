// Family (socialsvc's own contract, SOCIAL_SVC_DESIGN.md §4.1).
import { getSocialBaseUrl } from '../config';
import { currentChatRegion } from '../chatRegion';
import type { WorldApiCore } from './core';
import type {
  FamilyDetailView,
  FamilyView,
  FamilyJoinRequestView,
  FamilyMessageView,
  PlayerProfileExtra,
  FamilyRole,
} from './types';

/** Family domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class FamilyService {
  constructor(private readonly core: WorldApiCore) {}

  /** The caller's own family (live from socialsvc), or null if not in one. Not a "list of joinable families" despite the name below. */
  async getMyFamily(): Promise<FamilyDetailView | null> {
    return this.core.req('GET', '/social/family/mine', undefined, 10_000, getSocialBaseUrl());
  }

  async listFamilies(): Promise<FamilyView[]> {
    const fam = await this.getMyFamily();
    return fam ? [fam] : [];
  }

  async getFamily(familyId: string): Promise<FamilyDetailView> {
    return this.core.req(
      'GET',
      `/social/family/${encodeURIComponent(familyId)}`,
      undefined,
      10_000,
      getSocialBaseUrl()
    );
  }

  async createFamily(name: string, tag: string): Promise<FamilyDetailView> {
    return this.core.req('POST', '/social/family', { name, tag }, 10_000, getSocialBaseUrl(), {
      'X-Chat-Region': currentChatRegion(),
    });
  }

  /** Submit a request to join a family — leader/elder approval required before membership takes effect. */
  async requestJoinFamily(familyId: string): Promise<{ requestId: string }> {
    return this.core.req(
      'POST',
      `/social/family/${encodeURIComponent(familyId)}/join`,
      {},
      10_000,
      getSocialBaseUrl()
    );
  }

  /** Pending join requests for the caller's own family (leader/elder only). */
  async listJoinRequests(): Promise<FamilyJoinRequestView[]> {
    const res = await this.core.req<{ requests: FamilyJoinRequestView[] }>(
      'GET',
      '/social/family/requests',
      undefined,
      10_000,
      getSocialBaseUrl()
    );
    return res.requests;
  }

  /** Approve or reject a pending join request (leader/elder only). Rejection mails the applicant. */
  async respondJoinRequest(requestId: string, accept: boolean): Promise<{ ok: true }> {
    return this.core.req(
      'POST',
      `/social/family/requests/${encodeURIComponent(requestId)}/respond`,
      { accept },
      10_000,
      getSocialBaseUrl()
    );
  }

  /** Browse joinable families: top-N by prosperity (default), or fuzzy name-matched when `query` is given. Only families with an open slot are returned. */
  async browseFamilies(query?: string, limit = 10): Promise<FamilyView[]> {
    const qs = new URLSearchParams();
    if (query) qs.set('q', query);
    qs.set('limit', String(limit));
    return this.core.req(
      'GET',
      `/social/family/browse?${qs.toString()}`,
      undefined,
      10_000,
      getSocialBaseUrl()
    );
  }

  async leaveFamily(): Promise<{ ok: true }> {
    return this.core.req('POST', '/social/family/leave', {}, 10_000, getSocialBaseUrl());
  }

  async kickMember(targetId: string): Promise<{ ok: true }> {
    return this.core.req('POST', '/social/family/kick', { targetId }, 10_000, getSocialBaseUrl());
  }

  async setRole(targetId: string, role: FamilyRole): Promise<{ ok: true }> {
    return this.core.req(
      'POST',
      '/social/family/role',
      { targetId, role },
      10_000,
      getSocialBaseUrl()
    );
  }

  async dissolveFamily(): Promise<{ ok: true }> {
    return this.core.req('POST', '/social/family/disband', {}, 10_000, getSocialBaseUrl());
  }

  async sendFamilyMessage(
    familyId: string,
    body: string,
    senderName?: string
  ): Promise<{ id: string }> {
    return this.core.req(
      'POST',
      `/social/family/${encodeURIComponent(familyId)}/messages`,
      { body, ...(senderName ? { senderName } : {}) },
      10_000,
      getSocialBaseUrl(),
      { 'X-Chat-Region': currentChatRegion() }
    );
  }

  async getFamilyChannel(
    familyId: string,
    opts?: { before?: number; limit?: number }
  ): Promise<FamilyMessageView[]> {
    const params = new URLSearchParams();
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params}` : '';
    return this.core.req(
      'GET',
      `/social/family/${encodeURIComponent(familyId)}/messages${qs}`,
      undefined,
      10_000,
      getSocialBaseUrl()
    );
  }

  /** Unified profile-popup extras (rank/ELO + family/sect, if any) for an arbitrary player, looked up
   *  by public id — {@link ProfilePopup} fetches this itself on open rather than each screen threading
   *  its own copy of the same fields. All fields absent when the player has none of them. */
  async getProfileExtra(publicId: string): Promise<PlayerProfileExtra> {
    return this.core.req(
      'GET',
      `/social/profile/${encodeURIComponent(publicId)}/extra`,
      undefined,
      10_000,
      getSocialBaseUrl()
    );
  }
}
