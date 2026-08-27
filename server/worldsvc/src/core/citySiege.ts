// worldsvc core — ADR-074 P1 wild-city primitives: `CityDoc` init, lookup, lazy durability regen, and
// sect ownership transfer. The counterpart of core/nation.ts (which ADR-074 hollowed out: nation founding
// used to fire from occupying a single capital cell, and province ownership moves here, keyed on the SECT
// rather than an account + family — see that file's `applyNationChange` obituary).
//
// Composition, not inheritance (claudedocs/server.md 形态②): takes a narrow constructor-injected
// `core: WorldCore`, same as NationService.
//
// The battle side lives elsewhere: `combatSiege/arrival/citySiege.ts` fights the wave ladder and schedules
// the delayed durability hit, `combatSiege/damage.ts` settles it. This file owns the document.
import {
  SlgError,
  playerWorldId,
  cityDocId,
  cityNodeCovering,
  cityDurabilityMax,
  cityRegenPerHour,
  regenCityDurability,
  cityYieldBonus,
  citySiegeBonus,
  cityMarchMult,
  CITY_BONUS_MEMBERSHIP_DELAY_MS,
  type CityKind,
  type MapEditorCityNode,
} from '@nw/shared';
import type { WorldCore } from '../core';
import type { CityDoc, PlayerWorldDoc, SectDoc, WorldCollections } from '../db';

/** What a sect's held cities pay out (§8) — the shape cached on `SectDoc.cityPayoff`, minus the timestamp. */
export type SectCityPayoff = Omit<NonNullable<SectDoc['cityPayoff']>, 'at'>;

/** The payoff of holding nothing. Every sect starts here and returns here when its last city flips. */
export const NO_CITY_PAYOFF: SectCityPayoff = {
  yield: cityYieldBonus([]),
  siegeBonus: 0,
  marchMult: 1,
};

/** A city with its durability brought up to date — what every read path must hand out. */
export interface CityState extends CityDoc {
  /** `durability` after lazy regen at the read timestamp (the stored field is only a checkpoint). */
  liveDurability: number;
}

export class CitySiegeService {
  constructor(private readonly core: WorldCore) {}

  /**
   * Create the world's city documents (season open / world reset; idempotent). Mirrors
   * `initNations`'s `$setOnInsert` shape, and like it also normalizes the fields a REOPENED world must
   * not inherit from the previous season.
   *
   * Source of truth for the node list is `core.getCities(worldId)` — the list cloned onto the WorldDoc
   * from the active map template, i.e. including any city a designer dragged in tools/map-editor. Deriving
   * it from `allCityNodes(worldId)` here instead would put a city's HP where its sprite is NOT (a template's
   * terrain is generated on the templateId's seed, not the world's own).
   *
   * Durability/regen are recomputed on every call rather than only on insert, so a level change published
   * through the map editor (or a re-tuned constant) rescales an existing world's cities at its next open
   * instead of silently keeping the old wall. A city mid-siege keeps its damage: only the CAP moves.
   */
  async initCities(worldId: string): Promise<void> {
    const nodes = await this.core.getCities(worldId);
    for (const node of nodes) {
      const kind = node.kind as CityKind;
      const durabilityMax = cityDurabilityMax(node.level, kind);
      const regenPerHour = cityRegenPerHour(node.level, kind);
      await this.core.deps.cols.cities.updateOne(
        { _id: cityDocId(worldId, node.id) },
        {
          $setOnInsert: {
            worldId,
            nodeId: node.id,
            durability: durabilityMax,
            durabilityRegenAt: this.core.deps.now(),
            rev: 0,
          },
          // Geometry + scale are re-stamped every time: they follow the published node list, not the doc.
          $set: {
            kind,
            x: node.x,
            y: node.y,
            level: node.level,
            footprint: node.footprint,
            durabilityMax,
            regenPerHour,
            ...(node.provinceIdx != null ? { provinceIdx: node.provinceIdx } : {}),
          },
          // A reopened world (same worldId, no reset) must not inherit last season's conquests or a
          // half-finished siege round — the same staleness `initNations` closes for nation ownership.
          $unset: { ownerSectId: '', ownerSectName: '', capturedAt: '', protectedUntil: '', siegeLog: '', defenderLock: '' },
        },
        { upsert: true },
      );
    }
    // Ownership was just unset on every city, so every sect's cached payoff (§8) now describes a holding
    // that no longer exists. Dropped here rather than recomputed per sect: the correct answer for all of
    // them is "nothing", and `sectPayoff` already reads an absent field as `NO_CITY_PAYOFF`.
    await this.clearSectPayoffs(worldId);
  }

