// Generic in-memory Mongo-collection double for internal/* route tests (no real Mongo).
// Generalizes the ad-hoc FakeCol from season-close.test.ts: adds $or/$regex/$exists/$in/$gte/$lte
// filter support + a chainable find() cursor (.sort/.limit/.project/.toArray), which the plain
// equality-only version didn't need but internal/accountRoutes.ts (searchAccounts $or/$regex) and
// internal/{ladderRoutes,eventAdminRoutes,matchReport}.ts (.find().sort().limit().toArray()) do.
// Only implements the operators actually used by metaserver's internal/* modules — not a general Mongo shim.

export function getDotted(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

export function setDotted(obj: Record<string, unknown>, path: string, val: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]!] == null) o[keys[i]!] = {};
    o = o[keys[i]!] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]!] = val;
}

function unsetDotted(obj: Record<string, unknown>, path: string): void {
  const keys = path.split('.');
  let o: Record<string, unknown> | undefined = obj;
  for (let i = 0; i < keys.length - 1 && o; i++) o = o[keys[i]!] as Record<string, unknown> | undefined;
  if (o) delete o[keys[keys.length - 1]!];
}

/** Evaluates one field's query clause: plain equality, or one of {$exists,$regex,$in,$gte,$lte,$gt,$lt}. */
function evalClause(fieldVal: unknown, clause: unknown): boolean {
  if (clause !== null && typeof clause === 'object' && !Array.isArray(clause)) {
    const c = clause as Record<string, unknown>;
    if ('$exists' in c) return c.$exists ? fieldVal !== undefined : fieldVal === undefined;
    if ('$regex' in c) {
      const re = new RegExp(c.$regex as string, (c.$options as string) ?? undefined);
      return typeof fieldVal === 'string' && re.test(fieldVal);
    }
    if ('$in' in c) return Array.isArray(c.$in) && (c.$in as unknown[]).includes(fieldVal);
    if ('$gte' in c) return typeof fieldVal === 'number' && fieldVal >= (c.$gte as number);
    if ('$lte' in c) return typeof fieldVal === 'number' && fieldVal <= (c.$lte as number);
    if ('$gt' in c) return typeof fieldVal === 'number' && fieldVal > (c.$gt as number);
    if ('$lt' in c) return typeof fieldVal === 'number' && fieldVal < (c.$lt as number);
  }
  return fieldVal === clause;
}

export function docMatches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([k, v]) => {
    if (k === '$or') return (v as Record<string, unknown>[]).some((sub) => docMatches(doc, sub));
    return evalClause(getDotted(doc, k), v);
  });
}

interface Cursor<T> {
  sort(spec: Record<string, 1 | -1>): Cursor<T>;
  limit(n: number): Cursor<T>;
  project(spec: Record<string, 0 | 1>): Cursor<T>;
  toArray(): Promise<T[]>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

function makeCursor<T extends Record<string, unknown>>(initial: T[]): Cursor<T> {
  let items = initial;
  const cursor: Cursor<T> = {
    sort(spec) {
      const [[key, dir]] = Object.entries(spec);
      items = [...items].sort((a, b) => {
        const av = getDotted(a, key) as number, bv = getDotted(b, key) as number;
        return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
      });
      return cursor;
    },
    limit(n) {
      items = items.slice(0, n);
      return cursor;
    },
    project() {
      // Projection is a no-op here: tests assert on the specific fields they need, not on absence of others.
      return cursor;
    },
    async toArray() {
      return items;
    },
    async *[Symbol.asyncIterator]() {
      for (const d of items) yield d;
    },
  };
  return cursor;
}

/** Generic fake Mongo collection backed by a Map<_id, doc>. Covers findOne/find/updateOne/findOneAndUpdate/replaceOne/deleteOne/insertOne/countDocuments. */
export class FakeCollection<T extends { _id: string }> {
  docs = new Map<string, T>();

