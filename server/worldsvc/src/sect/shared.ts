// Sect business layer — shared pure helper (2026-08-11 split, see ../sectService.ts's header).
// Zero cross-file dependency; used by query.ts and membership.ts.
import type { SectDoc } from '../db';
import type { SectView } from './types';

export function docToView(doc: SectDoc): SectView {
  return {
    sectId: doc._id,
    worldId: doc.worldId,
    name: doc.name,
    tag: doc.tag,
    leaderFamilyId: doc.leaderFamilyId,
    leaderId: doc.leaderId,
    memberFamilyCount: doc.memberFamilyCount,
    allySectIds: doc.allySectIds,
    prosperity: doc.prosperity,
  };
}
