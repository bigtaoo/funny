// BoardView's base lifecycle (idle breathe, hit crack/pulse, critical ring, upgrade tier/effect,
// construction), extracted as form① free functions (claudedocs/client-modules.md "单文件 500 行
//收敛"). buildBases() returns the two BaseRef objects rather than writing through a host — it's
// called exactly once, from the constructor, so "build and return" is simpler than getter/setter
// ceremony for a one-time assignment. The owner-routing methods (playBaseCrackEffect/
// setBaseCritical/setBaseUpgradeLevel/playBaseUpgradeEffect) only mutate BaseRef's own properties
// in place (pulseT/critical/upgradeTier/sprite.texture/…) through the same object reference the
// class already holds — never reassign playerBase/enemyBase itself — so a plain readonly
// `{ playerBase, enemyBase }` pair works with no getter/setter needed. crackSeed is boxed
// (`{ value: number }`) for the same reason: `crackSeedBox.value++` mutates the box in place
// instead of needing a getter/setter for a bare number.
import * as PIXI from 'pixi.js-legacy';
import { sideToOwner } from '../../game';
import { ILayout, Rect } from '../../layout/ILayout';
import { SketchPen } from '../sketch';
import { palette, fx, factionInk } from '../theme';
import baseTexUrl from '../../assets/buildings/game_base.png';
import { loadBaseUpgradeAtlas, getBaseUpgradeTexture } from '../atlas/baseUpgradeAtlasLoader';

// Base idle: a subtle uniform scale breathe (NOT alpha — a 2026-07-25 user report found
// alpha-based idle pulsing on the upgraded tier-1/2 art read as "wrong transparency"; scale
// keeps the castle at all times fully opaque while still feeling alive, same ask as the
// unit stickmen's idle motion). Applied to the whole per-base container (sprite + crack/ring
// overlays together) so nothing drifts out of registration with the castle art.
const BASE_BREATH_SCALE_MIN   = 0.985;
const BASE_BREATH_SCALE_RANGE = 0.03;   // 0.985 → 1.015
const BASE_BREATH_SPEED       = Math.PI / 2; // rad/s → period = 4s

// Base under-attack: a hand-drawn outline pops around the base and fades out.
const BASE_HIT_PULSE_SEC   = 0.5;   // duration of one pulse
const BASE_HIT_PULSE_GROW  = 0.18;  // outline expands by this fraction as it fades

// Base critical (last HP): a faction-colored ring throbs around the base — this is
// where a haste-rush ends the game, so it draws the eye to the board, not the HUD.
const CRIT_RING_SPEED = 7.5; // rad/s → fast, urgent throb

// Castle art fill ratio within its 2×2 base rect — see buildBaseRef() for why this isn't 1.0.
const BASE_ART_INSET = 0.86;

/**
 * Idle faction ground patch under each base (敌红我蓝, art-direction §3.2): a soft
 * layered color wash at the castle's foot, drawn once and left static — same
 * "colored ground patch under a full-color AI asset" language as UnitView's
 * drawFactionMarker, not a persistent outline (§3.4 explicitly bans standing
 * outline glow: it beats against the hand-drawn ink linework and moirés).
 */
export function drawFactionGroundPatch(g: PIXI.Graphics, color: number, rect: Rect): void {
  const cx = 0, cy = rect.h * 0.32; // castle art sits high in its frame; patch anchors near its foot
  const rx = rect.w * 0.34, ry = rect.h * 0.1;
  g.clear();
  g.beginFill(color, 0.16); g.drawEllipse(cx,        cy,        rx * 1.3, ry * 1.3); g.endFill();
  g.beginFill(color, 0.24); g.drawEllipse(cx,        cy,        rx,       ry);       g.endFill();
  g.beginFill(color, 0.34); g.drawEllipse(cx,        cy,        rx * 0.6, ry * 0.6); g.endFill();
}