  /** Every city in the world, durability brought up to date. */
  async getCityStates(worldId: string): Promise<CityState[]> {
    const docs = await this.core.deps.cols.cities.find({ worldId }).toArray();
    const t = this.core.deps.now();
    return docs.map((d) => this.withLiveDurability(d, t));
  }

  /** One city by node id, or null. */
  async getCity(worldId: string, nodeId: string): Promise<CityState | null> {
    const doc = await this.core.deps.cols.cities.findOne({ _id: cityDocId(worldId, nodeId) });
    return doc ? this.withLiveDurability(doc, this.core.deps.now()) : null;
  }

  /**
   * The city whose footprint covers (x,y), or null — the lookup every siege path starts from, since a
   * march lands on a footprint CELL and the target is the whole city (§4.1 indivisible plot).
   *
   * Reads the `cities` collection rather than the node list so overlapping plots resolve against the same
   * documents that hold the durability; the overlap tie-break itself is the shared `cityNodeCovering`, kept
   * identical to `rasterizeMapEdits` and `_cityGroundNodeAt` (a P0 bug was exactly those three drifting).
   */
  async cityAt(worldId: string, x: number, y: number): Promise<CityState | null> {
    // Bounded by the largest footprint (9) — a box query beats scanning ~64 docs per siege arrival.
    const half = 4;
    const docs = await this.core.deps.cols.cities
      .find({ worldId, x: { $gte: x - half, $lte: x + half }, y: { $gte: y - half, $lte: y + half } })
      .toArray();
    const hit = cityNodeCovering(docs, x, y);
    return hit ? this.withLiveDurability(hit, this.core.deps.now()) : null;
  }

  /** Attach the lazily-regenerated durability. Pure — no write; the checkpoint is only advanced on a hit. */
  private withLiveDurability(doc: CityDoc, t: number): CityState {
    return {
      ...doc,
      liveDurability: Math.floor(regenCityDurability(doc.durability, doc.durabilityMax, doc.durabilityRegenAt, t, doc.regenPerHour)),
    };
  }

  /**
   * Throws unless `accountId` is in a sect (ADR-074 decision 1) — the attack gate. Sect membership is
   * mirrored onto `PlayerWorldDoc.sectId` at `joinWorld`, so this costs no cross-service call.
   *
   * Sect and not family: ADR-039's connectivity check is already sect-scoped, so a family-level gate would
   * produce "allowed to attack but cannot connect". And the zh wording for `profile.sect` is 帮会, which
   * `social.sect.noFamily` already gates behind having a family — so a sect gate contains a family gate.
   *
   * Reuses the existing `NOT_IN_SECT` (403) error code rather than the `NO_SECT` the design doc drafted:
   * the client already has i18n for it from the sect-membership endpoints, and one code for one condition
   * beats two.
   */
  async requireSect(worldId: string, accountId: string): Promise<string> {
    const pw = await this.core.deps.cols.playerWorld.findOne(
      { _id: playerWorldId(worldId, accountId) },
      { projection: { sectId: 1 } },
    );
    if (!pw?.sectId) throw new SlgError('NOT_IN_SECT', 'Only members of a sect can besiege a city');
    return pw.sectId;
  }

  /** True when the city is inside its post-capture protection window. */
  isProtected(city: CityDoc, t: number): boolean {
    return (city.protectedUntil ?? 0) > t;
  }

  // ── P3: occupation payoff (§8) ──────────────────────────────────────────────────────────────────

  /**
   * Recompute one sect's cached city payoff from the cities it currently holds, and persist it.
   *
   * Called on capture for BOTH sects (a capture is also a loss) and whenever a world's city ownership is
   * wiped. Deliberately a full recompute from the `cities` collection rather than an incremental delta:
   * the input is ~64 documents indexed by `ownerSectId`, and an incremental update would have to be exactly
   * right about protection windows, world resets and simultaneous captures to avoid drifting into a payoff
   * that corresponds to no real holding. A wrong cached faucet is worse than an extra query.
   *
   * `$set` of an absolute value is correct here without a rev guard: the value is a pure function of the
   * `cities` collection at read time, not of the sect document, so two concurrent recomputes cannot lose
   * each other's information — the later read simply wins, and it is the more current one. (`sects` is also
   * outside `check:absolutewrites`' scope, which covers `playerWorld`/`tiles`; the reasoning is the same
   * one that gate encodes — what matters is whether the write publishes a value derived from a snapshot of
   * the document being written.)
   */
  async recomputeSectPayoff(worldId: string, sectId: string): Promise<SectCityPayoff> {
    const held = await this.core.deps.cols.cities
      .find({ worldId, ownerSectId: sectId }, { projection: { kind: 1, level: 1 } })
      .toArray();
    const payoff: SectCityPayoff = {
      yield: cityYieldBonus(held),
      siegeBonus: citySiegeBonus(held),
      marchMult: cityMarchMult(held),
    };
    await this.core.deps.cols.sects.updateOne(
      { _id: sectId },
      { $set: { cityPayoff: { ...payoff, at: this.core.deps.now() } } },
    );
    return payoff;
  }

