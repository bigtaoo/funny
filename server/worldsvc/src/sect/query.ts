// Sect business layer — read-only lookups (S8-4b, SLG_DESIGN §2.1/§8.2). Split out of sectService.ts
// (2026-08-11, 独立类+组合 form, familyService.ts's sibling — see ../sectService.ts for the composing
// facade). Zero cross-domain calls into membership.ts/chat.ts.
import { SECT_REMOVAL_VOTE_RATIO } from '@nw/shared';
import { nullWorldSocialsvcClient, type WorldSocialsvcClient } from '../socialsvcClient';
import { docToView } from './shared';
import type { SectDetailView, SectMemberFamilyView, SectServiceDeps, SectView } from './types';

export class SectQueryService {
  private readonly socialsvc: WorldSocialsvcClient;

  constructor(private readonly deps: SectServiceDeps) {
    this.socialsvc = deps.socialsvc ?? nullWorldSocialsvcClient;
  }

  /** Lists all sects in the world (sorted by member family count descending, capped at 50). */
  async listSects(worldId: string): Promise<SectView[]> {
    const docs = await this.deps.cols.sects
      .find({ worldId })
      .sort({ memberFamilyCount: -1 })
      .limit(50)
      .toArray();
    return docs.map(docToView);
  }

  /** Sect detail (includes member family list, sourced from socialsvc's family.sectId mirror). */
  async getSect(sectId: string): Promise<SectDetailView | null> {
    const doc = await this.deps.cols.sects.findOne({ _id: sectId });
    if (!doc) return null;
    const fams = await this.socialsvc.getFamiliesBySect(sectId);
    const memberFamilies: SectMemberFamilyView[] = fams.map((f) => ({
      familyId: f.familyId,
      name: f.name,
      tag: f.tag,
      leaderId: f.leaderId,
      memberCount: f.memberCount,
      territoryCount: f.territoryCount ?? 0,
      ...(f.emblemKey ? { emblemKey: f.emblemKey } : {}),
      ...(f.emblemColor != null ? { emblemColor: f.emblemColor } : {}),
    }));
    const view: SectDetailView = { ...docToView(doc), memberFamilies };
    if (doc.removalVote) {
      view.removalVote = {
        nomineeFamilyId: doc.removalVote.nomineeFamilyId,
        voteCount: doc.removalVote.voterFamilyIds.length,
        needed: Math.ceil(doc.memberFamilyCount * SECT_REMOVAL_VOTE_RATIO),
      };
    }
    return view;
  }
}