export interface BaseRef {
  sprite:   PIXI.Sprite;
  crackGfx: PIXI.Graphics;
  /** Hand-drawn outline shown briefly when the base takes damage. */
  pulseGfx: PIXI.Graphics;
  /** Remaining seconds of the current hit pulse (0 = idle). */
  pulseT:   number;
  /** Monotonic seed so each pulse scrawls with a fresh hand. */
  pulseSeed: number;
  rect:     Rect;
  /** Base-upgrade tier currently shown (0 = original texture, no upgrade bought yet). */
  upgradeTier: number;
  /** Faction-colored critical ring (throbs while this base is one hit from over). */
  ringGfx:  PIXI.Graphics;
  /** Faction hue for the critical ring (this base's owner: us = blue, enemy = red). */
  ringColor: number;
  /** True while HP is critical — drives the ring throb in update(). */
  critical: boolean;
  /** Parent container (sprite + crack/ring overlays) — scaled as one for the idle breathe. */
  container: PIXI.Container;
}

function buildBaseRef(parent: PIXI.Container, rect: Rect, mirror: boolean, tex: PIXI.Texture, ringColor: number): BaseRef {
  const con = new PIXI.Container();
  con.x = rect.x + rect.w / 2;
  con.y = rect.y + rect.h / 2;

  const ringGfx = new PIXI.Graphics(); // critical throb — behind the sprite (halo)
  const groundGfx = new PIXI.Graphics(); // idle faction ground patch — under everything

  const s = new PIXI.Sprite(tex);
  s.anchor.set(0.5);
  // Inset the castle art within its 2×2 rect (BASE_ART_INSET) so it doesn't
  // draw edge-to-edge with the boundary — at full rect.w/h the castle wall
  // touched the very next cell with zero gap, reading as "overlapping" the
  // building placed right next to it (2026-08-09 user report, PvE + PvP).
  // Buildings already sit inset within their own cell (SPRITE_SIZE=56 in a
  // 70px CELL, ~10% each side in BuildingView.ts); match that here.
  s.width  = rect.w * BASE_ART_INSET;
  s.height = rect.h * BASE_ART_INSET;
  if (mirror) {
    // Distinguish the enemy base with a horizontal flip in BOTH orientations.
    // (Portrait used to flip vertically, but an upside-down castle reads as a
    // rendering bug — a left/right mirror is the cleaner distinction.)
    s.scale.x *= -1;
  }

  const crackGfx = new PIXI.Graphics();
  const pulseGfx = new PIXI.Graphics();   // under-attack outline, drawn on top
  con.addChild(groundGfx, ringGfx, s, crackGfx, pulseGfx);
  parent.addChild(con);
  drawFactionGroundPatch(groundGfx, ringColor, rect);
  return { sprite: s, crackGfx, pulseGfx, pulseT: 0, pulseSeed: 1, rect, upgradeTier: 0, ringGfx, ringColor, critical: false, container: con };
}

/**
 * Construct both bases (called once, from the constructor). Base art is a bitmap asset (art
 * belongs to AI-drawn assets, not procedural — see art-direction.md "Asset responsibility
 * breakdown"). Enemy base mirrors by orientation. playerBase = local player's base (blue = us);
 * enemyBase = opponent (red).
 */
export function buildBases(layout: ILayout, container: PIXI.Container): { playerBase: BaseRef; enemyBase: BaseRef } {
  const baseTex = PIXI.Texture.from(baseTexUrl as string);
  const playerBase = buildBaseRef(container, layout.playerBaseRect(), false, baseTex, factionInk.friend);
  const enemyBase  = buildBaseRef(container, layout.enemyBaseRect(),  true,  baseTex, factionInk.enemy);
  loadBaseUpgradeAtlas().catch((err) => console.warn('[BoardView] base upgrade atlas load failed:', err));
  return { playerBase, enemyBase };
}

/** Idle "alive" cue: a gentle uniform scale breathe on the whole base container (never alpha). */
export function applyBaseBreath(base: BaseRef | null, t: number, phaseOffset: number): void {
  if (!base) return;
  const v = Math.sin(t * BASE_BREATH_SPEED + phaseOffset);
  base.container.scale.set(BASE_BREATH_SCALE_MIN + BASE_BREATH_SCALE_RANGE * (v * 0.5 + 0.5));
}

/** Animate the under-attack outline: fade out + slight expand, then clear. */
export function applyHitPulse(base: BaseRef | null, dt: number): void {
  if (!base || base.pulseT <= 0) return;
  base.pulseT -= dt;
  if (base.pulseT <= 0) {
    base.pulseT = 0;
    base.pulseGfx.clear();
    return;
  }
  const frac = base.pulseT / BASE_HIT_PULSE_SEC;   // 1 → 0
  base.pulseGfx.alpha = frac;
  base.pulseGfx.scale.set(1 + (1 - frac) * BASE_HIT_PULSE_GROW);
}

