// worldsvc core — nation primitives (S8-6.5). Peeled out of the WorldCore god-class (2026-07-03).
// Capital doc init, nation founding/conquest on capital capture, naming, and Voronoi lookup. No behavior change.
import { capitalIdxAt, nearestCapitalIdx, SlgError } from '@nw/shared';
import { WorldCorePush } from './corePush';
import type { NationDoc } from './db';

export class WorldCoreNation extends WorldCorePush {
  // ── S8-6.5: nation system ──────────────────────────────────────

  /**
   * Initialize the 10 capital documents for a world (called when a season opens; idempotent).
   * Skips existing documents ($setOnInsert + unique _id prevents duplicates).
   */
  async initNations(worldId: string): Promise<void> {
    const caps = this.capitals;
    for (let i = 0; i < caps.length; i++) {
      const [x, y] = caps[i]!;
      const id = `nation:${worldId}:${i}`;
      const doc: NationDoc = { _id: id, worldId, capitalIdx: i, x, y, rev: 0 };
      await this.deps.cols.nations.updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true });
    }
  }

  /** Get the state of all nations in a world. */
  async getNations(worldId: string): Promise<NationDoc[]> {
    return this.deps.cols.nations.find({ worldId }).toArray();
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
    const idx = capitalIdxAt(x, y, this.capitals);
    if (idx < 0) return false; // not a capital tile
    const nationId = `nation:${worldId}:${idx}`;
    await this.deps.cols.nations.updateOne(
      { _id: nationId },
      {
        $set: {
          ownerId: winnerAccountId,
          ...(winnerFamilyId ? { familyId: winnerFamilyId } : {}),
          foundedAt: this.deps.now(),
          rev: 1, // overwrite, not incremented (simplified; can be changed to $inc later)
        },
        $unset: { nationName: '' }, // clear the old nation name before the new occupier renames it
      },
    );
    return true;
  }

  /** Set the nation name (only the capital occupier may name it). */
  async setNationName(worldId: string, accountId: string, capitalIdx: number, name: string): Promise<void> {
    if (!name || name.length < 1 || name.length > 10) throw new SlgError('BAD_REQUEST', 'Nation name must be 1–10 characters');
    const nationId = `nation:${worldId}:${capitalIdx}`;
    const nation = await this.deps.cols.nations.findOne({ _id: nationId });
    if (!nation?.ownerId) throw new SlgError('TILE_NOT_OWNED', 'This capital has no nation yet');
    if (nation.ownerId !== accountId) throw new SlgError('NO_PERMISSION', 'Only the capital occupier can name the nation');
    await this.deps.cols.nations.updateOne({ _id: nationId }, { $set: { nationName: name } });
  }

  /**
   * Query the nation corresponding to (x,y) (nearest capital by Voronoi partition).
   * Returns null if the nearest capital currently has no nation (ownerless).
   */
  async getNationAt(worldId: string, x: number, y: number): Promise<NationDoc | null> {
    const idx = nearestCapitalIdx(x, y, this.capitals);
    const nationId = `nation:${worldId}:${idx}`;
    return this.deps.cols.nations.findOne({ _id: nationId });
  }
}
