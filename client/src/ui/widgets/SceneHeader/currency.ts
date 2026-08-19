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
import { ui as C, txt } from '../../../render/sketchUi';
import { buildIcon, type IconKind } from '../../../render/icons';
import { buildCoinIcon } from '../../../render/atlas/coinIconAtlas';
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
 */
export function drawHeaderCurrency(
  container: PIXI.Container,
  w: number, headerH: number,
  coins: number,
  chips: readonly HeaderCurrencyChip[] = [],
  capacity?: { text: string; color: number },
  scale = 1,
): void {
  const midY = headerH / 2;
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
    // 'coin' goes through the shared atlas-backed glyph so this reads identically to the shop's
    // balance icon; other currency chips (materials, etc.) keep the procedural buildIcon draw.
    const ic = icon === 'coin' ? buildCoinIcon(icon, iconSize, color) : buildIcon(icon, iconSize, color);
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

  cluster.x = w - 10 - cx;
  cluster.y = midY;
  container.addChild(cluster);
}