/** Throb the faction ring while a base is critical (fast, urgent). */
export function applyCriticalRing(base: BaseRef | null, t: number): void {
  if (!base || !base.critical) return;
  const p   = 0.5 + 0.5 * Math.sin(t * CRIT_RING_SPEED);
  const pad = 6 + 9 * p;
  const hw  = base.rect.w / 2, hh = base.rect.h / 2;
  const g   = base.ringGfx;
  g.clear();
  g.lineStyle(4, base.ringColor, 0.35 + 0.5 * p);
  g.drawRoundedRect(-hw - pad, -hh - pad, base.rect.w + pad * 2, base.rect.h + pad * 2, 12);
}

/**
 * Draw a hand-drawn red outline around the base footprint (centered on the
 * base container) and start its fade-out pulse. Red = the correcting pen /
 * damage; reads instantly as "under attack" on the clear-edged base bitmap.
 */
function triggerBaseHitPulse(base: BaseRef): void {
  // Under sustained fire base_hp_changed fires almost every frame; don't restart
  // a pulse that's still animating, or it freezes at full alpha/scale (looks
  // like a static frame). Let the current pulse finish, then the next hit starts
  // a fresh one — a steady rhythm of expand-and-fade pulses.
  if (base.pulseT > 0) return;

  const g = base.pulseGfx;
  g.clear();
  g.alpha = 1;
  g.scale.set(1);
  const hw = base.rect.w / 2;
  const hh = base.rect.h / 2;
  const pen = new SketchPen(g, (base.pulseSeed++ * 0x9e3779b1) >>> 0 || 1);
  pen.rect(-hw - 3, -hh - 3, base.rect.w + 6, base.rect.h + 6, {
    color: palette.inkRed, width: 3, jitter: 1.4,
  });
  base.pulseT = BASE_HIT_PULSE_SEC;
}

/** What the owner-routing base methods need to pick playerBase vs enemyBase and the local-side mapping. */
export interface BasesHost {
  readonly layout: ILayout;
  readonly container: PIXI.Container;
  readonly playerBase: BaseRef | null;
  readonly enemyBase: BaseRef | null;
}

function baseForOwner(host: BasesHost, owner: 0 | 1): BaseRef | null {
  const localOwner = sideToOwner(host.layout.localSide);
  return owner === localOwner ? host.playerBase : host.enemyBase;
}

/**
 * Accumulate pencil-sketch crack lines on a base when it takes damage.
 * No cracks above 85% HP; 2 cracks per hit below 40% HP. `crackSeedBox` persists across calls
 * (boxed so the caller's counter mutates in place without needing a getter/setter).
 */
export function playBaseCrackEffect(host: BasesHost, crackSeedBox: { value: number }, owner: 0 | 1, hp: number, maxHp: number): void {
  const base = baseForOwner(host, owner);
  if (!base) return;

  // Outline pulse on EVERY hit (immediate "this base got hit" feedback),
  // independent of the accumulated cracks below.
  triggerBaseHitPulse(base);

  const ratio = hp / maxHp;
  if (ratio > 0.85) return;

  const gfx = base.crackGfx;
  const hw = base.rect.w * 0.25;  // ±1/4 width, i.e. half the distance from center to edge
  const hh = base.rect.h * 0.25;
  const numCracks = ratio < 0.4 ? 2 : 1;

  // Draw with the shared hand-drawn pencil pen (art-direction §8) instead of a
  // raw line, so cracks read as scrawled marks. Seed bumps per call so each hit
  // adds a distinct jagged line on top of the accumulated ones.
  const pen = new SketchPen(gfx, (crackSeedBox.value++ * 0x9e3779b1) >>> 0 || 1);
  for (let i = 0; i < numCracks; i++) {
    // Random start near the base center (render-side jitter is fine).
    let x = (Math.random() * 2 - 1) * hw;
    let y = (Math.random() * 2 - 1) * hh;
    let dir = Math.random() * Math.PI * 2;
    const pts = [{ x, y }];
    for (let seg = 0; seg < 3; seg++) {   // 3-segment jagged line
      dir += (Math.random() - 0.5) * 1.2;
      x += Math.cos(dir) * (8 + Math.random() * 8);
      y += Math.sin(dir) * (8 + Math.random() * 8);
      pts.push({ x, y });
    }
    pen.stroke(pts, { color: palette.pencil, width: 1.3, alpha: 0.7, taper: 0.5, double: false });
  }
}

