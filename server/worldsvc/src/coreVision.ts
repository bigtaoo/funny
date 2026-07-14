// worldsvc core — family / sect membership, fog-of-war vision, and reverse-vision observers.
// Peeled out of the WorldCore god-class (2026-07-03). Also holds sameFamily and the
// best-effort family-activity/prosperity bump. No behavior change.
import {
  playerWorldId,
  isInVision,
  marchInterpPos,
  baseFootprintCells,
  VISION_MAX_RADIUS,
  type VisionSource,
} from '@nw/shared';
import { WorldCoreSpawn } from './coreSpawn';
import { marchVisionRadius, tileVisionRadius } from './coreHelpers';
import { refreshFamilyProsperity } from './prosperity';
import type { TileDoc } from './db';

export class WorldCoreVision extends WorldCoreSpawn {
  /** Set of accountIds for the player plus all same-family members (family-level vision sharing / ally determination, §8.2; includes self). Sourced from PlayerWorldDoc.familyId (SS7 mirror, scoped to this world) rather than a local family mirror (dead since P4, see db.ts note above SectDoc). */
  async familyMemberIds(worldId: string, accountId: string): Promise<Set<string>> {
    const ids = new Set<string>([accountId]);
    const myPw = await this.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (myPw?.familyId) {
      const mates = await this.deps.cols.playerWorld.find({ worldId, familyId: myPw.familyId }).toArray();
      for (const m of mates) ids.add(m.accountId);
    }
    return ids;
  }

