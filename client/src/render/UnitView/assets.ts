// UnitView's per-unit-type asset URL tables + skin-override resolution, extracted as form① (zero
// classes, zero `this`) — claudedocs/client-modules.md "单文件 500 行收敛". Also the pool
// factory/resetter and the faction-ground-marker/HP-bar-Y pure helpers, since they're used both at
// module scope (the object pool) and by UnitView's instance methods, with no shared mutable state
// of their own either way.
import * as PIXI from 'pixi.js-legacy';
import { Side, UnitType } from '@nw/engine/types';
import { targetScreenHeight } from '../unitSize';
import { factionInk } from '../theme';
import infantryTaoUrl from '../../assets/units/infantry.tao';
import archerTaoUrl from '../../assets/units/archer.tao';
import shieldBearerTaoUrl from '../../assets/units/shieldbearer.tao';
import maxTaoUrl from '../../assets/units/max.tao';
import lenaTaoUrl from '../../assets/units/lena.tao';
import maraTaoUrl from '../../assets/units/mara.tao';
import ironcladTaoUrl from '../../assets/units/ironclad.tao';
import runnerTaoUrl from '../../assets/units/runner.tao';
import harpyTaoUrl from '../../assets/units/harpy.tao';
import medicTaoUrl from '../../assets/units/medic.tao';
import berserkerTaoUrl from '../../assets/units/berserker.tao';
import splitterTaoUrl from '../../assets/units/splitter.tao';
import skinInfantryTaoUrl from '../../assets/units/skins/skin_infantry.tao';
import skinArcherTaoUrl from '../../assets/units/skins/skin_archer.tao';
import skinShieldBearerTaoUrl from '../../assets/units/skins/skin_shieldbearer.tao';
import skinLenaTaoUrl from '../../assets/units/skins/skin_lena.tao';
import skinMaraTaoUrl from '../../assets/units/skins/skin_mara.tao';
import skinMaxTaoUrl from '../../assets/units/skins/skin_max.tao';

/**
 * .tao skeletal-animation bundle URL per unit type. Types listed here render as
 * animated stickmen; types absent fall back to the colored-circle placeholder.
 * Exported for reuse by WorldMapRenderer/fog.ts (march-token art picks the deployed
 * team's leader unit-type from this same set, 2026-07-26).
 */
export const STICKMAN_ASSETS: Partial<Record<UnitType, string>> = {
  [UnitType.Infantry]: infantryTaoUrl     as unknown as string,
  [UnitType.Archer]:    archerTaoUrl       as unknown as string,
  [UnitType.ShieldBearer]:  shieldBearerTaoUrl as unknown as string, // shield bearer
  // Anna faction trio — each with a separate .tao animation (A6, individually re-exported in the animator)
  [UnitType.Max]:   maxTaoUrl  as unknown as string,
  [UnitType.Lena]:  lenaTaoUrl as unknown as string,
  [UnitType.Mara]:  maraTaoUrl as unknown as string,
  // PvE myth creatures (PVP-P5 art) — 6 units authored 2026-07, wired in 2026-07-27.
  [UnitType.Ironclad]:  ironcladTaoUrl as unknown as string,
  [UnitType.Runner]:    runnerTaoUrl   as unknown as string,
  [UnitType.Harpy]:     harpyTaoUrl    as unknown as string,
  [UnitType.Medic]:     medicTaoUrl    as unknown as string,
  [UnitType.Berserker]: berserkerTaoUrl as unknown as string,
  [UnitType.Splitter]:  splitterTaoUrl as unknown as string,
};

/**
 * Skin → per-type .tao override (S3-4). Each equipped skin (SaveData.equipped, one slot per
 * character — game/meta/skinDefs.ts, LOBBY_IA_REDESIGN §15) swaps ONLY that character's texture
 * bundle — never stats — so a skin carried into PvP changes nothing but the picture (hard wall,
 * §5.2). Since a skin never targets more than one UnitType, several can be equipped at once
 * (one per character) with no risk of one overriding another's entry. An unknown / unmapped skin
 * falls back to the default look in STICKMAN_ASSETS.
 *
 * LAUNCH SKIN CATALOGUE (owner decision 2026-07-02, GACHA_DESIGN §9.5): one skin per
 * character, 6 total, each a full .tao (procedural recolor retired post-v0.4, see
 * art-direction §9.1). Rigged onto each character's base skeleton (animator, 2026-07-30) —
 * see art/skins/<character>/ for the .taoeditor sources.
 */
