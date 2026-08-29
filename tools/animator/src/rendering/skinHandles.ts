// Skin-mode manipulation handles for the selected bone — split out of Renderer.ts
// (2026-08-29) once that file crossed the 500-line convention. A length handle at the
// bone tip (always), plus (only when the sprite is actually visible, i.e. Sprite
// preview) an outline of its sprite quad and a rotation knob above it. Mirrors
// InteractionController's handle hit-tests so what's drawn is what's draggable.
//
// Takes a plain Graphics target + a structural subset of RenderData (rather than
// importing RenderData from Renderer.ts) so this stays a one-way dependency —
// Renderer.ts calls in here, this file never reaches back into Renderer.ts.
import * as PIXI from 'pixi.js';
import type { WorldPositions, SpriteBinding } from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';
import { bindingToSpriteFrame, spriteCorners, rotationHandlePos } from './spriteGeometry';

export interface SkinHandlesInput {
  worldPose:    WorldPositions;
  bindings:     ReadonlyMap<string, SpriteBinding>;
  getTexture:   (boneId: string) => PIXI.Texture | undefined;
  previewMode:  'skeleton' | 'sprite';
  selectedBone: string | null;
}

export function drawSkinHandles(g: PIXI.Graphics, data: SkinHandlesInput): void {
  const boneId = data.selectedBone;
  if (!boneId) return;
  const bone = Skeleton.BONE_MAP.get(boneId);
  const pose = data.worldPose.get(boneId);
  if (!bone || !pose) return;

  if (bone.len > 0 && !bone.isHead) {
    g.lineStyle({ width: 2, color: 0x222222, alpha: 0.9 });
    g.beginFill(0xf9e2af, 0.95);
    g.drawRect(pose.ex - 6, pose.ey - 6, 12, 12);
    g.endFill();
  }

  if (data.previewMode !== 'sprite') return;
  const binding = data.bindings.get(boneId);
  const texture = data.getTexture(boneId);
  if (!binding || !texture) return;

  const frame   = bindingToSpriteFrame(pose.sx, pose.sy, pose.wa, binding, texture.width, texture.height);
  const corners = spriteCorners(frame);
  g.lineStyle({ width: 1.5, color: 0xa6e3a1, alpha: 0.85 });
  g.moveTo(corners[0].x, corners[0].y);
  g.lineTo(corners[1].x, corners[1].y);
  g.lineTo(corners[2].x, corners[2].y);
  g.lineTo(corners[3].x, corners[3].y);
  g.lineTo(corners[0].x, corners[0].y);

  const handle = rotationHandlePos(frame);
  const midX = (corners[0].x + corners[1].x) / 2, midY = (corners[0].y + corners[1].y) / 2;
  g.lineStyle({ width: 1, color: 0xa6e3a1, alpha: 0.6 });
  g.moveTo(midX, midY);
  g.lineTo(handle.x, handle.y);
  g.lineStyle({ width: 1.5, color: 0xffffff, alpha: 0.95 });
  g.beginFill(0xa6e3a1, 0.95);
  g.drawCircle(handle.x, handle.y, 6);
  g.endFill();
}
