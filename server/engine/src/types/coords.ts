// Split 2026-08-10 out of engine/src/types.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Grid/fixed-point coordinates + the owner/side identity helpers built on them.
import type { Fp } from '../math/fixed';
import { Side } from './enums';

/** Integer grid position. col: 0–11, row: 0–17 (all 0-indexed) */
export interface GridPos {
  col: number;
  row: number;
}

/**
 * Fixed-point position used in game events.
 * col is a plain integer column index (0–11).
 * y_fp is a Fp (row × 1000); rendering layer uses fromFp(y_fp) to get float row.
 */
export interface Vec2_fp {
  col: number;
  y_fp: Fp;
}

/** Player identifier: 0 = Bottom (local), 1 = Top (AI) */
export type OwnerId = 0 | 1;

export function sideToOwner(side: Side): OwnerId {
  return side === Side.Bottom ? 0 : 1;
}

export function ownerToSide(owner: OwnerId): Side {
  return owner === 0 ? Side.Bottom : Side.Top;
}
