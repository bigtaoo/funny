// Fusion flow (CHARACTER_CARDS_DESIGN §3, fusion redesign 2026-07-19): from the detail modal, open
// a ring layout — the target card sits in the center, 5 material slots surround it. Tapping an
// eligible candidate below (same faction, same level as the target, unlocked, not deployed) fills
// the next empty slot; tapping a filled slot returns that card to the pool. Once all 5 slots are
// filled, Fuse consumes them and the target gains one level (core.doFuse → playFusionAnim, see
// ./feedAnim.ts).
//
// The candidate list collapses duplicates into one row per defId (level is fixed = target's level,
// so a group key is just defId) with a remaining-count badge, drag-scrollable when it overflows —
// each row's own draw is ./feedList.ts's drawFuseCandidateRow.
//
// Portrait: single column (title/hint → ring → list → footer), unchanged from the original layout.
// Landscape (2026-07-20): split into a left column (title/hint/ring) and a right column
// (candidate list + Fuse/Cancel), side by side, so the whole panel uses the wide aspect instead of
// stacking everything down the middle.
//
// Auto-retarget + auto-continue (2026-07-20, revised 2026-07-22, toast trimmed 2026-07-25, ranking
// extended 2026-08-02, ranking reordered 2026-08-10): if the tapped target doesn't have 5 eligible
// materials on hand, the panel silently swaps in the best fusable card instead and toasts the player.
// After a successful fuse of a level-1/2 target, the panel prefers to KEEP the just-upgraded card (it
// retains its id, now one level higher) as the target and continue on it while it's still fusable; only
// when it can't be fused further does it drop back to another card that still has materials — silently,
// no toast (the ring already shows the swap by changing which portrait sits at the center; the
// "auto-continue" fast-forward hits this branch on nearly every fuse, so a toast here fired far too
// often — see roster.fuseAutoRetarget below, which stays toasted since it only fires once per
// panel-open). "Best fusable card" is ranked by findAutoTarget: currently-deployed-to-a-team FIRST (the
// target may be deployed even though deployed cards can never be materials), then same character line,
// then same faction, then highest level — see its doc comment below for the full rationale. Level-3+
// targets fuse once and close, requiring the player to reopen the dialog for the next round.
//
// This depends only on Core — the reverse dependency (the confirm button needs to call
// ActionsPanel.doFuse, but actions.ts is constructed AFTER this class — see the assembly's ordering
// comment) goes through the {@link CardSceneCore.doFuse} lazy hook instead of a direct reference.
//
// Split (2026-08-11, form ① per claudedocs/client-modules.md's split-form priority note, to keep
// this file under the 500-line convention): the fusion animation (no dependency on this class's
// per-open local state) lives in ./feedAnim.ts; the candidate-row renderer (per-row, explicit params)
// lives in ./feedList.ts — see FamilyScene/SectScene's lists.ts precedent.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { FACTION_COLOR } from '../../render/factionIcon';
import { cardInstanceArtUrl, getArtTexture } from '../../render/cardArt';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { buildLevelStars } from '../../render/levelStars';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import type { Rect } from '../../layout/ILayout';
import type { CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, MAX_CARD_LEVEL, FUSION_MATERIAL_COUNT, fusionMaterialCandidates, type Faction } from '../../game/meta/cardDefs';
import { CardSceneCore, MODAL_DIM } from './core';
import { playFusionAnimImpl, type FuseRingGeom } from './feedAnim';
import { drawFuseCandidateRow, type FuseGroup } from './feedList';
import { findAutoTarget as findAutoTargetImpl } from './feedAutoTarget';

/** Fusion-flow domain (see ../CardScene.ts assembly + ./core.ts for the shared state). */
export class FeedPanel {
  private fuseRingGeom: FuseRingGeom | null = null;

  constructor(private readonly core: CardSceneCore) {}

  /** In-engine fusion animation — see ./feedAnim.ts's playFusionAnimImpl for the actual visual. */
  async playFusionAnim(): Promise<void> {
    await playFusionAnimImpl(this.core, this.fuseRingGeom);
  }

