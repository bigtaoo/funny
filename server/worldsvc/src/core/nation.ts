// worldsvc core — nation primitives (S8-6.5). Peeled out of the WorldCore god-class (2026-07-03).
// Capital doc init, nation founding/conquest on capital capture, naming, and province lookup
// (angle-sector ring model, ADR-034 — replaces the old Voronoi-nearest-capital lookup).
//
// 2026-08-11 (mixin-chain re-audit, claudedocs/server.md "拆分形态的优先级" 形态②): converted from an
// `extends WorldCorePush` inheritance-chain link to composition — the only cross-layer call is
// `capitalsFor` (kernel), so this takes a narrow constructor-injected `core: WorldCore`.
import { provinceIdxAt, SlgError, censorChat, orgNameWidth, ORG_NAME_WIDTH_MIN, ORG_NAME_WIDTH_MAX, type ChatRegion } from '@nw/shared';
import type { WorldCore } from '../core';
import type { NationDoc } from '../db';

export class NationService {
  constructor(private readonly core: WorldCore) {}

  // ── S8-6.5: nation system ──────────────────────────────────────

  /**
   * Initialize the 10 capital documents for a world (called when a season opens; idempotent).
   * Skips existing documents ($setOnInsert + unique _id prevents duplicates).
   *
   * ADR-074 also makes this CLEAR any ownership on an existing document. Two reasons:
   *  • Nation founding no longer exists. It used to fire from `settleOccupation`, i.e. plain-occupying the
   *    single capital anchor cell (npcGarrison(10) = 1200 troops) founded a nation for one player — the
   *    hole ADR-074 closes. Ownership will be re-established in ADR-074 P1 by capturing the capital CITY,
   *    keyed on the sect, not on an account + family. Any ownership still stored was produced by the old
   *    path, so it is invalid by construction (用户拍板: 直接清空, 不做赛季内迁移).
   *  • Independently of that, `$setOnInsert` meant a REOPENED world (same worldId) kept the previous
   *    season's conquest attribution, contradicting the season-reset rule that all season-scoped strategic
   *    state is wiped (D-CITY-1). `resetWorld` deletes the whole collection and re-inits, so only the
   *    reopen path had this; now both are clean.
   *
   * Note this only takes effect at season open / world reset. A world that is ALREADY open keeps its stale
   * nation ownership (and therefore its stale NATION_BONUS_PRODUCTION / NATION_BONUS_DEFENSE) until one of
   * those runs — there is deliberately no self-heal on player entry for it.
   */
  async initNations(worldId: string): Promise<void> {
    const caps = this.core.capitalsFor(worldId);
    for (let i = 0; i < caps.length; i++) {
      const [x, y] = caps[i]!;
      const id = `nation:${worldId}:${i}`;
      const doc: NationDoc = { _id: id, worldId, capitalIdx: i, x, y, rev: 0 };
      await this.core.deps.cols.nations.updateOne(
        { _id: id },
        { $setOnInsert: doc, $unset: { ownerId: '', familyId: '', nationName: '', foundedAt: '' } },
        { upsert: true },
      );
    }
  }

  /** Get the state of all nations in a world. */
  async getNations(worldId: string): Promise<NationDoc[]> {
    return this.core.deps.cols.nations.find({ worldId }).toArray();
  }

  // `applyNationChange` (nation founding / conquest on capital-tile capture) was DELETED by ADR-074.
  //
  // It fired from two places: `settleOccupation` (the plain occupy path) and `settleSiegeDamage` (capturing
  // a player-owned tile that happened to sit on a capital). The first was the vulnerability — occupying ONE
  // cell against a 1200-troop NPC garrison founded a nation for a single player, granting that account
  // +NATION_BONUS_PRODUCTION across the whole province and +NATION_BONUS_DEFENSE on its garrisons, with
  // attribution to an account + family rather than a sect. The second is unreachable now regardless: a
  // capital's whole footprint is city ground (`familyKeep`), which can no longer be owned by a player at
  // all, so no capital tile can ever reach the player-vs-player capture path.
  //
  // Ownership is re-established in ADR-074 P1 by besieging the capital CITY (CityDoc.ownerSectId). Until
  // then no nation has an owner, so both nation bonuses are inert — a deliberate, temporary regression, NOT
  // a silent one: see SLG_CITY_SIEGE_DESIGN §9 for why re-pointing them at sect city ownership is P1/P3
  // work rather than something to bolt onto the deleted account-keyed path.
  //
  // The read paths are intentionally left in place (`core/yield.ts` nation production bonus,
  // `combatSiege/arrival.ts` nation defense bonus): they now read documents whose ownership `initNations`
  // clears, and P1 re-points them instead of re-adding them.

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
