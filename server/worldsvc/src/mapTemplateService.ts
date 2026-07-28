// Map template service (SLG_DESIGN §24 Layer A). Owns the admin-editable terrain baseline that seeds new
// worlds: server-generated first draft (proceduralTile) → hand-tuned in the admin map editor → cloned
// (copied, not referenced) into a world's own baseline at world-open time so later template edits never
// retroactively affect a running world. Independent of WorldService/WorldCore — instantiated standalone in
// index.ts and called directly from httpApi.ts's /admin/world/map-templates/* branch.
//
// Storage (2026-07-27 redesign, see shared/src/slg/mapRle.ts header): rows are run-length-encoded — one
// Mongo doc per row (height docs, e.g. 1500 at SLG_MAP_W×SLG_MAP_H) instead of one per cell (width×height,
// e.g. 2.25M) for both `mapTemplateRows` (the template) and `mapBaselineRows` (every world cloned from an
// active template). The external contract (MapTemplateTile: one flat {x,y,type,level,...} per cell) is
// unchanged — encoding/decoding happens entirely inside this service and coreMap.ts.
import {
  proceduralTile,
  encodeRow,
  applyEditsToRow,
  sliceRuns,
  MAP_TEMPLATE_SAVE_MAX_TILES,
  MAP_TEMPLATE_READ_MAX_TILES,
  SlgError,
  type MapTemplateSummary,
  type MapTemplateTile,
  type ProceduralTile,
} from '@nw/shared';
import type { WorldCollections, MapTemplateRowDoc } from './db';

export interface MapTemplateServiceDeps {
  cols: WorldCollections;
  now: () => number;
}

/** Chunk size for bulk Mongo writes — keeps a single generate/clone op within a sane payload size. */
const BULK_CHUNK = 2000;

async function bulkChunked<T>(items: T[], fn: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += BULK_CHUNK) {
    await fn(items.slice(i, i + BULK_CHUNK));
  }
}

export class MapTemplateService {
  constructor(private readonly deps: MapTemplateServiceDeps) {}

