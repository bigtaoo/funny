// Shared foundation for the WorldMapRenderer composition (see ../WorldMapRenderer.ts assembly).
//
// WorldMapRendererCore holds the single `ctx` field (public, so the sibling domain classes below
// can reference `this.core.ctx.*`) plus the memoized NPC-city node list (cityNodes()), the only
// own instance state the renderer keeps outside ctx. Every rendering concern — scene scaffold/
// loading cover (build), viewport/zoom transforms (viewport), the L1/L2 tile pool (pool), city
// sprites (city), fog + overlay + L3 batch (fog), the base-damage vignette (vignette), and the
// update/bootstrap/teardown lifecycle (lifecycle) — is its own independent class in a sibling
// file, constructed with `core` (+ sibling references per the confirmed call graph) and composed
// into the final WorldMapRenderer facade (2026-08-12: converted from the former `XMixin(Base)`
// inheritance chain — see claudedocs/client-modules.md's split-form priority note, and
// ../WorldMapRenderer.ts's file-header comment for how the two genuine bidirectional dependencies
// found during the conversion — both involving the old pool.ts — were resolved).
import { allCityNodes, type MapEditorCityNode } from '@nw/shared';
import type { WorldMapContext } from '../WorldMapContext';

export class WorldMapRendererCore {
  /** Seed-derived NPC city nodes for the current world, memoized (they depend only on the seed). Only used
   * as the fallback in cityNodes() below — never in preference to the server's list. */
  private seedCityNodesCache: MapEditorCityNode[] | null = null;
  private seedCityNodesWorld = '';

  constructor(readonly ctx: WorldMapContext) {}

  /**
   * The NPC city nodes the city sprite layer should draw.
   *
   * The server's list (`ctx.cityNodes`, from `POST /world/enter`) wins whenever it has arrived, because it
   * is the only list that agrees with the GROUND the same world serves: tools/map-editor lets a designer
   * drag cities and publish, which rasterizes each city's whole N×N footprint into the map template's tiles
   * (shared rasterizeMapEdits) and stores the moved node list next to them. Recomputing `allCityNodes()`
   * from the world's seed — which is all this did before 2026-08-19 — drew every sprite at its original
   * procedural position, leaving published cities as plots of bare city ground with the castle standing
   * somewhere else entirely. It is also wrong for an UNEDITED template whose id differs from the world's,
   * since a template's terrain is generated on the templateId's seed.
   *
   * `allCityNodes(worldId)` remains the fallback for the frames before the entry fetch lands, for an
   * offline/failed entry fetch, and for test fixtures that never call it — all cases where the world has
   * no server-side city list to disagree with.
   */
  cityNodes(): MapEditorCityNode[] {
    if (this.ctx.cityNodes) return this.ctx.cityNodes;
    if (this.seedCityNodesCache && this.seedCityNodesWorld === this.ctx.cb.worldId) return this.seedCityNodesCache;
    this.seedCityNodesCache = allCityNodes(this.ctx.cb.worldId);
    this.seedCityNodesWorld = this.ctx.cb.worldId;
    return this.seedCityNodesCache;
  }
}
