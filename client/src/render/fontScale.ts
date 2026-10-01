/**
 * fontScale.ts — the single source of truth for in-game font sizes.
 *
 * Before this, font sizes were set ~590 different times across 61 files with no
 * shared table: `txt(label, 12, …)` / `fontSize: 14` fixed literals (23 distinct
 * values, 9–60px) mixed with responsive `Math.round(h * 0.026)` expressions (48
 * distinct fraction multipliers against a grab-bag of base dimensions). The same
 * *semantic* piece of text — a card subtitle, say — was 12px in one scene, 13px
 * in another, `0.024 * h` in a third. Re-tuning "all the small labels" meant a
 * global grep.
 *
 * This module collapses that into ONE semantic scale. Every scene sizes text by
 * intent — `FS.body`, `FS.title` — not by a magic number, and the whole game's
 * typography is re-tuned from the nine numbers below. All values are in the 1080
 * design-coordinate space that both {@link LandscapeLayout} (designHeight 1080)
 * and {@link PortraitLayout} (designWidth 1080) render into, so a token means the
 * same rendered size in either orientation.
 *
 * The tokens are ordered small→large and each covers the raw-px band noted beside
 * it (the band the old scattered values fell in, snapped to the tier). To change
 * how big "body text" is everywhere, edit the number here — nowhere else.
 *
 * ## The legibility floor (2026-09-11)
 *
 * A design px is not a screen px. `ScalingManager` contains the design rect into the
 * viewport, and that factor is nowhere near 1 on a phone held upright: portrait's design
 * width is a fixed 1080, so a 390-px-wide iPhone renders the whole UI at **0.36x**, and a
 * 360-wide budget Android at 0.33x. `FS.micro` (11 design px) is then 4 CSS px — smaller
 * than the smallest text any OS will render, and unreadable in the portrait sweep's own
 * screenshots (the defense editor's footer, the city page's `/200k` caps and `Lv.0`
 * subtitles).
 *
 * So the table below is the *design* scale, and what a scene actually gets is that value
 * lifted to a floor derived from the live design scale: no token may render below
 * {@link MIN_LEGIBLE_CSS_PX} CSS px. `FS.micro` is a getter, not a number, so this reaches
 * all ~590 call sites without any of them knowing — and, crucially, the *same* lifted
 * number reaches the layout arithmetic beside them (`y += FS.small + 6`), which a floor
 * applied inside the text factory could not do.
 *
 * Two deliberate limits:
 *
 *  - **The floor is itself a token** (snapped up the table), never an off-scale number, so a
 *    lifted `micro` is indistinguishable from a scene that asked for `small` outright.
 *  - **It is capped at `FLOOR_CAP`.** Reaching a genuinely comfortable 9–10 CSS px on a
 *    390-wide phone would need a ~25 design px floor, which is above `FS.label` — every token
 *    from fine print to section heading would collapse onto one size and the whole portrait UI
 *    would have to be re-laid-out around it. The cap keeps the floor inside the fine-print end
 *    of the scale, which bounds the reflow to labels that were already short. What the cap
 *    leaves on the table (a 360-wide phone still lands at 6.7 CSS px) is recorded in
 *    design/game/UI_DESIGN_LOG_2026-08.md §49 — the real fix there is portrait's design width,
 *    not the font table.
 *
 * The floor is a function of the design scale alone, NOT of orientation: landscape on a phone
 * (844x390 → 0.36x) is the same arithmetic, and a desktop landscape window (0.83x) asks for a
 * floor below `micro` and is therefore left exactly as it was. *
 * ## The phone type boost (2026-10-01)
 *
 * The floor only rescues fine print; it leaves `body` at 7.2 CSS px and `title` at 11.6 on a
 * 390-wide phone, and it cannot do better without collapsing the hierarchy (see its cap). So on
 * top of it, every token is multiplied by a boost derived from the same design scale:
 *
 *     boost(scale) = clamp(TARGET_BODY_CSS_PX / (BASE.body * scale), 1, MAX_BOOST)   (0.05 steps)
 *
 * applied in full to the label end of the table and tapered towards `display` (headings are
 * already legible on a phone, and they sit in the fixed-size headers that would overflow first).
 * The boost preserves order — every token stays strictly larger than the one below it — which is
 * exactly what raising the floor could not. A desktop window asks for a boost below 1 and keeps
 * the raw table byte for byte; a phone in either orientation gets the same 1.4x.
 *
 * What it deliberately does NOT touch: {@link snapFont} (sizes computed from a control's own
 * dimensions — the control does not grow, so neither may its text) and icons / cells, which are
 * geometry. Those are what portrait design width would fix; this is the cheaper half. Log:
 * design/game/UI_DESIGN_LOG_2026-10.md §72.
 */