  openFuseSelect(initialTarget: CardInstance): void {
    const core = this.core;
    const cardState = core.cb.getCardState?.() ?? {};
    const candidateOf = (id: string): boolean => !cardState[id]?.teamId; // deployed cards cannot be fused

    /** See ./feedAutoTarget.ts's doc comment for the full ranking rationale. */
    const findAutoTarget = (requireLevel?: number, preferDefId?: string): CardInstance | null =>
      findAutoTargetImpl(core.cb.getSave().cardInv ?? {}, candidateOf, requireLevel, preferDefId);

    let currentTarget = initialTarget;
    const initialCandidateCount = fusionMaterialCandidates(currentTarget, core.cb.getSave().cardInv ?? {})
      .filter((c) => candidateOf(c.id)).length;
    if (initialCandidateCount < FUSION_MATERIAL_COUNT) {
      const alt = findAutoTarget(undefined, currentTarget.defId);
      if (alt) {
        currentTarget = alt;
        core.showToast(t('roster.fuseAutoRetarget'), C.gold);
      }
    }
    // Auto-continue fast-forwards through the low levels: after a successful fuse the panel keeps the
    // just-upgraded card as the target (or, when it can't be fused further, drops back to a lower
    // card) instead of closing. Armed only when we START at level 1-2; a level-3+ target fuses once
    // and closes, as before. Evaluated per-fuse against the card's *current* level, not this initial
    // one, so the same card can be carried Lv.1 → Lv.2 → Lv.3 within one open session.
    const autoContinue = currentTarget.level <= 2;

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
      const save = core.cb.getSave();
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

    const { w, h } = core;
    const ml = core.modalLayer;
    tearDownChildren(ml);
    core.modalHits = [];
    core.modalOpen = true;
    core.fuseRingOpen = true;
    core.feedScrollPx = 0;
    const artHooked = new Set<string>();

    /** After a fuse settles: continue with another same-level target when the auto-continue rule
     * applies and one is available, otherwise close like before (doFuse's old default behavior). */
    const onFuseSettled = (success: boolean): void => {
      // The fuse request can resolve after the scene was torn down (player backed out of the
      // roster while it was in flight) — bail before touching modalLayer/detailId on an already-
      // destroyed scene (2026-08-03 fix; mirrors the `if (this.destroyed) return` guard every
      // other deferred completion in this codebase uses).
      if (core.destroyed) return;
      if (success && autoContinue) {
        const inv = core.cb.getSave().cardInv ?? {};
        // Priority 1: keep upgrading the SAME card the player just fused. It kept its id and is now
        // one level higher; carry it forward as long as it stays in the low-level window and still
        // has 5 eligible materials on hand (so Lv.1 → Lv.2 stays on the Lv.2 for its next fuse).
        const upgraded = inv[currentTarget.id];
        if (
          upgraded && upgraded.level <= 2 &&
          fusionMaterialCandidates(upgraded, inv).filter((m) => candidateOf(m.id)).length >= FUSION_MATERIAL_COUNT
        ) {
          currentTarget = upgraded;
          slotIds.fill(null);
          drawFusePanel();
          return;
        }
        // Priority 2: the upgraded card can't continue — drop back to another card that still has
        // materials, ranked by findAutoTarget (same character, then same faction, then deployed,
        // then level — see its doc comment). No toast: this branch fires on nearly every fuse once
        // auto-continue exhausts a low-level card, and the ring already shows the swap by changing
        // which portrait sits at the center (2026-07-25, was too frequent/long).
        const fallback = findAutoTarget(2, currentTarget.defId) ?? findAutoTarget(1, currentTarget.defId);
        if (fallback) {
          currentTarget = fallback;
          slotIds.fill(null);
          drawFusePanel();
          return;
        }
      }
      core.closeModal();
      core.detailId = null;
      core.render();
    };

    const drawFusePanel = (): void => {
      tearDownChildren(ml);
      core.modalHits = [];

      const save = core.cb.getSave();
      const def = CARD_DEFS[currentTarget.defId];
      if (!def) { core.closeModal(); core.render(); return; }

      const topLimit = core.headerH + 4;
      const bottomLimit = h - 8;
      const availH = Math.max(0, bottomLimit - topLimit);
      const groups = groupsOf();
      const listRows = Math.min(Math.max(groups.length, 1), 4);

      // The panel fills 80% of the primary viewport axis — height in landscape, width in portrait —
      // and S scales the whole panel (ring, rows, fonts) so the content grows to match, while the
      // secondary axis stays content-driven (2026-07-20). The *U constants below are authored at S=1.
      // Landscape's left column is narrower than portrait, so its hint line can wrap to 2 lines (see
      // drawHeaderAndRing's wordWrap) — a taller header block keeps the ring from crowding it.
      const headerBlockU = core.landscape ? 52 : 40;
      const ringU = 130, rowU = 40, footerBlockU = 52;
      const S = core.landscape
        ? Math.min(h * 0.8, availH) / Math.max(headerBlockU + ringU + 8, listRows * rowU + footerBlockU + 8)
        : (w * 0.8) / 340;
      const headerBlockH = headerBlockU * S;
      const ringH = ringU * S;
      const rowH = rowU * S;
      const footerBlockH = footerBlockU * S;

      const artUrlFor = (cardId: string | null): string | null => {
        if (!cardId) return null;
        const inst = save.cardInv?.[cardId];
        return inst ? cardInstanceArtUrl(inst) : null;
      };

      const drawPortrait = (
        cardId: string | null, cx: number, cy: number, r: number, faction: Faction | undefined,
      ): void => {
        const frame = new PIXI.Graphics();
        frame.lineStyle(2, faction ? FACTION_COLOR[faction] : C.mid, cardId ? 1 : 0.4);
        frame.beginFill(0xf0eee7, cardId ? 1 : 0.5).drawCircle(cx, cy, r).endFill();
        ml.addChild(frame);
        if (!cardId) return;
        const artUrl = artUrlFor(cardId);
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
        // Level as a row of gold stars, not "Lv.N" text (2026-07-25) — matches the roster grid
        // (list.ts) / detail modal (detail.ts) convention: one filled star per level, capped at
        // MAX_CARD_LEVEL. No maxW cap here (nothing to shrink to fit against) — just centered on width.
        const starN = Math.max(1, Math.min(MAX_CARD_LEVEL, currentTarget.level));
        const { container: stars } = buildLevelStars(starN, Infinity, 8 * S, 2 * S);
        stars.name = 'levelStars';
        stars.x = ringCx - stars.width / 2; stars.y = ringCy + centerR + 2 * S;
        ml.addChild(stars);

        const slotPositions: { x: number; y: number }[] = [];
        const slotArtUrl: (string | null)[] = [];
        for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
          const ang = -Math.PI / 2 + (i * 2 * Math.PI) / FUSION_MATERIAL_COUNT;
          const sx = ringCx + Math.cos(ang) * orbit, sy = ringCy + Math.sin(ang) * orbit;
          slotPositions.push({ x: sx, y: sy });
          const slotCardId = slotIds[i];
          slotArtUrl.push(artUrlFor(slotCardId));
          drawPortrait(slotCardId, sx, sy, slotR, def.faction);
          if (slotCardId) {
            core.modalHits.push({
              rect: { x: sx - slotR, y: sy - slotR, w: slotR * 2, h: slotR * 2 },
              action: () => unassign(i),
            });
          }
        }
        this.fuseRingGeom = {
          center: { x: ringCx, y: ringCy }, slots: slotPositions, color: FACTION_COLOR[def.faction],
          centerR, slotR, slotArtUrl, targetArtUrl: artUrlFor(currentTarget.id),
        };
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
        core.feedScrollPx = Math.max(0, Math.min(core.feedScrollPx, scrollMax));
        core.feedScrollMax = scrollMax;
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
          if (c) core.modalHits.push({ rect: c, action });
        };

        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          const rowTop = listY - core.feedScrollPx + i * rowH;
          if (rowTop + rowH <= listY || rowTop >= listY + listH) continue;
          const canAssign = firstEmptySlot() >= 0;
          drawFuseCandidateRow(
            core, listC, g, i, listX, rowTop, rowW, rowH, S, artHooked, canAssign,
            pushHit, () => assign(g.ids[0]), () => core.feedRedraw?.(),
          );
        }

