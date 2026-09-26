// Family membership + join-request approval (BOTSVC_DESIGN §3.3): public /social/* REST, same as any
// real client — auth is the bot's own player JWT from metaserver device-login, not the internal key.
import type { FamilyRole } from '@nw/shared';
import { envelopeError } from './apiError';

export interface FamilyMemberView {
  /** Present only when the caller is a member of this family (socialsvc strips it for outsiders). */
  accountId?: string;
  role: FamilyRole;
  joinedAt: number;
}

export interface FamilyView {
  familyId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  prosperity: number;
  sectId?: string;
  members?: FamilyMemberView[];
}

export interface JoinRequestView {
  requestId: string;
  accountId: string;
  createdAt: number;
}

export class SocialClient {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json()) as { ok: boolean; data?: T; error?: unknown };
    if (!parsed.ok) throw envelopeError(parsed.error, `social call failed: ${method} ${path}`);
    return parsed.data as T;
  }

  /** The caller's own family with its member list (accountIds included), or null when familyless. */
  myFamily(token: string): Promise<FamilyView | null> {
    return this.call<FamilyView | null>('GET', '/social/family/mine', token);
  }

  /** Any family by id (`fam:TAG`); null when it does not exist. */
  getFamily(token: string, familyId: string): Promise<FamilyView | null> {
    return this.call<FamilyView | null>('GET', `/social/family/${encodeURIComponent(familyId)}`, token);
  }

  createFamily(token: string, name: string, tag: string): Promise<FamilyView> {
    return this.call<FamilyView>('POST', '/social/family', token, { name, tag });
  }

  /** Files a pending join request; membership only happens once a leader/elder accepts it. */
  requestJoin(token: string, familyId: string): Promise<{ requestId: string }> {
    return this.call<{ requestId: string }>('POST', `/social/family/${encodeURIComponent(familyId)}/join`, token);
  }

  /** Pending requests for the caller's own family (leader/elder only). */
  async listJoinRequests(token: string): Promise<JoinRequestView[]> {
    return (await this.call<{ requests: JoinRequestView[] }>('GET', '/social/family/requests', token)).requests;
  }

  respondJoinRequest(token: string, requestId: string, accept: boolean): Promise<void> {
    return this.call<void>('POST', `/social/family/requests/${encodeURIComponent(requestId)}/respond`, token, { accept });
  }

  /** Leader-only. */
  setRole(token: string, targetId: string, role: Exclude<FamilyRole, 'leader'>): Promise<void> {
    return this.call<void>('POST', '/social/family/role', token, { targetId, role });
  }
}