/** Raw design-px scale, before {@link fontFloorDesignPx}'s legibility floor. */
const BASE = {
  /** ≤11 — fine print: unit counters, timers, "/cap" suffixes, tiny badges. */
  micro: 11,
  /** 12–14 — secondary labels, hints, cost lines, dense metadata. */
  tiny: 13,
  /** 15–16 — compact body / dense list rows. */
  small: 16,
  /** 17–18 — default body text and standard button labels. */
  body: 18,
  /** 19–21 — emphasized body, item / card names. */
  bodyLg: 20,
  /** 22–25 — section labels, sub-headings, list-group titles. */
  label: 24,
  /** 26–29 — panel headings, prominent counters. */
  heading: 28,
  /** 30–35 — scene / panel titles. */
  title: 32,
  /** 36–47 — hero titles, toasts, headline callouts. */
  headline: 42,
  /** ≥48 — splash / result numbers. */
  display: 60,
} as const;

/** A font-scale token name (e.g. `'body'`). */
export type FontToken = keyof typeof BASE;

/**
 * Smallest size (CSS px, i.e. real screen px) a label may render at. Below this a monospace
 * glyph on a phone stops resolving into characters — judged off the portrait sweep's own
 * dpr-2 screenshots, where `FS.micro`'s 4 CSS px is a grey smudge and the 7 CSS px this
 * produces is small print that can still be read.
 */
export const MIN_LEGIBLE_CSS_PX = 7;

/**
 * Ceiling for the floor — see the module header's second limit. `bodyLg` is the largest token
 * that is still "a label", so a floor at it can never turn fine print into a heading.
 */
const FLOOR_CAP: number = BASE.bodyLg;

/** What `FS.body` should reach on screen, in CSS px, when the boost is not capped. */
export const TARGET_BODY_CSS_PX = 10;

/** Largest boost ever applied — a 390-wide phone sits on it (its unclamped ask is 1.54). */
export const MAX_BOOST = 1.4;

/**
 * How much of the boost each token takes (as an exponent, so 1 = all of it, 0 = none). Labels and
 * body take all of it; headings progressively less, because they are already legible on a phone
 * and live in the fixed-height headers and title bands that a full boost would burst.
 */
const BOOST_WEIGHT: Readonly<Record<FontToken, number>> = {
  micro: 1, tiny: 1, small: 1, body: 1, bodyLg: 1,
  label: 0.85, heading: 0.75, title: 0.65, headline: 0.5, display: 0.35,
};

/**
 * The type boost implied by a design→screen scale — see the module header. Pure, and quantised to
 * 0.05 so a window dragged a few pixels does not mint a new set of sizes (and glyph caches).
 */
export function fontBoost(designScale: number): number {
  if (!Number.isFinite(designScale) || designScale <= 0) return 1;
  const ask = TARGET_BODY_CSS_PX / (BASE.body * designScale);
  const stepped = Math.floor(ask * 20 + 1e-9) / 20;
  return Math.min(MAX_BOOST, Math.max(1, stepped));
}

/** The full live table for a scale: each token boosted, then lifted to the legibility floor. */
export function fontTableFor(designScale: number): Readonly<Record<FontToken, number>> {
  const boost = fontBoost(designScale);
  const floor = fontFloorDesignPx(designScale);
  const out = {} as Record<FontToken, number>;
  for (const [token, px] of Object.entries(BASE) as Array<[FontToken, number]>) {
    out[token] = Math.max(floor, Math.round(px * Math.pow(boost, BOOST_WEIGHT[token])));
  }
  return out;
}

