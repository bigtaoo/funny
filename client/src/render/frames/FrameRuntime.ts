// ── FrameRuntime — a battle unit played from a baked frame sheet ─────────────
//
// Same surface as StickmanRuntime (see render/unitRuntime.ts), so UnitView pools, flashes and
// kills either kind the same way. One sprite for the figure, one for its hit-flash contour and
// the shared soft shadow; a frame swap is a texture swap, nothing is posed per tick.
import * as PIXI from 'pixi.js-legacy';
import { STATE_ANIM } from '../stickman/constants';
import { getShadowTexture } from '../stickman/shadow';
import type { GearGlyphSpec } from '../stickman/runtimeTypes';
import type { FrameClip, FrameSheet } from './frameSheet';
import type { UnitRuntime, UnitRuntimeOptions } from '../unitRuntime';

/**
 * Where the ground sits below the container origin, in figure heights. The bone rigs are rooted
 * at the hip, so everything UnitView places around a unit (HP bar at -0.6 H, the faction marker
 * under the shadow, the cell centre) assumes the origin is there; a frame unit keeps that contract.
 */
const GROUND_BELOW_ORIGIN = 0.33;

export class FrameRuntime implements UnitRuntime {
  readonly container: PIXI.Container;

  private readonly sheet: FrameSheet;
  private readonly shadow: PIXI.Sprite;
  private readonly body: PIXI.Sprite;
  private readonly line: PIXI.Sprite;
  /** Sheet px → screen px. */
  private readonly baseScale: number;
  /** Ground y in container-local (sheet) px. */
  private readonly groundY: number;

  private clip: FrameClip | null = null;
  private clipName = '';
  private time = 0;
  private frame = -1;
  /** Start offset for looping clips, so a crowd of the same unit does not step in unison. */
  private phase = 0;
  private attackIntervalSec = 0;

  constructor(sheet: FrameSheet, options: UnitRuntimeOptions = {}) {
    this.sheet = sheet;
    this.container = new PIXI.Container();
    this.baseScale = options.targetHeight ? options.targetHeight / sheet.height : 1;
    this.groundY = sheet.height * GROUND_BELOW_ORIGIN;

    this.shadow = new PIXI.Sprite(getShadowTexture());
    this.shadow.anchor.set(0.5);
    this.shadow.position.set(0, this.groundY);
    this.shadow.width  = sheet.shadow[0] * sheet.height * 2;
    this.shadow.height = sheet.shadow[1] * sheet.height * 2;
    this.shadow.alpha  = 0.35;

    this.body = new PIXI.Sprite();
    this.line = new PIXI.Sprite();
    for (const s of [this.body, this.line]) {
      s.anchor.set(sheet.anchorX, sheet.anchorY);
      s.position.set(0, this.groundY);
    }
    this.line.visible = false;

    this.container.addChild(this.shadow, this.body, this.line);
    this.reset(options);
  }

  reset(options: UnitRuntimeOptions = {}): void {
    this.container.scale.set(this.baseScale * (options.mirrorX ? -1 : 1), this.baseScale);
    this.setOutlineFlash(null);
    this.clip = null;
    this.clipName = '';
    this.phase = Math.random();
    this.play('idle');
  }

  play(name: string): void {
    if (name === this.clipName) return;
    const clip = this.sheet.clips.get(name);
    if (!clip) return;
    this.clip = clip;
    this.clipName = name;
    this.time = 0;
    this.frame = -1;
    this.showFrame();
  }

  syncState(unitState: string): void {
    const name = STATE_ANIM[unitState] ?? 'idle';
    if (name !== this.clipName) {
      this.play(name);
    } else if (this.clip && !this.clip.loop && this.time >= this.clip.duration) {
      // A unit that keeps attacking swings again (one playthrough = one real attack interval).
      this.time = 0;
    }
  }

  setAttackInterval(seconds: number): void {
    this.attackIntervalSec = seconds;
  }

  get currentDuration(): number {
    return this.clip?.duration ?? 0;
  }

  update(dt: number): void {
    const clip = this.clip;
    if (!clip) return;
    let rate = 1;
    if (this.clipName === 'attack' && this.attackIntervalSec > 0) rate = clip.duration / this.attackIntervalSec;
    this.time += dt * rate;
    if (clip.loop) this.time %= clip.duration;
    else this.time = Math.min(this.time, clip.duration);
    this.showFrame();
  }

  private showFrame(): void {
    const clip = this.clip!;
    const n = clip.body.length;
    const i = clip.loop
      ? Math.floor((this.time / clip.duration + this.phase) * n) % n
      : Math.min(Math.floor(this.time * clip.fps), n - 1);
    if (i === this.frame) return;
    this.frame = i;
    this.body.texture = clip.body[i]!;
    this.line.texture = clip.line[i]!;
  }

  setOutlineFlash(color: number | null, alpha = 1): void {
    this.line.visible = color != null;
    if (color != null) { this.line.tint = color; this.line.alpha = alpha; }
  }

  /** Gear decals hang off bones; a frame sheet has none yet, so frame units show no gear. */
  setGear(_specs: GearGlyphSpec[]): void { /* not supported by frame sheets yet */ }

  getShadowGround(): { x: number; y: number; rx: number; ry: number } {
    const sx = this.container.scale.x, sy = this.container.scale.y;
    const h = this.sheet.height;
    return {
      x: 0,
      y: this.groundY * sy,
      rx: this.sheet.shadow[0] * h * Math.abs(sx),
      ry: this.sheet.shadow[1] * h * sy,
    };
  }

  getAttachmentOffset(id: string): { x: number; y: number } | null {
    const p = this.sheet.points[id];
    if (!p) return null;
    const h = this.sheet.height;
    return { x: p[0] * h * this.container.scale.x, y: (this.groundY + p[1] * h) * this.container.scale.y };
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
