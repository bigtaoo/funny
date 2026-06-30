/**
 * HubTabs.ts — a shared horizontal "section tab" strip for a hub group of
 * scenes (LOBBY_IA_REDESIGN P1.5).
 *
 * P1 merged features into hub tabs but wired them as launchers: tapping Equipment
 * left CollectionScene for EquipmentScene with only a lone "← back", and the
 * shop's Gacha/BattlePass footer buttons launched isolated full-screen pages. The
 * sub-pages of one group never showed each other, so they read as "jump out &
 * come back", not as peer tabs of one hub.
 *
 * This strip pins a persistent group tab bar drawn just below the standard
 * SceneHeader on every member scene of a group, so the merged features feel
 * like one place. It only *navigates* between sibling scenes (we keep the
 * one-scene-one-feature architecture; nothing is embedded), but visually the
 * group reads as a single tabbed hub:
 *
 *   Shop group       : [Shop | Gacha | BattlePass]
 *   Collection group : [Collection | Equipment]
 *
 * Visual language matches CollectionScene's own tab bar: a sketch panel per
 * cell, active = dark fill + accent border + white bold, inactive = paper fill
 * + line border + mid. Callers draw it after the header, then register the
 * returned hit rects with their own hit testing.
 *
 *   const stripH = hubTabsHeight(h);
 *   const hits = drawHubTabs(this.container, w, barH, stripH, tabs, (i) => …);
 *   this.hits.push(...hits);
 *   // lay body out below barH + stripH
 */
import * as PIXI from 'pixi.js-legacy';
import type { Rect } from '../../layout/ILayout';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';

export interface HubTab {
  label: string;
  /** The current page — drawn highlighted and not tappable. */
  active: boolean;
}

/** Standard strip height (5% of design height) — a touch shorter than a full header. */
export function hubTabsHeight(h: number): number {
  return Math.round(h * 0.05);
}

/**
 * Draw the group tab strip at (0, y) spanning the full width, height stripH.
 * Returns hit rects for the inactive (tappable) cells; the active cell is a
 * no-op and gets no rect. The caller owns hit testing and y-layout below.
 */
export function drawHubTabs(
  container: PIXI.Container,
  w: number,
  y: number,
  stripH: number,
  tabs: HubTab[],
  onSelect: (index: number) => void,
): Array<{ rect: Rect; fn: () => void }> {
  const hits: Array<{ rect: Rect; fn: () => void }> = [];
  if (tabs.length === 0) return hits;

  const pad = Math.round(w * 0.04);
  const gap = Math.round(w * 0.02);
  const cellW = Math.round((w - pad * 2 - gap * (tabs.length - 1)) / tabs.length);

  tabs.forEach((tab, i) => {
    const x = pad + i * (cellW + gap);
    const box = sketchPanel(cellW, stripH, {
      fill: tab.active ? C.dark : C.paper,
      border: tab.active ? C.accent : C.line,
      width: tab.active ? 2.4 : 1.6,
      seed: seedFor(x, y, cellW),
    });
    box.x = x; box.y = y;
    container.addChild(box);

    const lbl = txt(tab.label, Math.round(stripH * 0.42), tab.active ? 0xffffff : C.mid, true);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = x + cellW / 2;
    lbl.y = y + stripH / 2;
    container.addChild(lbl);

    if (!tab.active) {
      hits.push({ rect: { x, y, w: cellW, h: stripH }, fn: () => onSelect(i) });
    }
  });

  return hits;
}
