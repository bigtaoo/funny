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
import { buildIcon, type IconKind } from '../../render/icons';

export interface HubTab {
  label: string;
  /** The current page — drawn highlighted and not tappable. */
  active: boolean;
  /**
   * Optional hand-drawn glyph shown left of the label (art-direction: tab icons
   * as a standard convention — see LOBBY_IA_REDESIGN P1.5). Tinted to match the
   * label (white when active, mid when inactive).
   */
  icon?: IconKind;
}

/** Standard strip height — a prominent tab bar, roughly on par with the header. */
export function hubTabsHeight(h: number): number {
  return Math.round(h * 0.066);
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

    const fg = tab.active ? 0xffffff : C.mid;
    const lbl = txt(tab.label, Math.round(stripH * 0.42), fg, true);
    lbl.anchor.set(0.5, 0.5);
    lbl.y = y + stripH / 2;

    if (tab.icon) {
      // Icon + label as one centred group: [icon][gap][label].
      const iconSize = Math.round(stripH * 0.6);
      const gapIL = Math.round(stripH * 0.16);
      const groupW = iconSize + gapIL + lbl.width;
      const gx = x + (cellW - groupW) / 2;
      const icon = buildIcon(tab.icon, iconSize, fg);
      icon.x = gx;
      icon.y = y + (stripH - iconSize) / 2;
      container.addChild(icon);
      lbl.x = gx + iconSize + gapIL + lbl.width / 2;
    } else {
      lbl.x = x + cellW / 2;
    }
    container.addChild(lbl);

    if (!tab.active) {
      hits.push({ rect: { x, y, w: cellW, h: stripH }, fn: () => onSelect(i) });
    }
  });

  return hits;
}

/** Height of one vertical sidebar nav cell (see {@link drawSidebarTabs}). */
export function sidebarItemHeight(h: number): number {
  return Math.round(h * 0.09);
}

/**
 * Draw a vertical stack of nav cells inside the left notebook-margin gutter
 * (width = `marginLineX(w)` from `render/sketchUi`) — a left-rail counterpart
 * to {@link drawHubTabs} for groups where a horizontal strip would otherwise
 * have to squeeze into that narrow gutter (CardScene/EquipmentScene sidebar
 * nav; see LOBBY_IA_REDESIGN.md §8 sidebar addendum).
 *
 * Cells stack top-to-bottom starting at `y`, each `sidebarItemHeight(h)` tall
 * with a small gap; icon-over-label layout mirrors the bottom lobby nav
 * convention. Returns hit rects for inactive (tappable) cells plus the y just
 * below the last cell, so callers can stack further sidebar content beneath
 * (e.g. EquipmentScene's Inventory/Craft sub-tabs).
 */
export function drawSidebarTabs(
  container: PIXI.Container,
  sidebarW: number,
  y: number,
  h: number,
  tabs: HubTab[],
  onSelect: (index: number) => void,
): { hits: Array<{ rect: Rect; fn: () => void }>; bottom: number } {
  const hits: Array<{ rect: Rect; fn: () => void }> = [];
  if (tabs.length === 0) return { hits, bottom: y };

  const itemH = sidebarItemHeight(h);
  const gap = Math.round(h * 0.015);
  let cy = y;

  tabs.forEach((tab, i) => {
    const box = sketchPanel(sidebarW, itemH, {
      fill: tab.active ? C.dark : C.paper,
      border: tab.active ? C.accent : C.line,
      width: tab.active ? 2.4 : 1.6,
      seed: seedFor(0, cy, sidebarW),
    });
    box.x = 0; box.y = cy;
    container.addChild(box);

    const fg = tab.active ? 0xffffff : C.mid;
    const lbl = txt(tab.label, Math.round(itemH * 0.24), fg, true);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = sidebarW / 2;

    if (tab.icon) {
      const iconSize = Math.round(itemH * 0.34);
      const icon = buildIcon(tab.icon, iconSize, fg);
      icon.x = sidebarW / 2 - iconSize / 2;
      icon.y = cy + itemH * 0.2;
      container.addChild(icon);
      lbl.y = cy + itemH * 0.72;
    } else {
      lbl.y = cy + itemH / 2;
    }
    container.addChild(lbl);

    if (!tab.active) {
      hits.push({ rect: { x: 0, y: cy, w: sidebarW, h: itemH }, fn: () => onSelect(i) });
    }
    cy += itemH + gap;
  });

  return { hits, bottom: cy - gap };
}
