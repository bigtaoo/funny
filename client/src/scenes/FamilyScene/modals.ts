// The family scene's two list modals: the family picker (browse / join) and the pending join-request
// approval sheet.
//
// Free functions over `core` (form ①, per claudedocs/client-modules.md's split-form priority note),
// not a domain class — both need to call back into ActionsPanel (join a family, approve/reject a
// request) while ActionsPanel is what opens them, so a class here would be a real bidirectional
// dependency for no gain. Taking the callback explicitly makes it one-way. Split out of actions.ts
// (2026-08-25) when both lists gained real scrolling, which is also what keeps actions.ts under the
// 500-line convention. SectScene's equivalent lives in its own ./SectScene/modals.ts (a class there,
// because its picker calls nothing back except the caller-supplied `onPick`).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { scrollRegionLayer } from '../../ui/widgets/scrollRegionLayer';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import type { FamilyView } from '../../net/WorldApiClient';
import type { FamilySceneCore } from './core';

/** Row pitch of the picker list (row box + gap), and the request sheet's taller rows. */
const PICK_ROW = 40;
const PICK_ROW_H = 36;
const REQ_ROW = 88;
const REQ_ROW_H = 80;

/** Shared modal chrome: dim backdrop (tap to close) + paper panel. Returns the panel's rect. */
function openModalFrame(core: FamilySceneCore, maxW: number, maxH: number): { mx: number; my: number; mw: number; mh: number } {
  const { w, h } = core;
  const ml = core.modalLayer;
  tearDownChildren(ml); // free prior modal Text (title/rows/labels) — bare removeChildren orphaned them
  core.modalHits = [];
  core.modalOpen = true;

  const mw = Math.min(maxW, w - 32);
  const mh = Math.min(maxH, h - 80);
  const mx = (w - mw) / 2;
  const my = (h - mh) / 2;

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
  ml.addChild(dim);
  core.modalHits.push({ rect: { x: 0, y: 0, w, h }, sound: 'sfx.ui.back', fn: () => core.closeModal() });

  const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
  panel.x = mx; panel.y = my;
  ml.addChild(panel);
  return { mx, my, mw, mh };
}

/**
 * Browse/join picker.
 *
 * @param keepScroll Redraw of an already-open modal (the cheap-scroll fallback in ./repaint.ts)
 *   rather than a fresh open — keeps the reader's position instead of jumping to the top.
 */
export function drawFamilyPickModal(
  core: FamilySceneCore,
  families: FamilyView[],
  onPick: (familyId: string) => void,
  keepScroll = false,
): void {
  const { mx, my, mw, mh } = openModalFrame(core, 300, 300);
  const ml = core.modalLayer;
  if (!keepScroll) core.modalScrollY = 0;
  core.modalRedraw = () => drawFamilyPickModal(core, families, onPick, true);

  if (families.length === 0) {
    core.modalMax = 0;
    const lbl = txt(t('family.noFamily'), FS.tiny, C.dark);
    lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
    ml.addChild(lbl);
    return;
  }

  // The list scrolls (2026-08-25). It used to be `families.slice(0, 6)`: on a populated shard the
  // join dialog offered six families and no way to see, or even know about, any of the others.
  const listTop = my + 10;
  const contentH = families.length * PICK_ROW;
  const viewH = peekViewportH(mh - 20, PICK_ROW, contentH);
  const view = { x: mx + 8, y: listTop, w: mw - 16, h: viewH };
  core.modalMax = Math.max(0, contentH - viewH);
  core.modalRegionTop = listTop;
  core.modalRegionBottom = listTop + viewH;
  core.modalScrollY = Math.max(0, Math.min(core.modalScrollY, core.modalMax));

  const { layer } = scrollRegionLayer(ml, view);
  const over = viewH;

  let cy = listTop - core.modalScrollY;
  for (const fam of families) {
    if (cy + PICK_ROW_H >= listTop - over && cy <= listTop + viewH + over) {
      const row = sketchPanel(mw - 16, PICK_ROW_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 16) });
      row.x = mx + 8; row.y = cy;
      layer.addChild(row);
      const lbl = txt(`[${fam.tag}] ${fam.name} (${fam.memberCount})`, FS.tiny, C.dark);
      lbl.x = mx + 14; lbl.y = cy + 10;
      layer.addChild(lbl);
      const famId = fam.familyId;
      core.modalHits.push({ rect: { x: mx + 8, y: cy, w: mw - 16, h: PICK_ROW_H }, fn: () => onPick(famId), scroll: 'modal' });
    }
    cy += PICK_ROW;
  }

  const bar = drawScrollIndicator(ml, view, core.modalScrollY, core.modalMax);
  core.repaint.register('modal', { layer, key: 'modalScrollY', view, max: core.modalMax, bar });
}