  /** Drop every sect's cached payoff in a world — the counterpart of `initCities` unsetting ownership. */
  async clearSectPayoffs(worldId: string): Promise<void> {
    await this.core.deps.cols.sects.updateMany({ worldId }, { $unset: { cityPayoff: '' } });
  }

  /**
   * The cached payoff for a sect, or the empty one. `sectId` is allowed to be undefined so callers can pass
   * `pw.sectId` straight through without a branch of their own.
   */
  async sectPayoff(sectId: string | undefined): Promise<SectCityPayoff> {
    if (!sectId) return NO_CITY_PAYOFF;
    const doc = await this.core.deps.cols.sects.findOne({ _id: sectId }, { projection: { cityPayoff: 1 } });
    const p = doc?.cityPayoff;
    return p ? { yield: p.yield, siegeBonus: p.siegeBonus, marchMult: p.marchMult } : NO_CITY_PAYOFF;
  }

  /**
   * The node list enriched with siege state, for `POST /world/enter`. Cities with no document yet (a world
   * opened before ADR-074 P1 and not since reset) fall back to full durability at their computed cap, so
   * the client always has a bar to draw and the map never renders a city with no state at all.
   */
  async getCityViews(worldId: string): Promise<Array<MapEditorCityNode & {
    ownerSectId?: string; ownerSectName?: string; protectedUntil?: number;
    durability: number; durabilityMax: number; regenPerHour: number;
    siegeLog?: Record<string, number>;
  }>> {
    const [nodes, states] = await Promise.all([this.core.getCities(worldId), this.getCityStates(worldId)]);
    const byNode = new Map(states.map((s) => [s.nodeId, s]));
    return nodes.map((node) => {
      const s = byNode.get(node.id);
      const kind = node.kind as CityKind;
      return {
        ...node,
        durability: s ? s.liveDurability : cityDurabilityMax(node.level, kind),
        durabilityMax: s ? s.durabilityMax : cityDurabilityMax(node.level, kind),
        regenPerHour: s ? s.regenPerHour : cityRegenPerHour(node.level, kind),
        ...(s?.ownerSectId ? { ownerSectId: s.ownerSectId } : {}),
        ...(s?.ownerSectName ? { ownerSectName: s.ownerSectName } : {}),
        ...(s?.protectedUntil ? { protectedUntil: s.protectedUntil } : {}),
        ...(s?.siegeLog ? { siegeLog: s.siegeLog } : {}),
      };
    });
  }
}

/**
 * Whether an account has been in its sect long enough for the city yield bonus (§8.5).
 *
 * Pure and exported so the yield path can decide without a second read. Two documented holes, both in the
 * "under-credit" direction: a `sectSince` written before P3 shipped is absent and counts as long-standing
 * (a real member who was already there), and a player who joins a FAMILY already inside a sect keeps an
 * absent `sectId` until their next joinWorld — so they get nothing rather than getting it early.
 */
export function sectMembershipQualifies(pw: Pick<PlayerWorldDoc, 'sectId' | 'sectSince'>, t: number): boolean {
  if (!pw.sectId) return false;
  if (pw.sectSince == null) return true;
  return t - pw.sectSince >= CITY_BONUS_MEMBERSHIP_DELAY_MS;
}

/**
 * Mirror a family's sect membership onto every one of its members' `playerWorld` documents in a world,
 * stamping `sectSince` (§8.5's clock). `sectId === null` clears both fields.
 *
 * A standalone function rather than a `CitySiegeService` method because its two callers sit on opposite
 * sides of the service graph — `sect/membership.ts` has `cols` and `now` but no `WorldCore` — and one
 * implementation of "what the mirror looks like" is worth more than a tidier home for it.
 *
 * Point writes on two named fields, so this commutes with every other writer of these documents and needs
 * no rev guard. `updateMany` and not a loop: a family is capped small, but the whole family transitions at
 * once and a partial mirror would pay some members and not others for the same sect's cities.
 */
export async function mirrorSectMembership(
  cols: Pick<WorldCollections, 'playerWorld'>,
  worldId: string,
  familyId: string,
  sectId: string | null,
  t: number,
): Promise<void> {
  await cols.playerWorld.updateMany(
    { worldId, familyId },
    sectId ? { $set: { sectId, sectSince: t } } : { $unset: { sectId: '', sectSince: '' } },
  );
}
