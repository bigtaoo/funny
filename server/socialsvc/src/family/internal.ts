// Family business layer — internal API called by worldsvc (identity lookups, activity/prosperity
// mirrors, sect linkage, season reset; SOCIAL_SVC_DESIGN §3/§4). Split out of familyService.ts (see
// ../familyService.ts for the composing facade).
import { familyProsperity } from '@nw/shared';
import type { FamilyServiceDeps, FamilyView, FamilyMembershipView } from './types';
import { docToView } from './shared';

export class FamilyInternalService {
  constructor(private readonly deps: FamilyServiceDeps) {}

  /** Internal API: look up the familyId the player currently belongs to (called by worldsvc). */
  async getFamilyIdByAccount(accountId: string): Promise<string | null> {
    const mem = await this.deps.cols.familyMembers.findOne({ _id: accountId });
    return mem ? mem.familyId : null;
  }

  /** Internal API: called by worldsvc to increment activity (occupation / battle +1). */
  async bumpActivity(familyId: string, delta = 1): Promise<void> {
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      { $inc: { activity: delta } },
    );
  }

  /** Internal API: membership + family identity in one round trip (called by worldsvc's sect permission checks). Returns null if not in a family. */
  async getMember(accountId: string): Promise<FamilyMembershipView | null> {
    const mem = await this.deps.cols.familyMembers.findOne({ _id: accountId });
    if (!mem) return null;
    const fam = await this.deps.cols.families.findOne({ _id: mem.familyId });
    if (!fam) return null;
    return {
      familyId: mem.familyId, role: mem.role, leaderId: fam.leaderId, name: fam.name, tag: fam.tag,
      memberCount: fam.memberCount,
      ...(fam.sectId ? { sectId: fam.sectId } : {}),
      ...(fam.sectName ? { sectName: fam.sectName } : {}),
    };
  }

  /** Internal API: batch fetch families by id (called by worldsvc for sect roster display / season settlement). Missing ids are silently skipped. */
  async getFamiliesByIds(familyIds: string[]): Promise<FamilyView[]> {
    if (familyIds.length === 0) return [];
    const docs = await this.deps.cols.families.find({ _id: { $in: familyIds } }).toArray();
    return docs.map(docToView);
  }

  /** Internal API: all families currently pointing at the given sectId (called by worldsvc sect roster / leave-vote flows). */
  async getFamiliesBySect(sectId: string): Promise<FamilyView[]> {
    const docs = await this.deps.cols.families.find({ sectId }).toArray();
    return docs.map(docToView);
  }

  /** Internal API: set/clear the sect a family belongs to (called by worldsvc on sect join/leave/found/dissolve; worldsvc is authoritative, this is a read cache for clients). */
  async setSect(familyId: string, sectId: string | null, sectName?: string | null): Promise<void> {
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      sectId
        ? { $set: { sectId, ...(sectName ? { sectName } : {}) } }
        : { $unset: { sectId: '', sectName: '' } },
    );
  }

  /**
   * Internal API: recompute + persist prosperity from a worldsvc-supplied territoryCount (worldsvc owns tile
   * ownership; socialsvc owns the family doc). Called at explicit refresh points (occupation / siege / sect-founding / settle),
   * mirroring the pre-P4 worldsvc-local refreshFamilyProsperity semantics. Family not found → returns 0 without writing.
   */
  async refreshProsperity(familyId: string, territoryCount: number): Promise<number> {
    const fam = await this.deps.cols.families.findOne({ _id: familyId });
    if (!fam) return 0;
    const prosperity = familyProsperity(territoryCount, fam.memberCount, fam.activity ?? 0);
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      { $set: { prosperity, prosperityUpdatedAt: this.deps.now(), territoryCount } },
    );
    return prosperity;
  }

  /**
   * Merged bumpActivity + refreshProsperity (comm-audit batch F item 9): worldsvc's bumpFamilyActivity
   * always calls both back-to-back for the same familyId, so do the $inc then recompute-and-$set in one
   * round trip instead of two sequential internal-HTTP hops (same "one hop, multiple Mongo ops" shape as
   * resetSlgState below). Returns the new prosperity value (0 on unknown family, same as refreshProsperity).
   */
  async bumpActivityAndProsperity(familyId: string, delta: number, territoryCount: number): Promise<number> {
    const fam = await this.deps.cols.families.findOneAndUpdate(
      { _id: familyId },
      { $inc: { activity: delta } },
      { returnDocument: 'after' },
    );
    if (!fam) return 0;
    const prosperity = familyProsperity(territoryCount, fam.memberCount, fam.activity ?? 0);
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      { $set: { prosperity, prosperityUpdatedAt: this.deps.now(), territoryCount } },
    );
    return prosperity;
  }

  /** Internal API: zero all SLG season state (territory/prosperity/activity/sect) on world reset (SLG_DESIGN §17.3); family identity/membership is untouched. */
  async resetSlgState(familyId: string): Promise<void> {
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      { $set: { territoryCount: 0, prosperity: 0, activity: 0, prosperityUpdatedAt: this.deps.now() }, $unset: { sectId: '', sectName: '' } },
    );
  }
}
