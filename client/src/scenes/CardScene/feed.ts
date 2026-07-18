// Feed flow (modal-within-modal): from the detail modal, pick eligible material cards (same faction,
// unlocked, not deployed) via a multi-select panel, then confirm → doFeed().
//
// Identical materials (same card def + same level) collapse into ONE row with a quantity stepper —
// e.g. "Mara Lv.1  1 / 3" — instead of listing every duplicate. The list is drag-scrollable (pan with
// a press-drag) rather than paged via arrow buttons.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { FACTION_COLOR } from '../../render/factionIcon';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { Rect } from '../../layout/ILayout';
import type { CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS } from '../../game/meta/cardDefs';
import { type Constructor, type CardSceneBaseCtor, MODAL_DIM } from './base';

export interface FeedHandlers {
  openFeedSelect(target: CardInstance): void;
}

/** One collapsed material row: all owned cards sharing a def + level, plus how many are selected. */
interface FeedGroup {
  defId: string;
  level: number;
  ids: string[];
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

      // Collapse duplicates: group by def + level, preserving first-seen order.
      const groupMap = new Map<string, FeedGroup>();
      for (const c of candidates) {
        const key = `${c.defId}:${c.level}`;
        let g = groupMap.get(key);
        if (!g) { g = { defId: c.defId, level: c.level, ids: [] }; groupMap.set(key, g); }
        g.ids.push(c.id);
      }
      const groups = [...groupMap.values()];
      const keyOf = (g: FeedGroup): string => `${g.defId}:${g.level}`;
      // Selected quantity per group (0..ids.length).
      const counts = new Map<string, number>();
      const totalSelected = (): number => { let n = 0; for (const v of counts.values()) n += v; return n; };
      const selectedIds = (): string[] => {
        const out: string[] = [];
        for (const g of groups) out.push(...g.ids.slice(0, counts.get(keyOf(g)) ?? 0));
        return out;
      };

      const { w, h } = this;
      const ml = this.modalLayer;
      ml.removeChildren();
      this.modalHits = [];
      this.modalOpen = true;
      this.feedScrollPx = 0;

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
        // Panel height shows up to 6 rows before scrolling kicks in, still clamped to the screen.
        const mh = Math.min(headerBlockH + Math.min(Math.max(groups.length, 1), 6) * rowH + footerBlockH, availH);
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

        if (groups.length === 0) {
          const empty = txt(t('roster.feedEmpty'), snapFont(12 * S), C.mid);
          empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = listY + listH / 2;
          ml.addChild(empty);
        }

        // Pixel-based drag scroll: clamp the offset, reserve a slim scrollbar column on overflow.
        const contentH = groups.length * rowH;
        const scrollMax = Math.max(0, contentH - listH);
        this.feedScrollPx = Math.max(0, Math.min(this.feedScrollPx, scrollMax));
        this.feedScrollMax = scrollMax;
        const barW = scrollMax > 0 ? 10 * S : 0;
        const listX = mx + 8 * S;
        const rowW = mw - 16 * S - barW;
        const viewport: Rect = { x: listX, y: listY, w: rowW + barW, h: listH };

        // Mask the rows to the viewport so partial rows at the top/bottom edge don't spill over the
        // title/footer. Rows live in an untransformed container, so their local coords == screen coords.
        const listC = new PIXI.Container();
        ml.addChild(listC);
        const maskG = new PIXI.Graphics();
        maskG.beginFill(0xffffff).drawRect(viewport.x, viewport.y, viewport.w, viewport.h).endFill();
        ml.addChild(maskG);
        listC.mask = maskG;

        // Intersect a hit rect with the viewport so taps on a clipped-away part of a partial row don't fire.
        const clip = (r: Rect): Rect | null => {
          const x1 = Math.max(r.x, viewport.x), y1 = Math.max(r.y, viewport.y);
          const x2 = Math.min(r.x + r.w, viewport.x + viewport.w), y2 = Math.min(r.y + r.h, viewport.y + viewport.h);
          if (x2 <= x1 || y2 <= y1) return null;
          return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        };
        const pushHit = (rect: Rect, action: () => void): void => {
          const c = clip(rect);
          if (c) this.modalHits.push({ rect: c, action });
        };

        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          const rowTop = listY - this.feedScrollPx + i * rowH;
          if (rowTop + rowH <= listY || rowTop >= listY + listH) continue; // fully off-screen
          const key = keyOf(g);
          const total = g.ids.length;
          const n = counts.get(key) ?? 0;
          const isSelected = n > 0;
          const rowCy = rowTop + (rowH - 4 * S) / 2;

