// cards/* split — the pure fusion rule check shared by fuse.ts (one round) and fuseBatch.ts (N rounds
// in one request). Extracted 2026-08-20 when the batch endpoint landed: the batch validates each of
// its rounds against an in-memory projection of the roster rather than a fresh Mongo read, so the
// rules had to stop being welded to fuseCards' single-shot read-then-commit body.
import {
  CARD_DEFS,
  MAX_CARD_LEVEL,
  FUSION_MATERIAL_COUNT,
  type CardInstance,
} from '@nw/shared';
import type { CardError } from './helpers.js';

/** Shape checks that need no roster read (arity, duplicates, self-material). */
export function checkFuseShape(targetId: string, materialIds: string[]): CardError | null {
  if (!targetId) return { error: 'targetId required', code: 'BAD_REQUEST' };
  if (!Array.isArray(materialIds) || materialIds.length !== FUSION_MATERIAL_COUNT)
    return { error: `materialIds must contain exactly ${FUSION_MATERIAL_COUNT} entries`, code: 'BAD_REQUEST' };
  if (materialIds.includes(targetId))
    return { error: 'target cannot be its own material', code: 'BAD_REQUEST' };
  if (new Set(materialIds).size !== FUSION_MATERIAL_COUNT)
    return { error: 'materialIds must not contain duplicates', code: 'BAD_REQUEST' };
  return null;
}

/**
 * Full rule check for one fusion against `cards` (a roster projection: id → instance). Same rules,
 * same error codes, same order as the pre-split fuseCards body — target exists and is below max
 * level; every material exists, is unlocked, matches the target's faction and its *current* level.
 */
export function checkFuseRound(
  cards: Map<string, CardInstance>,
  targetId: string,
  materialIds: readonly string[],
): { target: CardInstance } | CardError {
  const target = cards.get(targetId);
  if (!target) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
  const targetDef = CARD_DEFS[target.defId];
  if (!targetDef) return { error: `unknown card def: ${target.defId}`, code: 'BAD_REQUEST' };
  if (target.level >= MAX_CARD_LEVEL)
    return { error: 'target card is already at max level', code: 'BAD_REQUEST' };
  for (const matId of materialIds) {
    const mat = cards.get(matId);
    if (!mat) return { error: `material card not found: ${matId}`, code: 'CARD_NOT_FOUND' };
    if (mat.locked) return { error: `material card is locked: ${matId}`, code: 'CARD_LOCKED' };
    const matDef = CARD_DEFS[mat.defId];
    if (!matDef) return { error: `unknown card def for material: ${matId}`, code: 'BAD_REQUEST' };
    if (matDef.faction !== targetDef.faction) {
      return {
        error: `faction mismatch: target=${targetDef.faction}, material=${matDef.faction} (${matId})`,
        code: 'WRONG_FACTION',
      };
    }
    if (mat.level !== target.level) {
      return {
        error: `material level mismatch: target=${target.level}, material=${mat.level} (${matId})`,
        code: 'BAD_REQUEST',
      };
    }
  }
  return { target };
}
