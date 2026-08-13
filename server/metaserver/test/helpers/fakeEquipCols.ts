// Shared in-memory `Collections` builder for equipment/* unit tests that import directly from
// `../src/equipment/*.ts` (not `../dist/*.js`) so vitest's v8 coverage provider can attribute
// executed lines back to source (see equipment-*-unit.test.ts files for the "why" — dist imports
// don't get source-mapped coverage).
// Deliberately a NEW helper file (does not modify fakeCollection.ts, which other equipment tests
// also rely on) — only extends it locally with a `deleteMany` FakeCollection lacks, since
// salvageEquipment (src/equipment/salvage.ts) is the one equipment/* function that batch-deletes.
import type { Collections, SaveData, EquipmentInstance } from '@nw/shared';
import { makeNewSave } from '@nw/shared';
import { FakeCollection, docMatches, getDotted } from './fakeCollection.js';

/** FakeCollection + deleteMany (only equipmentInstances needs it, for salvageEquipment's batch delete). */
export class FakeCollectionEx<T extends { _id: string }> extends FakeCollection<T> {
  async deleteMany(filter: Record<string, unknown> = {}): Promise<{ deletedCount: number }> {
    let deletedCount = 0;
    for (const [id, doc] of [...this.docs.entries()]) {
      if (docMatches(doc as unknown as Record<string, unknown>, filter)) {
        this.docs.delete(id);
        deletedCount++;
      }
    }
    return { deletedCount };
  }
}

/** docMatches() (fakeCollection.ts) has no $ne support — equipEquipment's "equipped elsewhere?" query
 * (`_id: { $ne: cardInstanceId }, $or: [...gear.<slot> === instanceId]`) needs it, so cardInstances gets
 * its own findOne override rather than editing the shared fakeCollection.ts (used by unrelated tests). */
function matchesWithNe(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
  const rest: Record<string, unknown> = {};
  const neChecks: [string, unknown][] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && '$ne' in (v as Record<string, unknown>)) {
      neChecks.push([k, (v as Record<string, unknown>).$ne]);
    } else {
      rest[k] = v;
    }
  }
  if (!docMatches(doc, rest)) return false;
  return neChecks.every(([k, target]) => getDotted(doc, k) !== target);
}

export class FakeCardCollection<T extends { _id: string }> extends FakeCollection<T> {
  async findOne(query: Record<string, unknown> = {}): Promise<T | null> {
    for (const d of this.docs.values()) if (matchesWithNe(d as unknown as Record<string, unknown>, query)) return d;
    return null;
  }
}

export type FakeSaveDoc = { _id: string; save: SaveData; rev: number };
export type FakeIdemDoc = { _id: string; accountId: string; op: string; result: unknown; committed?: boolean; expireAt: Date };
export type FakeInstDoc = {
  _id: string;
  accountId: string;
  defId: string;
  rarity: string;
  level: number;
  affixes: { id: string; value: number }[];
  locked?: boolean;
  sourceType?: string;
  obtainedAt?: number;
};
export type FakeCardDoc = {
  _id: string;
  accountId: string;
  defId: string;
  level: number;
  gear: Record<string, string>;
  gearInstanceIds: string[];
  locked: boolean;
};

export interface FakeEquipCols {
  cols: Collections;
  saves: FakeCollection<FakeSaveDoc>;
  equipmentIdem: FakeCollection<FakeIdemDoc>;
  equipmentInstances: FakeCollectionEx<FakeInstDoc>;
  cardInstances: FakeCardCollection<FakeCardDoc>;
}

/** Builds a fresh set of FakeCollection-backed `Collections` (no real Mongo, no shared state across tests). */
export function makeFakeCols(): FakeEquipCols {
  const saves = new FakeCollection<FakeSaveDoc>();
  const equipmentIdem = new FakeCollection<FakeIdemDoc>();
  const equipmentInstances = new FakeCollectionEx<FakeInstDoc>();
  const cardInstances = new FakeCardCollection<FakeCardDoc>();
  const cols = { saves, equipmentIdem, equipmentInstances, cardInstances } as unknown as Collections;
  return { cols, saves, equipmentIdem, equipmentInstances, cardInstances };
}

/** Seeds a fresh save (optionally mutated) for accountId, returning the SaveData object seeded. */
export function seedSave(
  saves: FakeEquipCols['saves'],
  accountId: string,
  now: number,
  mutate?: (s: SaveData) => void,
): SaveData {
  const save = makeNewSave(accountId, now);
  mutate?.(save);
  saves.seed({ _id: accountId, save, rev: save.rev });
  return save;
}

/** Directly seeds one equipment instance into the equipmentInstances FakeCollection (bypassing craft). */
export function seedInst(
  equipmentInstances: FakeEquipCols['equipmentInstances'],
  accountId: string,
  inst: EquipmentInstance,
): void {
  equipmentInstances.seed({
    _id: inst.id,
    accountId,
    defId: inst.defId,
    rarity: inst.rarity,
    level: inst.level,
    affixes: inst.affixes,
    ...(inst.locked !== undefined ? { locked: inst.locked } : {}),
    ...(inst.sourceType !== undefined ? { sourceType: inst.sourceType } : {}),
    ...(inst.obtainedAt !== undefined ? { obtainedAt: inst.obtainedAt } : {}),
  });
}

/** Reads one equipment instance back out in EquipmentInstance shape (mirrors fromInstanceDoc). */
export function readInst(equipmentInstances: FakeEquipCols['equipmentInstances'], id: string): EquipmentInstance | undefined {
  const d = equipmentInstances.docs.get(id);
  if (!d) return undefined;
  return {
    id: d._id,
    defId: d.defId,
    rarity: d.rarity as EquipmentInstance['rarity'],
    level: d.level,
    affixes: d.affixes,
    ...(d.locked !== undefined ? { locked: d.locked } : {}),
    ...(d.sourceType !== undefined ? { sourceType: d.sourceType } : {}),
    ...(d.obtainedAt !== undefined ? { obtainedAt: d.obtainedAt } : {}),
  };
}

/** Directly seeds one card instance (Hero Roster) into the cardInstances FakeCollection. */
export function seedCardInst(
  cardInstances: FakeEquipCols['cardInstances'],
  accountId: string,
  card: { id: string; defId?: string; level?: number; gear?: Record<string, string>; locked?: boolean },
): void {
  const gear = card.gear ?? {};
  cardInstances.seed({
    _id: card.id,
    accountId,
    defId: card.defId ?? 'card_test',
    level: card.level ?? 1,
    gear,
    gearInstanceIds: Object.values(gear).filter((v): v is string => !!v),
    locked: card.locked ?? false,
  });
}
