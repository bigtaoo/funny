/**
 * theme.ts — single source of truth for the notebook art direction.
 *
 * Palette + pen parameters live here so the board, UI, and any future
 * procedural art share one "set of pens". Tweak the look in one place.
 *
 * Art direction (see project memory "art-direction"): hand-drawn scrawl on a
 * worn student notebook. Three stationery pens — pencil (black, shadows /
 * hatching), ink pen, and a restrained marker accent. Friend = blue ink,
 * enemy = red ink (the teacher's correcting pen). Flat fills + cross-hatch
 * shading, never soft gradients.
 */

export const palette = {
  /** Aged paper base (matches PIXI.Application backgroundColor 0xf5f0e8). */
  paper:       0xf5f0e8,
  /** Slightly darker paper tone for the board area, distinct from margins. */
  paperShade:  0xece6da,
  /** Faint warm shadow used under fills / fold creases. */
  paperDeep:   0xddd4c2,

  /** Pencil — primary line work, shadows, hatching. */
  pencil:      0x3a3632,
  /** Lighter pencil for secondary marks / faint construction lines. */
  pencilLight: 0x8a8278,

  /** Blue ink — the local player (us). */
  inkBlue:     0x2b4f8c,
  /** Red ink — the enemy (teacher's correcting pen). */
  inkRed:      0xc0392b,

  /** Marker highlight — used sparingly for emphasis. */
  marker:      0xf2c14e,

  /** Printed notebook rule lines (faint blue), like real ruled paper. */
  ruleLine:    0xb9cfe4,
} as const;

export const pen = {
  /** Default ink line width (design-space px). */
  width:        2.2,
  /** Perpendicular wobble amplitude (px) applied along a stroke. */
  jitter:       1.1,
  /** Target length (px) of each resampled stroke segment. */
  segLen:       10,
  /** End-of-stroke thinning: line tapers to `taper × width` at both ends. */
  taper:        0.45,
  /**
   * Double-stroke offset (px). Hand-drawn lines are rarely single — we trace
   * each stroke twice with a small offset + fresh jitter for a sketched feel.
   */
  doubleOffset: 0.9,
  /** Alpha of the second (ghost) stroke pass. */
  ghostAlpha:   0.5,
} as const;

export const hatchDefaults = {
  /** Gap between hatch lines (px). */
  spacing: 7,
  /** Hatch angle (radians). */
  angle:   Math.PI / 4,
  /** Hatch line width. */
  width:   1.2,
  alpha:   0.5,
} as const;

/**
 * Faction ink by side — the art direction's primary readability rule
 * (us = blue pen, enemy = red pen). Battlefield units / bases tint to these;
 * keep them sourced from here so a re-skin never breaks the friend/foe split.
 */
export const factionInk = {
  /** Local player (us). */
  friend: palette.inkBlue,
  /** Opponent (the teacher's correcting pen). */
  enemy:  palette.inkRed,
} as const;

/**
 * Functional / state colors. Per the art direction (§3.3) these UI colors are
 * NOT bound by the friend/foe blue-red rule — they signal placement validity,
 * targeting and HP. Centralized here so the board, units and HUD share one set.
 */
export const fx = {
  /** Valid attack lane highlight (blue tint). */
  laneValid:     0x4488ff,
  /** Lane blocked (spawn row occupied). */
  laneBlocked:   0xdd3333,
  /** Hovered lane (brighter blue). */
  laneHover:     0x2266ff,
  /** Valid building slot (green tint). */
  buildingValid: 0x44aa44,
  /** Meteor targeting (red marker). */
  meteor:        0xff4422,
  /** Base-upgrade highlight (marker yellow). */
  upgrade:       0xffcc00,
  /** No-build cell fill / ✕. */
  noBuild:       0x888888,
  /** HP bar — healthy / hurt. */
  hpHigh:        0x44cc44,
  hpLow:         0xcc4444,
} as const;
