/**
 * StickmanRuntime — game-side playback runtime.
 *
 * Shares core logic with the editor:
 *   - src/core/types.ts  (data interfaces)
 *   - src/animation/interpolate.ts  (sampleClip, pure function)
 *   - src/skeleton/Skeleton.ts  (FK computation, pure)
 *
 * No editor UI is imported. Bundle this file alongside the three
 * shared modules for use in any PixiJS v7 game.
 *
 * Usage:
 *   const runtime = new StickmanRuntime({
 *     atlasJson:  '/assets/sheet.json',
 *     atlasImage: '/assets/sheet.png',
 *     animData:   '/assets/character.animator.json',
 *     container:  myPixiContainer,
 *   });
 *   await runtime.load();
 *   runtime.play('walk');
 *   runtime.play('attack', { loop: false, onComplete: () => runtime.play('idle') });
 */

import * as PIXI from 'pixi.js';
import type { AnimationClip, BoneKeyframe, SpriteBinding } from '../src/core/types';
import { sampleClip } from '../src/animation/interpolate';
import { Skeleton } from '../src/skeleton/Skeleton';

// ── Serialized project format (mirrors IOController's format) ─────────────────

interface SerializedBinding {
  frameId: string;
  anchorX?: number;
  anchorY?: number;
  flipX?:   boolean;
}

interface SerializedBoneKF {
  rotation?:   number;
  scaleX?:     number;
  scaleY?:     number;
  translateX?: number;
  translateY?: number;
  alpha?:      number;
  frameId?:    string | null;
  easing?:     string;
}

interface SerializedKeyframe {
  time:  number;
  bones: Record<string, SerializedBoneKF>;
}

interface SerializedClip {
  duration:  number;
  loop:      boolean;
  keyframes: SerializedKeyframe[];
}

interface SerializedProject {
  version:    number;
  bindings:   Record<string, SerializedBinding>;
  animations: Record<string, SerializedClip>;
}

// ── Atlas JSON shapes (TexturePacker hash / array) ────────────────────────────

interface TPFrame {
  frame: { x: number; y: number; w: number; h: number };
}

interface TPJsonHash  { frames: Record<string, TPFrame>; }
interface TPJsonArray { frames: Array<{ filename: string } & TPFrame>; }

// ── Public API ────────────────────────────────────────────────────────────────

export interface RuntimeOptions {
  /** URL to the TexturePacker JSON atlas. */
  atlasJson:  string;
  /** URL to the atlas spritesheet image. */
  atlasImage: string;
  /** URL to the `.animator.json` project file exported from the editor. */
  animData:   string;
  /** PixiJS container that the runtime will add bone sprites to. */
  container:  PIXI.Container;
  /**
   * Root position of the skeleton within `container`.
   * Defaults to (0, 0) — i.e. the container's local origin is the hip pivot.
   */
  rootX?: number;
  rootY?: number;
}

export interface PlayOptions {
  /** Override the clip's own loop flag. */
  loop?:       boolean;
  /** Called once when a non-looping clip reaches its end. */
  onComplete?: () => void;
}

// ── StickmanRuntime ───────────────────────────────────────────────────────────

export class StickmanRuntime {
  private readonly animations = new Map<string, AnimationClip>();
  private readonly bindings   = new Map<string, SpriteBinding>();
  private readonly textures   = new Map<string, PIXI.Texture>();
  /** boneId → Sprite (one per binding, reused across frame switches via texture swap) */
  private readonly sprites    = new Map<string, PIXI.Sprite>();

  private currentName:        string | null = null;
  private currentTime         = 0;
  private isPlaying           = false;
  private speed               = 1;
  private looping             = true;
  private onCompleteCallback: (() => void) | null = null;

  private rafId:  number = 0;
  private lastTs: number | null = null;

  private rootX: number;
  private rootY: number;

