// Map template service (SLG_DESIGN §24 Layer A). Owns the admin-editable terrain baseline that seeds new
// worlds: server-generated first draft (proceduralTile) → hand-tuned in the admin map editor → cloned
// (copied, not referenced) into a world's own baseline at world-open time so later template edits never
// retroactively affect a running world. Independent of WorldService/WorldCore — instantiated standalone in
// index.ts and called directly from httpApi.ts's /admin/world/map-templates/* branch.
import {
  proceduralTile,
  MAP_TEMPLATE_SAVE_MAX_TILES,
  MAP_TEMPLATE_READ_MAX_TILES,
  SlgError,
  type MapTemplateSummary,
  type MapTemplateTile,
} from '@nw/shared';
import type { WorldCollections, MapTemplateTileDoc } from './db';

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
   * Generate a template's seed data by batch-running proceduralTile() over its full grid (§24 "首包生成走服务器端").
   * proceduralTile is currently hardcoded to the fixed SLG_MAP_W/H map (module-scope Voronoi capital precompute);
   * multi-size support is blocked on the ADR-034 rewrite generalizing it — until then, generate only accepts the
   * current fixed size so every produced tile is actually correct rather than silently wrong for other sizes.
   */
  async generateTemplate(templateId: string, width: number, height: number): Promise<MapTemplateSummary> {
    if (!templateId.trim()) throw new SlgError('BAD_REQUEST', 'templateId required');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new SlgError('BAD_REQUEST', 'width/height must be positive integers');
    }

    const existing = await this.deps.cols.mapTemplates.findOne({ _id: templateId });
    const version = (existing?.version ?? 0) + 1;

    // Regenerating an existing templateId replaces its tiles outright (old seed rows would otherwise linger as stale garbage).
    await this.deps.cols.mapTemplateTiles.deleteMany({ templateId });

    const docs: MapTemplateTileDoc[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = proceduralTile(templateId, x, y);
        docs.push({ _id: `${templateId}:${x}:${y}`, templateId, x, y, type: t.type, level: t.level, ...(t.resType ? { resType: t.resType } : {}) });
      }
    }
    await bulkChunked(docs, (chunk) => this.deps.cols.mapTemplateTiles.insertMany(chunk, { ordered: false }));

    const now = this.deps.now();
    await this.deps.cols.mapTemplates.updateOne(
      { _id: templateId },
      {
        $set: { width, height, version, tileCount: docs.length, updatedAt: now },
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

  /** Viewport bbox read (§24 "每次打开从数据库取最新地形") — never dumps a whole 500×500 template in one response. */
  async getTiles(templateId: string, x0: number, y0: number, w: number, h: number): Promise<MapTemplateTile[]> {
    if (w * h > MAP_TEMPLATE_READ_MAX_TILES) {
      throw new SlgError('BAD_REQUEST', `viewport too large (${w}x${h}), max ${MAP_TEMPLATE_READ_MAX_TILES} tiles`);
    }
    const docs = await this.deps.cols.mapTemplateTiles
      .find({ templateId, x: { $gte: x0, $lt: x0 + w }, y: { $gte: y0, $lt: y0 + h } })
      .toArray();
    return docs.map((d) => ({ x: d.x, y: d.y, type: d.type, level: d.level, ...(d.resType ? { resType: d.resType } : {}) }));
  }

  /** Diff-save (§24 "保存时只上发本次改动的格子") — upserts exactly the tiles the editor changed. No lock: last writer wins. */
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

    await bulkChunked(tiles, (chunk) =>
      this.deps.cols.mapTemplateTiles.bulkWrite(
        chunk.map((t) => ({
          replaceOne: {
            filter: { _id: `${templateId}:${t.x}:${t.y}` },
            replacement: { _id: `${templateId}:${t.x}:${t.y}`, templateId, x: t.x, y: t.y, type: t.type, level: t.level, ...(t.resType ? { resType: t.resType } : {}) },
            upsert: true,
          },
        })),
        { ordered: false },
      ),
    );
    await this.deps.cols.mapTemplates.updateOne({ _id: templateId }, { $set: { updatedAt: this.deps.now() } });
    return { updated: tiles.length };
  }

  /** §24 "不能删除当前被设为创建新世界用配置的 templateId" — historical world instances are unaffected either way (they hold a clone, not a reference). */
  async deleteTemplate(templateId: string): Promise<void> {
    const template = await this.deps.cols.mapTemplates.findOne({ _id: templateId });
    if (!template) throw new SlgError('NOT_FOUND', `no such template: ${templateId}`);
    if (template.active) throw new SlgError('BAD_REQUEST', 'cannot delete the template currently active for new worlds — activate another template first');
    await this.deps.cols.mapTemplateTiles.deleteMany({ templateId });
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
   * Clone (copy) the currently active template's tiles into `worldId`'s own baseline (§24 "世界创建时对模板是克隆而非实时引用").
   * No-op (returns null) when no template is marked active — callers should keep working exactly as before
   * (proceduralTile-only) in that case; this is intentionally additive and does not change existing world-open behavior.
   */
  async cloneActiveTemplateInto(worldId: string): Promise<{ templateId: string; cloned: number } | null> {
    const template = await this.deps.cols.mapTemplates.findOne({ active: true });
    if (!template) return null;
    await this.deps.cols.mapBaselines.deleteMany({ worldId });
    const cursor = this.deps.cols.mapTemplateTiles.find({ templateId: template._id });
    let cloned = 0;
    let batch: MapTemplateTileDoc[] = [];
    for await (const t of cursor) {
      batch.push(t);
      if (batch.length >= BULK_CHUNK) {
        await this.deps.cols.mapBaselines.insertMany(
          batch.map((t) => ({ _id: `${worldId}:${t.x}:${t.y}`, worldId, x: t.x, y: t.y, type: t.type, level: t.level, ...(t.resType ? { resType: t.resType } : {}) })),
          { ordered: false },
        );
        cloned += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.deps.cols.mapBaselines.insertMany(
        batch.map((t) => ({ _id: `${worldId}:${t.x}:${t.y}`, worldId, x: t.x, y: t.y, type: t.type, level: t.level, ...(t.resType ? { resType: t.resType } : {}) })),
        { ordered: false },
      );
      cloned += batch.length;
    }
    return { templateId: template._id, cloned };
  }
}
