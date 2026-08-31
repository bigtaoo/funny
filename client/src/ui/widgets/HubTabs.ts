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
import { snapFont } from '../../render/fontScale';

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
  /** Small red dot pinned to the cell's top-right corner — a claimable reward lives behind this tab. */
  badge?: boolean;
}

/** Standard strip height — a prominent tab bar, roughly on par with the header. */
export function hubTabsHeight(h: number): number {
  return Math.round(h * 0.066);
}

/**
 * Draw the group tab strip at (0, y) spanning the full width, height stripH — or, with `opts`,
 * inside an arbitrary x-range (see the parameter's own note).
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
  /**
   * Optional placement overrides for callers that are NOT the full-width, below-the-header case
   * this strip was written for. The world-map territory panel draws the same strip inside a
   * centred modal panel (2026-08-30 SLG widget pass), where the strip has to start at the panel's
   * left edge and use the panel's own inner padding rather than a fraction of the screen width:
   * `drawHubTabs(ml, pw, tabY, PANEL_TAB_H, tabs, cb, { x: px, pad: PANEL_PAD, gap: MARGIN })`.
   * All defaults reproduce the previous behaviour exactly, so the ~30 existing full-width call
   * sites are unaffected.
   */
  opts?: { x?: number; pad?: number; gap?: number },
): Array<{ rect: Rect; fn: () => void }> {
  const hits: Array<{ rect: Rect; fn: () => void }> = [];
  if (tabs.length === 0) return hits;

  const originX = opts?.x ?? 0;
  const pad = opts?.pad ?? Math.round(w * 0.04);
  const gap = opts?.gap ?? Math.round(w * 0.02);
  const cellW = Math.round((w - pad * 2 - gap * (tabs.length - 1)) / tabs.length);

  tabs.forEach((tab, i) => {
    const x = originX + pad + i * (cellW + gap);
    const box = sketchPanel(cellW, stripH, {
      fill: tab.active ? C.dark : C.paper,
      border: tab.active ? C.accent : C.line,
      width: tab.active ? 2.4 : 1.6,
      seed: seedFor(x, y, cellW),
    });
    box.x = x; box.y = y;
    container.addChild(box);

    const fg = tab.active ? 0xffffff : C.mid;
    const lbl = txt(tab.label, snapFont(Math.round(stripH * 0.42)), fg, true);
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

    if (tab.badge) {
      const r = Math.round(stripH * 0.09);
      const dot = new PIXI.Graphics();
      dot.beginFill(C.red);
      dot.lineStyle(Math.max(1, Math.round(r * 0.5)), 0xffffff, 0.9);
      dot.drawCircle(x + cellW - r, y + r, r);
      dot.endFill();
      container.addChild(dot);
    }

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
 * Width of the vertical sidebar nav rail (see {@link drawSidebarTabs}).
 *
 * The rail used to reuse the narrow notebook-margin gutter (`marginLineX`, 9% of
 * width). At portrait scale (~0.35) that gutter is only ~34 CSS px, far too
 * narrow for horizontal labels like "Hero Roster"/"Equipment" — they overflowed
 * the cell and were clipped off the left screen edge. This widens the rail to a
 * fifth of the width so the icon-over-label cells fit legibly; callers start body
 * content at `sidebarNavW(w, h, landscape)` instead of `marginLineX(w)` when the
 * rail is shown.
 *
 * `designWidth`/`designHeight` swap meaning between orientations (portrait:
 * 1080x1920, landscape: 1920x1080 — see ILayout), so pegging the rail to a flat
 * 20% of `w` made it 216px in portrait but 384px in landscape — nearly double
 * width for the same two-line labels, crowding out the body content. The rail's
 * ideal width is a property of the phone's physical short edge, not of whichever
 * design axis currently happens to be called "width", so landscape must read off
 * `h` (1080, the short edge there) instead of `w` (1920, the long edge).
 */
export function sidebarNavW(w: number, h: number, landscape: boolean): number {
  return landscape ? Math.round(h * 0.2) : Math.round(w * 0.2);
}

/**
 * Height of the portrait bottom nav bar (see {@link drawBottomNavTabs}) — the
 * portrait counterpart to `sidebarNavW`'s left rail (LOBBY_IA_REDESIGN.md §18:
 * portrait replaces the left rail with a bottom bar, since portrait's short
 * edge is the whole screen width and a left rail there eats too much of it).
 * Reuses `sidebarItemHeight`'s scale directly — that constant already tunes
 * the icon/label sizing for one nav cell; a bottom bar is the same cell
 * content, just laid out horizontally instead of stacked.
 */
export function bottomNavH(h: number): number {
  return sidebarItemHeight(h);
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
  /**
   * `sub: true` demotes this stack to a second-tier group nested under the primary tabs above it
   * (e.g. Inventory/Craft under the [Cards|Equipment] peer nav): smaller cells, indented from the
   * left edge, so it visually reads as "belongs to" rather than a sibling of equal weight.
   *
   * `activeTappable: true` also emits a hit rect for the currently-active cell (normally the active
   * cell is a no-op with no rect). Needed by rails where re-tapping the active tab means something —
   * e.g. the social rail backs out of a drilled-in detail view (an open mail) to that tab's list.
   */
  opts?: { sub?: boolean; activeTappable?: boolean },
): { hits: Array<{ rect: Rect; fn: () => void }>; bottom: number } {
  const hits: Array<{ rect: Rect; fn: () => void }> = [];
  if (tabs.length === 0) return { hits, bottom: y };

  const sub = opts?.sub ?? false;
  const indent = sub ? Math.round(sidebarW * 0.14) : 0;
  const cellW = sidebarW - indent;
  const itemH = Math.round(sidebarItemHeight(h) * (sub ? 0.76 : 1));
  const gap = Math.round(h * 0.015);
  let cy = y;

  tabs.forEach((tab, i) => {
    const box = sketchPanel(cellW, itemH, {
      fill: tab.active ? C.dark : C.paper,
      border: tab.active ? C.accent : C.line,
      width: tab.active ? 2.4 : 1.6,
      seed: seedFor(0, cy, cellW),
    });
    box.x = indent; box.y = cy;
    container.addChild(box);

    const fg = tab.active ? 0xffffff : C.mid;
    const lbl = txt(tab.label, snapFont(Math.round(itemH * (sub ? 0.28 : 0.24))), fg, true);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = indent + cellW / 2;
    // Never let a long label ("Hero Roster") spill past the cell and clip off the
    // screen edge: shrink it to fit the cell width (with a small horizontal pad).
    const maxLblW = cellW - Math.round(cellW * 0.14);
    if (lbl.width > maxLblW) lbl.scale.set(maxLblW / lbl.width);

    if (tab.icon) {
      const iconSize = Math.round(itemH * 0.34);
      const icon = buildIcon(tab.icon, iconSize, fg);
      icon.x = indent + cellW / 2 - iconSize / 2;
      icon.y = cy + itemH * 0.2;
      container.addChild(icon);
      lbl.y = cy + itemH * 0.72;
    } else {
      lbl.y = cy + itemH / 2;
    }
    container.addChild(lbl);

    if (tab.badge) {
      const r = Math.round(itemH * 0.1);
      const dot = new PIXI.Graphics();
      dot.beginFill(C.red);
      dot.lineStyle(Math.max(1, Math.round(r * 0.5)), 0xffffff, 0.9);
      dot.drawCircle(indent + cellW - r, cy + r, r);
      dot.endFill();
      container.addChild(dot);
    }

    if (!tab.active || opts?.activeTappable) {
      hits.push({ rect: { x: indent, y: cy, w: cellW, h: itemH }, fn: () => onSelect(i) });
    }
    cy += itemH + gap;
  });

  return { hits, bottom: cy - gap };
}

/**
 * Draw a horizontal row of nav cells spanning the full width at the bottom of
 * the screen — the portrait counterpart to {@link drawSidebarTabs} (LOBBY_IA_REDESIGN.md
 * §18). Cell content (icon over label, top-right badge dot) is the same as one
 * `drawSidebarTabs` cell, just laid out left-to-right across `w` instead of
 * stacked top-to-bottom down a rail; sizing/spacing mirrors {@link drawHubTabs}'s
 * equal-width-cell math so the two horizontal strips (this one at the bottom,
 * `drawHubTabs` for in-scene sub-tabs) read as the same visual family.
 *
 * Deliberately kept flat (no `sub`/nesting support, no `.bottom` chaining):
 * a portrait screen has exactly one bottom nav bar, so scenes that used to
 * stack two `drawSidebarTabs` groups down the left rail move their second
 * (nested) group to a `drawHubTabs` strip under the header instead — see the
 * per-scene conversion notes in LOBBY_IA_REDESIGN.md §18.
 */
export function drawBottomNavTabs(
  container: PIXI.Container,
  w: number,
  y: number,
  barH: number,
  tabs: HubTab[],
  onSelect: (index: number) => void,
  opts?: { activeTappable?: boolean },
): { hits: Array<{ rect: Rect; fn: () => void }> } {
  const hits: Array<{ rect: Rect; fn: () => void }> = [];
  if (tabs.length === 0) return { hits };

  // Full-width backing strip drawn first: without it the pad/gap slivers around and between the
  // individual tab cell panels below were transparent, letting scrolled body content (or the bare
  // paper background) show through right up to the screen's bottom edge — reading as a see-through
  // bar rather than a solid nav bar docked to the bottom of the screen (2026-08-09 fix). Fill is
  // `C.dark` (not `C.paper`, LobbyScene's own bottom nav convention — build.ts's `navBg` — uses the
  // same dark-cover-at-0.9-alpha look): `C.paper` (0xfaf6ee) sits almost on top of the page bg
  // (0xf5f0e8), so the strip was there but unreadable as a bar. Individual cells still draw their own
  // lighter paper-fill panels on top for inactive tabs, reading as cards docked on a dark shelf.
  const bg = new PIXI.Graphics();
  bg.beginFill(C.dark, 0.92).drawRect(0, y, w, barH).endFill();
  container.addChild(bg);

  const pad = Math.round(w * 0.02);
  const gap = Math.round(w * 0.015);
  const cellW = Math.round((w - pad * 2 - gap * (tabs.length - 1)) / tabs.length);

  tabs.forEach((tab, i) => {
    const x = pad + i * (cellW + gap);
    const box = sketchPanel(cellW, barH, {
      fill: tab.active ? C.dark : C.paper,
      border: tab.active ? C.accent : C.line,
      width: tab.active ? 2.4 : 1.6,
      seed: seedFor(x, y, cellW),
    });
    box.x = x; box.y = y;
    container.addChild(box);

    const fg = tab.active ? 0xffffff : C.mid;
    const lbl = txt(tab.label, snapFont(Math.round(barH * 0.24)), fg, true);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = x + cellW / 2;
    const maxLblW = cellW - Math.round(cellW * 0.14);
    if (lbl.width > maxLblW) lbl.scale.set(maxLblW / lbl.width);

    if (tab.icon) {
      const iconSize = Math.round(barH * 0.34);
      const icon = buildIcon(tab.icon, iconSize, fg);
      icon.x = x + cellW / 2 - iconSize / 2;
      icon.y = y + barH * 0.2;
      container.addChild(icon);
      lbl.y = y + barH * 0.72;
    } else {
      lbl.y = y + barH / 2;
    }
    container.addChild(lbl);

    if (tab.badge) {
      const r = Math.round(barH * 0.1);
      const dot = new PIXI.Graphics();
      dot.beginFill(C.red);
      dot.lineStyle(Math.max(1, Math.round(r * 0.5)), 0xffffff, 0.9);
      dot.drawCircle(x + cellW - r, y + r, r);
      dot.endFill();
      container.addChild(dot);
    }

    if (!tab.active || opts?.activeTappable) {
      hits.push({ rect: { x, y, w: cellW, h: barH }, fn: () => onSelect(i) });
    }
  });

  return { hits };
}
