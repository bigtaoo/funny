// SLG map template ops (§24). Thin proxy over worldsvc /admin/world/map-templates/* (own the same way
// WorldMixin proxies season ops) + audit for the mutating actions. Business rules (delete-guard on the
// active template, viewport/diff-save size caps) live in worldsvc's MapTemplateService — this layer only
// adds capability gating (enforced again at httpApi.ts) + audit trail.
import type { MapTemplateSummary, MapTemplateTile } from '@nw/shared';
import type { AdminBaseCtor, Constructor } from './base';

export interface MapTemplatesHandlers {
  slgListMapTemplates(): Promise<MapTemplateSummary[]>;
  slgGenerateMapTemplate(actor: string, templateId: string, width: number, height: number): Promise<MapTemplateSummary>;
  slgGetMapTemplateTiles(templateId: string, x: number, y: number, w: number, h: number): Promise<MapTemplateTile[]>;
  slgSaveMapTemplateTiles(actor: string, templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }>;
  slgActivateMapTemplate(actor: string, templateId: string): Promise<void>;
  slgDeleteMapTemplate(actor: string, templateId: string): Promise<void>;
}

export function MapTemplatesMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<MapTemplatesHandlers> {
  return class extends Base {
    /** List template metadata (capability slg.map.view). Returns empty if worldsvc is unreachable. */
    async slgListMapTemplates(): Promise<MapTemplateSummary[]> {
      if (!this.world.available) return [];
      return this.world.listMapTemplates();
    }

    /** Generate (or regenerate) a template's seed tiles from proceduralTile (capability slg.map.manage, high-risk: replaces existing tiles for this templateId). Audited. */
    async slgGenerateMapTemplate(actor: string, templateId: string, width: number, height: number): Promise<MapTemplateSummary> {
      const summary = await this.world.generateMapTemplate(templateId, width, height);
      await this.audit(actor, 'slg.map.template.generate', { target: templateId, summary: `${width}x${height} tiles=${summary.tileCount}` });
      return summary;
    }

    /** Viewport bbox read for the editor canvas (capability slg.map.view). */
    async slgGetMapTemplateTiles(templateId: string, x: number, y: number, w: number, h: number): Promise<MapTemplateTile[]> {
      if (!this.world.available) return [];
      return this.world.getMapTemplateTiles(templateId, x, y, w, h);
    }

    /** Diff-save the tiles the editor changed (capability slg.map.manage). Audited. */
    async slgSaveMapTemplateTiles(actor: string, templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }> {
      const result = await this.world.saveMapTemplateTiles(templateId, tiles);
      await this.audit(actor, 'slg.map.template.save', { target: templateId, summary: `${result.updated} tiles` });
      return result;
    }

    /** Mark templateId as the one new worlds clone at open time (capability slg.map.manage). Audited. */
    async slgActivateMapTemplate(actor: string, templateId: string): Promise<void> {
      await this.world.activateMapTemplate(templateId);
      await this.audit(actor, 'slg.map.template.activate', { target: templateId });
    }

    /** Delete a template (capability slg.map.manage, high-risk). worldsvc rejects if it is the active template. Audited. */
    async slgDeleteMapTemplate(actor: string, templateId: string): Promise<void> {
      await this.world.deleteMapTemplate(templateId);
      await this.audit(actor, 'slg.map.template.delete', { target: templateId });
    }
  };
}
