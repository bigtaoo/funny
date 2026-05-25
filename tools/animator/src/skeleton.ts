/**
 * Bone definitions and forward kinematics.
 * No external imports from this project — pure data & math.
 */
import type { BoneDef, BoneDeltas, WorldPositions } from './types';

export const HEAD_R = 24;

const RAW_DEFS: Omit<BoneDef, 'rla'>[] = [
  { id: 'root',         parent: null,          len: 0,   rwa: 0,   label: 'Root'         },
  { id: 'spine',        parent: 'root',        len: 68,  rwa: -90, outerW: 22, innerW: 12, label: 'Spine'        },
  { id: 'head',         parent: 'spine',       len: HEAD_R, rwa: -90, isHead: true,        label: 'Head'         },
  { id: 'r_upper_arm',  parent: 'spine',       len: 38,  rwa: 82,  outerW: 18, innerW: 10, label: 'R. Upper Arm' },
  { id: 'r_lower_arm',  parent: 'r_upper_arm', len: 30,  rwa: 98,  outerW: 14, innerW: 7,  label: 'R. Lower Arm' },
  { id: 'l_upper_arm',  parent: 'spine',       len: 36,  rwa: 98,  outerW: 16, innerW: 9,  label: 'L. Upper Arm' },
  { id: 'l_lower_arm',  parent: 'l_upper_arm', len: 28,  rwa: 112, outerW: 12, innerW: 6,  label: 'L. Lower Arm' },
  { id: 'r_upper_leg',  parent: 'root',        len: 50,  rwa: 82,  outerW: 20, innerW: 11, label: 'R. Upper Leg' },
  { id: 'r_lower_leg',  parent: 'r_upper_leg', len: 44,  rwa: 92,  outerW: 16, innerW: 8,  label: 'R. Lower Leg' },
  { id: 'l_upper_leg',  parent: 'root',        len: 50,  rwa: 98,  outerW: 18, innerW: 10, label: 'L. Upper Leg' },
  { id: 'l_lower_leg',  parent: 'l_upper_leg', len: 44,  rwa: 88,  outerW: 14, innerW: 7,  label: 'L. Lower Leg' },
];

// Build the map first so rla computation can look up parent rwa
export const BONE_MAP: Record<string, BoneDef> = {};

export const BONE_DEFS: BoneDef[] = RAW_DEFS.map(raw => {
  const parentRwa = raw.parent ? (BONE_MAP[raw.parent]?.rwa ?? 0) : 0;
  const def: BoneDef = { ...raw, rla: raw.rwa - (raw.parent ? parentRwa : 0) };
  BONE_MAP[def.id] = def;
  return def;
});

/** Draw order: back limbs first, front limbs last (side-view depth). */
export const DRAW_ORDER = [
  'l_upper_leg', 'l_lower_leg',
  'l_upper_arm', 'l_lower_arm',
  'spine',
  'head',
  'r_upper_arm', 'r_lower_arm',
  'r_upper_leg', 'r_lower_leg',
] as const;

/** Bones the user can select and rotate. */
export const SELECTABLE_BONES = BONE_DEFS
  .filter(b => b.id !== 'root')
  .map(b => b.id);

/** Bones shown as rows in the timeline. */
export const TIMELINE_BONES = [
  'spine', 'r_upper_arm', 'r_lower_arm', 'l_upper_arm', 'l_lower_arm',
  'r_upper_leg', 'r_lower_leg', 'l_upper_leg', 'l_lower_leg',
];

/**
 * Forward kinematics: compute world positions for every bone.
 * @param rootX  Hip x position on canvas.
 * @param rootY  Hip y position on canvas.
 * @param deltas Per-bone rotation deltas (degrees) on top of rest pose.
 */
export function computeFK(
  rootX: number,
  rootY: number,
  deltas: BoneDeltas,
): WorldPositions {
  const wp: WorldPositions = {};
  wp['root'] = { sx: rootX, sy: rootY, ex: rootX, ey: rootY, wa: 0 };

  for (const bone of BONE_DEFS) {
    if (bone.id === 'root') continue;
    const p = wp[bone.parent!];
    const delta = deltas[bone.id] ?? 0;
    const wa = p.wa + bone.rla + delta;
    const rad = (wa * Math.PI) / 180;
    const sx = p.ex, sy = p.ey;
    const ex = sx + Math.cos(rad) * bone.len;
    const ey = sy + Math.sin(rad) * bone.len;
    wp[bone.id] = { sx, sy, ex, ey, wa };
  }

  return wp;
}