  constructor(private readonly options: RuntimeOptions) {
    this.rootX = options.rootX ?? 0;
    this.rootY = options.rootY ?? 0;
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  /** Fetch all assets and build the sprite tree.  Must be awaited before play(). */
  async load(): Promise<void> {
    const [atlasJson, animData] = await Promise.all([
      fetch(this.options.atlasJson).then(r => { if (!r.ok) throw new Error(`Atlas JSON fetch failed: ${r.status}`); return r.json(); }),
      fetch(this.options.animData).then(r => { if (!r.ok) throw new Error(`Anim data fetch failed: ${r.status}`);   return r.json(); }),
    ]);

    // Build PIXI textures from atlas
    const base = PIXI.BaseTexture.from(this.options.atlasImage);
    this.parseAtlas(atlasJson as TPJsonHash | TPJsonArray).forEach((f, id) => {
      this.textures.set(id, new PIXI.Texture(base, new PIXI.Rectangle(f.x, f.y, f.w, f.h)));
    });

    // Load bindings
    const project = animData as SerializedProject;
    for (const [boneId, raw] of Object.entries(project.bindings ?? {})) {
      this.bindings.set(boneId, {
        frameId: raw.frameId,
        anchorX: raw.anchorX ?? 0.5,
        anchorY: raw.anchorY ?? 0.5,
        flipX:   raw.flipX   ?? false,
      });
    }

    // Load animation clips
    for (const [name, raw] of Object.entries(project.animations ?? {})) {
      this.animations.set(name, this.deserializeClip(raw));
    }

    // Create one Sprite per binding
    this.bindings.forEach((binding, boneId) => {
      const texture = this.textures.get(binding.frameId);
      const sprite  = new PIXI.Sprite(texture ?? PIXI.Texture.EMPTY);
      sprite.anchor.set(binding.anchorX, binding.anchorY);
      this.sprites.set(boneId, sprite);
      this.options.container.addChild(sprite);
    });
  }

  // ── Playback controls ─────────────────────────────────────────────────────

  /** Start playing an animation clip (from t = 0). */
  play(name: string, opts?: PlayOptions): void {
    const clip = this.animations.get(name);
    if (!clip) { console.warn(`StickmanRuntime: unknown clip "${name}"`); return; }

    cancelAnimationFrame(this.rafId);
    this.currentName       = name;
    this.currentTime       = 0;
    this.isPlaying         = true;
    this.looping           = opts?.loop ?? clip.loop;
    this.onCompleteCallback = opts?.onComplete ?? null;
    this.lastTs            = null;
    this.rafId             = requestAnimationFrame(ts => this.tick(ts));
  }

  pause(): void {
    this.isPlaying = false;
    cancelAnimationFrame(this.rafId);
  }

  stop(): void {
    this.pause();
    this.currentTime = 0;
    this.updateFrame();
  }

  setSpeed(v: number): void {
    this.speed = Math.max(0, v);
  }

  /** Set the hip/root position in the container's coordinate space. */
  setRootPos(x: number, y: number): void {
    this.rootX = x;
    this.rootY = y;
  }

  /** Destroy all sprites and textures.  Do not use the runtime after calling this. */
  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.sprites.forEach(s => s.destroy());
    this.textures.forEach(t => t.destroy(false));
    this.sprites.clear();
    this.textures.clear();
  }

  // ── RAF loop ──────────────────────────────────────────────────────────────

  private tick(ts: number): void {
    if (!this.isPlaying) return;

    if (this.lastTs !== null) {
      const dt   = ((ts - this.lastTs) / 1000) * this.speed;
      const clip = this.animations.get(this.currentName!)!;
      let   t    = this.currentTime + dt;

      if (t >= clip.duration) {
        if (this.looping) {
          t = t % clip.duration;
        } else {
          this.currentTime = clip.duration;
          this.isPlaying   = false;
          this.updateFrame();
          this.onCompleteCallback?.();
          return;
        }
      }
      this.currentTime = t;
    }

    this.lastTs = ts;
    this.updateFrame();
    this.rafId = requestAnimationFrame(ts2 => this.tick(ts2));
  }

  // ── Frame application ─────────────────────────────────────────────────────

  private updateFrame(): void {
    const clip = this.currentName ? this.animations.get(this.currentName) : null;
    if (!clip) return;

    const transforms = sampleClip(clip, this.currentTime);
    const worldPose  = Skeleton.computeFK(this.rootX, this.rootY, transforms);

    this.sprites.forEach((sprite, boneId) => {
      const pose      = worldPose.get(boneId);
      const binding   = this.bindings.get(boneId);
      const transform = transforms.get(boneId);
      if (!pose || !binding) { sprite.visible = false; return; }

      // Determine which frame to show
      const frameId = transform?.frameId !== undefined
        ? transform.frameId
        : binding.frameId;

      if (frameId === null) { sprite.visible = false; return; }

      const texture = this.textures.get(frameId);
      if (texture) sprite.texture = texture;

      sprite.visible  = true;
      sprite.anchor.set(binding.anchorX, binding.anchorY);
      sprite.x        = pose.sx + (transform?.translateX ?? 0);
      sprite.y        = pose.sy + (transform?.translateY ?? 0);
      sprite.rotation = ((pose.wa + (transform?.rotation ?? 0)) * Math.PI) / 180;
      sprite.scale.set(
        (binding.flipX ? -1 : 1) * (transform?.scaleX ?? 1),
        transform?.scaleY ?? 1,
      );
      sprite.alpha = transform?.alpha ?? 1;
    });
  }

  // ── Deserialize helpers ───────────────────────────────────────────────────

  private deserializeClip(raw: SerializedClip): AnimationClip {
    return {
      duration:  raw.duration,
      loop:      raw.loop,
      keyframes: raw.keyframes.map(kf => ({
        time:  kf.time,
        bones: new Map(
          Object.entries(kf.bones).map(([id, bkf]) => [id, bkf as BoneKeyframe]),
        ),
      })),
    };
  }

  private parseAtlas(
    json: TPJsonHash | TPJsonArray,
  ): Map<string, { x: number; y: number; w: number; h: number }> {
    const out = new Map<string, { x: number; y: number; w: number; h: number }>();
    if (Array.isArray((json as TPJsonArray).frames)) {
      for (const e of (json as TPJsonArray).frames) {
        out.set(e.filename, e.frame);
      }
    } else {
      for (const [name, e] of Object.entries((json as TPJsonHash).frames)) {
        out.set(name, e.frame);
      }
    }
    return out;
  }
}