        if (scrollMax > 0) {
          drawScrollIndicator(ml, viewport, core.feedScrollPx, scrollMax);
        }

        // ── Footer: Fuse / Cancel ──
        const btnH = 26 * S;
        const btnPadX = 14 * S;
        const btnGap = 8 * S;
        const btnY = panelBottomY - 32 * S;

        const n = filledCount();
        const confirmOn = n === FUSION_MATERIAL_COUNT && !core.bt.busy;
        // Cancel must not abort an in-flight fuse request (2026-08-03 fix): the request itself
        // isn't cancellable, so letting the player close/re-open other cards while it's still
        // pending left onFuseSettled's stale closure (currentTarget/slotIds/autoContinue) free to
        // clobber whatever the player navigated to by the time it resolved. Same busy-gate as the
        // Confirm button above.
        const cancelOn = !core.bt.busy;
        const confirmLbl = txt(`${t('roster.fuseBtn')} (${n}/${FUSION_MATERIAL_COUNT})`, snapFont(10 * S), confirmOn ? C.light : C.mid);
        const cancelLbl = txt(t('equip.cancel'), snapFont(10 * S), cancelOn ? C.dark : C.mid);
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
          core.modalHits.push({
            rect: { x: confirmX, y: btnY, w: confirmBtnW, h: btnH },
            action: () => void core.doFuse(currentTarget.id, slotIds.filter((id): id is string => id !== null), onFuseSettled),
          });
        }

        const cancelBtn = sketchPanel(cancelBtnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 21, cancelBtnW) });
        cancelBtn.x = cancelX; cancelBtn.y = btnY;
        ml.addChild(cancelBtn);
        cancelLbl.anchor.set(0.5, 0.5); cancelLbl.x = cancelX + cancelBtnW / 2; cancelLbl.y = btnY + btnH / 2;
        ml.addChild(cancelLbl);
        if (cancelOn) {
          core.modalHits.push({ rect: { x: cancelX, y: btnY, w: cancelBtnW, h: btnH }, action: () => { core.closeModal(); core.render(); } });
        }
      };

      let mw: number, mh: number, mx: number, my: number;
      if (core.landscape) {
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

      // Dismiss on backdrop — suppressed while a fuse is in flight, same reasoning as Cancel above.
      core.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
      if (!core.bt.busy) {
        core.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { core.closeModal(); core.render(); } });
      }
    };

    core.feedRedraw = drawFusePanel;
    drawFusePanel();
  }
}
