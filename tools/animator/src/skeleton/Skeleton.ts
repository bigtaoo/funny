import type { BoneDef, WorldPose, WorldPositions, ResolvedBoneTransform } from '../core/types';

// ── Bone definitions ──────────────────────────────────────────────────────────

const RAW_DEFS: Omit<BoneDef, 'rla'>[] = [
  { id: 'root',         parent: null,          len: 0,   rwa:   0, label: 'Root'         },
  { id: 'spine',        parent: 'root',        len: 68,  rwa: -90, outerW: 22, innerW: 12, label: 'Spine'        },
  { id: 'head',         parent: 'spine',       len: 24,  rwa: -90, isHead: true,           label: 'Head'         },
  { id: 'r_upper_arm',  parent: 'spine',       len: 38,  rwa:  82, outerW: 18, innerW: 10, label: 'R. Upper Arm' },
  { id: 'r_lower_arm',  parent: 'r_upper_arm', len: 30,  rwa:  98, outerW: 14, innerW:  7, label: 'R. Lower Arm' },
  { id: 'l_upper_arm',  parent: 'spine',       len: 36,  rwa:  98, outerW: 16, innerW:  9, label: 'L. Upper Arm' },
  { id: 'l_lower_arm',  parent: 'l_upper_arm', len: 28,  rwa: 112, outerW: 12, innerW:  6, label: 'L. Lower Arm' },
  { id: 'r_upper_leg',  parent: 'root',        len: 50,  rwa:  82, outerW: 20, innerW: 11, label: 'R. Upper Leg' },
  { id: 'r_lower_leg',  parent: 'r_upper_leg', len: 44,  rwa:  92, outerW: 16, innerW:  8, label: 'R. Lower Leg' },
  { id: 'l_upper_leg',  parent: 'root',        len: 50,  rwa:  98, outerW: 18, innerW: 10, label: 'L. Upper Leg' },
  { id: 'l_lower_leg',  parent: 'l_upper_leg', len: 44,  rwa:  88, outerW: 14, innerW:  7, label: 'L. Lower Leg' },
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

  /** Forward kinematics: compute world poses for every bone.
   *  Pure function — no side effects.
   *  @param transforms  Per-bone resolved transforms; rotation field drives FK. */
  static computeFK(
    rootX: number,
    rootY: number,
    transforms: Map<string, ResolvedBoneTransform>,
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
      const ex = sx + Math.cos(rad) * bone.len;
      const ey = sy + Math.sin(rad) * bone.len;
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
