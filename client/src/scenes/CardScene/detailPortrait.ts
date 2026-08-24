// detailPortrait.ts — the card-detail modal's portrait window: which face it shows (art or lore) and
// the squash-flip that swaps between them. Split out of ./detail.ts (2026-08-24) to keep that file
// under the 500-line convention; a natural seam because neither function touches the modal's layout
// or its hit rects — they own one container the caller hands them.
//
// The flip drives PIXI.Ticker.shared directly and parks its unsubscribe on `core.flipTickerCleanup`,
// which openDetail/closeModal must call before destroying the container: the tick closure writes
// `container.scale.x` every frame and PIXI nulls `transform` on destroy.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import type { CardSceneCore } from './core';

/** Draw the portrait face: art (front) or word-wrapped lore text (back), centered on the container's local origin. */
export function drawDetailFace(
  core: CardSceneCore, container: PIXI.Container, box: number,
  artUrl: string | undefined, loreText: string, flipped: boolean,
): void {
  tearDownChildren(container);
  if (!flipped) {
    if (artUrl) core.drawArtFit(artUrl, -box / 2, -box / 2, box, container);
    return;
  }
  const bg = new PIXI.Graphics();
  bg.beginFill(0xf0eee7).drawRect(-box / 2, -box / 2, box, box).endFill();
  container.addChild(bg);
  const lore = core.stxt(loreText, FS.micro, C.mid);
  lore.style.wordWrap = true;
  lore.style.wordWrapWidth = box - 10;
  lore.x = -box / 2 + 5; lore.y = -box / 2 + 5;
  container.addChild(lore);
}

/** Squash-flip the portrait face container (scaleX 1→0→1, swapping content at the midpoint) via PIXI.Ticker.shared. */
export function flipDetailPortrait(
  core: CardSceneCore, container: PIXI.Container, box: number,
  artUrl: string | undefined, loreText: string,
): void {
  core.flipTickerCleanup?.();
  const DUR_MS = 260;
  let elapsed = 0;
  let swapped = false;
  const tick = () => {
    elapsed += PIXI.Ticker.shared.deltaMS;
    const t = Math.min(1, elapsed / DUR_MS);
    if (!swapped && t >= 0.5) {
      swapped = true;
      core.detailFlipped = !core.detailFlipped;
      drawDetailFace(core, container, box, artUrl, loreText, core.detailFlipped);
    }
    container.scale.x = Math.max(0.02, t < 0.5 ? 1 - t / 0.5 : (t - 0.5) / 0.5);
    if (t >= 1) {
      container.scale.x = 1;
      PIXI.Ticker.shared.remove(tick);
      core.flipTickerCleanup = null;
    }
  };
  core.flipTickerCleanup = () => PIXI.Ticker.shared.remove(tick);
  PIXI.Ticker.shared.add(tick);
}