  private toSummary(doc: { _id: string; width: number; height: number; version: number; tileCount: number; active: boolean; createdAt: number; updatedAt: number }): MapTemplateSummary {
    return {
      templateId: doc._id,
      width: doc.width,
      height: doc.height,
      version: doc.version,
      tileCount: doc.tileCount,
      active: doc.active,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  /**
   * Generate a template's seed data by batch-running proceduralTile() over its full grid (§24 "initial-package generation runs server-side").
   * proceduralTile is currently hardcoded to the fixed SLG_MAP_W/H map (module-scope province/capital precompute
   * in province.ts, ADR-034 model). Multi-size support would need that precompute generalized to an arbitrary
   * grid — a separate, currently unscheduled piece of work, not something ADR-034 itself was going to unblock
   * (that rewrite is already done). Until multi-size is actually built, generate only accepts the current fixed
   * size so every produced tile is actually correct rather than silently wrong for other sizes.
   *
   * Each row is run-length-encoded (encodeRow) before being written — the write below produces `height` Mongo
   * documents, not `width*height` (see module header). `tileCount` in the summary still reports the logical
   * cell count (width*height) — that's a product-facing number (§24 API contract / existing tests), unrelated
   * to how many documents back it.
   */
  async generateTemplate(templateId: string, width: number, height: number): Promise<MapTemplateSummary> {
    if (!templateId.trim()) throw new SlgError('BAD_REQUEST', 'templateId required');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new SlgError('BAD_REQUEST', 'width/height must be positive integers');
    }

    const existing = await this.deps.cols.mapTemplates.findOne({ _id: templateId });
    const version = (existing?.version ?? 0) + 1;

    // Regenerating an existing templateId replaces its rows outright (old seed rows would otherwise linger as stale garbage).
    await this.deps.cols.mapTemplateRows.deleteMany({ templateId });

    const rows: MapTemplateRowDoc[] = [];
    for (let y = 0; y < height; y++) {
      const runs = encodeRow(width, (x) => proceduralTile(templateId, x, y));
      rows.push({ _id: `${templateId}:${y}`, templateId, y, runs });
    }
    await bulkChunked(rows, (chunk) => this.deps.cols.mapTemplateRows.insertMany(chunk, { ordered: false }));

    const now = this.deps.now();
    await this.deps.cols.mapTemplates.updateOne(
      { _id: templateId },
      {
        $set: { width, height, version, tileCount: width * height, updatedAt: now },
        $setOnInsert: { _id: templateId, active: false, createdAt: now },
      },
      { upsert: true },
    );
    const doc = await this.deps.cols.mapTemplates.findOne({ _id: templateId });
    return this.toSummary(doc!);
  }

  async listTemplates(): Promise<MapTemplateSummary[]> {
    const docs = await this.deps.cols.mapTemplates.find({}).sort({ updatedAt: -1 }).toArray();
    return docs.map((d) => this.toSummary(d));
  }

  /** Viewport bbox read (§24 "each open fetches the latest terrain from the database") — never dumps a whole 1500×1500 template in one response. Fetches only the needed row range, then decodes+slices the x range in-memory per row. */
  async getTiles(templateId: string, x0: number, y0: number, w: number, h: number): Promise<MapTemplateTile[]> {
    if (w * h > MAP_TEMPLATE_READ_MAX_TILES) {
      throw new SlgError('BAD_REQUEST', `viewport too large (${w}x${h}), max ${MAP_TEMPLATE_READ_MAX_TILES} tiles`);
    }
    const rows = await this.deps.cols.mapTemplateRows
      .find({ templateId, y: { $gte: y0, $lt: y0 + h } })
      .toArray();
    const out: MapTemplateTile[] = [];
    for (const row of rows) {
      for (const r of sliceRuns(row.runs, x0, x0 + w - 1)) {
        for (let x = r.x0; x <= r.x1; x++) {
          out.push({ x, y: row.y, type: r.type, level: r.level, ...(r.resType ? { resType: r.resType } : {}), ...(r.obstacleKind ? { obstacleKind: r.obstacleKind } : {}) });
        }
      }
    }
    return out;
  }

  /**
   * Diff-save (§24 "on save, only upload the tiles changed this time") — upserts exactly the tiles the editor
   * changed. No lock: last writer wins. Edits are grouped by row (a painted river/mountain band typically spans
   * many x's across few y's) so the read-modify-write cost is proportional to rows touched, not tiles.
   */
  async saveTilesDiff(templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }> {
    if (tiles.length === 0) return { updated: 0 };
    if (tiles.length > MAP_TEMPLATE_SAVE_MAX_TILES) {
      throw new SlgError('BAD_REQUEST', `too many tiles in one save (${tiles.length}), max ${MAP_TEMPLATE_SAVE_MAX_TILES}`);
    }
    const template = await this.deps.cols.mapTemplates.findOne({ _id: templateId });
    if (!template) throw new SlgError('NOT_FOUND', `no such template: ${templateId}`);
    for (const t of tiles) {
      if (t.x < 0 || t.x >= template.width || t.y < 0 || t.y >= template.height) {
        throw new SlgError('BAD_REQUEST', `tile (${t.x},${t.y}) outside template bounds ${template.width}x${template.height}`);
      }
    }

    const editsByY = new Map<number, Map<number, ProceduralTile>>();
    for (const t of tiles) {
      let edits = editsByY.get(t.y);
      if (!edits) { edits = new Map(); editsByY.set(t.y, edits); }
      edits.set(t.x, { type: t.type, level: t.level, ...(t.resType ? { resType: t.resType } : {}), ...(t.obstacleKind ? { obstacleKind: t.obstacleKind } : {}) });
    }

    const ys = [...editsByY.keys()];
    const existingRows = await this.deps.cols.mapTemplateRows.find({ templateId, y: { $in: ys } }).toArray();
    const rowByY = new Map(existingRows.map((r) => [r.y, r]));

    await this.deps.cols.mapTemplateRows.bulkWrite(
      ys.map((y) => {
        const edits = editsByY.get(y)!;
        // generateTemplate always writes every row 0..height-1, so `existing` should be present; synthesize a
        // fresh procedural row on the rare miss (e.g. a pre-redesign template never migrated) rather than
        // silently dropping the edit.
        const baseRuns = rowByY.get(y)?.runs ?? encodeRow(template.width, (x) => proceduralTile(templateId, x, y));
        const runs = applyEditsToRow(baseRuns, template.width, edits);
        return {
          replaceOne: {
            filter: { _id: `${templateId}:${y}` },
            replacement: { _id: `${templateId}:${y}`, templateId, y, runs },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
    await this.deps.cols.mapTemplates.updateOne({ _id: templateId }, { $set: { updatedAt: this.deps.now() } });
    return { updated: tiles.length };
  }

  /** §24 "cannot delete the templateId currently set as the config for creating new worlds" — historical world instances are unaffected either way (they hold a clone, not a reference). */
  async deleteTemplate(templateId: string): Promise<void> {
    const template = await this.deps.cols.mapTemplates.findOne({ _id: templateId });
    if (!template) throw new SlgError('NOT_FOUND', `no such template: ${templateId}`);
    if (template.active) throw new SlgError('BAD_REQUEST', 'cannot delete the template currently active for new worlds — activate another template first');
    await this.deps.cols.mapTemplateRows.deleteMany({ templateId });
    await this.deps.cols.mapTemplates.deleteOne({ _id: templateId });
  }

  /** Marks templateId as the one new worlds clone at open time. At most one template is active. */
  async setActiveTemplate(templateId: string): Promise<void> {
    const template = await this.deps.cols.mapTemplates.findOne({ _id: templateId });
    if (!template) throw new SlgError('NOT_FOUND', `no such template: ${templateId}`);
    await this.deps.cols.mapTemplates.updateMany({ active: true }, { $set: { active: false } });
    await this.deps.cols.mapTemplates.updateOne({ _id: templateId }, { $set: { active: true } });
  }

  /**
   * Clone (copy) the currently active template's rows into `worldId`'s own baseline (§24 "on world creation,
   * the template is cloned rather than referenced live"). No-op (returns null) when no template is marked
   * active — callers should keep working exactly as before (proceduralTile-only) in that case; this is
   * intentionally additive and does not change existing world-open behavior.
   * `cloned` counts ROWS (up to `height`, ~1500), not cells — no caller currently inspects this value beyond
   * logging; see module header for why rows replaced cells as the unit of storage.
   */
  async cloneActiveTemplateInto(worldId: string): Promise<{ templateId: string; cloned: number } | null> {
    const template = await this.deps.cols.mapTemplates.findOne({ active: true });
    if (!template) return null;
    await this.deps.cols.mapBaselineRows.deleteMany({ worldId });
    const cursor = this.deps.cols.mapTemplateRows.find({ templateId: template._id });
    let cloned = 0;
    let batch: MapTemplateRowDoc[] = [];
    for await (const row of cursor) {
      batch.push(row);
      if (batch.length >= BULK_CHUNK) {
        await this.deps.cols.mapBaselineRows.insertMany(
          batch.map((r) => ({ _id: `${worldId}:${r.y}`, worldId, y: r.y, runs: r.runs })),
          { ordered: false },
        );
        cloned += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.deps.cols.mapBaselineRows.insertMany(
        batch.map((r) => ({ _id: `${worldId}:${r.y}`, worldId, y: r.y, runs: r.runs })),
        { ordered: false },
      );
      cloned += batch.length;
    }
    return { templateId: template._id, cloned };
  }
}
