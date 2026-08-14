// Family business layer — helpers shared across query.ts / membership.ts (docToView, makeFamilyId,
// withProfiles). Pure/best-effort functions, no Mongo collections touched directly.
import type { FamilyDoc } from '../db';
import type { SocialMetaClient } from '../metaClient';
import type { FamilyView, FamilyMemberView } from './types';

export function makeFamilyId(tag: string): string {
  return `fam:${tag.toUpperCase()}`;
}

export function docToView(doc: FamilyDoc): FamilyView {
  return {
    familyId: doc._id,
    name: doc.name,
    tag: doc.tag,
    leaderId: doc.leaderId,
    memberCount: doc.memberCount,
    prosperity: doc.prosperity,
    prosperityUpdatedAt: doc.prosperityUpdatedAt,
    ...(doc.territoryCount != null ? { territoryCount: doc.territoryCount } : {}),
    ...(doc.sectId ? { sectId: doc.sectId } : {}),
    ...(doc.sectName ? { sectName: doc.sectName } : {}),
    ...(doc.announcement ? { announcement: doc.announcement } : {}),
    ...(doc.emblemKey ? { emblemKey: doc.emblemKey } : {}),
    ...(doc.emblemColor != null ? { emblemColor: doc.emblemColor } : {}),
  };
}

/** Attach resolved publicId/displayName to each member (best-effort; missing profiles are left unresolved). */
export async function withProfiles(
  meta: SocialMetaClient,
  members: (FamilyMemberView & { accountId: string })[],
): Promise<FamilyMemberView[]> {
  const profiles = await meta.batchProfiles(members.map((m) => m.accountId));
  return members.map((m) => {
    const p = profiles.get(m.accountId);
    return p ? { ...m, publicId: p.publicId, displayName: p.displayName, ...(p.avatarId ? { avatarId: p.avatarId } : {}) } : m;
  });
}
