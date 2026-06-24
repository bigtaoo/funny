/**
 * EffectModel.ts — the editor's mutable working copy of one effect.
 *
 * Holds the current EffectDef, exposes structured mutations (layer/param CRUD,
 * meta edits), snapshot-based undo/redo, a change-listener bus, and the
 * performance-budget metrics (DESIGN §9). UI panels read `effect` and call the
 * mutators; every mutator records history and notifies listeners.
 *
 * The data model itself is the game-side single source of truth (@vfx/types).
 */
import { EffectDef, LayerDef, ParamTrack, PrimitiveType } from '@vfx/types';
import { COUNT_PRIMITIVES } from './paramHints';

type Listener = () => void;

const HISTORY_CAP = 80;

/** Performance budget thresholds (DESIGN §9). */
export const BUDGET = {
  layers: 8,
  count: 32,
  vertices: 400,
  boilVariants: 4,
  boilFps: 12,
  duration: 2,
} as const;

export interface Metrics {
  layers: number;
  maxCount: number;
  vertices: number;
  duration: number;
  warnings: string[];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class EffectModel {
  private def: EffectDef;
  private listeners = new Set<Listener>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** Index of the selected layer, or -1 when none. */
  selectedLayer = -1;

  constructor(initial: EffectDef) {
    this.def = clone(initial);
    if (this.def.layers.length > 0) this.selectedLayer = 0;
  }

  // ── Observation ─────────────────────────────────────────────────────────────
  get effect(): EffectDef { return this.def; }
  get layers(): LayerDef[] { return this.def.layers; }
  get selected(): LayerDef | null {
    return this.selectedLayer >= 0 ? this.def.layers[this.selectedLayer] ?? null : null;
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(): void { for (const l of this.listeners) l(); }

  // ── History ─────────────────────────────────────────────────────────────────
  private snapshot(): void {
    this.undoStack.push(JSON.stringify(this.def));
    if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(JSON.stringify(this.def));
    this.def = JSON.parse(prev) as EffectDef;
    this.clampSelection();
    this.emit();
  }
  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(JSON.stringify(this.def));
    this.def = JSON.parse(next) as EffectDef;
    this.clampSelection();
    this.emit();
  }

  private clampSelection(): void {
    if (this.def.layers.length === 0) this.selectedLayer = -1;
    else if (this.selectedLayer >= this.def.layers.length) this.selectedLayer = this.def.layers.length - 1;
    else if (this.selectedLayer < 0) this.selectedLayer = 0;
  }

  /** Replace the whole effect WITHOUT recording history (effect switch / load). */
  loadFresh(def: EffectDef): void {
    this.def = clone(def);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.selectedLayer = this.def.layers.length > 0 ? 0 : -1;
    this.emit();
  }

  /** Replace the whole effect AND record history (e.g. JSON "apply"). */
  replace(def: EffectDef): void {
    this.snapshot();
    this.def = clone(def);
    this.clampSelection();
    this.emit();
  }

  // ── Effect meta ─────────────────────────────────────────────────────────────
  setId(id: string): void { this.snapshot(); this.def.id = id; this.emit(); }
  setDuration(d: number): void {
    if (!(d > 0)) return;
    this.snapshot(); this.def.duration = d; this.emit();
  }
  setLoop(loop: boolean): void { this.snapshot(); this.def.loop = loop; this.emit(); }
  setDefaultColor(c: string): void {
    this.snapshot();
    this.def.defaultColor = c.trim() === '' ? undefined : c.trim();
    this.emit();
  }

  // ── Layer CRUD ──────────────────────────────────────────────────────────────
  addLayer(type: PrimitiveType): void {
    this.snapshot();
    const layer: LayerDef = { type };
    if (COUNT_PRIMITIVES.has(type)) layer.count = 6;
    if (type === 'polyline') layer.points = [[0, 0], [0, -20]];
    layer.params = defaultParamsFor(type);
    this.def.layers.push(layer);
    this.selectedLayer = this.def.layers.length - 1;
    this.emit();
  }
  removeLayer(i: number): void {
    if (i < 0 || i >= this.def.layers.length) return;
    this.snapshot();
    this.def.layers.splice(i, 1);
    this.clampSelection();
    this.emit();
  }
  duplicateLayer(i: number): void {
    const src = this.def.layers[i];
    if (!src) return;
    this.snapshot();
    this.def.layers.splice(i + 1, 0, clone(src));
    this.selectedLayer = i + 1;
    this.emit();
  }
  moveLayer(i: number, dir: -1 | 1): void {
    const j = i + dir;
    if (i < 0 || i >= this.def.layers.length || j < 0 || j >= this.def.layers.length) return;
    this.snapshot();
    const [l] = this.def.layers.splice(i, 1);
    this.def.layers.splice(j, 0, l);
    this.selectedLayer = j;
    this.emit();
  }
  select(i: number): void {
    if (i === this.selectedLayer) return;
    this.selectedLayer = i;
    this.emit();
  }

  // ── Layer fields ────────────────────────────────────────────────────────────
  private mutateSelected(fn: (l: LayerDef) => void): void {
    const l = this.selected;
    if (!l) return;
    this.snapshot();
    fn(l);
    this.emit();
  }
  setLayerType(type: PrimitiveType): void {
    this.mutateSelected((l) => {
      l.type = type;
      if (COUNT_PRIMITIVES.has(type) && l.count === undefined) l.count = 6;
      if (type === 'polyline' && !l.points) l.points = [[0, 0], [0, -20]];
    });
  }
  setLayerCount(n: number): void { this.mutateSelected((l) => { l.count = Math.max(1, Math.round(n)); }); }
  setLayerSeed(seed: number | undefined): void {
    this.mutateSelected((l) => { if (seed === undefined || Number.isNaN(seed)) delete l.seed; else l.seed = seed; });
  }
  setLayerZ(z: number | undefined): void {
    this.mutateSelected((l) => { if (z === undefined || Number.isNaN(z)) delete l.z; else l.z = z; });
  }
  setLayerBoil(boil: { variants?: number; fps?: number } | undefined): void {
    this.mutateSelected((l) => { if (!boil) delete l.boil; else l.boil = boil; });
  }
  setLayerPoints(points: Array<[number, number]>): void { this.mutateSelected((l) => { l.points = points; }); }

  // ── Param CRUD (on selected layer) ──────────────────────────────────────────
  setParam(key: string, track: ParamTrack): void {
    this.mutateSelected((l) => { (l.params ??= {})[key] = track; });
  }
  removeParam(key: string): void {
    this.mutateSelected((l) => { if (l.params) delete l.params[key]; });
  }

  // ── Metrics (DESIGN §9) ─────────────────────────────────────────────────────
  metrics(): Metrics {
    const layers = this.def.layers.length;
    let maxCount = 0;
    let vertices = 0;
    const warnings: string[] = [];

    for (const l of this.def.layers) {
      const count = COUNT_PRIMITIVES.has(l.type) ? Math.max(1, l.count ?? 1) : 1;
      maxCount = Math.max(maxCount, count);
      vertices += estimateVertices(l, count);
      if (l.boil) {
        if ((l.boil.variants ?? 3) > BUDGET.boilVariants) warnings.push(`图层 boil.variants > ${BUDGET.boilVariants}`);
        if ((l.boil.fps ?? 8) > BUDGET.boilFps) warnings.push(`图层 boil.fps > ${BUDGET.boilFps}`);
      }
    }

    if (layers > BUDGET.layers) warnings.push(`图层数 ${layers} > ${BUDGET.layers}`);
    if (maxCount > BUDGET.count) warnings.push(`单层 count ${maxCount} > ${BUDGET.count}`);
    if (vertices > BUDGET.vertices) warnings.push(`估算顶点 ${vertices} > ${BUDGET.vertices}`);
    if (!this.def.loop && this.def.duration > BUDGET.duration) warnings.push(`时长 ${this.def.duration}s > ${BUDGET.duration}s`);

    return { layers, maxCount, vertices, duration: this.def.duration, warnings };
  }
}

/** Rough vertex cost per primitive for the budget estimate (visual-only). */
function estimateVertices(l: LayerDef, count: number): number {
  switch (l.type) {
    case 'ring':     return 32;
    case 'arc':      return 16;
    case 'spokes':   return count * 2;
    case 'burst':    return count * 2;
    case 'dots':     return count * 8;
    case 'polyline': return l.points?.length ?? 0;
    case 'emitter':  return 0;
    default:         return 0;
  }
}

/** Minimal starter params so a freshly-added layer is visible in preview. */
function defaultParamsFor(type: PrimitiveType): Record<string, ParamTrack> {
  switch (type) {
    case 'ring':     return { radius: { from: 0, to: 24 }, alpha: { from: 1, to: 0 }, lineWidth: 2 };
    case 'arc':      return { radius: 20, alpha: { from: 1, to: 0 }, lineWidth: 2, startAngle: 0, sweep: Math.PI };
    case 'spokes':   return { innerR: { from: 0, to: 8 }, outerR: { from: 0, to: 24 }, alpha: { from: 1, to: 0 }, lineWidth: 2 };
    case 'burst':    return { nearR: { from: 0, to: 8 }, farR: { from: 8, to: 30 }, alpha: { from: 1, to: 0 }, lineWidth: 2 };
    case 'dots':     return { spreadR: { from: 0, to: 20 }, dotSize: { from: 4, to: 0 }, alpha: { from: 1, to: 0 } };
    case 'polyline': return { alpha: { from: 1, to: 0 }, lineWidth: 2, scale: 1, rotation: 0 };
    case 'emitter':  return {};
    default:         return {};
  }
}