/**
 * Pending join requests, with approve/reject per row.
 *
 * 2x the size of every other confirm-style modal in this scene — approving/rejecting a join request
 * is a more consequential action (changes the roster) and was easy to miss at the old, small size
 * (user feedback 2026-07-18).
 *
 * @param keepScroll As above — also used by the in-flight repaint that greys the buttons while a
 *   response is on the wire, which otherwise scrolled the sheet back to the top mid-review.
 */
export function drawJoinRequestsModal(
  core: FamilySceneCore,
  onRespond: (requestId: string, accept: boolean) => void,
  keepScroll = false,
): void {
  const { mx, my, mw, mh } = openModalFrame(core, 680, 720);
  const ml = core.modalLayer;
  if (!keepScroll) core.modalScrollY = 0;
  core.modalRedraw = () => drawJoinRequestsModal(core, onRespond, true);

  const title = txt(t('family.pendingRequests', { n: core.joinRequests.length }), FS.heading * 2, C.dark, true);
  title.x = mx + 24; title.y = my + 20;
  ml.addChild(title);

  if (core.joinRequests.length === 0) {
    core.modalMax = 0;
    const lbl = txt(t('family.noPendingRequests'), FS.tiny * 2, C.dark);
    lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
    ml.addChild(lbl);
    return;
  }

  // Scrolls too (2026-08-25): this one never truncated, it just kept drawing rows past the panel's
  // bottom edge — with a big enough backlog the later requests were painted off the sheet (and off
  // screen) with nothing clipping them.
  const busy = core.bt.busy;
  const listTop = my + 80;
  const contentH = core.joinRequests.length * REQ_ROW;
  const viewH = peekViewportH(mh - 80 - 12, REQ_ROW, contentH);
  const view = { x: mx + 16, y: listTop, w: mw - 32, h: viewH };
  core.modalMax = Math.max(0, contentH - viewH);
  core.modalRegionTop = listTop;
  core.modalRegionBottom = listTop + viewH;
  core.modalScrollY = Math.max(0, Math.min(core.modalScrollY, core.modalMax));

  const { layer } = scrollRegionLayer(ml, view);
  const over = viewH;

  let cy = listTop - core.modalScrollY;
  for (const reqv of core.joinRequests) {
    if (cy + REQ_ROW_H < listTop - over || cy > listTop + viewH + over) { cy += REQ_ROW; continue; }
    const row = sketchPanel(mw - 32, REQ_ROW_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 32) });
    row.x = mx + 16; row.y = cy;
    layer.addChild(row);
    const nameLbl = txt(reqv.displayName ?? reqv.publicId ?? reqv.accountId, FS.tiny * 2, C.dark);
    nameLbl.x = mx + 28; nameLbl.y = cy + 24;
    layer.addChild(nameLbl);

    // Button width follows the measured label width (not a fixed literal) — locales like
    // German ("Ablehnen"/"Annehmen") run longer than English and would clip a fixed box.
    const btnH = 52, gap = 12, btnPadX = 28;
    const approveColor = busy ? C.mid : 0x2f6b2f;
    const rejectColor = busy ? C.mid : C.red;
    const al = txt(t('family.approve'), FS.label * 2, approveColor);
    const approveW = al.width + btnPadX * 2;
    const rl = txt(t('family.reject'), FS.label * 2, rejectColor);
    const rejectW = rl.width + btnPadX * 2;

    const rejectX = mx + mw - 16 - rejectW;
    const approveX = rejectX - gap - approveW;

    const approveBtn = sketchPanel(approveW, btnH, { fill: 0xe0f0e0, border: approveColor, seed: seedFor(cy, 1, approveW) });
    approveBtn.x = approveX; approveBtn.y = cy + 14;
    layer.addChild(approveBtn);
    al.anchor.set(0.5, 0.5); al.x = approveX + approveW / 2; al.y = cy + 14 + btnH / 2;
    layer.addChild(al);
    const rid = reqv.requestId;
    if (!busy) core.modalHits.push({ rect: { x: approveX, y: cy + 14, w: approveW, h: btnH }, fn: () => onRespond(rid, true), scroll: 'modal' });

    const rejectBtn = sketchPanel(rejectW, btnH, { fill: 0xf0e0e0, border: rejectColor, seed: seedFor(cy, 2, rejectW) });
    rejectBtn.x = rejectX; rejectBtn.y = cy + 14;
    layer.addChild(rejectBtn);
    rl.anchor.set(0.5, 0.5); rl.x = rejectX + rejectW / 2; rl.y = cy + 14 + btnH / 2;
    layer.addChild(rl);
    if (!busy) core.modalHits.push({ rect: { x: rejectX, y: cy + 14, w: rejectW, h: btnH }, fn: () => onRespond(rid, false), scroll: 'modal' });

    cy += REQ_ROW;
  }

  const bar = drawScrollIndicator(ml, view, core.modalScrollY, core.modalMax);
  core.repaint.register('modal', { layer, key: 'modalScrollY', view, max: core.modalMax, bar });
}