const SKIN_ASSETS: Record<string, Partial<Record<UnitType, string>>> = {
  skin_shop_c1: { [UnitType.Infantry]:     skinInfantryTaoUrl     as unknown as string }, // Tao/Lichuang  (shop, common)
  skin_shop_r1: { [UnitType.Archer]:       skinArcherTaoUrl       as unknown as string }, // Tao/Suyuan    (shop, rare)
  skin_shop_e1: { [UnitType.ShieldBearer]: skinShieldBearerTaoUrl as unknown as string }, // Tao/Chenshou  (shop, epic)
  skin_e1:      { [UnitType.Lena]:         skinLenaTaoUrl         as unknown as string }, // Anna/Lena     (gacha, epic)
  skin_e2:      { [UnitType.Mara]:         skinMaraTaoUrl         as unknown as string }, // Anna/Mara     (gacha, epic)
  skin_l1:      { [UnitType.Max]:          skinMaxTaoUrl          as unknown as string }, // Anna/Max      (gacha, legendary)
};

/**
 * Per-type skin-override asset URLs for a set of equipped skin ids — overrides ONLY (not merged with
 * the default STICKMAN_ASSETS bundle); a type absent from the result has no equipped skin and falls
 * back to the default at the call site. Kept separate from the default set so the two can be loaded
 * into distinct side-scoped maps (see the UnitView constructor / acquireSprite).
 *
 * Exported for reuse by `assets/battleAssets.ts` (pre-match asset-readiness gate, ASSET_PACKAGING
 * §10) — it needs the exact same skin→url resolution to pre-warm StickmanRuntime's cache before
 * the scene is shown, so it doesn't compute this independently.
 */
export function resolveSkinOverrides(equippedSkins: readonly string[]): Partial<Record<UnitType, string>> {
  let overrides: Partial<Record<UnitType, string>> = {};
  for (const id of equippedSkins) {
    const skin = SKIN_ASSETS[id];
    if (skin) overrides = { ...overrides, ...skin };
  }
  return overrides;
}

/**
 * Faction ink fills the unit body — blue = us, red = enemy (art-direction §3.2,
 * the primary readability rule). Sourced from theme so a re-skin can't break the
 * friend/foe split. NOTE: Bottom/Top here are render sides, not owners; the local
 * player always sits at Bottom after the localSide-aware layout flip.
 *
 * Placeholder units (PvE-only Ironclad/Runner, or any stickman type before its
 * .tao bundle loads) draw the procedural skeleton draft (stickmanDraft.ts) in
 * faction ink. The figure height now comes from the unit's size tier
 * (targetScreenHeight → unitSize.ts), the SAME source the .tao runtime path uses,
 * so a draft and its eventual .tao render at consistent tiered heights instead of
 * the old hand-tuned per-type px (art-direction §4.5.3 A). Tier still gives the
 * silhouette cue (§3.2: types by silhouette, not color — color is the faction).
 */

/** Stable pen seed per type so each draft scrawls consistently. */
export const DRAFT_SEED: Record<UnitType, number> = {
  [UnitType.Infantry]:     1011,
  [UnitType.ShieldBearer]: 2027,
  [UnitType.Archer]:       3041,
  [UnitType.Ironclad]:     4057,
  [UnitType.Runner]:       5077,
  [UnitType.Harpy]:        6089,
  [UnitType.Medic]:        7103,
  [UnitType.Berserker]:    8117,
  [UnitType.Splitter]:     9131,
  [UnitType.Max]:          10147,
  [UnitType.Lena]:         11161,
  [UnitType.Mara]:         12173,
};

export const RADIUS        = 10;

/**
 * Faction ground marker — a soft highlighter-style color wash under the unit's
 * feet (blue = us / red = enemy). This is the friend/foe signal for full-color
 * art sprites that can't be body-tinted (art-direction §3.2). A low-frequency
 * ground blob deliberately replaces the old per-bone contour outline: a thin
 * traced line competed with the hand-drawn ink linework (high-frequency "moiré"
 * vibration → eye strain); a marker patch at the feet reads instantly without
 * touching the character art, and matches the stationery look.
 */
