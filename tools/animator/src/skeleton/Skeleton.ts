import type { BoneDef, WorldPose, WorldPositions, ResolvedBoneTransform, AnimationClip } from '../core/types';

// ── Bone definitions ──────────────────────────────────────────────────────────

// Rest-pose world angles assume the character faces RIGHT.
// Anatomical right  (r_) = screen LEFT  → arm rwa≈180°, leg rwa≈120°
// Anatomical left   (l_) = screen RIGHT → arm rwa≈0°,   leg rwa≈60°
const RAW_DEFS: Omit<BoneDef, 'rla'>[] = [
  { id: 'root',         parent: null,          len: 0,   rwa:   0, label: 'Root'         },
  { id: 'spine',        parent: 'root',        len: 68,  rwa: -90, outerW: 22, innerW: 12, label: 'Spine'        },
  { id: 'head',         parent: 'spine',       len: 24,  rwa: -90, isHead: true,           label: 'Head'         },
  { id: 'r_upper_arm',  parent: 'spine',       len: 38,  rwa: 180, outerW: 18, innerW: 10, label: 'R. Upper Arm' },
  { id: 'r_lower_arm',  parent: 'r_upper_arm', len: 30,  rwa: 195, outerW: 14, innerW:  7, label: 'R. Lower Arm' },
  { id: 'l_upper_arm',  parent: 'spine',       len: 36,  rwa:   0, outerW: 16, innerW:  9, label: 'L. Upper Arm' },
  { id: 'l_lower_arm',  parent: 'l_upper_arm', len: 28,  rwa: -15, outerW: 12, innerW:  6, label: 'L. Lower Arm' },
  { id: 'r_upper_leg',  parent: 'root',        len: 50,  rwa: 120, outerW: 20, innerW: 11, label: 'R. Upper Leg' },
  { id: 'r_lower_leg',  parent: 'r_upper_leg', len: 44,  rwa: 130, outerW: 16, innerW:  8, label: 'R. Lower Leg' },
  { id: 'l_upper_leg',  parent: 'root',        len: 50,  rwa:  60, outerW: 18, innerW: 10, label: 'L. Upper Leg' },
  { id: 'l_lower_leg',  parent: 'l_upper_leg', len: 44,  rwa:  50, outerW: 14, innerW:  7, label: 'L. Lower Leg' },
];

// ── Skeleton static class ─────────────────────────────────────────────────────

export class Skeleton {
  static readonly HEAD_R = 24;

  static readonly BONE_MAP: ReadonlyMap<string, BoneDef>;
  static readonly BONE_DEFS: readonly BoneDef[];
  static readonly DRAW_ORDER: readonly string[];
  static readonly SELECTABLE_BONES: readonly string[];
  static readonly TIMELINE_BONES: readonly string[];

  /** Compute a sensible default shadow ellipse size based on rest-pose leg span.
   *  Returns { w: half-width, h: half-height } in logical pixels. */
  static computeDefaultShadowSize(): { w: number; h: number } {
    const rest = Skeleton.computeFK(0, 0, new Map());
    const rFoot = rest.get('r_lower_leg');
    const lFoot = rest.get('l_lower_leg');
    if (!rFoot || !lFoot) return { w: 18, h: 5 };

    // Foot span + half the leg bone width on each side
    const legOuterW = Skeleton.BONE_MAP.get('r_lower_leg')?.outerW ?? 16;
    const span = Math.abs(rFoot.ex - lFoot.ex);
    const w = Math.ceil(span / 2 + legOuterW);
    const h = Math.max(4, Math.ceil(w * 0.3));
    return { w, h };
  }

