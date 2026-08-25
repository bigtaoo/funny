/**
 * SceneHeader/currency.ts — the right-aligned coin / material / capacity cluster scenes draw on top
 * of an already-baked title bar.
 *
 * Split out of SceneHeader.ts (19.08.2026, second time that file crossed the 500-line rule in a day)
 * because it is the one part of that module with nothing to do with the bar itself: it takes a
 * height and paints over whatever is already there. Re-exported from SceneHeader.ts so the ~10 call
 * sites keep their import path.
 */
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, tearDownChildren } from '../../../render/sketchUi';
import { buildIcon, type IconKind } from '../../../render/icons';
import { snapFont } from '../../../render/fontScale';

export interface HeaderCurrencyChip {
  icon: IconKind;
  color: number;
  amount: number;
  /** Short name drawn between the icon and the amount (e.g. "crumbs") — without it, an icon + bare
   * number is unreadable to a player who hasn't memorized the material set. */
  label?: string;
}

/**
 * Right-aligned coin (+ optional material chips, + optional capacity readout) drawn
 * on top of an already-baked header bar so it reads as part of the title row instead
 * of a separate band underneath it (the two used to visually float apart — see the
 * "equipment/card inventory" header-alignment fix). Draw into a per-render overlay layer added
 * *after* the cached header chrome, so the coin icon isn't hidden behind the bar.
 *
 * `leftBound` (design px) is the right edge of whatever the header already drew — pass
 * {@link SceneHeaderResult.titleRight}. It is a **backstop**, not the primary layout: the title
 * band is supposed to have been sized with {@link headerCurrencyWidth} so the cluster fits at full
 * size. It engages when that reserve went stale — the title is baked once in a scene's build() while
 * this redraws every render, so a coin balance that gains a digit mid-scene can outgrow the space
 * measured for it — and then scales the whole cluster down (anchored on its right edge) rather than
 * letting the two overlap. Deliberately unfloored: a fit small enough to be unreadable means the
 * reserve was wrong, and silently overlapping instead would hide that.
 */
export function drawHeaderCurrency(
  container: PIXI.Container,
  w: number, headerH: number,
  coins: number,
  chips: readonly HeaderCurrencyChip[] = [],
  capacity?: { text: string; color: number },
  scale = 1,
  leftBound?: number,
): void {
  const { cluster, width } = buildCluster(headerH, coins, chips, capacity, scale);
  const avail = leftBound === undefined ? width : w - RIGHT_MARGIN - leftBound;
  const fit = width > 0 && avail > 0 && width > avail ? avail / width : 1;
  cluster.scale.set(fit);
  cluster.x = w - RIGHT_MARGIN - width * fit;
  cluster.y = headerH / 2;
  container.addChild(cluster);
}

/**
 * Width the cluster {@link drawHeaderCurrency} would draw for the same arguments, in design px —
 * so a caller can reserve exactly that much before `drawSceneHeader` bakes the title
 * (`opts.rightReserve`). Shares one layout path with the drawing, so the two cannot drift apart;
 * measuring does build and then tear down the nodes, which is why this belongs in a scene's build()
 * and not in a per-frame path.
 *
 * The fixed-ratio reserve this replaces (SceneHeader.ts's TITLE_RIGHT_RESERVE_RATIO, 20% of the bar)
 * was too small for a coin balance plus a capacity readout: on a 430pt-wide portrait viewport the
 * roster's cluster measured ~27% of the bar and the centred title ran straight under the coin number
 * (2026-08-24).
 */
export function headerCurrencyWidth(
  headerH: number,
  coins: number,
  chips: readonly HeaderCurrencyChip[] = [],
  capacity?: { text: string; color: number },
  scale = 1,
): number {
  const { cluster, width } = buildCluster(headerH, coins, chips, capacity, scale);
  tearDownChildren(cluster);
  cluster.destroy();
  return width;
}

/** Inset of the cluster's right edge from the bar's right edge (design px). */
const RIGHT_MARGIN = 10;

function buildCluster(
  headerH: number,
  coins: number,
  chips: readonly HeaderCurrencyChip[],
  capacity: { text: string; color: number } | undefined,
  scale: number,
): { cluster: PIXI.Container; width: number } {
  const iconSize = Math.round(headerH * 0.32 * scale);
  const fontSize = snapFont(Math.round(headerH * 0.26 * scale));
  const labelSize = snapFont(Math.round(fontSize * 0.8));
  const capSize = snapFont(Math.round(headerH * 0.2 * scale));
  const gap = Math.round(headerH * 0.28 * scale);

  const cluster = new PIXI.Container();
  let cx = 0;

  const addChip = (
    icon: IconKind, color: number, amount: number, label?: string,
    amountColor: number = C.dark, bold = false,
  ): void => {
    const ic = buildIcon(icon, iconSize, color);
    ic.x = cx; ic.y = -iconSize / 2;
    cluster.addChild(ic);
    cx += iconSize + 4;
    if (label) {
      const lb = txt(label, labelSize, C.mid);
      lb.anchor.set(0, 0.5); lb.x = cx; lb.y = 0;
      cluster.addChild(lb);
      cx += lb.width + 4;
    }
    const lbl = txt(amount.toLocaleString(), fontSize, amountColor, bold);
    lbl.anchor.set(0, 0.5); lbl.x = cx; lbl.y = 0;
    cluster.addChild(lbl);
    cx += lbl.width + gap;
  };

  // Coin balance: gold bold number, no text label — the glyph is the unit. This is the single
  // coin readout shared by every scene (shop / gacha / battle pass / equipment / roster / …).
  addChip('coin', C.gold, coins, undefined, C.gold, true);
  for (const chip of chips) addChip(chip.icon, chip.color, chip.amount, chip.label);

  if (capacity) {
    const capLbl = txt(capacity.text, capSize, capacity.color);
    capLbl.anchor.set(0, 0.5); capLbl.x = cx; capLbl.y = 0;
    cluster.addChild(capLbl);
    cx += capLbl.width;
  } else {
    cx -= gap; // trim the trailing gap after the last chip
  }

  return { cluster, width: cx };
}
