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
  /** Deterministic NPC city nodes for the current world, memoized (they depend only on the seed). */
  private cityNodesCache: MapEditorCityNode[] | null = null;
  private cityNodesWorld = '';

  constructor(readonly ctx: WorldMapContext) {}

  cityNodes(): MapEditorCityNode[] {
    if (this.cityNodesCache && this.cityNodesWorld === this.ctx.cb.worldId) return this.cityNodesCache;
    this.cityNodesCache = allCityNodes(this.ctx.cb.worldId);
    this.cityNodesWorld = this.ctx.cb.worldId;
    return this.cityNodesCache;
  }
}
