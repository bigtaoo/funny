// Pure layout geometry — no PIXI, no DOM — so it is unit-testable in the plain
// node vitest suite. Extracted from the lobby hero silhouette after two failed
// attempts to size/centre it: both regressions were in *this* math (which height
// to normalise, and how to centre), so pinning it down in a pure function that a
// test can exercise directly is what keeps it from breaking a third time.

/** A measured content box in its own pre-scale coordinate space. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The target box to fit into, in screen space. */
export interface TargetBox {
  /** Top edge (screen y). */
  top: number;
  /** Box height. */
  height: number;
  /** Desired horizontal centre (screen x) of the content. */
  centerX: number;
}

export interface FitResult {
  /** Uniform scale to apply to the content container. */
  scale: number;
  /** Container x so the content's measured centre lands on box.centerX. */
  x: number;
  /** Container y so the content's measured centre lands on the box's vertical centre. */
  y: number;
}

/**
 * Fit measured `content` to `fraction` of `box.height`, centred on both axes.
 *
 * The critical property — and the thing both prior lobby fixes got wrong — is
 * that BOTH the scale and the centring are derived from the *measured* content
 * box, never from an assumed origin (e.g. "the feet are at y=0, so the figure
 * spans targetH upward"). When the content overhangs its nominal origin
 * asymmetrically (art reaching past the skeleton joints), only measuring the real
 * box makes the result land at the requested fraction and stay centred.
 *
 * After applying the result:
 *   rendered height   = scale * content.height          = fraction * box.height
 *   rendered centre y = y + scale*(content.y+height/2)  = box.top + box.height/2
 *   rendered centre x = x + scale*(content.x+width/2)   = box.centerX
 */
export function fitContentToBox(content: Bounds, box: TargetBox, fraction: number): FitResult {
  const scale = content.height > 0 ? (fraction * box.height) / content.height : 1;
  const boxCenterY = box.top + box.height / 2;
  return {
    scale,
    x: Math.round(box.centerX - scale * (content.x + content.width / 2)),
    y: Math.round(boxCenterY - scale * (content.y + content.height / 2)),
  };
}