  /**
   * G5: set of accountIds of all members of the player's sect's "allied sects" (`sect.allySectIds`, ≤2).
   * Chain: accountId → playerWorld.familyId → socialsvc family.sectId → sect.allySectIds → member families of each allied sect (socialsvc) → members joined to this world.
   * Alliances do **not** share vision (§8.2); used only by getMap to tag allied territory (yellow border). No sect / no alliance → empty set.
   * Does not include self or same-family members (those go through `familyMemberIds`).
   */
  protected async allySectMemberIds(worldId: string, accountId: string): Promise<Set<string>> {
    const { cols } = this.deps;
    const result = new Set<string>();
    const myPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!myPw?.familyId) return result;
    const [myFam] = await this.socialsvc.getFamiliesByIds([myPw.familyId]);
    if (!myFam?.sectId) return result;
    const mySect = await cols.sects.findOne({ _id: myFam.sectId });
    const allyIds = mySect?.allySectIds ?? [];
    if (allyIds.length === 0) return result;
    const allyFamilies = (await Promise.all(allyIds.map((sid) => this.socialsvc.getFamiliesBySect(sid)))).flat();
    const famIds = allyFamilies.map((f) => f.familyId);
    if (famIds.length === 0) return result;
    const members = await cols.playerWorld.find({ worldId, familyId: { $in: famIds } }).toArray();
    for (const m of members) result.add(m.accountId);
    return result;
  }

  /**
   * R-3 (§8.2 / §18.7): the set of accountIds the player must NOT siege — "friendly fire" prevention.
   * Covers three friendly tiers: self + own family (≤30) + own sect (all families sharing the sect) +
   * allied sects (`sect.allySectIds`, ≤2). Blocking only allied *other* sects while leaving same-sect
   * families attackable would be inconsistent (the sect is itself a cooperative grouping), so all three
   * are unioned here. Chain: familyId → sectId → {own sect ∪ allied sects} → member families → members
   * joined to this world. No family → just self. Read-only; runs only on the attack branch of startMarch.
   */
  async friendlyAccountIds(worldId: string, accountId: string): Promise<Set<string>> {
    const { cols } = this.deps;
    const result = new Set<string>([accountId]);
    const myPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!myPw?.familyId) return result;
    const famIds = new Set<string>([myPw.familyId]); // own family always friendly
    const [myFam] = await this.socialsvc.getFamiliesByIds([myPw.familyId]);
    if (myFam?.sectId) {
      const mySect = await cols.sects.findOne({ _id: myFam.sectId });
      const sectIds = [myFam.sectId, ...(mySect?.allySectIds ?? [])]; // own sect + allied sects
      const fams = (await Promise.all(sectIds.map((sid) => this.socialsvc.getFamiliesBySect(sid)))).flat();
      for (const f of fams) famIds.add(f.familyId);
    }
    const members = await cols.playerWorld.find({ worldId, familyId: { $in: [...famIds] } }).toArray();
    for (const m of members) result.add(m.accountId);
    return result;
  }

  /**
   * G5: compute the set of vision sources for the requester within the given viewport (including the radius-padded border).
   * Sources = own + same-family members' territory (capital type:'base' gets large radius, other territory gets small radius) + own/family marches in transit
   * (current position linearly interpolated from departAt/arriveAt) + tiles own/family currently hold a pending occupation on (ADR-037 §5.4: `contestedBy`,
   * so the holder keeps eyes on their own hold countdown even though the tile isn't owned yet). Family members are looked up via familyMembers (tile.familyId is
   * not written on the occupy path and cannot be relied upon), ≤30 members. Vision is not persisted; computed fresh on each read (short-TTL cache deferred to G5 follow-up optimization).
   */
  async computeVisionSources(
    worldId: string,
    accountId: string,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
  ): Promise<VisionSource[]> {
    const { cols, now } = this.deps;
    // Vision source owners = self + same-family members (family-level sharing, decided in §8.2).
    const ids = [...(await this.familyMemberIds(worldId, accountId))];

    // Source territory: pad the viewport by the maximum vision radius (territory/watchtowers outside the viewport can still illuminate its edges).
    const pad = VISION_MAX_RADIUS;
    const sources: VisionSource[] = [];
    const srcTiles = await cols.tiles
      .find({
        worldId,
        $or: [{ ownerId: { $in: ids } }, { contestedBy: { $in: ids } }],
        x: { $gte: x0 - pad, $lte: x1 + pad },
        y: { $gte: y0 - pad, $lte: y1 + pad },
      })
      .toArray();
    for (const t of srcTiles) {
      sources.push({ x: t.x, y: t.y, radius: tileVisionRadius(t) });
    }

    // In-transit marches (own + family): interpolate current position → small-radius vision (the value of scout marches).
    const marches = await cols.marches.find({ worldId, ownerId: { $in: ids }, status: 'marching' }).toArray();
    const t = now();
    for (const m of marches) {
      const pos = marchInterpPos(
        this.coordX(m.fromTile), this.coordY(m.fromTile),
        this.coordX(m.toTile), this.coordY(m.toTile),
        m.departAt, m.arriveAt, t,
      );
      sources.push({ x: pos.x, y: pos.y, radius: marchVisionRadius(m.kind) });
    }
    return sources;
  }

  /**
   * G5-2 reverse vision: find "players whose vision covers any of the given cells" — i.e. accounts that own
   * territory/capitals whose vision radius reaches any cell. Used to push events to visible observers when a march
   * starts or a tile changes hands (enemy march entering your vision triggers a push, V4).
   * Called once per low-frequency event (not per tick) to avoid the U11 reverse fan-out explosion. v1 only fetches
   * the territory owner themselves (real-time fan-out to family members deferred — they see it via family-shared
   * getMap polling too). exclude = parties already pushed individually (march owner / defender).
   */
  async visionObservers(
    worldId: string,
    cells: readonly { x: number; y: number }[],
    exclude: ReadonlySet<string>,
  ): Promise<string[]> {
    if (cells.length === 0) return [];
    const { cols } = this.deps;
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const pad = VISION_MAX_RADIUS;
    // Vision sources are territory/capitals/watchtowers → query owned tiles within the cells bounding-box padded by the maximum vision radius.
    const owned = await cols.tiles
      .find({
        worldId,
        x: { $gte: Math.min(...xs) - pad, $lte: Math.max(...xs) + pad },
        y: { $gte: Math.min(...ys) - pad, $lte: Math.max(...ys) + pad },
      })
      .toArray();
    const seers = new Set<string>();
    for (const t of owned) {
      if (!t.ownerId || exclude.has(t.ownerId) || seers.has(t.ownerId)) continue;
      const radius = tileVisionRadius(t);
      for (const c of cells) {
        if (Math.abs(t.x - c.x) <= radius && Math.abs(t.y - c.y) <= radius) {
          seers.add(t.ownerId);
          break;
        }
      }
    }
    return [...seers];
  }

  /** G5-2: push a tile change to all observers whose vision covers it (exclude parties already pushed individually, such as the tile owner / defender). */
  async pushTileToObservers(t: TileDoc, exclude: ReadonlySet<string>): Promise<void> {
    const observers = await this.visionObservers(t.worldId, [{ x: t.x, y: t.y }], exclude);
    for (const acct of observers) void this.pushTile(acct, t);
  }

  /**
   * ADR-039: familyIds of the player's own family plus every sibling family in the same sect
   * (NOT allied sects — alliance is diplomatic only and does not merge territory for connectivity
   * purposes, unlike friendlyAccountIds' friendly-fire check which does include allies). No family →
   * empty set (caller falls back to the player's own tiles only).
   */
  private async ownSectFamilyIds(worldId: string, accountId: string): Promise<Set<string>> {
    const { cols } = this.deps;
    const result = new Set<string>();
    const myPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!myPw?.familyId) return result;
    result.add(myPw.familyId);
    const [myFam] = await this.socialsvc.getFamiliesByIds([myPw.familyId]);
    if (myFam?.sectId) {
      const sectFams = await this.socialsvc.getFamiliesBySect(myFam.sectId);
      for (const f of sectFams) result.add(f.familyId);
    }
    return result;
  }

  /**
   * ADR-039 helper: which cells connectivity should check adjacency against for a given target — the whole
   * 3×3 base footprint if the target is a capital (anchor or ring cell; anchor coords are parsed straight out
   * of `baseAnchor`'s tileId string, no extra DB round-trip), otherwise just the single target cell. A
   * capital's anchor is only ever bordered by its own ring cells, so checking the anchor alone would make
   * capitals structurally unattackable — the footprint's outer perimeter is what attacking territory can
   * actually reach.
   */
  targetFootprintCells(tile: TileDoc | null | undefined, x: number, y: number): { x: number; y: number }[] {
    if (tile?.type === 'base') return baseFootprintCells(x, y);
    if (tile?.baseRing && tile.baseAnchor) {
      return baseFootprintCells(this.coordX(tile.baseAnchor), this.coordY(tile.baseAnchor));
    }
    return [{ x, y }];
  }

  /**
   * ADR-039 territory connectivity ("连地"): true if any cell of `targetCells` is 4-directionally adjacent
   * to a tile owned by the player, or by any fellow member of the player's sect (own family ∪ sibling
   * families in the same sect — allied sects do NOT count; an alliance is a non-aggression pact, not a
   * merged frontier). No family/sect → checks the player's own tiles only. Gates both occupy and attack
   * march departure (startMarch) and is re-checked on arrival (sect territory can shift mid-flight);
   * applies uniformly to regular tiles, capitals, and bridges/plankways since they all funnel through the
   * same march/siege path. `targetCells` is the single target cell for ordinary tiles, or the WHOLE 3×3
   * footprint for a capital (ADR-025: a capital's anchor is only ever bordered by its own ring cells, so
   * checking the anchor alone would make capitals structurally unattackable — the outer perimeter of the
   * footprint is what an attacker's territory can actually reach); callers resolve which applies.
   */
  async isConnectedToSectTerritory(
    worldId: string,
    accountId: string,
    targetCells: readonly { x: number; y: number }[],
  ): Promise<boolean> {
    const { cols } = this.deps;
    const famIds = await this.ownSectFamilyIds(worldId, accountId);
    const ownerIds = famIds.size > 0
      ? (await cols.playerWorld
          .find({ worldId, familyId: { $in: [...famIds] } })
          .project<{ accountId: string }>({ accountId: 1 })
          .toArray()
        ).map((p) => p.accountId)
      : [accountId];
    const targetKeys = new Set(targetCells.map((c) => `${c.x}:${c.y}`));
    const neighbors = targetCells.flatMap(({ x, y }) => [
      { x: x - 1, y }, { x: x + 1, y }, { x, y: y - 1 }, { x, y: y + 1 },
    ]).filter((c) => !targetKeys.has(`${c.x}:${c.y}`)); // a footprint's own cells never count as their own neighbor
    if (neighbors.length === 0) return false;
    const n = await cols.tiles.countDocuments({
      worldId,
      ownerId: { $in: ownerIds },
      $or: neighbors,
    });
    return n > 0;
  }

  async sameFamily(worldId: string, a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const { cols } = this.deps;
    const [pa, pb] = await Promise.all([
      cols.playerWorld.findOne({ _id: playerWorldId(worldId, a) }),
      cols.playerWorld.findOne({ _id: playerWorldId(worldId, b) }),
    ]);
    return !!pa?.familyId && pa.familyId === pb?.familyId;
  }

  /**
   * Increment family activity by delta and refresh prosperity (§17.4, server-authoritative, no client write path).
   * Best-effort: failure is logged but does not block the main occupy/siege flow. familyId absent (solo player) → skip.
   */
  async bumpFamilyActivity(worldId: string, familyId: string | undefined, delta: number): Promise<void> {
    if (!familyId) return;
    try {
      await this.socialsvc.bumpActivity(familyId, delta);
      await refreshFamilyProsperity(this.deps.cols, this.socialsvc, worldId, familyId);
    } catch (e) {
      console.error('[worldsvc] bumpFamilyActivity failed', { worldId, familyId, err: (e as Error).message });
    }
  }
}
