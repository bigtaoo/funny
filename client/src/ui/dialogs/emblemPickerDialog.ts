/**
 * emblemPickerDialog.ts — the shared family/sect emblem-picker modal (family-emblem-art-prompts.md,
 * 2026-08-14): a 24-icon grid (EMBLEM_KEYS) + an 8-swatch accent-colour row (EMBLEM_COLORS) +
 * Confirm/Cancel, tinting the live preview as the player taps around before committing.
 *
 * Unlike confirmDialog.ts (draw once, hand back hit rects, done), this dialog is interactive across
 * multiple taps before the final Confirm — every tap (pick an icon, pick a colour) needs to redraw
 * the same modal with the new selection highlighted. So the caller (FamilyScene/SectScene's
 * ActionsPanel) owns the in-progress `EmblemPickerState` + a `busy` flag (true while the Confirm POST
 * is in flight) and re-invokes `drawEmblemPickerDialog` after every interaction — mirrors
 * FamilyScene/actions.ts's showJoinRequestsModal pattern, which redraws itself the same way.
 */
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, sketchButton, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { t } from '../../i18n/index';
import { EMBLEM_KEYS, EMBLEM_COLORS, type EmblemKey, buildEmblemIcon, isEmblemAtlasReady } from '../../render/emblemIcon';

export interface Rect { x: number; y: number; w: number; h: number; }
export interface ModalHit { rect: Rect; action: () => void; }

export interface EmblemPickerState {
  key: EmblemKey;
  color: number;
}

const GRID_COLS = 6;
const CELL_GAP = 10;
const SWATCH_D = 30;
const SWATCH_GAP = 14;

/**
 * Draws the picker into `ml` and returns its hit rects. `state` is the in-progress pick (mutated by
 * the caller in `onPick`/`onPickColor`, then this function is called again to redraw); `busy` greys
 * the Confirm button while the caller's actual setEmblem POST is in flight.
 */