/**
 * Toggle the critical-HP ring on a base (owner is the raw game owner; mapped to
 * the local/enemy sprite like playBaseCrackEffect). Idempotent — the ring is
 * animated by applyCriticalRing while `critical` is set, and cleared once on toggle-off.
 */
export function setBaseCritical(host: BasesHost, owner: 0 | 1, on: boolean): void {
  const base = baseForOwner(host, owner);
  if (!base || base.critical === on) return;
  base.critical = on;
  if (!on) base.ringGfx.clear();
}

/**
 * Swap a base's sprite texture to match its current upgrade level once the
 * upgrade atlas has decoded. Level 0 keeps the original `game_base.png`
 * texture; level 1 → castle-town; level 2+ (max) → palace (the atlas only
 * has 2 upgrade tiers, so the top tier covers both remaining levels).
 * No-op if the tier hasn't changed or the atlas isn't ready yet.
 */
export function setBaseUpgradeLevel(host: BasesHost, owner: 0 | 1, upgradeLevel: number): void {
  const base = baseForOwner(host, owner);
  if (!base) return;

  const tier = upgradeLevel <= 0 ? 0 : Math.min(upgradeLevel, 2);
  if (tier === base.upgradeTier) return;

  const tex = tier === 0 ? PIXI.Texture.from(baseTexUrl as string) : getBaseUpgradeTexture(tier as 1 | 2);
  if (!tex) return; // atlas not decoded yet — try again next sync
  base.sprite.texture = tex;
  // Re-fit to the base footprint: the upgrade-tier frames (256×256) have a
  // different native size than game_base.png (324×256), so without re-applying
  // width/height the retained scale would render the upgraded base squished
  // (~79% width). PIXI's width/height setters preserve the sign of scale, so the
  // enemy base's mirror flip (scale.x < 0) survives.
  base.sprite.width  = base.rect.w;
  base.sprite.height = base.rect.h;
  base.upgradeTier = tier;
}

/**
 * One-shot celebratory "level-up" flash when a base upgrades (event-driven).
 * The persistent tier texture is swapped separately by setBaseUpgradeLevel
 * (state-reconciled each frame); this only plays the transient burst.
 *
 * Routes to the correct base via the same localSide-aware mapping as the crack
 * effect. A hand-drawn gold outline is stamped ONCE (SketchPen jitter frozen),
 * then expanded + faded via transform — no per-frame redraw (avoids wobble).
 * A brief scale-pop of the whole base container punctuates the upgrade.
 */
export function playBaseUpgradeEffect(host: BasesHost, fxTicks: Set<() => void>, owner: 0 | 1): void {
  const base = baseForOwner(host, owner);
  if (!base) return;

  // The base sprite/crack/pulse all live under one container centered on the base;
  // popping it scales the whole castle. Fall back gracefully if unparented.
  const con = base.sprite.parent as PIXI.Container | null;

  const ring = new PIXI.Graphics();
  const hw = base.rect.w / 2;
  const hh = base.rect.h / 2;
  const pen = new SketchPen(ring, (base.pulseSeed++ * 0x9e3779b1) >>> 0 || 1);
  pen.rect(-hw - 4, -hh - 4, base.rect.w + 8, base.rect.h + 8, {
    color: fx.upgrade, width: 3.5, jitter: 1.8,
  });
  (con ?? host.container).addChild(ring);

  const DURATION = 0.6; // seconds
  let elapsed = 0;
  const tick = (): void => {
    elapsed += PIXI.Ticker.shared.deltaMS / 1000;
    const t = Math.min(elapsed / DURATION, 1);
    ring.alpha = 1 - t;
    ring.scale.set(1 + t * 0.5); // ring blooms outward as it fades
    // Container pop: overshoot to +12% by 0.15s, settle back to 1 by 0.3s.
    if (con) con.scale.set(1 + 0.12 * Math.sin(Math.min(elapsed / 0.3, 1) * Math.PI));
    if (t >= 1) {
      PIXI.Ticker.shared.remove(tick);
      fxTicks.delete(tick);
      if (con) con.scale.set(1);
      ring.destroy();
    }
  };
  fxTicks.add(tick);
  PIXI.Ticker.shared.add(tick);
}
