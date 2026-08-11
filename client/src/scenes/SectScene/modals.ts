// Modal overlays: the sect picker (browse / ally / manage-allies) and the generic OK/cancel confirm.
//
// ModalsPanel has no dependency on any other domain class — Actions depends on IT (2026-08-11
// converted from the former `XMixin(Base)` inheritance chain to an independent class over `core`,
// per claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { drawConfirmDialog } from '../../ui/dialogs/confirmDialog';
import type { SectView } from '../../net/WorldApiClient';
import { FS } from '../../render/fontScale';
import type { SectSceneCore } from './core';

export interface ModalsHandlers {
  showSectPickModal(sects: SectView[], onPick: (sectId: string) => void, emptyKey: 'sect.noSects' | 'sect.noAllies', readOnly?: boolean): void;
  showConfirm(msg: string, onOk: () => void): void;
}

export class ModalsPanel implements ModalsHandlers {
  constructor(private readonly core: SectSceneCore) {}

  showSectPickModal(sects: SectView[], onPick: (sectId: string) => void, emptyKey: 'sect.noSects' | 'sect.noAllies', readOnly = false): void {
    const core = this.core;
    const { w, h } = core;
    const ml = core.modalLayer;
    tearDownChildren(ml);
    core.modalHits = [];
    core.modalOpen = true;

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
      const lbl = txt(t(emptyKey), FS.tiny, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
      ml.addChild(lbl);
      return;
    }

    let cy = my + 10;
    const maxRows = Math.max(6, Math.floor((mh - 20) / 40));
    for (const s of sects.slice(0, maxRows)) {
      const row = sketchPanel(mw - 16, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 16) });
      row.x = mx + 8; row.y = cy;
      ml.addChild(row);
      const lbl = txt(`[${s.tag}] ${s.name} (${s.memberFamilyCount})`, FS.tiny, C.dark);
      lbl.x = mx + 14; lbl.y = cy + 10;
      ml.addChild(lbl);
      const sid = s.sectId;
      // Read-only view (member-facing allies list) registers no row hit — rows are display-only.
      if (!readOnly) core.modalHits.push({ rect: { x: mx + 8, y: cy, w: mw - 16, h: 36 }, action: () => onPick(sid) });
      cy += 40;
    }
  }

  showConfirm(msg: string, onOk: () => void): void {
    const core = this.core;
    core.modalOpen = true;
    core.modalHits = drawConfirmDialog(core.modalLayer, core.w, core.h, msg, onOk, () => core.closeModal());
  }
}
