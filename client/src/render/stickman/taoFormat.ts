// ── .tao on-disk schema (read side) ───────────────────────────────────────────
// The shapes `animation.json` and `spritesheet.json` actually have inside a .tao ZIP.
// See claudedocs/file-formats.md for the format itself.
//
// WHY this file exists: the writer is `tools/animator/src/io/taoExport.ts`
// (`SerializedProject` / `SpritesheetJson` / `SerializedClip`), and it is fully typed —
// but the reader used to `JSON.parse(...) as any` and then index into the result, so
// nothing connected the two. Renaming a field on the export side produced no error
// anywhere; the client just read `undefined` and silently fell back to a default (a
// figure rendering at zOrder 0 / scale 1 looks plausible enough to ship). These
// declarations are the reader's half of that contract: they don't validate at runtime,
// but they make the field names and optionality explicit and reviewable next to the
// writer's.
//
// DELIBERATELY more permissive than the writer's types: `.tao` bundles in
// `client/src/assets` predate several format revisions (pre-§4.5 bundles have no
// `unitHeight`, older ones no `boneLengthScales`), and the loader's `?? default` chain
// is what keeps them loading. So anything the current writer always emits but an older
// bundle may lack is optional here. Required means "no bundle can load without it".
//
// Cross-package duplication is intentional: `tools/animator` and `client` are separate
// packages with no shared types dependency, and a .tao is a file on disk (or on the CDN),
// not a call across a module boundary — the versions genuinely can differ. Keep this in
// sync with taoExport.ts by hand; `version` is the field to bump when they can't be.

import type { EasingType } from './types';

/** One bone's delta at one keyframe. Every channel is optional — absent means "default"
 *  (see interpolate.ts DEFAULTS), which is how the animator keeps exports small. */
export interface TaoBoneKeyframeJson {
  rotation?:   number;
  scaleX?:     number;
  scaleY?:     number;
  translateX?: number;
  translateY?: number;
  alpha?:      number;
  /** Writer types this as a plain `string`; narrow with `asEasing()` before use. */
  easing?:     string;
}

export interface TaoKeyframeJson {
  time:  number;
  bones: Record<string, TaoBoneKeyframeJson>;
}

export interface TaoClipJson {
  duration:  number;
  loop:      boolean;
  keyframes: TaoKeyframeJson[];
}

/** Per-bone static sprite binding. The writer always emits all seven fields, but the
 *  loader defaults each one, so older bundles with a partial binding still load. */
export interface TaoBindingJson {
  anchorX?:  number;
  anchorY?:  number;
  flipX?:    boolean;
  zOrder?:   number;
  rotation?: number;
  scaleX?:   number;
  scaleY?:   number;
  /**
   * World-space pixel offset, and the one field pair the writer's types do NOT mention:
   * `SpriteBinding` in tools/animator/src/core/types.ts has seven fields, none of them an
   * offset. Yet 7 of the 18 bundles in src/assets carry NON-ZERO values here (harpy,
   * infantry, ironclad, medic, runner, skin_infantry, splitter — limb offsets up to ±16px,
   * e.g. `l_upper_leg` +16 x), the matching art/*.tao.editor projects carry them too, and
   * this loader reads and applies them. They survive a round-trip through the animator
   * only because every hop is an untyped object spread (`{ ...b }`), which carries keys the
   * type never declared; anything that builds a binding field-by-field drops them silently
   * and those units shift. Declared here so the read side at least states what is on disk
   * — the animator's writer-side type is the half that still needs deciding (declare the
   * channel, or drop it deliberately and re-export the 7 bundles).
   */
  offsetX?:  number;
  offsetY?:  number;
}

export interface TaoAttachmentPointJson {
  id:          string;
  /** Editor-facing display name; the runtime ignores it. */
  label?:      string;
  parentBone?: string;
  offsetX?:    number;
  offsetY?:    number;
  /** Shadow ellipse size (animator px). Only meaningful for id === 'shadow'. */
  shadowW?:    number;
  shadowH?:    number;
}

export interface TaoAnimationJson {
  /** 2 for every bundle the runtime has ever shipped. */
  version:           number;
  animations:        Record<string, TaoClipJson>;
  bindings:          Record<string, TaoBindingJson>;
  boneLengthScales?: Record<string, number>;
  attachmentPoints?: TaoAttachmentPointJson[];
  /**
   * Bake metadata (art-direction §4.5.3 B). Informational — the runtime sizes units
   * from its own unitSize.ts by UnitType and recomputes H_nat from the clips, so
   * nothing here is read. Absent in pre-§4.5 bundles.
   */
  unitHeight?: {
    tier:           string;
    targetScreenPx: number;
    naturalHeight:  number;
    supersample:    number;
  };
}

export interface TaoSpritesheetFrameJson {
  frame:       { x: number; y: number; w: number; h: number };
  /** Pre-bake source size; the runtime derives everything it needs from `frame`. */
  sourceSize?: { w: number; h: number };
}

export interface TaoSpritesheetJson {
  frames: Record<string, TaoSpritesheetFrameJson>;
  meta?:  { size: { w: number; h: number } };
}

const EASINGS: readonly EasingType[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'step'];

/** Narrow the on-disk easing string to the runtime union. Unknown values become
 *  `undefined`, which interpolate.ts already treats as 'linear' — same result the old
 *  blanket `as BoneKeyframe` cast produced (applyEasing's `default:` branch), just
 *  without asserting that the file's string was one of ours.
 *
 *  A no-op on everything shipped today: a scan of all 18 bundles in src/assets (108 clips,
 *  445 keyframes, 1968 bone deltas) found the `easing` key present zero times — the
 *  animator has never written one, so every keyframe interpolates linearly. This exists for
 *  the day it does, and to make the union boundary the loader's problem rather than a cast
 *  that would have let `"ease-int"` through as a valid EasingType. */
export function asEasing(raw: string | undefined): EasingType | undefined {
  return raw !== undefined && (EASINGS as readonly string[]).includes(raw)
    ? (raw as EasingType)
    : undefined;
}
