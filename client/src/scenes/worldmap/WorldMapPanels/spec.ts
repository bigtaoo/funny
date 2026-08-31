// Shared layout spec for the world-map modal panels (shop / territory / replay / tile actions).
//
// Why this file exists (2026-08-30 SLG panel audit): every other shared component in the game has
// been through an enlargement pass at some point — `confirmDialog` ("1.5x the original hand-tuned
// sizes"), `showModal` ("1.5× the original footprint"), the world HUD's chips ("2x the original
// 88x34 footprint"), `SceneHeader.backSize` ("1.5x the original 0.026") — but these four panels
// were never in any of them. They still carried their first-draft numbers: FS.tiny (13px) titles
// against a 1080-wide design space where a scene title is >= FS.headline (42px), 11px button
// labels in 26px-tall bands against UI_DESIGN.md §1's ">= ~80px hit area" rule, and four panel
// widths (440 / 560 / 840 / 900) picked independently with no common grid.
//
// The numbers below are that missing pass, in one place so the four panels cannot drift apart
// again. They are design px in the 1080-space both layouts render into (see fontScale.ts), which
// is also the space `WorldMapContext.w/h` is in — no per-panel scaling is involved, unlike
// CityScene's modals (see CityScene/helpers.ts `modalScaleFor`).
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, seedFor } from '../../../render/sketchUi';
import { SketchPen } from '../../../render/sketch';
import { FS } from '../../../render/fontScale';

/**
 * Modal panel width tiers. Every world-map modal picks one of these three rather than a private
 * constant; callers still clamp to the viewport (`Math.min(tier, w - PANEL_MARGIN * 2)`) because
 * portrait's design width is only 1080.
 *
 * - `sm` — a single-column list (recent sieges).
 * - `md` — a card grid, or a text+buttons dialog (`showModal`; unchanged at 900, so the tile-action
 *   modal keeps the footprint it was already tuned to).
 * - `lg` — a tabbed, data-dense panel (territory overview / list / world).
 */
export const PANEL_W = { sm: 720, md: 900, lg: 1000 } as const;

/** Viewport inset a panel keeps on each side when the tier above would overflow. */
export const PANEL_MARGIN = 16;

/** Inner padding from the panel edge to its content. */
export const PANEL_PAD = 20;

/** Panel heading — matches SceneHeader's paper-variant title (dark ink, not the blue accent). */
export const PANEL_TITLE_FONT = FS.heading;

/** Height of the title band, i.e. the y-offset from the panel top to where the body starts. */
export const PANEL_HEADER_H = 64;

/** Standard button height inside a panel, and the label font that fills it. */
export const PANEL_BTN_H = 56;
export const PANEL_BTN_FONT = FS.body;

/** Width of the footer Close button, and the band reserved for it along the panel bottom. */
export const PANEL_CLOSE_W = 200;
export const PANEL_FOOTER_H = PANEL_BTN_H + PANEL_PAD;

/** Tab-strip cell height for a tabbed panel. */
export const PANEL_TAB_H = 56;

/** Row height for the panels' scroll lists, and the inline row-action button size. */
export const PANEL_ROW_H = 64;
export const PANEL_ROW_BTN_W = 120;
export const PANEL_ROW_BTN_H = 48;

/**
 * Draw a panel heading: centred dark title plus the thin accent rule underneath it, the same
 * "fill stays paper, the category cue is a 2px accent line" treatment `SceneHeader` uses for every
 * scene title bar (UI_DESIGN.md §3.1, 顶栏统一 2026-07-07). Before this the three panels each drew
 * a bare FS.tiny title in C.accent, which is why they read as a different visual family from every
 * full scene behind them.
 *
 * @returns the y at which the panel body should start.
 */
export function drawPanelTitle(
  ml: PIXI.Container,
  title: string,
  px: number,
  py: number,
  pw: number
): number {
  const lbl = txt(title, PANEL_TITLE_FONT, C.dark, true);
  lbl.anchor.set(0.5, 0);
  lbl.x = px + pw / 2;
  lbl.y = py + 14;
  ml.addChild(lbl);

  const rule = new PIXI.Graphics();
  new SketchPen(rule, seedFor(3, 3, pw)).line(
    px + PANEL_PAD,
    py + PANEL_HEADER_H,
    px + pw - PANEL_PAD,
    py + PANEL_HEADER_H,
    { color: C.accent, width: 2, jitter: 0.6 }
  );
  ml.addChild(rule);

  return py + PANEL_HEADER_H + PANEL_PAD;
}
