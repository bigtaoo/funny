// Modal overlays: the sect picker (browse / ally / manage-allies) and the generic OK/cancel confirm.
//
// ModalsPanel has no dependency on any other domain class — Actions depends on IT (2026-08-11
// converted from the former `XMixin(Base)` inheritance chain to an independent class over `core`,
// per claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { drawConfirmDialog } from '../../ui/dialogs/confirmDialog';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { scrollRegionLayer } from '../../ui/widgets/scrollRegionLayer';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import type { SectView } from '../../net/WorldApiClient';
import { FS } from '../../render/fontScale';
import type { SectSceneCore } from './core';

/** Row pitch of the picker list (row box + gap). */
const PICK_ROW = 40;
const PICK_ROW_H = 36;

export interface ModalsHandlers {
  showSectPickModal(
    sects: SectView[], onPick: (sectId: string) => void,
    emptyKey: 'sect.noSects' | 'sect.noAllies', readOnly?: boolean,
    opts?: { keepScroll?: boolean },
  ): void;
  showConfirm(msg: string, onOk: () => void): void;
}

export class ModalsPanel implements ModalsHandlers {
  constructor(private readonly core: SectSceneCore) {}

  /**
   * The browse / ally / manage-allies / allies-view list.
   *
   * @param opts.keepScroll Redraw of an already-open modal (the cheap-scroll fallback, a busy-state
   *   repaint) rather than a fresh open — keeps the reader where they were instead of jumping to the
   *   top. Fresh opens leave it unset.
   */
  showSectPickModal(
    sects: SectView[], onPick: (sectId: string) => void,
    emptyKey: 'sect.noSects' | 'sect.noAllies', readOnly = false,
    opts?: { keepScroll?: boolean },
  ): void {
    const core = this.core;
    const { w, h } = core;
    const ml = core.modalLayer;
    tearDownChildren(ml);
    core.modalHits = [];
    core.modalOpen = true;
    if (!opts?.keepScroll) core.modalScrollY = 0;
    // Every redraw of this modal — including the cheap-scroll fallback in ./repaint.ts — comes back
    // through here with the same arguments, since modalLayer is outside render()'s tree.
    core.modalRedraw = () => this.showSectPickModal(sects, onPick, emptyKey, readOnly, { keepScroll: true });

    // Doubled from the original 320×320 cap — this one modal already backs both the ally-list
    // and manage-allies dialogs (and the sect browse list), so enlarging it here covers all three.
    const mw = Math.min(640, w - 32);
    const mh = Math.min(640, h - 80);
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    core.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => core.closeModal() });

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    if (sects.length === 0) {
      core.modalMax = 0;
      const lbl = txt(t(emptyKey), FS.tiny, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
      ml.addChild(lbl);
      return;
    }

    // The list scrolls (2026-08-25). It used to be `sects.slice(0, maxRows)`: everything past the
    // modal's height was unreachable, with nothing on screen saying so — on a populated shard the
    // browse dialog could only ever offer the first handful of sects.
    const listTop = my + 10;
    const contentH = sects.length * PICK_ROW;
    const viewH = peekViewportH(mh - 20, PICK_ROW, contentH);
    const view = { x: mx + 8, y: listTop, w: mw - 16, h: viewH };
    core.modalMax = Math.max(0, contentH - viewH);
    core.modalRegionTop = listTop;
    core.modalRegionBottom = listTop + viewH;
    core.modalScrollY = Math.max(0, Math.min(core.modalScrollY, core.modalMax));

    const { layer } = scrollRegionLayer(ml, view);
    const over = viewH; // one viewport of pre-built rows each way, so a drag translates

    let cy = listTop - core.modalScrollY;
    for (const s of sects) {
      if (cy + PICK_ROW_H >= listTop - over && cy <= listTop + viewH + over) {
        const row = sketchPanel(mw - 16, PICK_ROW_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 16) });
        row.x = mx + 8; row.y = cy;
        layer.addChild(row);
        const lbl = txt(`[${s.tag}] ${s.name} (${s.memberFamilyCount})`, FS.tiny, C.dark);
        lbl.x = mx + 14; lbl.y = cy + 10;
        layer.addChild(lbl);
        const sid = s.sectId;
        // Read-only view (member-facing allies list) registers no row hit — rows are display-only.
        if (!readOnly) {
          core.modalHits.push({ rect: { x: mx + 8, y: cy, w: mw - 16, h: PICK_ROW_H }, action: () => onPick(sid), scroll: 'modal' });
        }
      }
      cy += PICK_ROW;
    }

    const bar = drawScrollIndicator(ml, view, core.modalScrollY, core.modalMax);
    core.repaint.register('modal', { layer, key: 'modalScrollY', view, max: core.modalMax, bar });
  }

  showConfirm(msg: string, onOk: () => void): void {
    const core = this.core;
    core.modalOpen = true;
    core.modalHits = drawConfirmDialog(core.modalLayer, core.w, core.h, msg, onOk, () => core.closeModal());
  }
}
