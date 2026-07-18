/**
 * confirmDialog.ts — the single shared OK/Cancel confirm modal.
 *
 * Before this, FamilyScene, EquipmentScene and SectScene each carried their own
 * copy-pasted `showConfirm` with drifted panel sizes (280×110 / 300×130 / 300×120),
 * a mix of hardcoded `'OK'` text and `t('equip.ok')`, and an inconsistent Cancel
 * button (text in Equipment, a ✕ icon in Family/Sect). This module draws the one
 * dialog every scene should use; each scene keeps its own modalLayer/modalHits/
 * closeModal bookkeeping and just wires the returned hit rects in.
 */
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, sketchButton, seedFor, tearDownChildren } from './sketchUi';
import { FS } from './fontScale';
import { t } from '../i18n';

export interface Rect { x: number; y: number; w: number; h: number; }
export interface ModalHit { rect: Rect; action: () => void; }

// 1.5x the original hand-tuned sizes (mw 300 / mh 130 / buttons 84×28).
const MW = 450;
const MH = 195;
const BTN_W = 126;
const BTN_H = 42;
const BTN_GAP_HALF = 12;
const BTN_BOTTOM_PAD = 12;
const LABEL_TOP = 24;
const LABEL_SIDE_PAD = 36;

/**
 * Draws the confirm dialog (dim + panel + message + OK/Cancel) into `ml` and
 * returns the OK/Cancel hit rects. Caller is responsible for modalOpen/modalHits/
 * closeModal — this only draws.
 */
export function drawConfirmDialog(
  ml: PIXI.Container, w: number, h: number, msg: string,
  onOk: () => void, onCancel: () => void,
): ModalHit[] {
  tearDownChildren(ml);

  const mw = Math.min(MW, w - 60);
  const mh = MH;
  const mx = (w - mw) / 2;
  const my = (h - mh) / 2;

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
  ml.addChild(dim);

  const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
  panel.x = mx; panel.y = my;
  ml.addChild(panel);

  const lbl = txt(msg, FS.bodyLg, C.dark);
  lbl.anchor.set(0.5, 0); lbl.x = mx + mw / 2; lbl.y = my + LABEL_TOP;
  lbl.style.wordWrap = true; lbl.style.wordWrapWidth = mw - LABEL_SIDE_PAD;
  lbl.style.align = 'center';
  ml.addChild(lbl);

  const btnY = my + mh - BTN_BOTTOM_PAD - BTN_H;

  const okBtn = sketchButton(BTN_W, BTN_H, seedFor(0, 1, BTN_W));
  okBtn.x = mx + mw / 2 - BTN_GAP_HALF - BTN_W; okBtn.y = btnY;
  ml.addChild(okBtn);
  const ol = txt(t('common.ok'), FS.bodyLg, C.light, true);
  ol.anchor.set(0.5, 0.5); ol.x = okBtn.x + BTN_W / 2; ol.y = okBtn.y + BTN_H / 2;
  ml.addChild(ol);

  const caBtn = sketchPanel(BTN_W, BTN_H, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 2, BTN_W) });
  caBtn.x = mx + mw / 2 + BTN_GAP_HALF; caBtn.y = btnY;
  ml.addChild(caBtn);
  const cl = txt(t('common.cancel'), FS.bodyLg, C.dark);
  cl.anchor.set(0.5, 0.5); cl.x = caBtn.x + BTN_W / 2; cl.y = caBtn.y + BTN_H / 2;
  ml.addChild(cl);

  return [
    { rect: { x: okBtn.x, y: okBtn.y, w: BTN_W, h: BTN_H }, action: onOk },
    { rect: { x: caBtn.x, y: caBtn.y, w: BTN_W, h: BTN_H }, action: onCancel },
  ];
}