  /**
   * Natural bounding-box height (animator px) of the figure: the vertical extent
   * (maxY − minY) of every FK joint point, unioned over the rest pose AND every
   * keyframe of every clip (art-direction §4.5.3). This is H_nat — the export bake
   * divides the target screen height into it to get the global bake factor, and the
   * game runtime divides it into the target to get the per-unit display scale, so the
   * two stay coupled. Joint points only (computeDefaultShadowSize covers leg width).
   *
   * Keep in sync with the game's StickmanRuntime-side Skeleton.computeNaturalHeight.
   * Returns 0 when there are no clips (signals "unknown").
   */
  static computeNaturalHeight(
    clips: Iterable<AnimationClip>,
    lengthScales?: ReadonlyMap<string, number>,
  ): number {
    let minY = Infinity, maxY = -Infinity;
    const scan = (transforms: Map<string, ResolvedBoneTransform>): void => {
      const wp = Skeleton.computeFK(0, 0, transforms, lengthScales);
      for (const p of wp.values()) {
        if (p.sy < minY) minY = p.sy;
        if (p.sy > maxY) maxY = p.sy;
        if (p.ey < minY) minY = p.ey;
        if (p.ey > maxY) maxY = p.ey;
      }
    };

    scan(new Map());   // rest pose (empty transforms)
    for (const clip of clips) {
      for (const kf of clip.keyframes) {
        const tf = new Map<string, ResolvedBoneTransform>();
        // FK only reads .rotation; the rest are filled with identity defaults.
        kf.bones.forEach((bkf, id) => tf.set(id, {
          rotation:   bkf.rotation ?? 0,
          scaleX:     1, scaleY: 1,
          translateX: 0, translateY: 0,
          alpha:      1,
        }));
        scan(tf);
      }
    }

    return (Number.isFinite(minY) && maxY > minY) ? maxY - minY : 0;
  }

  /** Forward kinematics: compute world poses for every bone.
   *  Pure function — no side effects.
   *  @param transforms  Per-bone resolved transforms; rotation field drives FK. */
  static computeFK(
    rootX: number,
    rootY: number,
    transforms: Map<string, ResolvedBoneTransform>,
    lengthScales?: ReadonlyMap<string, number>,
  ): WorldPositions {
    const result = new Map<string, WorldPose>();
    result.set('root', { sx: rootX, sy: rootY, ex: rootX, ey: rootY, wa: 0 });

    for (const bone of Skeleton.BONE_DEFS) {
      if (bone.id === 'root') continue;
      const p = result.get(bone.parent!)!;
      const delta = transforms.get(bone.id)?.rotation ?? 0;
      const wa = p.wa + bone.rla + delta;
      const rad = (wa * Math.PI) / 180;
      const sx = p.ex, sy = p.ey;
      const len = bone.len * (lengthScales?.get(bone.id) ?? 1);
      const ex = sx + Math.cos(rad) * len;
      const ey = sy + Math.sin(rad) * len;
      result.set(bone.id, { sx, sy, ex, ey, wa });
    }

    return result;
  }
}

// ── Static initialisation ─────────────────────────────────────────────────────
// TypeScript does not support static class blocks in older targets, so we
// initialise the static properties via module-level code after the class.

const _boneMap = new Map<string, BoneDef>();
const _boneDefs: BoneDef[] = RAW_DEFS.map(raw => {
  const parentRwa = raw.parent ? (_boneMap.get(raw.parent)?.rwa ?? 0) : 0;
  const def: BoneDef = { ...raw, rla: raw.rwa - (raw.parent ? parentRwa : 0) };
  _boneMap.set(def.id, def);
  return def;
});

// Cast away readonly so we can assign once at init time
type MutableSkeleton = {
  -readonly [K in keyof typeof Skeleton]: (typeof Skeleton)[K];
};
const S = Skeleton as unknown as MutableSkeleton;

S.BONE_MAP        = _boneMap;
S.BONE_DEFS       = _boneDefs;
S.DRAW_ORDER      = ['l_upper_leg', 'l_lower_leg', 'l_upper_arm', 'l_lower_arm', 'spine', 'head', 'r_upper_arm', 'r_lower_arm', 'r_upper_leg', 'r_lower_leg'];
S.SELECTABLE_BONES = _boneDefs.filter(b => b.id !== 'root').map(b => b.id);
S.TIMELINE_BONES  = ['spine', 'head', 'r_upper_arm', 'r_lower_arm', 'l_upper_arm', 'l_lower_arm', 'r_upper_leg', 'r_lower_leg', 'l_upper_leg', 'l_lower_leg'];
