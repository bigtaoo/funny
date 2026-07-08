// Feed flow (modal-within-modal): from the detail modal, pick eligible material cards (same faction,
// unlocked, not deployed) via a multi-select panel, then confirm → doFeed().
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import type { CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS } from '../../game/meta/cardDefs';
import { type Constructor, type CardSceneBaseCtor, MODAL_DIM } from './base';

export interface FeedHandlers {
  openFeedSelect(target: CardInstance): void;
}

export function FeedMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<FeedHandlers> {
  return class extends Base {
    openFeedSelect(target: CardInstance): void {
      const save = this.cb.getSave();
      const def = CARD_DEFS[target.defId];
      if (!def) return;

      // Eligible materials: same faction, not locked, not this card, not in SLG team.
      const cardState = this.cb.getCardState?.() ?? {};
      const candidates = Object.values(save.cardInv ?? {}).filter((c) => {
        if (c.id === target.id) return false;
        if (c.locked) return false;
        const matDef = CARD_DEFS[c.defId];
        if (!matDef || matDef.faction !== def.faction) return false;
        if (cardState[c.id]?.teamId) return false; // deployed cards cannot be fed
        return true;
      });

      const { w, h } = this;
      const ml = this.modalLayer;
      ml.removeChildren();
      this.modalHits = [];
      this.modalOpen = true;

      const selected = new Set<string>();
      const drawFeedPanel = (): void => {
        ml.removeChildren();
        this.modalHits = [];

        const mw = Math.min(320, w - 24);
        const rowH = 44;
        const mh = Math.min(60 + candidates.length * rowH + 56, h - 60);
        const mx = (w - mw) / 2;
        const my = Math.max(this.headerH + 4, (h - mh) / 2);

        const dim = new PIXI.Graphics();
        dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
        ml.addChild(dim);

        const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.gold, width: 2, seed: seedFor(0, 18, mw) });
        panel.x = mx; panel.y = my;
        ml.addChild(panel);

        const titleLbl = txt(t('roster.feedTitle'), 13, C.dark, true);
        titleLbl.anchor.set(0.5, 0); titleLbl.x = mx + mw / 2; titleLbl.y = my + 10;
        ml.addChild(titleLbl);

        const hintLbl = txt(t('roster.feedHint'), 10, C.mid);
        hintLbl.anchor.set(0.5, 0); hintLbl.x = mx + mw / 2; hintLbl.y = my + 26;
        ml.addChild(hintLbl);

        let cy = my + 44;
        if (candidates.length === 0) {
          const empty = txt(t('roster.feedEmpty'), 12, C.mid);
          empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = my + mh / 2 - 20;
          ml.addChild(empty);
        }

        for (const mat of candidates) {
          const isSelected = selected.has(mat.id);
          const matDef = CARD_DEFS[mat.defId];
          const rowBg = sketchPanel(mw - 16, rowH - 4, { fill: isSelected ? 0xfaf0d4 : 0xf5f3ec, border: isSelected ? C.gold : C.mid, seed: seedFor(cy, 19, mw) });
          rowBg.x = mx + 8; rowBg.y = cy;
          ml.addChild(rowBg);

          // Checkbox: a small ink box, ticked with a hand-drawn check when selected (replaces [✓]/[ ]).
          const boxSz = 14;
          const box = new PIXI.Graphics();
          box.lineStyle(1.5, isSelected ? C.accent : C.mid, 1);
          box.drawRect(mx + 14, cy + 6, boxSz, boxSz);
          ml.addChild(box);
          if (isSelected) {
            const ck = buildIcon('check', boxSz, C.accent);
            ck.x = mx + 14; ck.y = cy + 6;
            ml.addChild(ck);
          }

          const matName = t(`card.${mat.defId}.name` as TranslationKey);
          const nameLbl = txt(`${matName} Lv.${mat.level}`, 12, C.dark, true);
          nameLbl.x = mx + 36; nameLbl.y = cy + 6;
          ml.addChild(nameLbl);

          const facLbl = txt(matDef ? t(`roster.faction.${matDef.faction}` as TranslationKey) : '', 10, matDef?.faction === 'anna' ? 0xcc4466 : 0x4477cc);
          facLbl.x = mx + 36; facLbl.y = cy + 22;
          ml.addChild(facLbl);

          const matId = mat.id;
          this.modalHits.push({
            rect: { x: mx + 8, y: cy, w: mw - 16, h: rowH - 4 },
            action: () => {
              if (selected.has(matId)) selected.delete(matId);
              else selected.add(matId);
              drawFeedPanel();
            },
          });
          cy += rowH;
        }

        // Confirm button
        const confirmOn = selected.size > 0 && !this.bt.busy;
        const confirmBtnW = 100;
        const confirmBtn = sketchPanel(confirmBtnW, 28, {
          fill: confirmOn ? C.dark : C.btnOff, border: confirmOn ? C.gold : C.mid,
          seed: seedFor(0, 20, confirmBtnW),
        });
        confirmBtn.x = mx + mw / 2 - confirmBtnW - 4; confirmBtn.y = my + mh - 36;
        ml.addChild(confirmBtn);
        const confirmLbl = txt(`${t('roster.feedBtn')} (${selected.size})`, 11, confirmOn ? C.light : C.mid);
        confirmLbl.anchor.set(0.5, 0.5); confirmLbl.x = confirmBtn.x + confirmBtnW / 2; confirmLbl.y = confirmBtn.y + 14;
        ml.addChild(confirmLbl);
        if (confirmOn) {
          this.modalHits.push({
            rect: { x: confirmBtn.x, y: confirmBtn.y, w: confirmBtnW, h: 28 },
            action: () => void this.doFeed(target.id, [...selected]),
          });
        }

        // Cancel button
        const cancelBtnW = 80;
        const cancelBtn = sketchPanel(cancelBtnW, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 21, cancelBtnW) });
        cancelBtn.x = mx + mw / 2 + 4; cancelBtn.y = my + mh - 36;
        ml.addChild(cancelBtn);
        const cancelLbl = txt(t('equip.cancel'), 11, C.dark);
        cancelLbl.anchor.set(0.5, 0.5); cancelLbl.x = cancelBtn.x + cancelBtnW / 2; cancelLbl.y = cancelBtn.y + 14;
        ml.addChild(cancelLbl);
        this.modalHits.push({ rect: { x: cancelBtn.x, y: cancelBtn.y, w: cancelBtnW, h: 28 }, action: () => { this.closeModal(); this.render(); } });

        // Dismiss on backdrop
        this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
        this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.closeModal(); this.render(); } });
      };

      drawFeedPanel();
    }
  };
}
