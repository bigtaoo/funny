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

        // Scale the whole feed modal up 3x (local factor, other modals untouched).
        // Geometry stays clamped to the screen so it never overflows.
        const S = 3;
        const mw = Math.min(320 * S, w - 24);
        const rowH = 44 * S;
        const mh = Math.min(60 * S + candidates.length * rowH + 56 * S, h - 60);
        const mx = (w - mw) / 2;
        const my = Math.max(this.headerH + 4, (h - mh) / 2);

        const dim = new PIXI.Graphics();
        dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
        ml.addChild(dim);

        const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.gold, width: 2 * S, seed: seedFor(0, 18, mw) });
        panel.x = mx; panel.y = my;
        ml.addChild(panel);

        const titleLbl = txt(t('roster.feedTitle'), 13 * S, C.dark, true);
        titleLbl.anchor.set(0.5, 0); titleLbl.x = mx + mw / 2; titleLbl.y = my + 10 * S;
        ml.addChild(titleLbl);

        const hintLbl = txt(t('roster.feedHint'), 10 * S, C.mid);
        hintLbl.anchor.set(0.5, 0); hintLbl.x = mx + mw / 2; hintLbl.y = my + 26 * S;
        ml.addChild(hintLbl);

        let cy = my + 44 * S;
        if (candidates.length === 0) {
          const empty = txt(t('roster.feedEmpty'), 12 * S, C.mid);
          empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = my + mh / 2 - 20 * S;
          ml.addChild(empty);
        }

        for (const mat of candidates) {
          const isSelected = selected.has(mat.id);
          const matDef = CARD_DEFS[mat.defId];
          const rowBg = sketchPanel(mw - 16 * S, rowH - 4 * S, { fill: isSelected ? 0xfaf0d4 : 0xf5f3ec, border: isSelected ? C.gold : C.mid, seed: seedFor(cy, 19, mw) });
          rowBg.x = mx + 8 * S; rowBg.y = cy;
          ml.addChild(rowBg);

          // Checkbox: a small ink box, ticked with a hand-drawn check when selected (replaces [✓]/[ ]).
          const boxSz = 14 * S;
          const box = new PIXI.Graphics();
          box.lineStyle(1.5 * S, isSelected ? C.accent : C.mid, 1);
          box.drawRect(mx + 14 * S, cy + 6 * S, boxSz, boxSz);
          ml.addChild(box);
          if (isSelected) {
            const ck = buildIcon('check', boxSz, C.accent);
            ck.x = mx + 14 * S; ck.y = cy + 6 * S;
            ml.addChild(ck);
          }

          const matName = t(`card.${mat.defId}.name` as TranslationKey);
          const nameLbl = txt(`${matName} Lv.${mat.level}`, 12 * S, C.dark, true);
          nameLbl.x = mx + 36 * S; nameLbl.y = cy + 6 * S;
          ml.addChild(nameLbl);

          const facLbl = txt(matDef ? t(`roster.faction.${matDef.faction}` as TranslationKey) : '', 10 * S, matDef?.faction === 'anna' ? 0xcc4466 : 0x4477cc);
          facLbl.x = mx + 36 * S; facLbl.y = cy + 22 * S;
          ml.addChild(facLbl);

          const matId = mat.id;
          this.modalHits.push({
            rect: { x: mx + 8 * S, y: cy, w: mw - 16 * S, h: rowH - 4 * S },
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
        const confirmBtnW = 100 * S;
        const btnH = 28 * S;
        const confirmBtn = sketchPanel(confirmBtnW, btnH, {
          fill: confirmOn ? C.dark : C.btnOff, border: confirmOn ? C.gold : C.mid,
          seed: seedFor(0, 20, confirmBtnW),
        });
        confirmBtn.x = mx + mw / 2 - confirmBtnW - 4 * S; confirmBtn.y = my + mh - 36 * S;
        ml.addChild(confirmBtn);
        const confirmLbl = txt(`${t('roster.feedBtn')} (${selected.size})`, 11 * S, confirmOn ? C.light : C.mid);
        confirmLbl.anchor.set(0.5, 0.5); confirmLbl.x = confirmBtn.x + confirmBtnW / 2; confirmLbl.y = confirmBtn.y + btnH / 2;
        ml.addChild(confirmLbl);
        if (confirmOn) {
          this.modalHits.push({
            rect: { x: confirmBtn.x, y: confirmBtn.y, w: confirmBtnW, h: btnH },
            action: () => void this.doFeed(target.id, [...selected]),
          });
        }

        // Cancel button
        const cancelBtnW = 80 * S;
        const cancelBtn = sketchPanel(cancelBtnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 21, cancelBtnW) });
        cancelBtn.x = mx + mw / 2 + 4 * S; cancelBtn.y = my + mh - 36 * S;
        ml.addChild(cancelBtn);
        const cancelLbl = txt(t('equip.cancel'), 11 * S, C.dark);
        cancelLbl.anchor.set(0.5, 0.5); cancelLbl.x = cancelBtn.x + cancelBtnW / 2; cancelLbl.y = cancelBtn.y + btnH / 2;
        ml.addChild(cancelLbl);
        this.modalHits.push({ rect: { x: cancelBtn.x, y: cancelBtn.y, w: cancelBtnW, h: btnH }, action: () => { this.closeModal(); this.render(); } });

        // Dismiss on backdrop
        this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
        this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.closeModal(); this.render(); } });
      };

      drawFeedPanel();
    }
  };
}