  seed(...docs: T[]): this {
    for (const d of docs) this.docs.set(d._id, d);
    return this;
  }

  async findOne(query: Record<string, unknown> = {}, _opts?: unknown): Promise<T | null> {
    if (typeof query._id === 'string' && Object.keys(query).length === 1) return this.docs.get(query._id) ?? null;
    for (const d of this.docs.values()) if (docMatches(d as Record<string, unknown>, query)) return d;
    return null;
  }

  find(query: Record<string, unknown> = {}, opts?: { limit?: number }): Cursor<T> {
    const arr = [...this.docs.values()].filter((d) => docMatches(d as Record<string, unknown>, query));
    const cursor = makeCursor(arr);
    return opts?.limit ? cursor.limit(opts.limit) : cursor;
  }

  async countDocuments(query: Record<string, unknown> = {}): Promise<number> {
    return [...this.docs.values()].filter((d) => docMatches(d as Record<string, unknown>, query)).length;
  }

  async insertOne(doc: T): Promise<{ insertedId: string }> {
    if (this.docs.has(doc._id)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
    this.docs.set(doc._id, doc);
    return { insertedId: doc._id };
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { upsert?: boolean },
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }> {
    let d = typeof filter._id === 'string' ? this.docs.get(filter._id) : undefined;
    if (!d) d = [...this.docs.values()].find((x) => docMatches(x as Record<string, unknown>, filter));
    else if (!docMatches(d as Record<string, unknown>, filter)) d = undefined;
    const existed = !!d;
    if (!d) {
      if (!opts?.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      d = { _id: filter._id } as T;
      this.docs.set(filter._id as string, d);
    }
    const rec = d as unknown as Record<string, unknown>;
    if (update.$setOnInsert && !existed) Object.assign(rec, update.$setOnInsert);
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setDotted(rec, k, v);
    if (update.$unset) for (const k of Object.keys(update.$unset)) unsetDotted(rec, k);
    if (update.$addToSet) {
      for (const [k, v] of Object.entries(update.$addToSet)) {
        const cur = (getDotted(rec, k) as unknown[]) ?? [];
        if (!cur.includes(v)) cur.push(v);
        setDotted(rec, k, cur);
      }
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        setDotted(rec, k, ((getDotted(rec, k) as number) ?? 0) + (v as number));
      }
    }
    return { matchedCount: existed ? 1 : 0, modifiedCount: existed ? 1 : 0, upsertedCount: existed ? 0 : 1 };
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { returnDocument?: 'before' | 'after' },
  ): Promise<T | null> {
    let d = typeof filter._id === 'string' ? this.docs.get(filter._id) : undefined;
    if (!d) d = [...this.docs.values()].find((x) => docMatches(x as Record<string, unknown>, filter));
    if (!d || !docMatches(d as Record<string, unknown>, filter)) return null;
    const rec = d as unknown as Record<string, unknown>;
    const before = { ...rec } as T;
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setDotted(rec, k, v);
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) setDotted(rec, k, ((getDotted(rec, k) as number) ?? 0) + (v as number));
    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        const cur = (getDotted(rec, k) as unknown[]) ?? [];
        cur.push(v);
        setDotted(rec, k, cur);
      }
    }
    return opts?.returnDocument === 'before' ? before : d;
  }

  async replaceOne(_filter: Record<string, unknown>, doc: T): Promise<{ matchedCount: number }> {
    const existed = this.docs.has(doc._id);
    this.docs.set(doc._id, doc);
    return { matchedCount: existed ? 1 : 0 };
  }

  async deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    if (typeof filter._id === 'string') {
      const existed = this.docs.delete(filter._id);
      return { deletedCount: existed ? 1 : 0 };
    }
    const hit = [...this.docs.values()].find((x) => docMatches(x as Record<string, unknown>, filter));
    if (hit) { this.docs.delete(hit._id); return { deletedCount: 1 }; }
    return { deletedCount: 0 };
  }
}
