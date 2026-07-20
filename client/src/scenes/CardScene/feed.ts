// Fusion flow (CHARACTER_CARDS_DESIGN §3, fusion redesign 2026-07-19): from the detail modal, open
// a ring layout — the target card sits in the center, 5 material slots surround it. Tapping an
// eligible candidate below (same faction, same level as the target, unlocked, not deployed) fills
// the next empty slot; tapping a filled slot returns that card to the pool. Once all 5 slots are
// filled, Fuse consumes them and the target gains one level (doFuse → playFusionAnim).
//
// The candidate list collapses duplicates into one row per defId (level is fixed = target's level,
// so a group key is just defId) with a remaining-count badge, drag-scrollable when it overflows.
//
// Portrait: single column (title/hint → ring → list → footer), unchanged from the original layout.
// Landscape (2026-07-20): split into a left column (title/hint/ring) and a right column
// (candidate list + Fuse/Cancel), side by side, so the whole panel uses the wide aspect instead of
// stacking everything down the middle.
//
// Auto-retarget + auto-continue (2026-07-20): if the tapped target doesn't have 5 eligible materials
// on hand, the panel silently swaps in the best fusable card instead (highest level first) and toasts
// the player. After a successful fuse, level-1/2 targets auto-load another same-level card and stay
// open (fast-forward through the low levels); level-3+ targets close as before, requiring the player
// to reopen the dialog for the next round.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { FACTION_COLOR } from '../../render/factionIcon';
import { UNIT_ART_URLS, getArtTexture } from '../../render/cardArt';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import type { Rect } from '../../layout/ILayout';
import type { CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, MAX_CARD_LEVEL, FUSION_MATERIAL_COUNT, fusionMaterialCandidates, type Faction } from '../../game/meta/cardDefs';
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

/** Screen-space geometry of the last-drawn ring, captured so playFusionAnim can animate the 5
 * material portraits converging on the target before the burst plays. */
interface FuseRingGeom {
  center: { x: number; y: number };
  slots: { x: number; y: number }[];
  color: number;
}

