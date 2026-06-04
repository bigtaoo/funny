/**
 * VFXSystem — programmatic visual effects via PIXI.Graphics.
 *
 * All effects are drawn with ink-line aesthetics to match the notebook art style.
 * No external assets required; everything is vector geometry.
 *
 * Usage:
 *   const vfx = new VFXSystem();
 *   scene.addChild(vfx.container);
 *   // each frame:
 *   vfx.update(dt);   // dt in seconds
 *   // on event:
 *   vfx.play('hit', worldX, worldY);
 */
import * as PIXI from 'pixi.js-legacy';

// ── Effect definition ──────────────────────────────────────────────────────────

/**
 * Describes how to draw a single effect frame.
 * @param gfx     A pre-cleared Graphics instance positioned at the effect origin.
 * @param t       Progress 0 → 1.
 * @param color   Primary colour (hex).
 */
type DrawFn = (gfx: PIXI.Graphics, t: number, color: number) => void;

interface EffectDef {
  /** Total play time in seconds. */
  duration: number;
  draw:     DrawFn;
}

// ── Built-in effects ───────────────────────────────────────────────────────────

const EFFECTS: Readonly<Record<string, EffectDef>> = {

  /**
   * hit — expanding ring + 6 impact spokes.
   * Plays on unit_attack_hit.
   */
  hit: {
    duration: 0.25,
    draw(gfx, t, color) {
      const alpha = 1 - t;
      const r     = t * 26;
      // expanding ring
      gfx.lineStyle(2, color, alpha);
      gfx.drawCircle(0, 0, r);
      // 6 radial spokes
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        const r0  = r * 0.45;
        const r1  = r * 0.92;
        gfx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
        gfx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
      }
    },
  },

  /**
   * death_unit — 8 radiating lines with a shrinking centre dot.
   * Plays on unit_died.
   */
  death_unit: {
    duration: 0.45,
    draw(gfx, t, color) {
      const alpha    = 1 - t;
      const spread   = t * 24;
      const nearDist = t * 8;
      // 8 lines spreading outward
      gfx.lineStyle(2, color, alpha);
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        gfx.moveTo(Math.cos(ang) * nearDist,          Math.sin(ang) * nearDist);
        gfx.lineTo(Math.cos(ang) * (nearDist + spread), Math.sin(ang) * (nearDist + spread));
      }
      // shrinking centre dot
      const dotR = Math.max(0, (1 - t) * 5);
      if (dotR > 0) {
        gfx.lineStyle(0);
        gfx.beginFill(color, alpha);
        gfx.drawCircle(0, 0, dotR);
        gfx.endFill();
      }
    },
  },

  /**
   * death_building — large explosion: outer ring + 12 spokes + 4 debris dots.
   * Plays on building_destroyed.
   */
  death_building: {
    duration: 0.55,
    draw(gfx, t, color) {
      const alpha = 1 - t;
      const r     = t * 42;

      // outer ring fades as it expands
      gfx.lineStyle(2.5, color, alpha * 0.75);
      gfx.drawCircle(0, 0, r);

      // 12 spokes — every 3rd is thicker (manga emphasis)
      for (let i = 0; i < 12; i++) {
        const ang   = (i / 12) * Math.PI * 2;
        const thick = i % 3 === 0 ? 2.5 : 1.5;
        gfx.lineStyle(thick, color, alpha);
        gfx.moveTo(Math.cos(ang) * r * 0.28, Math.sin(ang) * r * 0.28);
        gfx.lineTo(Math.cos(ang) * r * 0.92, Math.sin(ang) * r * 0.92);
      }

      // 4 asymmetric debris dots that fly outward
      const debrisAngs = [0.63, 2.19, 3.77, 5.34]; // ~36°, 125°, 216°, 306°
      for (const ang of debrisAngs) {
        const dr   = t * 38;
        const dotR = Math.max(0, (1 - t) * 4);
        if (dotR > 0) {
          gfx.lineStyle(0);
          gfx.beginFill(color, alpha * 0.9);
          gfx.drawCircle(Math.cos(ang) * dr, Math.sin(ang) * dr, dotR);
          gfx.endFill();
        }
      }
    },
  },

  /**
   * spawn — circle implodes inward then snaps to nothing.
   * Plays on unit_spawned or building_placed (optional).
   */
  spawn: {
    duration: 0.3,
    draw(gfx, t, color) {
      // ease-out: fast start, slow end
      const et    = 1 - (1 - t) * (1 - t);
      const alpha = 1 - et;
      const r     = (1 - et) * 20;
      gfx.lineStyle(2, color, alpha);
      gfx.drawCircle(0, 0, r);
      // 4 short inward spokes
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2;
        const r0  = r * 1.3;
        const r1  = r * 0.8;
        gfx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
        gfx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
      }
    },
  },
};

// ── Active instance ────────────────────────────────────────────────────────────

interface VFXInstance {
  gfx:     PIXI.Graphics;
  def:     EffectDef;
  elapsed: number;
  color:   number;
}

// ── VFXSystem ──────────────────────────────────────────────────────────────────

export class VFXSystem {
  /** Add this container to your scene graph (above units, below HUD). */
  readonly container: PIXI.Container;

  private readonly active: VFXInstance[] = [];
  /** Recycled Graphics objects to avoid GC pressure. */
  private readonly pool: PIXI.Graphics[] = [];

  constructor() {
    this.container = new PIXI.Container();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Spawn an effect at the given world-space coordinates.
   * @param effectId  One of 'hit', 'death_unit', 'death_building', 'spawn'.
   * @param x         World X (screen / design-space pixels).
   * @param y         World Y.
   * @param color     Optional tint colour (default 0x222222 — ink/notebook dark).
   */
  play(effectId: string, x: number, y: number, color = 0x222222): void {
    const def = EFFECTS[effectId];
    if (!def) {
      console.warn(`VFXSystem: unknown effect "${effectId}"`);
      return;
    }

    const gfx = this.pool.pop() ?? new PIXI.Graphics();
    gfx.x     = x;
    gfx.y     = y;
    gfx.clear();
    this.container.addChild(gfx);

    this.active.push({ gfx, def, elapsed: 0, color });
  }

  /**
   * Advance all active effects.  Call once per frame from GameRenderer.update().
   * @param dt  Delta time in seconds.
   */
  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const inst = this.active[i];
      inst.elapsed += dt;

      const t = Math.min(1, inst.elapsed / inst.def.duration);
      inst.gfx.clear();
      inst.def.draw(inst.gfx, t, inst.color);

      if (t >= 1) {
        inst.gfx.clear();
        inst.gfx.removeFromParent();
        this.pool.push(inst.gfx);        // recycle
        this.active.splice(i, 1);
      }
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
}
