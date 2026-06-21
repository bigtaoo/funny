/**
 * VFXSystem — data-driven visual effects via PIXI.Graphics.
 *
 * Effects are declarative JSON (client/src/render/vfx/effects/*.json), drawn by
 * a generic interpreter in the ink-line notebook aesthetic. No external assets;
 * everything is seeded vector geometry (deterministic, replay-safe — design §6).
 *
 * Usage:
 *   const vfx = new VFXSystem();
 *   scene.addChild(vfx.container);
 *   // each frame:
 *   vfx.update(dt);              // dt in seconds
 *   // one-shot:
 *   vfx.play('hit', worldX, worldY);
 *   // looping (haste/aura/shield), bound to a unit:
 *   const h = vfx.play('aura_heal', x, y, 0x3366cc, { follow: () => unit.worldPos() });
 *   // …later, when the state ends:
 *   vfx.stop(h);
 *
 * Design doc: design/tools/vfx-editor/DESIGN.md
 */
import * as PIXI from 'pixi.js-legacy';
import { EFFECTS } from './vfx/registry';
import { interpret } from './vfx/interpret';
import { EffectDef } from './vfx/types';

const DEFAULT_COLOR = 0x222222;

/** Target the effect follows each frame; return null to auto-stop (e.g. unit gone). */
export type FollowFn = () => { x: number; y: number } | null;

export interface PlayOpts {
  /** Bind a looping/one-shot effect to a moving target's position. */
  follow?: FollowFn;
}

/** Opaque handle returned by play(); pass to stop() to end a looping effect. */
export type VFXHandle = number;

// ── Active instance ────────────────────────────────────────────────────────────

interface VFXInstance {
  handle:   VFXHandle;
  gfx:      PIXI.Graphics;
  def:      EffectDef;
  duration: number;
  loop:     boolean;
  elapsed:  number;
  color:    number;
  baseSeed: number;
  follow?:  FollowFn;
}

/** Resolve a number | "0xRRGGBB" string colour to a hex number. */
function toColor(c: string | number | undefined, fallback: number): number {
  if (typeof c === 'number') return c;
  if (typeof c === 'string') {
    const n = Number(c);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

/** Stable 32-bit hash of an effect id → per-instance seed base (deterministic). */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

// ── VFXSystem ──────────────────────────────────────────────────────────────────

export class VFXSystem {
  /** Add this container to your scene graph (above units, below HUD). */
  readonly container: PIXI.Container;

  private readonly active: VFXInstance[] = [];
  /** Recycled Graphics objects to avoid GC pressure. */
  private readonly pool: PIXI.Graphics[] = [];
  private nextHandle: VFXHandle = 1;

  constructor() {
    this.container = new PIXI.Container();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Spawn an effect at the given world-space coordinates.
   * @param effectId  A registered effect id ('hit', 'death_unit', …).
   * @param x         World X (design-space pixels).
   * @param y         World Y.
   * @param color     Optional tint; overrides the effect's defaultColor.
   * @param opts      Optional { follow } to bind the effect to a moving target.
   * @returns         A handle; for looping effects, pass it to stop().
   */
  play(effectId: string, x: number, y: number, color?: number, opts?: PlayOpts): VFXHandle {
    const def = EFFECTS[effectId];
    if (!def) {
      console.warn(`VFXSystem: unknown effect "${effectId}"`);
      return 0;
    }

    const gfx = this.pool.pop() ?? new PIXI.Graphics();
    gfx.x = x;
    gfx.y = y;
    gfx.clear();
    this.container.addChild(gfx);

    const handle = this.nextHandle++;
    this.active.push({
      handle,
      gfx,
      def,
      duration: def.duration,
      loop:     def.loop === true,
      elapsed:  0,
      color:    color ?? toColor(def.defaultColor, DEFAULT_COLOR),
      baseSeed: hashId(effectId),
      follow:   opts?.follow,
    });
    return handle;
  }

  /** Stop and recycle a (typically looping) effect by its handle. No-op if gone. */
  stop(handle: VFXHandle): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].handle === handle) {
        this.recycle(i);
        return;
      }
    }
  }

  /**
   * Advance all active effects. Call once per frame from GameRenderer.update().
   * @param dt  Delta time in seconds.
   */
  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const inst = this.active[i];
      inst.elapsed += dt;

      // Follow a moving target; a null result means the target is gone → stop.
      if (inst.follow) {
        const pos = inst.follow();
        if (pos === null) { this.recycle(i); continue; }
        inst.gfx.x = pos.x;
        inst.gfx.y = pos.y;
      }

      const t = inst.loop
        ? (inst.duration > 0 ? (inst.elapsed % inst.duration) / inst.duration : 0)
        : Math.min(1, inst.elapsed / inst.duration);

      inst.gfx.clear();
      interpret(inst.def.layers, t, inst.gfx, inst.color, inst.baseSeed);

      if (!inst.loop && t >= 1) this.recycle(i);
    }
  }

  /** Clean up all resources. Call when the scene is torn down. */
  destroy(): void {
    for (const inst of this.active) inst.gfx.destroy();
    for (const gfx  of this.pool)   gfx.destroy();
    this.active.length = 0;
    this.pool.length   = 0;
    this.container.destroy({ children: true });
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Remove the active instance at index i, returning its Graphics to the pool. */
  private recycle(i: number): void {
    const inst = this.active[i];
    inst.gfx.clear();
    inst.gfx.removeFromParent();
    this.pool.push(inst.gfx);
    this.active.splice(i, 1);
  }
}