          const rowBg = sketchPanel(rowW, rowH - 4 * S, { fill: isSelected ? 0xfaf0d4 : 0xf5f3ec, border: isSelected ? C.gold : C.mid, seed: seedFor(i, 19, mw) });
          rowBg.x = listX; rowBg.y = rowTop;
          listC.addChild(rowBg);

          // Faction identity dot (materials are same-faction anyway; the full totem is detail-only).
          const matDef = CARD_DEFS[g.defId];
          if (matDef) {
            const dot = new PIXI.Graphics();
            dot.beginFill(FACTION_COLOR[matDef.faction]).drawCircle(0, 0, 6 * S).endFill();
            dot.x = listX + 20 * S; dot.y = rowCy;
            listC.addChild(dot);
          }

          const matName = t(`card.${g.defId}.name` as TranslationKey);
          const nameLbl = txt(`${matName} Lv.${g.level}`, snapFont(12 * S), C.dark, true);
          nameLbl.anchor.set(0, 0.5); nameLbl.x = listX + 34 * S; nameLbl.y = rowCy;
          listC.addChild(nameLbl);

          // Quantity stepper on the right: [−]  n / total  [+].
          const stepSz = 26 * S;
          const rowRight = listX + rowW;
          const plusX = rowRight - 12 * S - stepSz;
          const minusX = plusX - stepSz - 56 * S;
          const countCx = (minusX + stepSz + plusX) / 2;
          const stepY = rowCy - stepSz / 2;

          const drawStepBtn = (bx: number, enabled: boolean, plus: boolean): void => {
            const btn = sketchPanel(stepSz, stepSz, { fill: enabled ? C.paper : C.btnOff, border: enabled ? C.dark : C.mid, seed: seedFor(bx, plus ? 22 : 23, stepSz) });
            btn.x = bx; btn.y = stepY;
            listC.addChild(btn);
            const glyph = new PIXI.Graphics();
            const gc = enabled ? C.dark : C.mid;
            const cx = bx + stepSz / 2, cy = stepY + stepSz / 2, arm = stepSz * 0.28;
            glyph.lineStyle(2.5 * S, gc, enabled ? 0.9 : 0.4);
            glyph.moveTo(cx - arm, cy).lineTo(cx + arm, cy);
            if (plus) glyph.moveTo(cx, cy - arm).lineTo(cx, cy + arm);
            listC.addChild(glyph);
          };

          const minusOn = n > 0;
          const plusOn = n < total;
          drawStepBtn(minusX, minusOn, false);
          drawStepBtn(plusX, plusOn, true);

          const countLbl = txt(`${n} / ${total}`, snapFont(12 * S), isSelected ? C.dark : C.mid, true);
          countLbl.anchor.set(0.5, 0.5); countLbl.x = countCx; countLbl.y = rowCy;
          listC.addChild(countLbl);

          const setCount = (v: number): void => {
            const clamped = Math.max(0, Math.min(total, v));
            if (clamped === 0) counts.delete(key); else counts.set(key, clamped);
            drawFeedPanel();
          };

          if (minusOn) pushHit({ x: minusX, y: stepY, w: stepSz, h: stepSz }, () => setCount(n - 1));
          if (plusOn) pushHit({ x: plusX, y: stepY, w: stepSz, h: stepSz }, () => setCount(n + 1));
          // Tapping the row body (left of the stepper) cycles the quantity: +1, wrapping to 0 past the max.
          pushHit({ x: listX, y: rowTop, w: minusX - listX, h: rowH - 4 * S }, () => setCount(n >= total ? 0 : n + 1));
        }

        if (scrollMax > 0) {
          drawScrollIndicator(ml, viewport, this.feedScrollPx, scrollMax);
        }

        // Confirm + Cancel buttons — each button's width auto-fits its label (with a
        // per-button minimum) so longer localized text (e.g. German "Zusammenbauen")
        // never overflows a fixed box; the pair stays centered under the panel.
        const btnH = 28 * S;
        const btnPadX = 16 * S;
        const btnGap = 8 * S;
        const btnY = my + mh - 36 * S;

        const total = totalSelected();
        const confirmOn = total > 0 && !this.bt.busy;
        const confirmLbl = txt(`${t('roster.feedBtn')} (${total})`, snapFont(11 * S), confirmOn ? C.light : C.mid);
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
            action: () => void this.doFeed(target.id, selectedIds()),
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

      this.feedRedraw = drawFeedPanel;
      drawFeedPanel();
    }
  };
}
