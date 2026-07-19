// Fusion flow (CHARACTER_CARDS_DESIGN §3, fusion redesign 2026-07-19): from the detail modal, open
// a ring layout — the target card sits in the center, 5 material slots surround it. Tapping an
// eligible candidate below (same faction, same level as the target, unlocked, not deployed) fills
// the next empty slot; tapping a filled slot returns that card to the pool. Once all 5 slots are
// filled, Fuse consumes them and the target gains one level (doFuse → playFusionAnim).
//
// The candidate list collapses duplicates into one row per defId (level is fixed = target's level,
// so a group key is just defId) with a remaining-count badge, drag-scrollable when it overflows.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { FACTION_COLOR } from '../../render/factionIcon';
import { UNIT_ART_URLS, getArtTexture } from '../../render/cardArt';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { Rect } from '../../layout/ILayout';
import type { CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, FUSION_MATERIAL_COUNT, fusionMaterialCandidates, type Faction } from '../../game/meta/cardDefs';
import { type Constructor, type CardSceneBaseCtor, MODAL_DIM } from './base';

export interface FeedHandlers {
  openFuseSelect(target: CardInstance): void;
  playFusionAnim(): Promise<void>;
}

/** One collapsed candidate row: all owned same-level same-faction cards of one defId. */
interface FuseGroup {
  defId: string;
  ids: string[];
}