/** Ordered (token, px) pairs, small → large. */
const TIERS: ReadonlyArray<readonly [FontToken, number]> = (
  Object.entries(BASE) as Array<[FontToken, number]>
).sort((a, b) => a[1] - b[1]);

/** Smallest token at or above `px` (the largest token if nothing reaches it). */
function snapUp(px: number): number {
  for (const tier of TIERS) if (tier[1] >= px) return tier[1];
  return TIERS[TIERS.length - 1]![1];
}

/** Largest token at or below `px` (the smallest token if nothing is). */
function snapDown(px: number): number {
  let best = TIERS[0]![1];
  for (const tier of TIERS) if (tier[1] <= px) best = tier[1];
  return best;
}

/**
 * The design-px floor implied by a design→screen scale: the smallest token that renders at
 * {@link MIN_LEGIBLE_CSS_PX} or more, capped at `FLOOR_CAP`.
 *
 * Pure, and exported for two callers that must agree on it exactly: {@link setFontScale} (the
 * live app) and the portrait sweep's `tiny` gate (test/browser/portraitLayout.spec.ts), which
 * asserts that nothing renders below the floor this scale promises.
 */
export function fontFloorDesignPx(designScale: number): number {
  if (!Number.isFinite(designScale) || designScale <= 0) return BASE.micro;
  return Math.min(FLOOR_CAP, Math.max(BASE.micro, snapUp(MIN_LEGIBLE_CSS_PX / designScale)));
}

/** Live floor. Only {@link setFontScale} writes it; {@link FS} reads it on every access. */
let floorPx: number = BASE.micro;

/** Live boosted + floored table. Only {@link setFontScale} writes it. */
let live: Readonly<Record<FontToken, number>> = { ...BASE };

/** Live boost, for diagnostics. */
let boostNow = 1;

/**
 * Adopt the design→screen scale the layer is being drawn at. Called from
 * `ScalingManager.applyScaling`, the one place that computes it (beside `setDesignScale`, for
 * the same reason: a caller-side copy would drift on the next resize path someone adds).
 *
 * Scenes read `FS.*` while building, so a scale change only reaches whatever is built after it.
 * That matches what resize already does with the rest of the layout: `ViewportResizer` rebuilds
 * the lobby and re-fits everything else without re-laying it out (see its header).
 */
export function setFontScale(designScale: number): void {
  floorPx = fontFloorDesignPx(designScale);
  boostNow = fontBoost(designScale);
  live = fontTableFor(designScale);
}

/** Back to the unlifted table (unit tests / headless harness). */
export function resetFontScaleForTest(): void {
  floorPx = BASE.micro;
  boostNow = 1;
  live = { ...BASE };
}

/** The boost currently in force (1 = the raw table) — for diagnostics and tests. */
export function currentFontBoost(): number {
  return boostNow;
}

/** The floor currently in force, in design px — for diagnostics and tests. */
export function currentFontFloor(): number {
  return floorPx;
}

const lift = (px: number): number => (px < floorPx ? floorPx : px);

/**
 * The semantic font scale, in design px (1080-space), each token multiplied by the live phone
 * boost and lifted to the live legibility floor — see the module header.
 *
 * **Every member is a getter, so read it where you draw.** A module-level `const ROW_FONT =
 * FS.body` is now a bug: module initialisers run at import time, which is before `ScalingManager`
 * has computed a scale at all, so such a copy is pinned to the unlifted table forever. (Four
 * existed when the floor landed; `WorldMapPanels/spec.ts` and `HUDView.ts` show the fix — make it
 * a function.) Inside a function, a local copy is fine: scenes are built after the scale is known
 * and rebuilt when it changes.
 */
export const FS = {
  /** ≤11 — fine print: unit counters, timers, "/cap" suffixes, tiny badges. */
  get micro(): number { return live.micro; },
  /** 12–14 — secondary labels, hints, cost lines, dense metadata. */
  get tiny(): number { return live.tiny; },
  /** 15–16 — compact body / dense list rows. */
  get small(): number { return live.small; },
  /** 17–18 — default body text and standard button labels. */
  get body(): number { return live.body; },
  /** 19–21 — emphasized body, item / card names. */
  get bodyLg(): number { return live.bodyLg; },
  /** 22–25 — section labels, sub-headings, list-group titles. */
  get label(): number { return live.label; },
  /** 26–29 — panel headings, prominent counters. */
  get heading(): number { return live.heading; },
  /** 30–35 — scene / panel titles. */
  get title(): number { return live.title; },
  /** 36–47 — hero titles, toasts, headline callouts. */
  get headline(): number { return live.headline; },
  /** ≥48 — splash / result numbers. */
  get display(): number { return live.display; },
} as const;

