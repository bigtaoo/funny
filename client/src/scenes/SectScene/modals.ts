// Modal overlays: the sect picker (browse / ally / manage-allies) and the generic OK/cancel confirm.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchButton, seedFor, tearDownChildren } from '../../render/sketchUi';
import { drawConfirmDialog } from '../../render/confirmDialog';
import type { SectView } from '../../net/WorldApiClient';
import { type Constructor, type SectSceneBaseCtor } from './base';
import { FS } from '../../render/fontScale';

export interface ModalsHandlers {
  showSectPickModal(sects: SectView[], onPick: (sectId: string) => void, emptyKey: 'sect.noSects' | 'sect.noAllies'): void;
  showConfirm(msg: string, onOk: () => void): void;
}

export function ModalsMixin<TBase extends SectSceneBaseCtor>(Base: TBase): TBase & Constructor<ModalsHandlers> {
  return class extends Base {
    showSectPickModal(sects: SectView[], onPick: (sectId: string) => void, emptyKey: 'sect.noSects' | 'sect.noAllies'): void {
      const { w, h } = this;
      const ml = this.modalLayer;
      tearDownChildren(ml);
      this.modalHits = [];
      this.modalOpen = true;

      const mw = Math.min(320, w - 32);
      const mh = Math.min(320, h - 80);
      const mx = (w - mw) / 2;
      const my = (h - mh) / 2;

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeModal() });

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
      for (const s of sects.slice(0, 6)) {
        const row = sketchPanel(mw - 16, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 16) });
        row.x = mx + 8; row.y = cy;
        ml.addChild(row);
        const lbl = txt(`[${s.tag}] ${s.name} (${s.memberFamilyCount})`, FS.tiny, C.dark);
        lbl.x = mx + 14; lbl.y = cy + 10;
        ml.addChild(lbl);
        const sid = s.sectId;
        this.modalHits.push({ rect: { x: mx + 8, y: cy, w: mw - 16, h: 36 }, action: () => onPick(sid) });
        cy += 40;
      }
    }

    showConfirm(msg: string, onOk: () => void): void {
      this.modalOpen = true;
      this.modalHits = drawConfirmDialog(this.modalLayer, this.w, this.h, msg, onOk, () => this.closeModal());
    }
  };
}
