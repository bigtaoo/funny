/**
 * Skeleton bone definitions and FK computation.
 * Verbatim copy from tools/animator/src/skeleton/Skeleton.ts.
 * Keep in sync with the animator.
 */
import type { BoneDef, WorldPositions, WorldPose, ResolvedBoneTransform } from './types';

// Rest-pose world angles assume the character faces RIGHT.
// Anatomical right (r_) = screen LEFT  → arm rwa≈180°, leg rwa≈120°
// Anatomical left  (l_) = screen RIGHT → arm rwa≈0°,   leg rwa≈60°
const RAW_DEFS: Omit<BoneDef, 'rla'>[] = [
  { id: 'root',         parent: null,          len:  0,  rwa:   0,                             label: 'Root'         },
  { id: 'spine',        parent: 'root',        len: 68,  rwa: -90, outerW: 22, innerW: 12,     label: 'Spine'        },
  { id: 'head',         parent: 'spine',       len: 24,  rwa: -90, isHead: true,               label: 'Head'         },
  { id: 'r_upper_arm',  parent: 'spine',       len: 38,  rwa: 180, outerW: 18, innerW: 10,     label: 'R. Upper Arm' },
  { id: 'r_lower_arm',  parent: 'r_upper_arm', len: 30,  rwa: 195, outerW: 14, innerW:  7,     label: 'R. Lower Arm' },
  { id: 'l_upper_arm',  parent: 'spine',       len: 36,  rwa:   0, outerW: 16, innerW:  9,     label: 'L. Upper Arm' },
  { id: 'l_lower_arm',  parent: 'l_upper_arm', len: 28,  rwa: -15, outerW: 12, innerW:  6,     label: 'L. Lower Arm' },
  { id: 'r_upper_leg',  parent: 'root',        len: 50,  rwa: 120, outerW: 20, innerW: 11,     label: 'R. Upper Leg' },
  { id: 'r_lower_leg',  parent: 'r_upper_leg', len: 44,  rwa: 130, outerW: 16, innerW:  8,     label: 'R. Lower Leg' },
  { id: 'l_upper_leg',  parent: 'root',        len: 50,  rwa:  60, outerW: 18, innerW: 10,     label: 'L. Upper Leg' },
  { id: 'l_lower_leg',  parent: 'l_upper_leg', len: 44,  rwa:  50, outerW: 14, innerW:  7,     label: 'L. Lower Leg' },
];

export class Skeleton {
  static readonly BONE_MAP:  ReadonlyMap<string, BoneDef>;
  static readonly BONE_DEFS: readonly BoneDef[];

  /**
   * Forward kinematics: compute world poses for every bone.
   * Pure function — no side effects.
   * @param transforms  Per-bone resolved transforms; rotation field drives FK.
   * @param lengthScales Optional per-bone length multiplier (sparse; 1.0 is default).
   */
  static computeFK(
    rootX: number,
    rootY: number,
    transforms:   Map<string, ResolvedBoneTransform>,
    lengthScales?: ReadonlyMap<string, number>,
  ): WorldPositions {
    const result = new Map<string, WorldPose>();
    result.set('root', { sx: rootX, sy: rootY, ex: rootX, ey: rootY, wa: 0 });

    for (const bone of Skeleton.BONE_DEFS) {
      if (bone.id === 'root') continue;
      const p     = result.get(bone.parent!)!;
      const delta = transforms.get(bone.id)?.rotation ?? 0;
      const wa    = p.wa + bone.rla + delta;
      const rad   = (wa * Math.PI) / 180;
      const sx    = p.ex;
      const sy    = p.ey;
      const len   = bone.len * (lengthScales?.get(bone.id) ?? 1);
      const ex    = sx + Math.cos(rad) * len;
      const ey    = sy + Math.sin(rad) * len;
      result.set(bone.id, { sx, sy, ex, ey, wa });
    }

    return result;
  }
}

// ── Static initialisation ─────────────────────────────────────────────────────

const _boneMap  = new Map<string, BoneDef>();
const _boneDefs: BoneDef[] = RAW_DEFS.map(raw => {
  const parentRwa = raw.parent ? (_boneMap.get(raw.parent)?.rwa ?? 0) : 0;
  const def: BoneDef = { ...raw, rla: raw.rwa - (raw.parent ? parentRwa : 0) };
  _boneMap.set(def.id, def);
  return def;
});

(Skeleton as any).BONE_MAP  = _boneMap;
(Skeleton as any).BONE_DEFS = _boneDefs;