export const MARKER_Y = 12;   // fallback feet ground Y (circle units / no shadow)

/**
 * Hit-flash outline color — a hot orange impact spark. NOT white: the detached
 * contour sits over the paper-colored gap, where white is near-invisible against
 * the aged-paper background; a saturated warm tone reads instantly as a hit.
 */
export const HIT_FLASH_COLOR = 0xff5a2b;

export const HP_BAR_WIDTH  = 20;
export const HP_BAR_HEIGHT = 3;
/** HP bar Y offset above the unit centre (circle placeholder units). */
export const HP_BAR_Y      = -(RADIUS + 8);

/**
 * HP bar Y for a stickman unit — sits just above the crown. Now that each tier
 * renders at its own height (art-direction §4.5.3 A), this scales with the unit's
 * target height instead of the old flat -32 (which would let an L/XL figure's head
 * poke through the bar). ~0.6× target clears the crown for the shared rig
 * proportions (head tip ≈ 0.54·H_nat above root → 0.54·target on screen).
 */
export function stickmanHpBarY(type: UnitType): number {
  return -Math.round(targetScreenHeight(type) * 0.6);
}
/** Render frames the HP bar stays fully visible after a hit (~2 s at 60 fps). */
export const HP_SHOW_FRAMES  = 120;
/** Render frames to fade out after HP_SHOW_FRAMES. */
export const HP_FADE_FRAMES  = 30;
export const HP_TOTAL_FRAMES = HP_SHOW_FRAMES + HP_FADE_FRAMES;

/**
 * Faction ground marker — a highlighter wash overlaid on the unit's shadow
 * (cx, cy = shadow center; rx, ry = wash half-extents). Three stacked ellipses:
 * a wide soft halo, a stronger mid disc, and a saturated core, so every unit
 * casts an unmistakable blue (us) or red (enemy) footprint readable at a glance
 * across a busy board — this is the primary friend/foe signal for full-colour
 * sprites (art-direction §3.2). Alphas raised from the old faint 0.16/0.22 wash.
 */
export function drawFactionMarker(
  g: PIXI.Graphics, side: Side,
  cx: number, cy: number, rx: number, ry: number,
): void {
  const color = side === Side.Bottom ? factionInk.friend : factionInk.enemy;
  g.clear();
  g.beginFill(color, 0.22); g.drawEllipse(cx,       cy,       rx * 1.12, ry * 1.12); g.endFill();
  g.beginFill(color, 0.38); g.drawEllipse(cx + 1.0, cy + 0.4, rx * 0.82, ry * 0.82); g.endFill();
  g.beginFill(color, 0.55); g.drawEllipse(cx + 1.5, cy + 0.6, rx * 0.5,  ry * 0.5);  g.endFill();
}

// ── Pool factory / resetter (circle placeholder for non-stickman unit types) ───

export function createUnitContainer(): PIXI.Container {
  const c = new PIXI.Container();

  const body   = new PIXI.Graphics(); body.name   = 'body';
  const ring   = new PIXI.Graphics(); ring.name   = 'ring';
  const hpBg   = new PIXI.Graphics(); hpBg.name   = 'hpBg';
  const hpFill = new PIXI.Graphics(); hpFill.name = 'hpFill';

  hpBg.beginFill(0xcccccc, 0.7);
  hpBg.drawRect(-HP_BAR_WIDTH / 2, HP_BAR_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT);
  hpBg.endFill();
  hpBg.visible  = false;
  hpFill.visible = false;

  c.addChild(body, ring, hpBg, hpFill);
  return c;
}

export function resetUnitContainer(c: PIXI.Container): void {
  c.removeFromParent();
  c.alpha   = 1;
  c.scale.set(1);
  c.visible = false;
  (c.getChildByName('hpFill') as PIXI.Graphics).clear();
  (c.getChildByName('hpBg')   as PIXI.Graphics).visible  = false;
  (c.getChildByName('hpFill') as PIXI.Graphics).visible  = false;
}
