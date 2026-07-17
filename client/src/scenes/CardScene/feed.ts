// Feed flow (modal-within-modal): from the detail modal, pick eligible material cards (same faction,
// unlocked, not deployed) via a multi-select panel, then confirm → doFeed().
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
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
      // Paged (not free-scroll) list: avoids fighting the modal's fire-on-pointerdown row
      // taps with a drag-to-scroll gesture over the same rows. this.feedScrollIdx is the index
      // of the first visible candidate; clamped to fit whenever the panel redraws.
      this.feedScrollIdx = 0;
      const drawFeedPanel = (): void => {
        ml.removeChildren();
        this.modalHits = [];

        // Scale the whole feed modal up 3x (local factor, other modals untouched).
        // Geometry stays clamped to the screen so it never overflows.
        const S = 3;
        const mw = Math.min(320 * S, w - 24);
        const rowH = 44 * S;
        const headerBlockH = 44 * S; // title + hint
        const footerBlockH = 56 * S; // confirm/cancel row + margin
        // Panel must fit strictly below the scene's own header bar and above the screen edge — a
        // naive `h - 60` cap (ignoring this.headerH) let a tall header push the panel's bottom
        // (Confirm/Cancel) off-screen even though the panel's own height looked clamped.
        const topLimit = this.headerH + 4;
        const bottomLimit = h - 8;
        const availH = Math.max(0, bottomLimit - topLimit);
        // Panel height shows up to 6 rows before paging kicks in, still clamped to the screen.
        const mh = Math.min(headerBlockH + Math.min(Math.max(candidates.length, 1), 6) * rowH + footerBlockH, availH);
        const mx = (w - mw) / 2;
        const my = topLimit + (availH - mh) / 2;

        const dim = new PIXI.Graphics();
        dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
        ml.addChild(dim);

        const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.gold, width: 2 * S, seed: seedFor(0, 18, mw) });
        panel.x = mx; panel.y = my;
        ml.addChild(panel);

        const titleLbl = txt(t('roster.feedTitle'), snapFont(13 * S), C.dark, true);
        titleLbl.anchor.set(0.5, 0); titleLbl.x = mx + mw / 2; titleLbl.y = my + 10 * S;
        ml.addChild(titleLbl);

        const hintLbl = txt(t('roster.feedHint'), snapFont(10 * S), C.mid);
        hintLbl.anchor.set(0.5, 0); hintLbl.x = mx + mw / 2; hintLbl.y = my + 26 * S;
        ml.addChild(hintLbl);

        const listY = my + headerBlockH;
        const listH = mh - headerBlockH - footerBlockH;

        if (candidates.length === 0) {
          const empty = txt(t('roster.feedEmpty'), snapFont(12 * S), C.mid);
          empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = listY + listH / 2;
          ml.addChild(empty);
        }

        const maxVisible = Math.max(1, Math.floor(listH / rowH));
        const scrollMax = Math.max(0, candidates.length - maxVisible);
        this.feedScrollIdx = Math.max(0, Math.min(this.feedScrollIdx, scrollMax));
        // Reserve a paging column on the right of the rows when the list overflows the panel.
        const pagerW = scrollMax > 0 ? 28 * S : 0;
        const rowW = mw - 16 * S - pagerW;

        let cy = listY;
        const visible = candidates.slice(this.feedScrollIdx, this.feedScrollIdx + maxVisible);
        for (const mat of visible) {
          const isSelected = selected.has(mat.id);
          const matDef = CARD_DEFS[mat.defId];
          const rowBg = sketchPanel(rowW, rowH - 4 * S, { fill: isSelected ? 0xfaf0d4 : 0xf5f3ec, border: isSelected ? C.gold : C.mid, seed: seedFor(cy, 19, mw) });
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
          const nameLbl = txt(`${matName} Lv.${mat.level}`, snapFont(12 * S), C.dark, true);
          nameLbl.x = mx + 36 * S; nameLbl.y = cy + 6 * S;
          ml.addChild(nameLbl);

          const facLbl = txt(matDef ? t(`roster.faction.${matDef.faction}` as TranslationKey) : '', snapFont(10 * S), matDef?.faction === 'anna' ? 0xcc4466 : 0x4477cc);
          facLbl.x = mx + 36 * S; facLbl.y = cy + 22 * S;
          ml.addChild(facLbl);

          const matId = mat.id;
          this.modalHits.push({
            rect: { x: mx + 8 * S, y: cy, w: rowW, h: rowH - 4 * S },
            action: () => {
              if (selected.has(matId)) selected.delete(matId);
              else selected.add(matId);
              drawFeedPanel();
            },
          });
          cy += rowH;
        }

        if (scrollMax > 0) {
          const pagerX = mx + mw - 8 * S - pagerW;
          const arrowSz = pagerW - 6 * S;
          const drawArrow = (ax: number, ay: number, pointUp: boolean, enabled: boolean): void => {
            const g = new PIXI.Graphics();
            g.beginFill(enabled ? C.dark : C.mid, enabled ? 0.85 : 0.4);
            if (pointUp) g.drawPolygon([ax, ay + arrowSz, ax + arrowSz / 2, ay, ax + arrowSz, ay + arrowSz]);
            else g.drawPolygon([ax, ay, ax + arrowSz, ay, ax + arrowSz / 2, ay + arrowSz]);
            g.endFill();
            ml.addChild(g);
          };

          const upEnabled = this.feedScrollIdx > 0;
          drawArrow(pagerX, listY, true, upEnabled);
          if (upEnabled) {
            this.modalHits.push({
              rect: { x: pagerX, y: listY, w: arrowSz, h: arrowSz },
              action: () => { this.feedScrollIdx = Math.max(0, this.feedScrollIdx - maxVisible); drawFeedPanel(); },
            });
          }

          const downY = listY + listH - arrowSz;
          const downEnabled = this.feedScrollIdx < scrollMax;
          drawArrow(pagerX, downY, false, downEnabled);
          if (downEnabled) {
            this.modalHits.push({
              rect: { x: pagerX, y: downY, w: arrowSz, h: arrowSz },
              action: () => { this.feedScrollIdx = Math.min(scrollMax, this.feedScrollIdx + maxVisible); drawFeedPanel(); },
            });
          }

          drawScrollIndicator(
            ml,
            { x: pagerX, y: listY + arrowSz + 4 * S, w: arrowSz, h: listH - 2 * arrowSz - 8 * S },
            this.feedScrollIdx * rowH,
            scrollMax * rowH,
          );
        }

        // Confirm + Cancel buttons — each button's width auto-fits its label (with a
        // per-button minimum) so longer localized text (e.g. German "Zusammenbauen")
        // never overflows a fixed box; the pair stays centered under the panel.
        const btnH = 28 * S;
        const btnPadX = 16 * S;
        const btnGap = 8 * S;
        const btnY = my + mh - 36 * S;

        const confirmOn = selected.size > 0 && !this.bt.busy;
        const confirmLbl = txt(`${t('roster.feedBtn')} (${selected.size})`, snapFont(11 * S), confirmOn ? C.light : C.mid);
        const cancelLbl = txt(t('equip.cancel'), snapFont(11 * S), C.dark);
        const confirmBtnW = Math.max(100 * S, confirmLbl.width + btnPadX * 2);
        const cancelBtnW = Math.max(80 * S, cancelLbl.width + btnPadX * 2);

        const pairW = confirmBtnW + btnGap + cancelBtnW;
        const confirmX = mx + mw / 2 - pairW / 2;
        const cancelX = confirmX + confirmBtnW + btnGap;

        const confirmBtn = sketchPanel(confirmBtnW, btnH, {
          fill: confirmOn ? C.dark : C.btnOff, border: confirmOn ? C.gold : C.mid,
          seed: seedFor(0, 20, confirmBtnW),
        });
        confirmBtn.x = confirmX; confirmBtn.y = btnY;
        ml.addChild(confirmBtn);
        confirmLbl.anchor.set(0.5, 0.5); confirmLbl.x = confirmX + confirmBtnW / 2; confirmLbl.y = btnY + btnH / 2;
        ml.addChild(confirmLbl);
        if (confirmOn) {
          this.modalHits.push({
            rect: { x: confirmX, y: btnY, w: confirmBtnW, h: btnH },
            action: () => void this.doFeed(target.id, [...selected]),
          });
        }

        const cancelBtn = sketchPanel(cancelBtnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 21, cancelBtnW) });
        cancelBtn.x = cancelX; cancelBtn.y = btnY;
        ml.addChild(cancelBtn);
        cancelLbl.anchor.set(0.5, 0.5); cancelLbl.x = cancelX + cancelBtnW / 2; cancelLbl.y = btnY + btnH / 2;
        ml.addChild(cancelLbl);
        this.modalHits.push({ rect: { x: cancelX, y: btnY, w: cancelBtnW, h: btnH }, action: () => { this.closeModal(); this.render(); } });

        // Dismiss on backdrop
        this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
        this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.closeModal(); this.render(); } });
      };

      drawFeedPanel();
    }
  };
}
