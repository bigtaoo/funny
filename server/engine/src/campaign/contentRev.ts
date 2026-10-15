// Campaign content revision (ONBOARDING_DESIGN §17.2). Level JSON ships inside every client build and the
// peer judge re-simulates a clear against ITS OWN bundled copy — so a judge on an older build would replay a
// reworked level against stale content and wrongly reject an honest clear. Clients advertise the revision
// they carry (gateway `ClientCaps.level_rev`; builds from before this field count as rev 1), the gateway
// only hands a level to judges at or above that level's revision, and metaserver skips the spot-check for a
// submitter whose build predates it.

/** The content revision this build carries. Bump when any level's gameplay content changes. */
export const CAMPAIGN_CONTENT_REV = 2;

/** Levels whose content changed after rev 1 → the revision of their latest change. Absent = 1. */
const LEVEL_CONTENT_REV: Readonly<Record<string, number>> = {
  // §17.2: ch1 first-ten rework (per-level card unlocks, monotonic difficulty, easier retry, lv5 hero trial).
  // ch0_tutorial is never judged; listed so every level carrying `cardUnlocks` is marked alike.
  ch0_tutorial: 2,
  ch1_lv1: 2, ch1_lv2: 2, ch1_lv3: 2, ch1_lv4: 2, ch1_lv5: 2, ch1_lv6: 2, ch1_lv7: 2, ch1_lv8: 2,
};

/** Revision of the latest content change to `levelId`. */
export function levelContentRev(levelId: string): number {
  return LEVEL_CONTENT_REV[levelId] ?? 1;
}

/** Whether a build advertising `rev` (undefined/0 = pre-revision build = 1) carries `levelId`'s current content. */
export function hasLevelContent(rev: number | undefined, levelId: string): boolean {
  return (rev || 1) >= levelContentRev(levelId);
}
