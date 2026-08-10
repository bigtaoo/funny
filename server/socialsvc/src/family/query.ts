// Family business layer — read-only lookups (SOCIAL_SVC_DESIGN §3/§4). Split out of familyService.ts
// (see ../familyService.ts for the composing facade).
import { FAMILY_CAP } from '@nw/shared';
import type { SocialMetaClient } from '../metaClient';
import { nullSocialMetaClient } from '../metaClient';
import type { FamilyServiceDeps, FamilyView, FamilyDetailView } from './types';
import { docToView, withProfiles } from './shared';

export class FamilyQueryService {
  private readonly meta: SocialMetaClient;

  constructor(private readonly deps: FamilyServiceDeps) {
    this.meta = deps.meta ?? nullSocialMetaClient;
  }

  /** Get the family the player belongs to (including member list). Returns null if not a member. */
  async getMyFamily(accountId: string): Promise<FamilyDetailView | null> {
    const mem = await this.deps.cols.familyMembers.findOne({ _id: accountId });
    if (!mem) return null;
    return this.getFamily(mem.familyId);
  }

  /** Get family details by familyId (including member list). */
  /**
   * @param callerId When provided and the caller is NOT a member of this family, raw `accountId`s are
   * stripped from the returned member list (2026-08-04 fix): `GET /social/family/:id` is a public route
   * reachable for ANY family id (discoverable via browse/search), and every other externally-facing view
   * in this service deliberately exposes only `publicId`/`displayName` — internal `accountId`s are meant to
   * be known only within the family itself (used there for role-gated kick/setRole). Omit `callerId` for
   * trusted internal callers (e.g. `/internal/push`'s family broadcast) that need the real accountIds
   * regardless of membership.
   */
  async getFamily(familyId: string, callerId?: string): Promise<FamilyDetailView | null> {
    const doc = await this.deps.cols.families.findOne({ _id: familyId });
    if (!doc) return null;
    const memberDocs = await this.deps.cols.familyMembers.find({ familyId }).toArray();
    const isMember = callerId === undefined || memberDocs.some((m) => m.accountId === callerId);
    const members = await withProfiles(this.meta, memberDocs.map((m) => ({
      accountId: m.accountId,
      role: m.role,
      joinedAt: m.joinedAt,
    })));
    return { ...docToView(doc), members: isMember ? members : members.map(({ accountId, ...rest }) => rest) };
  }

  /** Search for a family by TAG (exact match, case-insensitive). */
  async searchByTag(tag: string): Promise<FamilyView | null> {
    const doc = await this.deps.cols.families.findOne({ tag: tag.toUpperCase() });
    return doc ? docToView(doc) : null;
  }

  /**
   * Browse joinable families (join-picker source): families with an open slot, fuzzy-matched by
   * name when `query` is given, sorted by prosperity desc (default view = top-N most prosperous).
   */
  async browseFamilies(query: string | undefined, limit = 10): Promise<FamilyView[]> {
    const filter: Record<string, unknown> = { memberCount: { $lt: FAMILY_CAP } };
    const trimmed = query?.trim();
    if (trimmed) {
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = { $regex: escaped, $options: 'i' };
    }
    const docs = await this.deps.cols.families
      .find(filter)
      .sort({ prosperity: -1 })
      .limit(Math.min(Math.max(limit, 1), 50))
      .toArray();
    return docs.map(docToView);
  }
}
