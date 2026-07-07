// Public types for the StickmanRuntime .tao animation runtime.

import type * as PIXI from 'pixi.js-legacy';
import type { AnimationClip, SpriteBinding } from './types';
import type { EquipSlot, EquipRarity } from '../../game/meta/SaveData';

// ── TaoAsset (shared, loaded once per .tao file) ──────────────────────────────

/** Parsed attachment point from animation.json (includes optional shadow size). */
export interface TaoAttachmentPoint {
  id:         string;
  parentBone: string;
  offsetX:    number;
  offsetY:    number;
  /** Shadow ellipse half-width in animator pixels. Only present for id === 'shadow'. */
  shadowW?:   number;
  /** Shadow ellipse half-height in animator pixels. Only present for id === 'shadow'. */
  shadowH?:   number;
}

export interface TaoAsset {
  clips:             Map<string, AnimationClip>;
  textures:          Map<string, PIXI.Texture>;          // boneId → sub-texture
  bindings:          Map<string, SpriteBinding>;         // boneId → binding
  boneLengthScales:  Map<string, number>;
  attachmentPoints:  Map<string, TaoAttachmentPoint>;   // id → attachment
  /**
   * Per-bone white outline texture (a detached contour line: the band of pixels
   * just outside the silhouette, RGB forced white so a `tint` recolors it).
   * Generated once at load (cached on the shared asset). Used ONLY for the
   * momentary hit-flash — a brief contour pop on impact — never a constant
   * overlay (a static traced line competes with the hand-drawn ink linework and
   * reads as eye-straining moiré). Empty if generation was skipped (headless).
   */
  outlineTextures:   Map<string, PIXI.Texture>;          // boneId → outline texture
  /** Outline texture anchor (the bordered texture shifts the bone pivot). */
  outlineAnchors:    Map<string, { ax: number; ay: number }>;
  /**
   * Natural bounding-box height (animator px) of the figure — H_nat, the union of
   * FK joint extents over rest pose + all keyframes (see Skeleton.computeNaturalHeight).
   * The per-unit container scale = targetScreenHeight / naturalHeight, which renders
   * every same-tier unit at the same screen height regardless of the artist's canvas
   * size (art-direction §4.5.3 A). 0 when unknown (no clips) → falls back to STICKMAN_SCALE.
   */
  naturalHeight:     number;
}

// ── Equipment overlay (EQUIPMENT_DESIGN §20.4) ─────────────────────────────────

/** One equipped slot to overlay on the figure. */
export interface GearGlyphSpec {
  slot:   EquipSlot;
  rarity: EquipRarity;
}

// ── StickmanRuntime options ────────────────────────────────────────────────────

export interface StickmanOptions {
  /** Mirror the character horizontally (for Top-side / enemy units). */
  mirrorX?: boolean;
  /**
   * Target on-screen height (px) for this unit — its size tier's TARGET_SCREEN_PX
   * (see unitSize.ts / art-direction §4.5). The container is scaled by
   * targetHeight / asset.naturalHeight so the figure renders at this height. Omit
   * (or pass 0) to fall back to the flat STICKMAN_SCALE.
   */
  targetHeight?: number;
  /**
   * Create the ground shadow sprite (when the .tao has a shadow attachment).
   * Default true. Decorative floating figures (the lobby silhouette) pass false:
   * there's no ground under them, and the shadow would otherwise inflate the
   * bounds used to fit the figure to its box (see getRenderedLocalBounds).
   */
  showShadow?: boolean;
}