/**
 * The size to draw at so text that measures `need` px wide at `size` fits into `avail` — one token
 * down the scale as many steps as it takes, and never below the legibility floor.
 *
 * This exists because of what every such call site reached for first: `group.scale.set(avail /
 * need)`. Shrinking the built group is what the floor cannot survive — it multiplies the size the
 * scale just guaranteed by an arbitrary float, and the label lands wherever that float puts it
 * (measured before this existed: a 24px codex header at 0.68, a 28px world-map readout at 0.71,
 * i.e. under the floor and back to unreadable). Choosing the SIZE instead keeps the result on the
 * shared scale and bounded below by the floor.
 *
 * Exact rather than iterative: the UI font is monospace, so measured width is linear in size and
 * `size * avail / need` is the size that fits. Returning the floor when even that is too wide is
 * deliberate — the caller then has to wrap, drop a piece, or accept the overflow, which are the
 * only honest answers left; silently shrinking past legibility is not one of them.
 */
export function fitFont(size: number, need: number, avail: number): number {
  if (!Number.isFinite(need) || !Number.isFinite(avail) || need <= 0 || need <= avail) return size;
  return Math.max(floorPx, snapDown(size * (avail / need)));
}

/**
 * An ICON's drawn size, lifted to the same legibility floor a font token gets.
 *
 * For icons whose size is a proportion of the control they sit in (`rowH * 0.4`, and the like) -
 * the picture counterpart of what {@link snapFont} does for a proportional font size, and needed
 * for the same reason: a compact row on a phone computes a number that was fine on the design
 * canvas and is a smudge on the screen. NOT snapped to the font ladder, because an icon has no
 * business landing on typographic tiers; it is only floored.
 *
 * A fixed-size icon that sits beside a label should take the label's token instead
 * (`buildIcon('lock', FS.body, ...)`), which carries the floor already and keeps the pair matched.
 *
 * The audit gate on the other side of this is `testing/layoutAudit.ts`'s `icon` finding, which
 * holds icons to `fontFloorDesignPx(scale)` - the same number this lifts to, deliberately.
 */
export function iconFloorPx(px: number): number {
  return Math.max(floorPx, Math.round(px));
}

/**
 * A width that was tuned in characters of text — a grid's target column width, a column sized to
 * fit "15 monospace characters at the floor" — scaled by the live phone boost so it still holds
 * the same text once the text is bigger.
 *
 * The boost grows every label and nothing else; a grid whose column count was chosen so that its
 * text JUST fits (the auction house's three columns, equipment's 260-px minimum) then overflows on
 * exactly the viewports the boost is for. Passing its width target through here lets the column
 * count drop instead — fewer, wider cells — which is the honest trade for bigger text on a narrow
 * screen. Identity wherever the boost is 1 (desktop, tablets), so those grids do not move.
 */
export function typeWidth(px: number): number {
  return px * boostNow;
}

/**
 * Snap an arbitrary pixel size to the nearest scale token. Kept for the handful
 * of call sites whose size is genuinely computed at runtime (e.g. text scaled to
 * fill a variable-height control): pass the computed px through here so it still
 * lands on the shared scale rather than reintroducing an off-scale value.
 *
 * Ties round up to the larger tier (legibility over compactness), and the result carries the
 * same legibility floor as a named token — a control whose height suggests 9px text still gets
 * text that can be read.
 */
export function snapFont(px: number): number {
  let best = TIERS[0]!;
  let bestDist = Infinity;
  for (const tier of TIERS) {
    const d = Math.abs(tier[1] - px);
    if (d < bestDist || (d === bestDist && tier[1] > best[1])) {
      best = tier;
      bestDist = d;
    }
  }
  return lift(best[1]);
}