export function FeedMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<FeedHandlers> {
  return class extends Base {
    private fuseRingGeom: FuseRingGeom | null = null;

    /** Placeholder in-engine fusion animation: the 5 material portraits converge on the target first,
     * then the center portrait pulses gold. Program-art stand-in — a dedicated VFX-editor asset
     * replaces this call site once authored (feed.ts owns the whole visual, so the swap is local). */
    async playFusionAnim(): Promise<void> {
      const ml = this.modalLayer;
      const { w, h } = this;
      const geom = this.fuseRingGeom;
      const cx = geom?.center.x ?? w / 2;
      const cy = geom?.center.y ?? h / 2;

      // Phase 1: the 5 material portraits converge on the target.
      if (geom && geom.slots.length > 0) {
        const CONVERGE_MS = 380;
        const dots = geom.slots.map((s) => {
          const g = new PIXI.Graphics();
          g.beginFill(geom.color).drawCircle(0, 0, 15).endFill();
          g.position.set(s.x, s.y);
          ml.addChild(g);
          return { g, from: s };
        });
        await new Promise<void>((resolve) => {
          const start = performance.now();
          const tick = (): void => {
            // If anything tore down the modal layer (scene destroy, a texture-load redraw) the dots
            // are destroyed graphics; touching them would throw. Bail cleanly so the fuse still settles.
            if (dots.some((d) => d.g.destroyed)) { for (const d of dots) if (!d.g.destroyed) d.g.destroy(); resolve(); return; }
            const f = Math.min(1, (performance.now() - start) / CONVERGE_MS);
            const e = 1 - (1 - f) * (1 - f); // ease-out
            for (const d of dots) {
              d.g.x = d.from.x + (cx - d.from.x) * e;
              d.g.y = d.from.y + (cy - d.from.y) * e;
              d.g.scale.set(1 - 0.6 * e);
              d.g.alpha = 1 - 0.3 * e;
            }
            if (f < 1) {
              requestAnimationFrame(tick);
            } else {
              for (const d of dots) d.g.destroy();
              resolve();
            }
          };
          requestAnimationFrame(tick);
        });
      }

      // Phase 2: burst at the center.
      const flash = new PIXI.Graphics();
      flash.beginFill(0xffe28a, 0).drawRect(0, 0, w, h).endFill();
      ml.addChild(flash);
      const burst = new PIXI.Graphics();
      ml.addChild(burst);
      const DURATION_MS = 650;
      await new Promise<void>((resolve) => {
        const start = performance.now();
        const tick = (): void => {
          // Same guard as phase 1: a torn-down modal layer leaves flash/burst destroyed, and
          // burst.clear() on a destroyed Graphics throws (null _geometry). Bail cleanly instead.
          if (flash.destroyed || burst.destroyed) { resolve(); return; }
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

    openFuseSelect(initialTarget: CardInstance): void {
      const cardState = this.cb.getCardState?.() ?? {};
      const candidateOf = (id: string): boolean => !cardState[id]?.teamId; // deployed cards cannot be fused

      /** Best owned card to fuse right now: unlocked, undeployed, below max level, with >= FUSION_MATERIAL_COUNT
       * eligible same-faction same-level materials already on hand. Prefers the highest level. */
      const findAutoTarget = (requireLevel?: number): CardInstance | null => {
        const inv = this.cb.getSave().cardInv ?? {};
        let best: CardInstance | null = null;
        for (const c of Object.values(inv)) {
          if (c.locked || !candidateOf(c.id) || c.level >= MAX_CARD_LEVEL || !CARD_DEFS[c.defId]) continue;
          if (requireLevel !== undefined && c.level !== requireLevel) continue;
          const cnt = fusionMaterialCandidates(c, inv).filter((m) => candidateOf(m.id)).length;
          if (cnt < FUSION_MATERIAL_COUNT) continue;
          if (!best || c.level > best.level) best = c;
        }
        return best;
      };

      let currentTarget = initialTarget;
      const initialCandidateCount = fusionMaterialCandidates(currentTarget, this.cb.getSave().cardInv ?? {})
        .filter((c) => candidateOf(c.id)).length;
      if (initialCandidateCount < FUSION_MATERIAL_COUNT) {
        const alt = findAutoTarget();
        if (alt) {
          currentTarget = alt;
          this.showToast(t('roster.fuseAutoRetarget'), C.gold);
        }
      }
      // Levels 1-2 auto-continue onto another same-level card after each successful fuse; level 3+
      // always requires the player to reopen the dialog for the next round.
      const continueLevel = currentTarget.level <= 2 ? currentTarget.level : null;

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
        const save = this.cb.getSave();
        const allCandidates = fusionMaterialCandidates(currentTarget, save.cardInv ?? {}).filter((c) => candidateOf(c.id));
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

      /** After a fuse settles: continue with another same-level target when the auto-continue rule
       * applies and one is available, otherwise close like before (doFuse's old default behavior). */
      const onFuseSettled = (success: boolean): void => {
        if (success && continueLevel !== null) {
          const next = findAutoTarget(continueLevel);
          if (next) {
            currentTarget = next;
            slotIds.fill(null);
            drawFusePanel();
            return;
          }
        }
        this.closeModal();
        this.detailId = null;
        this.render();
      };

      const drawFusePanel = (): void => {
        tearDownChildren(ml);
        this.modalHits = [];

        const save = this.cb.getSave();
        const def = CARD_DEFS[currentTarget.defId];
        if (!def) { this.closeModal(); this.render(); return; }

        const topLimit = this.headerH + 4;
        const bottomLimit = h - 8;
        const availH = Math.max(0, bottomLimit - topLimit);
        const groups = groupsOf();
        const listRows = Math.min(Math.max(groups.length, 1), 4);

        // The panel fills 80% of the primary viewport axis — height in landscape, width in portrait —
        // and S scales the whole panel (ring, rows, fonts) so the content grows to match, while the
        // secondary axis stays content-driven (2026-07-20). The *U constants below are authored at S=1.
        // Landscape's left column is narrower than portrait, so its hint line can wrap to 2 lines (see
        // drawHeaderAndRing's wordWrap) — a taller header block keeps the ring from crowding it.
        const headerBlockU = this.landscape ? 52 : 40;
        const ringU = 130, rowU = 40, footerBlockU = 52;
        const S = this.landscape
          ? Math.min(h * 0.8, availH) / Math.max(headerBlockU + ringU + 8, listRows * rowU + footerBlockU + 8)
          : (w * 0.8) / 340;
        const headerBlockH = headerBlockU * S;
        const ringH = ringU * S;
        const rowH = rowU * S;
        const footerBlockH = footerBlockU * S;

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

        /** Title + hint + ring (target card + 5 material slots), centered within [colX, colX+colW). */
        const drawHeaderAndRing = (colX: number, colW: number, topY: number): void => {
          const titleLbl = txt(t('roster.fuseTitle'), snapFont(13 * S), C.dark, true);
          titleLbl.anchor.set(0.5, 0); titleLbl.x = colX + colW / 2; titleLbl.y = topY + 8 * S;
          ml.addChild(titleLbl);

          const hintLbl = txt(t('roster.fuseHint'), snapFont(9.5 * S), C.mid);
          hintLbl.style.wordWrap = true;
          hintLbl.style.wordWrapWidth = colW - 12 * S;
          hintLbl.style.align = 'center';
          hintLbl.anchor.set(0.5, 0); hintLbl.x = colX + colW / 2; hintLbl.y = topY + 24 * S;
          ml.addChild(hintLbl);

          const ringCx = colX + colW / 2;
          const ringCy = topY + headerBlockH + ringH / 2;
          const centerR = 22 * S;
          const slotR = 15 * S;
          const orbit = 46 * S;

          // Connecting spokes (drawn under the portraits) so the ring reads as one fusion unit.
          for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
            const ang = -Math.PI / 2 + (i * 2 * Math.PI) / FUSION_MATERIAL_COUNT;
            const sx = ringCx + Math.cos(ang) * orbit, sy = ringCy + Math.sin(ang) * orbit;
            const spoke = new PIXI.Graphics();
            spoke.lineStyle(1.5, C.mid, slotIds[i] ? 0.7 : 0.3);
            spoke.moveTo(ringCx, ringCy).lineTo(sx, sy);
            ml.addChild(spoke);
          }

          drawPortrait(currentTarget.id, ringCx, ringCy, centerR, def.faction);
          const lvlLbl = txt(`Lv.${currentTarget.level}`, snapFont(9 * S), C.dark, true);
          lvlLbl.anchor.set(0.5, 0); lvlLbl.x = ringCx; lvlLbl.y = ringCy + centerR + 2 * S;
          ml.addChild(lvlLbl);

          const slotPositions: { x: number; y: number }[] = [];
          for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
            const ang = -Math.PI / 2 + (i * 2 * Math.PI) / FUSION_MATERIAL_COUNT;
            const sx = ringCx + Math.cos(ang) * orbit, sy = ringCy + Math.sin(ang) * orbit;
            slotPositions.push({ x: sx, y: sy });
            const slotCardId = slotIds[i];
            drawPortrait(slotCardId, sx, sy, slotR, def.faction);
            if (slotCardId) {
              this.modalHits.push({
                rect: { x: sx - slotR, y: sy - slotR, w: slotR * 2, h: slotR * 2 },
                action: () => unassign(i),
              });
            }
          }
          this.fuseRingGeom = { center: { x: ringCx, y: ringCy }, slots: slotPositions, color: FACTION_COLOR[def.faction] };
        };

        /** Candidate list + Fuse/Cancel footer, within [colX, colX+colW), from listTopY down to (my+mh). */
        const drawListAndFooter = (colX: number, colW: number, listTopY: number, panelBottomY: number): void => {
          const listY = listTopY;
          // Clamp the viewport so it always cuts mid-row when groups overflow the budget — a partial
          // next row peeks above the fold instead of landing flush with the last full row.
          const listAvailH = Math.max(0, panelBottomY - footerBlockH - listY);
          const listH = peekViewportH(listAvailH, rowH, groups.length * rowH);
          if (groups.length === 0 && filledCount() < FUSION_MATERIAL_COUNT) {
            const empty = txt(t('roster.fuseEmpty'), snapFont(11 * S), C.mid);
            empty.anchor.set(0.5, 0.5); empty.x = colX + colW / 2; empty.y = listY + listH / 2;
            ml.addChild(empty);
          }

          const contentH = groups.length * rowH;
          const scrollMax = Math.max(0, contentH - listH);
          this.feedScrollPx = Math.max(0, Math.min(this.feedScrollPx, scrollMax));
          this.feedScrollMax = scrollMax;
          const barW = scrollMax > 0 ? 8 * S : 0;
          const listX = colX + 4 * S;
          const rowW = colW - 8 * S - barW;
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

            const rowBg = sketchPanel(rowW, rowH - 4 * S, { fill: canAssign ? 0xf5f3ec : 0xeeeeee, border: C.mid, seed: seedFor(i, 19, rowW) });
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
            const nameLbl = txt(`${matName} Lv.${currentTarget.level}`, snapFont(11 * S), C.dark, true);
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
          const btnY = panelBottomY - 32 * S;

          const n = filledCount();
          const confirmOn = n === FUSION_MATERIAL_COUNT && !this.bt.busy;
          const confirmLbl = txt(`${t('roster.fuseBtn')} (${n}/${FUSION_MATERIAL_COUNT})`, snapFont(10 * S), confirmOn ? C.light : C.mid);
          const cancelLbl = txt(t('equip.cancel'), snapFont(10 * S), C.dark);
          const confirmBtnW = Math.max(90 * S, confirmLbl.width + btnPadX * 2);
          const cancelBtnW = Math.max(70 * S, cancelLbl.width + btnPadX * 2);

          const pairW = confirmBtnW + btnGap + cancelBtnW;
          const confirmX = colX + colW / 2 - pairW / 2;
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
              action: () => void this.doFuse(currentTarget.id, slotIds.filter((id): id is string => id !== null), onFuseSettled),
            });
          }

          const cancelBtn = sketchPanel(cancelBtnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 21, cancelBtnW) });
          cancelBtn.x = cancelX; cancelBtn.y = btnY;
          ml.addChild(cancelBtn);
          cancelLbl.anchor.set(0.5, 0.5); cancelLbl.x = cancelX + cancelBtnW / 2; cancelLbl.y = btnY + btnH / 2;
          ml.addChild(cancelLbl);
          this.modalHits.push({ rect: { x: cancelX, y: btnY, w: cancelBtnW, h: btnH }, action: () => { this.closeModal(); this.render(); } });
        };

        let mw: number, mh: number, mx: number, my: number;
        if (this.landscape) {
          // Left column: title/hint + ring. Right column: candidate list + footer. Side by side so
          // the wide aspect is used instead of stacking everything down the middle (2026-07-20).
          const gap = 12 * S;
          let leftW = 180 * S;
          let rightW = 220 * S;
          const maxTotal = w - 24;
          if (leftW + gap + rightW > maxTotal) {
            const k = Math.max(0, maxTotal - gap) / (leftW + rightW);
            leftW *= k; rightW *= k;
          }
          mw = leftW + gap + rightW;
          const leftContentH = headerBlockH + ringH + 8 * S;
          const rightContentH = listRows * rowH + footerBlockH + 8 * S;
          mh = Math.min(Math.max(leftContentH, rightContentH), availH);
          mx = (w - mw) / 2;
          my = topLimit + (availH - mh) / 2;

          const dim = new PIXI.Graphics();
          dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
          ml.addChild(dim);
          const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.gold, width: 2 * S, seed: seedFor(0, 18, mw) });
          panel.x = mx; panel.y = my;
          ml.addChild(panel);

          const divider = new PIXI.Graphics();
          divider.lineStyle(1.5 * S, C.mid, 0.5);
          divider.moveTo(mx + leftW + gap / 2, my + 8 * S).lineTo(mx + leftW + gap / 2, my + mh - 8 * S);
          ml.addChild(divider);

          drawHeaderAndRing(mx, leftW, my);
          drawListAndFooter(mx + leftW + gap, rightW, my + 8 * S, my + mh);
        } else {
          mw = Math.min(340 * S, w - 24);
          const headerRingH = headerBlockH + ringH;
          mh = Math.min(headerRingH + listRows * rowH + footerBlockH, availH);
          mx = (w - mw) / 2;
          my = topLimit + (availH - mh) / 2;

          const dim = new PIXI.Graphics();
          dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
          ml.addChild(dim);
          const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.gold, width: 2 * S, seed: seedFor(0, 18, mw) });
          panel.x = mx; panel.y = my;
          ml.addChild(panel);

          drawHeaderAndRing(mx, mw, my);
          drawListAndFooter(mx, mw, my + headerRingH, my + mh);
        }

        // Dismiss on backdrop
        this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
        this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.closeModal(); this.render(); } });
      };

      this.feedRedraw = drawFusePanel;
      drawFusePanel();
    }
  };
}
