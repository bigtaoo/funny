// UnitView's event-driven per-unit effects (spell-target outline, hit flash, death fade), extracted
// as form① free functions (claudedocs/client-modules.md "单文件 500 行收敛"). `previewUnitIds` is a
// getter/setter pair (not a plain property) because setSpellTargetPreview reassigns it wholesale —
// a plain copied property would only rebind this throwaway host object, never reaching back to
// UnitView's own field (same reasoning as RoomScene/views.ts's RoomViewHost). The Maps/Set are
// plain readonly references — every mutation on them is in-place (.set/.delete/.add), never a
// wholesale reassignment of the collection itself, so no getter/setter needed for those.
import * as PIXI from 'pixi.js-legacy';
import type { StickmanRuntime } from '../stickman/StickmanRuntime';
import { fx } from '../theme';

const SPELL_TARGET_COLOR = fx.meteor;
const SPELL_TARGET_ALPHA = 0.6;
const HIT_FLASH_COLOR = 0xff5a2b;

/** Shared empty set — avoids an allocation on every no-AoE-selected highlight refresh. */
export const NO_SPELL_TARGETS: ReadonlySet<number> = new Set();

export interface EffectsHost {
  readonly sprites: Map<number, PIXI.Container>;
  readonly stickmanRuntimes: Map<number, StickmanRuntime>;
  readonly hpTimers: Map<number, number>;
  readonly effectTicks: Set<() => void>;
  previewUnitIds: ReadonlySet<number>;
  releaseUnit(unitId: number, sprite: PIXI.Container): void;
}

function addEffectTick(host: EffectsHost, tick: () => void): void {
  host.effectTicks.add(tick);
  PIXI.Ticker.shared.add(tick);
}

function removeEffectTick(host: EffectsHost, tick: () => void): void {
  PIXI.Ticker.shared.remove(tick);
  host.effectTicks.delete(tick);
}

/**
 * Screen position of the unit's `hit` attachment point (torso), for spawning
 * the hit spark on the body rather than the grid-cell centre. Falls back to
 * the unit's container origin when the unit has no stickman runtime (circle
 * placeholder / PvE-only types) or the .tao defines no `hit` attachment.
 * Returns null if the unit has no live sprite.
 */
export function getHitPoint(host: EffectsHost, unitId: number): { x: number; y: number } | null {
  const sprite = host.sprites.get(unitId);
  if (!sprite) return null;
  const runtime = host.stickmanRuntimes.get(unitId);
  if (runtime) {
    const off = runtime.getAttachmentOffset('hit');
    if (off) return { x: sprite.x + off.x, y: sprite.y + off.y };
  }
  return { x: sprite.x, y: sprite.y };
}

/**
 * Outline exactly the units that fall inside the currently hovered/dragged AoE
 * spell's footprint (2×2 meteor anchor, rockslide column, …) — requested fix:
 * the 2×2 target-rect fill alone doesn't tell the player which units' centers
 * actually sit inside it, so a frequently-used spell like Meteor kept missing
 * the intended target. Called every time GameRenderer/input.ts recomputes the
 * placement highlight (pointer move + the 10Hz board-state refresh), so this is
 * a plain diff against the previous call, not an animation.
 *
 * Only stickman-rendered units (the vast majority — see STICKMAN_ASSETS) get the
 * outline; it reuses the same outline-sprite texture as playHitEffect's
 * hit-flash via setOutlineFlash, just held steady instead of faded. Circle
 * placeholder units (pre-.tao-load fallback) have no outline texture and are
 * silently skipped, same limitation playHitEffect already accepts.
 */
export function setSpellTargetPreview(host: EffectsHost, unitIds: ReadonlySet<number>): void {
  if (unitIds === host.previewUnitIds) return;
  for (const id of host.previewUnitIds) {
    if (unitIds.has(id)) continue;
    host.stickmanRuntimes.get(id)?.setOutlineFlash(null);
  }
  for (const id of unitIds) {
    host.stickmanRuntimes.get(id)?.setOutlineFlash(SPELL_TARGET_COLOR, SPELL_TARGET_ALPHA);
  }
  host.previewUnitIds = unitIds;
}

export function playHitEffect(host: EffectsHost, unitId: number): void {
  const sprite = host.sprites.get(unitId);
  if (!sprite) return;

  const runtime = host.stickmanRuntimes.get(unitId);
  if (runtime) {
    // Hit-impact contour flash: a hot outline pops around the figure for a few
    // frames, fading out. Reuses the (otherwise idle) outline textures — the
    // right home for the outline look. Kept short + soft (peak alpha < 1) so
    // dense melee, where both fighters take damage every exchange, isn't noisy.
    const TOTAL = 4;
    const PEAK  = 0.7;
    let frames  = TOTAL;
    const tick = (): void => {
      if (!host.sprites.has(unitId)) { removeEffectTick(host, tick); runtime.setOutlineFlash(null); return; }
      runtime.setOutlineFlash(HIT_FLASH_COLOR, (frames / TOTAL) * PEAK);
      if (--frames <= 0) {
        removeEffectTick(host, tick);
        runtime.setOutlineFlash(null);
      }
    };
    addEffectTick(host, tick);
    return;
  }

  // Circle / draft placeholder units (no outline textures): alpha blink fallback.
  let frames = 6;
  const tick = (): void => {
    if (!host.sprites.has(unitId)) { removeEffectTick(host, tick); return; }
    sprite.alpha = frames % 2 === 0 ? 0.3 : 1;
    if (--frames <= 0) {
      removeEffectTick(host, tick);
      sprite.alpha = 1;
    }
  };
  addEffectTick(host, tick);
}

export function playDeathEffect(host: EffectsHost, unitId: number): void {
  const sprite = host.sprites.get(unitId);
  if (!sprite) return;

  // Take ownership: drop from the live maps so sync() (the unit is already gone
  // from board.units) doesn't release the sprite out from under this animation.
  host.sprites.delete(unitId);
  host.hpTimers.delete(unitId);
  const hpBg   = sprite.getChildByName('hpBg')   as PIXI.Graphics | null;
  const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics | null;
  if (hpBg)   hpBg.visible   = false;
  if (hpFill) hpFill.visible = false;

  // Switch to the death clip. The runtime is no longer ticked by sync() (the unit
  // left board.units), so we must advance its clock here for the clip to play.
  const runtime = host.stickmanRuntimes.get(unitId);
  if (runtime) runtime.play('death');

  const deathDur = runtime ? runtime.currentDuration : 0; // seconds
  const HOLD_SEC = 1.0;   // linger after the death clip finishes (requested)
  const FADE_SEC = 0.4;   // fade out over the tail of the hold
  const total    = deathDur + HOLD_SEC;

  let elapsed = 0;
  const tick = (): void => {
    const dt = PIXI.Ticker.shared.deltaMS / 1000;
    elapsed += dt;
    if (runtime) runtime.update(dt); // advance the (non-loop) death clip; clamps at its end

    const remaining = total - elapsed;
    sprite.alpha = remaining < FADE_SEC ? Math.max(0, remaining / FADE_SEC) : 1;

    if (elapsed >= total) {
      removeEffectTick(host, tick);
      host.releaseUnit(unitId, sprite);
    }
  };
  addEffectTick(host, tick);
}