export function FeedMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<FeedHandlers> {
  return class extends Base {
    /** Placeholder in-engine fusion animation: the center portrait pulses gold, the 5 material
     * thumbnails collapse inward and fade. Program-art stand-in — a dedicated VFX-editor asset
     * replaces this call site once authored (feed.ts owns the whole visual, so the swap is local). */
    async playFusionAnim(): Promise<void> {
      const ml = this.modalLayer;
      const { w, h } = this;
      const flash = new PIXI.Graphics();
      flash.beginFill(0xffe28a, 0).drawRect(0, 0, w, h).endFill();
      ml.addChild(flash);
      const cx = w / 2, cy = h / 2;
      const burst = new PIXI.Graphics();
      ml.addChild(burst);
      const DURATION_MS = 650;
      await new Promise<void>((resolve) => {
        const start = performance.now();
        const tick = (): void => {
          const elapsed = performance.now() - start;
          const f = Math.min(1, elapsed / DURATION_MS);
          const pulse = Math.sin(f * Math.PI); // 0 → 1 → 0
          flash.alpha = pulse * 0.5;
          burst.clear();
          burst.lineStyle(4, C.gold, pulse);
          burst.drawCircle(cx, cy, 24 + pulse * 70);
          if (f < 1) {
            requestAnimationFrame(tick);
          } else {
            flash.destroy();
            burst.destroy();
            resolve();
          }
        };
        requestAnimationFrame(tick);
      });
    }

    openFuseSelect(target: CardInstance): void {
      const save = this.cb.getSave();
      const def = CARD_DEFS[target.defId];
      if (!def) return;

      const cardState = this.cb.getCardState?.() ?? {};
      const candidateOf = (id: string): boolean => !cardState[id]?.teamId; // deployed cards cannot be fused
      const allCandidates = fusionMaterialCandidates(target, save.cardInv ?? {}).filter((c) => candidateOf(c.id));

      // slotIds[i] = the specific CardInstance id occupying material slot i, or null when empty.
      const slotIds: (string | null)[] = new Array(FUSION_MATERIAL_COUNT).fill(null);
      const filledCount = (): number => slotIds.filter((id) => id !== null).length;
      const firstEmptySlot = (): number => slotIds.indexOf(null);
      const assign = (cardId: string): void => {
        const i = firstEmptySlot();
        if (i < 0) return;
        slotIds[i] = cardId;
        drawFusePanel();
      };
      const unassign = (slotIdx: number): void => {
        slotIds[slotIdx] = null;
        drawFusePanel();
      };

      const groupsOf = (): FuseGroup[] => {
        const used = new Set(slotIds.filter((id): id is string => id !== null));
        const map = new Map<string, FuseGroup>();
        for (const c of allCandidates) {
          if (used.has(c.id)) continue; // already sitting in a slot
          let g = map.get(c.defId);
          if (!g) { g = { defId: c.defId, ids: [] }; map.set(c.defId, g); }
          g.ids.push(c.id);
        }
        return [...map.values()];
      };

      const { w, h } = this;
      const ml = this.modalLayer;
      tearDownChildren(ml);
      this.modalHits = [];
      this.modalOpen = true;
      this.feedScrollPx = 0;
      const artHooked = new Set<string>();

      const drawFusePanel = (): void => {
        tearDownChildren(ml);
        this.modalHits = [];

        const S = 2;
        const mw = Math.min(340 * S, w - 24);
        const topLimit = this.headerH + 4;
        const bottomLimit = h - 8;
        const availH = Math.max(0, bottomLimit - topLimit);
        const headerBlockH = 40 * S;
        const ringH = 130 * S;
        const rowH = 40 * S;
        const footerBlockH = 52 * S;
        const groups = groupsOf();
        const listRows = Math.min(Math.max(groups.length, 1), 4);
        const mh = Math.min(headerBlockH + ringH + listRows * rowH + footerBlockH, availH);
        const mx = (w - mw) / 2;
        const my = topLimit + (availH - mh) / 2;

        const dim = new PIXI.Graphics();
        dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
        ml.addChild(dim);

        const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.gold, width: 2 * S, seed: seedFor(0, 18, mw) });
        panel.x = mx; panel.y = my;
        ml.addChild(panel);

        const titleLbl = txt(t('roster.fuseTitle'), snapFont(13 * S), C.dark, true);
        titleLbl.anchor.set(0.5, 0); titleLbl.x = mx + mw / 2; titleLbl.y = my + 8 * S;
        ml.addChild(titleLbl);

        const hintLbl = txt(t('roster.fuseHint'), snapFont(9.5 * S), C.mid);
        hintLbl.anchor.set(0.5, 0); hintLbl.x = mx + mw / 2; hintLbl.y = my + 24 * S;
        ml.addChild(hintLbl);

        // ── Ring: center card + 5 material slots arranged around it ──
        const ringCx = mx + mw / 2;
        const ringCy = my + headerBlockH + ringH / 2;
        const centerR = 22 * S;
        const slotR = 15 * S;
        const orbit = 46 * S;

        const drawPortrait = (
          cardId: string | null, cx: number, cy: number, r: number, faction: Faction | undefined,
        ): void => {
          const frame = new PIXI.Graphics();
          frame.lineStyle(2, faction ? FACTION_COLOR[faction] : C.mid, cardId ? 1 : 0.4);
          frame.beginFill(0xf0eee7, cardId ? 1 : 0.5).drawCircle(cx, cy, r).endFill();
          ml.addChild(frame);
          if (!cardId) return;
          const inst = save.cardInv?.[cardId];
          const cDef = inst && CARD_DEFS[inst.defId];
          const artUrl = cDef && UNIT_ART_URLS[cDef.unitType];
          if (artUrl) {
            const tex = getArtTexture(artUrl);
            if (tex.baseTexture.valid) {
              const scale = Math.min((r * 2 - 4) / tex.width, (r * 2 - 4) / tex.height);
              const sp = new PIXI.Sprite(tex);
              sp.anchor.set(0.5);
              sp.scale.set(scale);
              sp.position.set(cx, cy);
              ml.addChild(sp);
            } else if (!artHooked.has(artUrl)) {
              artHooked.add(artUrl);
              tex.baseTexture.once('loaded', () => drawFusePanel());
            }
          }
        };

        // Connecting spokes (drawn under the portraits) so the ring reads as one fusion unit.
        for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
          const ang = -Math.PI / 2 + (i * 2 * Math.PI) / FUSION_MATERIAL_COUNT;
          const sx = ringCx + Math.cos(ang) * orbit, sy = ringCy + Math.sin(ang) * orbit;
          const spoke = new PIXI.Graphics();
          spoke.lineStyle(1.5, C.mid, slotIds[i] ? 0.7 : 0.3);
          spoke.moveTo(ringCx, ringCy).lineTo(sx, sy);
          ml.addChild(spoke);
        }

        drawPortrait(target.id, ringCx, ringCy, centerR, def.faction);
        const lvlLbl = txt(`Lv.${target.level}`, snapFont(9 * S), C.dark, true);
        lvlLbl.anchor.set(0.5, 0); lvlLbl.x = ringCx; lvlLbl.y = ringCy + centerR + 2 * S;
        ml.addChild(lvlLbl);

        for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
          const ang = -Math.PI / 2 + (i * 2 * Math.PI) / FUSION_MATERIAL_COUNT;
          const sx = ringCx + Math.cos(ang) * orbit, sy = ringCy + Math.sin(ang) * orbit;
          const slotCardId = slotIds[i];
          drawPortrait(slotCardId, sx, sy, slotR, def.faction);
          if (slotCardId) {
            this.modalHits.push({
              rect: { x: sx - slotR, y: sy - slotR, w: slotR * 2, h: slotR * 2 },
              action: () => unassign(i),
            });
          }
        }

        // ── Candidate list ──
        const listY = my + headerBlockH + ringH;
        const listH = mh - headerBlockH - ringH - footerBlockH;
        if (groups.length === 0 && filledCount() < FUSION_MATERIAL_COUNT) {
          const empty = txt(t('roster.fuseEmpty'), snapFont(11 * S), C.mid);
          empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = listY + listH / 2;
          ml.addChild(empty);
        }

        const contentH = groups.length * rowH;
        const scrollMax = Math.max(0, contentH - listH);
        this.feedScrollPx = Math.max(0, Math.min(this.feedScrollPx, scrollMax));
        this.feedScrollMax = scrollMax;
        const barW = scrollMax > 0 ? 8 * S : 0;
        const listX = mx + 8 * S;
        const rowW = mw - 16 * S - barW;
        const viewport: Rect = { x: listX, y: listY, w: rowW + barW, h: listH };

        const listC = new PIXI.Container();
        ml.addChild(listC);
        const maskG = new PIXI.Graphics();
        maskG.beginFill(0xffffff).drawRect(viewport.x, viewport.y, viewport.w, viewport.h).endFill();
        ml.addChild(maskG);
        listC.mask = maskG;

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
          if (rowTop + rowH <= listY || rowTop >= listY + listH) continue;
          const gDef = CARD_DEFS[g.defId];
          const canAssign = firstEmptySlot() >= 0;

          const rowBg = sketchPanel(rowW, rowH - 4 * S, { fill: canAssign ? 0xf5f3ec : 0xeeeeee, border: C.mid, seed: seedFor(i, 19, mw) });
          rowBg.x = listX; rowBg.y = rowTop;
          listC.addChild(rowBg);

          const thumbBox = rowH - 8 * S;
          const thumbX = listX + 4 * S;
          const thumbY = rowTop + (rowH - thumbBox) / 2;
          if (gDef) {
            const frame = sketchPanel(thumbBox, thumbBox, { fill: 0xf0eee7, border: FACTION_COLOR[gDef.faction], seed: seedFor(i, 24, thumbBox) });
            frame.x = thumbX; frame.y = thumbY;
            listC.addChild(frame);
            const artUrl = UNIT_ART_URLS[gDef.unitType];
            if (artUrl) {
              const tex = getArtTexture(artUrl);
              if (tex.baseTexture.valid) {
                const scale = Math.min((thumbBox - 4 * S) / tex.width, (thumbBox - 4 * S) / tex.height);
                const sp = new PIXI.Sprite(tex);
                sp.anchor.set(0.5);
                sp.scale.set(scale);
                sp.position.set(thumbX + thumbBox / 2, thumbY + thumbBox / 2);
                listC.addChild(sp);
              } else if (!artHooked.has(artUrl)) {
                artHooked.add(artUrl);
                tex.baseTexture.once('loaded', () => this.feedRedraw?.());
              }
            }
          }

          const matName = t(`card.${g.defId}.name` as TranslationKey);
          const nameLbl = txt(`${matName} Lv.${target.level}`, snapFont(11 * S), C.dark, true);
          nameLbl.anchor.set(0, 0.5); nameLbl.x = thumbX + thumbBox + 8 * S; nameLbl.y = rowTop + rowH / 2;
          listC.addChild(nameLbl);

          const countLbl = txt(`x${g.ids.length}`, snapFont(11 * S), C.mid);
          countLbl.anchor.set(1, 0.5); countLbl.x = listX + rowW - 8 * S; countLbl.y = rowTop + rowH / 2;
          listC.addChild(countLbl);

          if (canAssign) pushHit({ x: listX, y: rowTop, w: rowW, h: rowH - 4 * S }, () => assign(g.ids[0]));
        }

        if (scrollMax > 0) {
          drawScrollIndicator(ml, viewport, this.feedScrollPx, scrollMax);
        }

        // ── Footer: Fuse / Cancel ──
        const btnH = 26 * S;
        const btnPadX = 14 * S;
        const btnGap = 8 * S;
        const btnY = my + mh - 32 * S;

        const n = filledCount();
        const confirmOn = n === FUSION_MATERIAL_COUNT && !this.bt.busy;
        const confirmLbl = txt(`${t('roster.fuseBtn')} (${n}/${FUSION_MATERIAL_COUNT})`, snapFont(10 * S), confirmOn ? C.light : C.mid);
        const cancelLbl = txt(t('equip.cancel'), snapFont(10 * S), C.dark);
        const confirmBtnW = Math.max(90 * S, confirmLbl.width + btnPadX * 2);
        const cancelBtnW = Math.max(70 * S, cancelLbl.width + btnPadX * 2);

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
            action: () => void this.doFuse(target.id, slotIds.filter((id): id is string => id !== null)),
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

      this.feedRedraw = drawFusePanel;
      drawFusePanel();
    }
  };
}
