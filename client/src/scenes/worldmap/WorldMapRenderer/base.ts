// Shared foundation for the WorldMapRenderer mixin chain (see ../WorldMapRenderer.ts assembly).
//
// WorldMapRendererBase owns the constructor (`ctx`, the only injected dependency) plus the few own
// instance fields the renderer keeps outside ctx (the memoized NPC-city node list) and the small
// cityNodes() helper that fills it. Every rendering concern — scene scaffold/loading cover (build),
// viewport/zoom transforms (viewport), the L1/L2 tile pool (pool), city sprites (city), fog + overlay
// + L3 batch (fog), and the update/bootstrap/teardown lifecycle (lifecycle) — lives in its own sibling
// file as `XMixin(Base)` and is chained into the final WorldMapRenderer.
import { allCityNodes, type MapEditorCityNode } from '@nw/shared';
import type { WorldMapContext } from '../WorldMapContext';

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type WorldMapRendererBaseCtor = Constructor<WorldMapRendererBase>;

export class WorldMapRendererBase {
  /** Deterministic NPC city nodes for the current world, memoized (they depend only on the seed). */
  protected _cityNodes: MapEditorCityNode[] | null = null;
  protected _cityNodesWorld = '';

  constructor(protected readonly ctx: WorldMapContext) {}

  protected cityNodes(): MapEditorCityNode[] {
    if (this._cityNodes && this._cityNodesWorld === this.ctx.cb.worldId) return this._cityNodes;
    this._cityNodes = allCityNodes(this.ctx.cb.worldId);
    this._cityNodesWorld = this.ctx.cb.worldId;
    return this._cityNodes;
  }
}

// ── Cross-file method surface ───────────────────────────────────────────────────
// Methods that live in a mixin but are invoked from another mixin's body (across files) must be
// visible on the Base type so those calls type-check as METHODS (not properties, which would clash
// with the mixin's own definition — TS2425). Declaration-merged here; emits nothing at runtime, so the
// real prototype methods provided by the mixins run and all method bodies stay verbatim.
export interface WorldMapRendererBase {
  buildPool(): void;
  invalidatePool(): void;
  renderOverlay(dt?: number): void;
  refreshCityLayer(): void;
  isBaseAnchor(tx: number, ty: number): boolean;
  renderMap(): void;
  renderMapL3(): void;
  hideLoading(): void;
}
