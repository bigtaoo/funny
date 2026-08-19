// SLG map template ops (§24). Thin proxy over worldsvc /admin/world/map-templates/* (own the same way
// WorldMixin proxies season ops) + audit for the mutating actions. Business rules (delete-guard on the
// active template, viewport/diff-save size caps) live in worldsvc's MapTemplateService — this layer only
// adds capability gating (enforced again at httpApi.ts) + audit trail.
import type { MapEditorCityNode, MapTemplateSummary, MapTemplateTile } from '@nw/shared';
import type { AdminCore } from './base';

export interface MapTemplatesHandlers {
  slgListMapTemplates(): Promise<MapTemplateSummary[]>;
  slgGenerateMapTemplate(actor: string, templateId: string, width: number, height: number): Promise<MapTemplateSummary>;
  slgGetMapTemplateTiles(templateId: string, x: number, y: number, w: number, h: number): Promise<MapTemplateTile[]>;
  slgSaveMapTemplateTiles(actor: string, templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }>;
  slgGetMapTemplateCities(templateId: string): Promise<MapEditorCityNode[]>;
  slgSaveMapTemplateCities(actor: string, templateId: string, cities: MapEditorCityNode[]): Promise<{ updated: number }>;
  slgActivateMapTemplate(actor: string, templateId: string): Promise<void>;
  slgDeleteMapTemplate(actor: string, templateId: string): Promise<void>;
}

export class MapTemplatesService {
  constructor(private readonly core: AdminCore) {}

    /** List template metadata (capability slg.map.view). Returns empty if worldsvc is unreachable. */
    async slgListMapTemplates(): Promise<MapTemplateSummary[]> {
      if (!this.core.world.available) return [];
      return this.core.world.listMapTemplates();
    }

    /** Generate (or regenerate) a template's seed tiles from proceduralTile (capability slg.map.manage, high-risk: replaces existing tiles for this templateId). Audited. */
    async slgGenerateMapTemplate(actor: string, templateId: string, width: number, height: number): Promise<MapTemplateSummary> {
      const summary = await this.core.world.generateMapTemplate(templateId, width, height);
      await this.core.audit(actor, 'slg.map.template.generate', { target: templateId, summary: `${width}x${height} tiles=${summary.tileCount}` });
      return summary;
    }

    /** Viewport bbox read for the editor canvas (capability slg.map.view). */
    async slgGetMapTemplateTiles(templateId: string, x: number, y: number, w: number, h: number): Promise<MapTemplateTile[]> {
      if (!this.core.world.available) return [];
      return this.core.world.getMapTemplateTiles(templateId, x, y, w, h);
    }

    /** Diff-save the tiles the editor changed (capability slg.map.manage). Audited. */
    async slgSaveMapTemplateTiles(actor: string, templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }> {
      const result = await this.core.world.saveMapTemplateTiles(templateId, tiles);
      await this.core.audit(actor, 'slg.map.template.save', { target: templateId, summary: `${result.updated} tiles` });
      return result;
    }

    /** The template's city siege-point node list (capability slg.map.view). */
    async slgGetMapTemplateCities(templateId: string): Promise<MapEditorCityNode[]> {
      if (!this.core.world.available) return [];
      return this.core.world.getMapTemplateCities(templateId);
    }

    /**
     * Replace the template's city node list (capability slg.map.manage). Audited. The editor publishes this
     * together with the tile diff — the tiles are the ground under the cities, this list is what the game
     * renders city sprites from (worldsvc clones it onto each new world's WorldDoc).
     */
    async slgSaveMapTemplateCities(actor: string, templateId: string, cities: MapEditorCityNode[]): Promise<{ updated: number }> {
      const result = await this.core.world.saveMapTemplateCities(templateId, cities);
      await this.core.audit(actor, 'slg.map.template.cities', { target: templateId, summary: `${result.updated} cities` });
      return result;
    }

    /** Mark templateId as the one new worlds clone at open time (capability slg.map.manage). Audited. */
    async slgActivateMapTemplate(actor: string, templateId: string): Promise<void> {
      await this.core.world.activateMapTemplate(templateId);
      await this.core.audit(actor, 'slg.map.template.activate', { target: templateId });
    }

    /** Delete a template (capability slg.map.manage, high-risk). worldsvc rejects if it is the active template. Audited. */
    async slgDeleteMapTemplate(actor: string, templateId: string): Promise<void> {
      await this.core.world.deleteMapTemplate(templateId);
      await this.core.audit(actor, 'slg.map.template.delete', { target: templateId });
    }
}