export function drawEmblemPickerDialog(
  ml: PIXI.Container, w: number, h: number,
  state: EmblemPickerState, busy: boolean,
  onPick: (key: EmblemKey) => void,
  onPickColor: (color: number) => void,
  onConfirm: () => void,
  onCancel: () => void,
): ModalHit[] {
  tearDownChildren(ml);
  const hits: ModalHit[] = [];

  const mw = Math.min(600, w - 60);
  const cell = Math.floor((mw - 48 - (GRID_COLS - 1) * CELL_GAP) / GRID_COLS);
  const rows = Math.ceil(EMBLEM_KEYS.length / GRID_COLS);
  const gridH = rows * cell + (rows - 1) * CELL_GAP;
  const titleH = 44;
  const colorRowH = SWATCH_D + 20;
  const btnH = 42;
  const pad = 24;
  const mh = Math.min(h - 60, titleH + gridH + 20 + colorRowH + 20 + btnH + pad * 2);
  const mx = (w - mw) / 2;
  const my = (h - mh) / 2;

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
  ml.addChild(dim);
  hits.push({ rect: { x: 0, y: 0, w, h }, action: onCancel });

  const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
  panel.x = mx; panel.y = my;
  ml.addChild(panel);

  const title = txt(t('emblem.pick'), FS.heading, C.dark, true);
  title.anchor.set(0.5, 0); title.x = mx + mw / 2; title.y = my + pad - 4;
  ml.addChild(title);

  // 6×4 icon grid, tinted with the currently-picked colour so the preview matches what Confirm
  // will actually save. Atlas not decoded yet → a flat tinted square placeholder per cell (still
  // tappable) instead of leaving the grid blank; the caller kicks off loadEmblemAtlas() and redraws
  // once it resolves (see openEmblemPicker in actions.ts).
  const gridX = mx + (mw - (GRID_COLS * cell + (GRID_COLS - 1) * CELL_GAP)) / 2;
  const gridY = my + pad + titleH;
  const atlasReady = isEmblemAtlasReady();
  EMBLEM_KEYS.forEach((key, i) => {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    const cx = gridX + col * (cell + CELL_GAP);
    const cy = gridY + row * (cell + CELL_GAP);
    const selected = key === state.key;

    const cellBg = sketchPanel(cell, cell, {
      fill: selected ? 0xfff3d6 : 0xfaf9f5, border: selected ? C.accent : C.mid,
      width: selected ? 2.4 : 1.4, seed: seedFor(row, col, cell),
    });
    cellBg.x = cx; cellBg.y = cy;
    ml.addChild(cellBg);

    const iconSize = Math.round(cell * 0.62);
    const iconX = cx + (cell - iconSize) / 2;
    const iconY = cy + (cell - iconSize) / 2;
    if (atlasReady) {
      const icon = buildEmblemIcon(key, iconSize, state.color);
      if (icon) { icon.x = iconX; icon.y = iconY; ml.addChild(icon); }
    } else {
      const ph = new PIXI.Graphics();
      ph.beginFill(state.color, 0.55).drawRoundedRect(0, 0, iconSize, iconSize, 4).endFill();
      ph.x = iconX; ph.y = iconY;
      ml.addChild(ph);
    }
    hits.push({ rect: { x: cx, y: cy, w: cell, h: cell }, action: () => onPick(key) });
  });

  // Accent-colour swatch row.
  const swatchesW = EMBLEM_COLORS.length * SWATCH_D + (EMBLEM_COLORS.length - 1) * SWATCH_GAP;
  const swatchY = gridY + gridH + 20 + SWATCH_D / 2;
  let swatchX = mx + (mw - swatchesW) / 2 + SWATCH_D / 2;
  for (const color of EMBLEM_COLORS) {
    const selected = color === state.color;
    if (selected) {
      const ring = new PIXI.Graphics();
      ring.lineStyle(2.4, C.accent, 1);
      ring.drawCircle(swatchX, swatchY, SWATCH_D / 2 + 4);
      ml.addChild(ring);
    }
    const dot = new PIXI.Graphics();
    dot.lineStyle(1, C.dark, 0.5);
    dot.beginFill(color).drawCircle(swatchX, swatchY, SWATCH_D / 2).endFill();
    ml.addChild(dot);
    const sx = swatchX, sy = swatchY;
    hits.push({ rect: { x: sx - SWATCH_D / 2, y: sy - SWATCH_D / 2, w: SWATCH_D, h: SWATCH_D }, action: () => onPickColor(color) });
    swatchX += SWATCH_D + SWATCH_GAP;
  }

  // Confirm / Cancel, same bottom-bar convention as confirmDialog.ts.
  const btnW = 126, btnGapHalf = 12;
  const btnY = my + mh - pad - btnH;
  const confirmBtn = busy
    ? sketchPanel(btnW, btnH, { fill: C.btnOff, border: C.mid, seed: seedFor(0, 1, btnW) })
    : sketchButton(btnW, btnH, seedFor(0, 1, btnW));
  confirmBtn.x = mx + mw / 2 - btnGapHalf - btnW; confirmBtn.y = btnY;
  ml.addChild(confirmBtn);
  const cl = txt(t('common.ok'), FS.bodyLg, busy ? C.mid : C.light, true);
  cl.anchor.set(0.5, 0.5); cl.x = confirmBtn.x + btnW / 2; cl.y = btnY + btnH / 2;
  ml.addChild(cl);
  if (!busy) hits.push({ rect: { x: confirmBtn.x, y: btnY, w: btnW, h: btnH }, action: onConfirm });

  const cancelBtn = sketchPanel(btnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 2, btnW) });
  cancelBtn.x = mx + mw / 2 + btnGapHalf; cancelBtn.y = btnY;
  ml.addChild(cancelBtn);
  const xl = txt(t('common.cancel'), FS.bodyLg, C.dark);
  xl.anchor.set(0.5, 0.5); xl.x = cancelBtn.x + btnW / 2; xl.y = btnY + btnH / 2;
  ml.addChild(xl);
  hits.push({ rect: { x: cancelBtn.x, y: btnY, w: btnW, h: btnH }, action: onCancel });

  return hits;
}
