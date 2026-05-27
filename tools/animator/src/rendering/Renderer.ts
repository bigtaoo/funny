import * as PIXI from 'pixi.js';
import type {
  WorldPositions,
  ResolvedBoneTransform,
  SpriteBinding,
} from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';

// ── RenderData ────────────────────────────────────────────────────────────────

export interface RenderData {
  worldPose:    WorldPositions;
  boneTransforms: Map<string, ResolvedBoneTransform>;

  // Sprite resources
  bindings:   ReadonlyMap<string, SpriteBinding>;
  getTexture: (frameId: string) => PIXI.Texture | undefined;

  // Render options
  previewMode:         'skeleton' | 'sprite';
  selectedBone:        string | null;
  showJoints:          boolean;
  showSkeletonOverlay: boolean;
  showGuide:           boolean;
  showPivots:          boolean;
  backgroundColor:     number;
  rootX:               number;
  rootY:               number;
  onionData:           Array<{
    worldPose: WorldPositions;
    boneTransforms: Map<string, ResolvedBoneTransform>;
  }>;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class Renderer {
  readonly pixiApp: PIXI.Application;

  private readonly gridGfx:   PIXI.Graphics;
  private readonly onionGfx:  PIXI.Graphics;
  private readonly spriteLayer: PIXI.Container;
  private readonly boneGfx:   PIXI.Graphics;
  private readonly selGfx:    PIXI.Graphics;

  /** frameId → Sprite (reused across frames) */
  private readonly spriteCache = new Map<string, PIXI.Sprite>();

  constructor(container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.pixiApp = new PIXI.Application({
      width: w,
      height: h,
      backgroundColor: 0xF5F0E8,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    const canvas = this.pixiApp.view as HTMLCanvasElement;
    canvas.style.width  = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);

    this.gridGfx     = new PIXI.Graphics();
    this.onionGfx    = new PIXI.Graphics();
    this.spriteLayer = new PIXI.Container();
    this.boneGfx     = new PIXI.Graphics();
    this.selGfx      = new PIXI.Graphics();
    this.onionGfx.alpha = 0.2;

    this.pixiApp.stage.addChild(
      this.gridGfx, this.onionGfx, this.spriteLayer, this.boneGfx, this.selGfx,
    );

    this.drawGrid(w, h);
  }

  // ── Coordinate conversion ─────────────────────────────────────────────────

  /** Screen coords → stage logical coords (fixes devicePixelRatio mismatch). */
  toStageCoords(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = this.pixiApp.view as HTMLCanvasElement;
    const rect   = canvas.getBoundingClientRect();
    const { w, h } = this.logicalSize;
    return {
      x: ((clientX - rect.left) / rect.width)  * w,
      y: ((clientY - rect.top)  / rect.height) * h,
    };
  }

  get logicalSize(): { w: number; h: number } {
    const res = this.pixiApp.renderer.resolution || 1;
    return {
      w: this.pixiApp.renderer.width  / res,
      h: this.pixiApp.renderer.height / res,
    };
  }

  resize(w: number, h: number): void {
    this.pixiApp.renderer.resize(w, h);
    this.drawGrid(w, h);
  }

  destroy(): void {
    this.pixiApp.destroy(true, { children: true });
  }

  // ── Main draw ─────────────────────────────────────────────────────────────

  draw(data: RenderData): void {
    const { w, h } = this.logicalSize;

    // Background colour
    (this.pixiApp.renderer as PIXI.Renderer).backgroundColor = data.backgroundColor;

    // Onion skin
    this.onionGfx.clear();
    if (data.onionData.length) {
      for (const od of data.onionData) {
        this.drawSkeleton(this.onionGfx, od.worldPose, null, false, false);
      }
    }

    // Sprites (sprite mode)
    this.updateSprites(data);

    // Skeleton (always visible in skeleton mode; optional overlay in sprite mode)
    this.boneGfx.clear();
    if (data.previewMode === 'skeleton' || data.showSkeletonOverlay) {
      this.drawSkeleton(this.boneGfx, data.worldPose, data.selectedBone, data.showJoints, true);
    }

    // Selection & guides
    this.selGfx.clear();
    this.drawSelection(data);
    if (data.showGuide) this.drawGuide(data.rootX, data.rootY);
    if (data.showPivots) this.drawPivots(data.worldPose, data.selectedBone);
  }

  // ── Sprite layer ──────────────────────────────────────────────────────────

  private updateSprites(data: RenderData): void {
    const visible = new Set<string>();

    if (data.previewMode === 'sprite') {
      data.bindings.forEach((binding, boneId) => {
        const pose      = data.worldPose.get(boneId);
        const transform = data.boneTransforms.get(boneId);
        if (!pose) return;

        // Determine current frame
        const frameId   = transform?.frameId !== undefined
          ? transform.frameId
          : binding.frameId;
        if (frameId === null) return;

        const texture = data.getTexture(frameId);
        if (!texture) return;

        const key    = `${boneId}:${frameId}`;
        visible.add(key);

        let sprite = this.spriteCache.get(key);
        if (!sprite) {
          sprite = new PIXI.Sprite(texture);
          this.spriteCache.set(key, sprite);
          this.spriteLayer.addChild(sprite);
        }

        sprite.texture = texture;
        sprite.anchor.set(binding.anchorX, binding.anchorY);
        sprite.x      = pose.sx + (transform?.translateX ?? 0);
        sprite.y      = pose.sy + (transform?.translateY ?? 0);
        sprite.rotation = ((pose.wa + (transform?.rotation ?? 0)) * Math.PI) / 180;
        sprite.scale.set(
          (binding.flipX ? -1 : 1) * (transform?.scaleX ?? 1),
          transform?.scaleY ?? 1,
        );
        sprite.alpha   = transform?.alpha ?? 1;
        sprite.visible = true;
      });
    }

    // Hide sprites not in visible set
    this.spriteCache.forEach((sprite, key) => {
      sprite.visible = visible.has(key);
    });
  }

  // ── Skeleton drawing ──────────────────────────────────────────────────────

  private drawSkeleton(
    g: PIXI.Graphics,
    wp: WorldPositions,
    selectedBone: string | null,
    showJoints: boolean,
    showSelection: boolean,
  ): void {
    for (const boneId of Skeleton.DRAW_ORDER) {
      const bone = Skeleton.BONE_MAP.get(boneId);
      const pos  = wp.get(boneId);
      if (!bone || !pos) continue;

      if (bone.isHead) {
        this.drawHead(g, pos.ex, pos.ey, 1);
      } else if (bone.outerW && bone.innerW) {
        this.drawTubularBone(g, pos.sx, pos.sy, pos.ex, pos.ey, bone.outerW, bone.innerW, 1);
      }
    }

    if (showJoints) {
      const drawn = new Set<string>();
      for (const bone of Skeleton.BONE_DEFS) {
        if (bone.id === 'root' || bone.isHead) continue;
        const pos = wp.get(bone.id);
        if (!pos) continue;
        const sk = `${pos.sx.toFixed(0)},${pos.sy.toFixed(0)}`;
        if (!drawn.has(sk)) { this.drawJoint(g, pos.sx, pos.sy, 6); drawn.add(sk); }
        const isLeaf = !Skeleton.BONE_DEFS.some(b => b.parent === bone.id);
        if (isLeaf) {
          const ek = `${pos.ex.toFixed(0)},${pos.ey.toFixed(0)}`;
          if (!drawn.has(ek)) { this.drawJoint(g, pos.ex, pos.ey, 5); drawn.add(ek); }
        }
      }
    }

    if (showSelection && selectedBone) {
      const pos  = wp.get(selectedBone);
      const bone = Skeleton.BONE_MAP.get(selectedBone);
      if (pos && bone) {
        if (bone.isHead) {
          g.lineStyle({ width: 3, color: 0x74c7ec, alpha: 0.9 });
          g.beginFill(0, 0); g.drawCircle(pos.ex, pos.ey, Skeleton.HEAD_R + 5); g.endFill();
        } else {
          g.lineStyle({ width: (bone.outerW ?? 4) + 6, color: 0x74c7ec, alpha: 0.4, cap: PIXI.LINE_CAP.ROUND });
          g.moveTo(pos.sx, pos.sy); g.lineTo(pos.ex, pos.ey);
        }
      }
    }
  }

  private drawSelection(data: RenderData): void {
    const { selectedBone, worldPose } = data;
    if (!selectedBone) return;
    const pos  = worldPose.get(selectedBone);
    const bone = Skeleton.BONE_MAP.get(selectedBone);
    if (!pos || !bone || bone.isHead) return;

    this.selGfx.lineStyle({ width: 1.5, color: 0x74c7ec, alpha: 0.7 });
    this.selGfx.beginFill(0x74c7ec, 0.2);
    this.selGfx.drawCircle(pos.sx, pos.sy, 8);
    this.selGfx.endFill();
  }

  private drawGuide(rootX: number, rootY: number): void {
    this.selGfx.lineStyle({ width: 1, color: 0x89b4fa, alpha: 0.3 });
    this.selGfx.moveTo(rootX, rootY - 200);
    this.selGfx.lineTo(rootX, rootY + 50);
  }

  private drawPivots(wp: WorldPositions, selectedBone: string | null): void {
    wp.forEach((pos, boneId) => {
      if (boneId === 'root') return;
      const isSelected = boneId === selectedBone;
      const color = isSelected ? 0xf9e2af : 0x89b4fa;
      this.selGfx.lineStyle({ width: 1, color, alpha: 0.6 });
      this.selGfx.beginFill(color, 0.4);
      this.selGfx.drawCircle(pos.sx, pos.sy, 3);
      this.selGfx.endFill();
    });
  }

  // ── Drawing primitives ────────────────────────────────────────────────────

  private drawTubularBone(
    g: PIXI.Graphics,
    sx: number, sy: number, ex: number, ey: number,
    outerW: number, innerW: number, alpha: number,
  ): void {
    g.lineStyle({ width: outerW, color: 0x222222, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    g.moveTo(sx, sy); g.lineTo(ex, ey);
    g.lineStyle({ width: innerW, color: 0xFFFFFF, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    g.moveTo(sx, sy); g.lineTo(ex, ey);
  }

  private drawHead(g: PIXI.Graphics, cx: number, cy: number, alpha: number): void {
    g.lineStyle({ width: 4, color: 0x222222, alpha });
    g.beginFill(0xFFFFFF, alpha);
    g.drawCircle(cx, cy, Skeleton.HEAD_R);
    g.endFill();
    g.lineStyle(0);
    g.beginFill(0x222222, alpha);
    g.drawCircle(cx + Skeleton.HEAD_R * 0.38, cy - Skeleton.HEAD_R * 0.1, 3);
    g.endFill();
  }

  private drawJoint(g: PIXI.Graphics, x: number, y: number, r: number): void {
    g.lineStyle({ width: 2.5, color: 0x222222, alpha: 1 });
    g.beginFill(0xFFFFFF);
    g.drawCircle(x, y, r);
    g.endFill();
  }

  // ── Grid ──────────────────────────────────────────────────────────────────

  private drawGrid(w: number, h: number): void {
    const CELL = 48;
    this.gridGfx.clear();
    this.gridGfx.lineStyle({ width: 1, color: 0xC8D8E8, alpha: 0.5 });
    for (let x = 0; x < w; x += CELL) { this.gridGfx.moveTo(x, 0); this.gridGfx.lineTo(x, h); }
    for (let y = 0; y < h; y += CELL) { this.gridGfx.moveTo(0, y); this.gridGfx.lineTo(w, y); }
  }
}
