// worldsvc core — nation primitives (S8-6.5). Peeled out of the WorldCore god-class (2026-07-03).
// Capital doc init, nation founding/conquest on capital capture, naming, and province lookup
// (angle-sector ring model, ADR-034 — replaces the old Voronoi-nearest-capital lookup).
//
// 2026-08-11 (mixin-chain re-audit, claudedocs/server.md "拆分形态的优先级" 形态②): converted from an
// `extends WorldCorePush` inheritance-chain link to composition — the only cross-layer call is
// `capitalsFor` (kernel), so this takes a narrow constructor-injected `core: WorldCore`.
import { capitalIdxAt, provinceIdxAt, SlgError, censorChat, orgNameWidth, ORG_NAME_WIDTH_MIN, ORG_NAME_WIDTH_MAX, type ChatRegion } from '@nw/shared';
import type { WorldCore } from '../core';
import type { NationDoc } from '../db';

export class NationService {
  constructor(private readonly core: WorldCore) {}

  // ── S8-6.5: nation system ──────────────────────────────────────

  /**
   * Initialize the 10 capital documents for a world (called when a season opens; idempotent).
   * Skips existing documents ($setOnInsert + unique _id prevents duplicates).
   */
  async initNations(worldId: string): Promise<void> {
    const caps = this.core.capitalsFor(worldId);
    for (let i = 0; i < caps.length; i++) {
      const [x, y] = caps[i]!;
      const id = `nation:${worldId}:${i}`;
      const doc: NationDoc = { _id: id, worldId, capitalIdx: i, x, y, rev: 0 };
      await this.core.deps.cols.nations.updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true });
    }
  }

  /** Get the state of all nations in a world. */
  async getNations(worldId: string): Promise<NationDoc[]> {
    return this.core.deps.cols.nations.find({ worldId }).toArray();
  }

  /**
   * Check whether the target tile on siege/occupation arrival is a capital tile; trigger nation founding or conquest.
   * winnerAccountId = the occupier; if this tile previously belonged to another nation, that nation falls.
   * Returns whether a nation state change was triggered.
   */
  async applyNationChange(
    worldId: string,
    x: number,
    y: number,
    winnerAccountId: string,
    winnerFamilyId?: string,
  ): Promise<boolean> {
    const idx = capitalIdxAt(x, y, this.core.capitalsFor(worldId));
    if (idx < 0) return false; // not a capital tile
    const nationId = `nation:${worldId}:${idx}`;
    await this.core.deps.cols.nations.updateOne(
      { _id: nationId },
      {
        $set: {
          ownerId: winnerAccountId,
          ...(winnerFamilyId ? { familyId: winnerFamilyId } : {}),
          foundedAt: this.core.deps.now(),
          rev: 1, // overwrite, not incremented (simplified; can be changed to $inc later)
        },
        // Clear the old nation name before the new occupier renames it. familyId must go here too
        // (2026-08-03 worldsvc code review) — a family-less winner previously left the PREVIOUS
        // owning family's familyId in place (only $set writes a new one, with no matching $unset),
        // so a solo conqueror could inherit stale nation-bonus/leaderboard attribution to a family
        // that no longer controls the nation.
        $unset: { nationName: '', ...(winnerFamilyId ? {} : { familyId: '' }) },
      },
    );
    return true;
  }

  /** Set the nation name (only the capital occupier may name it). */
  async setNationName(worldId: string, accountId: string, capitalIdx: number, name: string, region: ChatRegion = 'global'): Promise<void> {
    // Width-based bound (matches sect/family display-name treatment, orgNameWidth: full-width/CJK
    // characters count double) rather than raw UTF-16 .length — a 10-character all-CJK name used to
    // pass the old length check while rendering roughly twice as wide as intended.
    const nameWidth = name ? orgNameWidth(name) : 0;
    if (nameWidth < ORG_NAME_WIDTH_MIN || nameWidth > ORG_NAME_WIDTH_MAX) {
      throw new SlgError('BAD_REQUEST', `Nation name must be ${ORG_NAME_WIDTH_MIN}–${ORG_NAME_WIDTH_MAX} display units (full-width chars count as 2)`);
    }
    // CONTENT_MODERATION_DESIGN.md CM5: a nation name is long-lived/public like a sect/family name, not
    // ephemeral chat — a hit rejects the rename outright rather than persisting a masked name. This was
    // previously the one persistent public player-chosen string in the codebase with no moderation check
    // at all (2026-08-03 worldsvc code review).
    if (censorChat(name, region, this.core.wordlists).hit) {
      throw new SlgError('BAD_REQUEST', 'Name contains disallowed words');
    }
    const nationId = `nation:${worldId}:${capitalIdx}`;
    const nation = await this.core.deps.cols.nations.findOne({ _id: nationId });
    if (!nation?.ownerId) throw new SlgError('TILE_NOT_OWNED', 'This capital has no nation yet');
    if (nation.ownerId !== accountId) throw new SlgError('NO_PERMISSION', 'Only the capital occupier can name the nation');
    await this.core.deps.cols.nations.updateOne({ _id: nationId }, { $set: { nationName: name } });
  }

  /**
   * Query the nation corresponding to (x,y) (province membership by angle-sector + ring, ADR-034).
   * Returns null if that province currently has no nation (ownerless).
   */
  async getNationAt(worldId: string, x: number, y: number): Promise<NationDoc | null> {
    const idx = provinceIdxAt(x, y);
    const nationId = `nation:${worldId}:${idx}`;
    return this.core.deps.cols.nations.findOne({ _id: nationId });
  }
}
