// Fusion flow (CHARACTER_CARDS_DESIGN §3): from the detail modal, open a ring layout — the target
// card sits in the center, 5 material slots surround it. Materials are pre-filled from the pool of
// eligible cards (same faction, same level, unlocked, not deployed) least-regrettable first; tapping
// a filled slot returns that card to the pool, tapping a candidate row below fills the next empty
// slot. Once all 5 slots are filled, Fuse consumes them and the target gains one level
// (core.doFuse → playFusionAnim, see ./feedAnim.ts).
//
// ── Target intent (2026-08-18 redesign, replaces auto-retarget + auto-continue) ────────────────
// The panel's target changes ONLY when the player taps, and the card he originally opened stays on
// screen until he says otherwise. The 2026-07-20..2026-08-10 behaviour did the opposite: opening a
// card with fewer than 5 materials on hand silently swapped in a different card (roster.
// fuseAutoRetarget), and every successful low-level fuse hopped to yet another card. Both were
// patches over one structural fact — with strict same-level 5-in-1 fusion on a 5^(L-1) curve,
// "not enough materials" is the NORMAL state from Lv.3 upward — so they fired constantly, and the
// player routinely ended up fusing a character he never chose.
//
// What replaces them:
//   · Gap state — the shortfall is SHOWN on the card the player opened ("2 more Lv.3 needed"),
//     with whatever materials do exist already sitting in the ring so he can see how close he is.
//   · Prep (./feedGap.ts's breadcrumb + ./feedPlan.ts's planPrep/pickFeeder) — "go fuse the
//     materials you're missing" as an explicit, player-started sub-task, nested at most
//     MAX_PREP_DEPTH deep, with the original goal and its progress pinned to the top of the panel
//     the whole time. Losing sight of the goal was the confusing part, not the target changing.
//   · Recommendation strip — the old findAutoTarget ranking, demoted from a decision-maker to a
//     row of taps ("these can be fused right now"), so a deployed card still gets surfaced first.
//   · After a successful fuse the panel STAYS on the same card and re-evaluates; nothing hops.
//
// The candidate list collapses duplicates into one row per defId (level is fixed = target's level,
// so a group key is just defId) with a remaining-count badge, drag-scrollable when it overflows —
// each row's own draw is ./feedList.ts's drawFuseCandidateRow.
//
// Portrait: single column (crumb → title/hint → ring → list → action → strip → footer). Landscape
// (2026-07-20): the crumb spans the top, then a left column (title/hint/ring) and a right column
// (list + action + strip + Fuse/Cancel) side by side, so the wide aspect is used instead of
// stacking everything down the middle.
//
// This depends only on Core — the reverse dependency (the confirm button needs to call
// ActionsPanel.doFuse/doPrepBatch, but actions.ts is constructed AFTER this class — see the
// assembly's ordering comment) goes through the {@link CardSceneCore.doFuse} lazy hooks instead of
// a direct reference.
//
// Split (2026-08-11, form ① per claudedocs/client-modules.md's split-form priority note, to keep
// this file under the 500-line convention): the fusion animation lives in ./feedAnim.ts; the
// candidate-row renderer in ./feedList.ts; the pure planning/ranking in ./feedPlan.ts; the crumb,
// gap notice and recommendation strip in ./feedGap.ts.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import type { Rect } from '../../layout/ILayout';
import type { CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, MAX_CARD_LEVEL, FUSION_MATERIAL_COUNT, type Faction } from '../../game/meta/cardDefs';
import { CardSceneCore, MODAL_DIM } from './core';
import { playFusionAnimImpl, type FuseRingGeom } from './feedAnim';
import { drawHeaderAndRing } from './feedRing';
import { drawFuseCandidateRow, type FuseGroup } from './feedList';
import {
  MAX_PREP_DEPTH, autoFillMaterials, countPrepRounds, listFusableTargets, pickFeeder, planPrep,
  readyMaterials,
} from './feedPlan';
import {
  CRUMB_U, GAP_U, STRIP_U, drawFuseFooter, drawGapNotice, drawPrepBatchBtn, drawPrepCrumb,
  drawRecommendStrip,
  type PrepFrame,
} from './feedGap';

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
    const candidateOf = (id: string): boolean => !cardState[id]?.teamId; // deployed cards cannot be materials
    const invOf = (): Record<string, CardInstance> => core.cb.getSave().cardInv ?? {};

    let currentTarget = initialTarget;
    /** Innermost-last. Empty = the player is working on the card he opened, which is the norm. */
    const prepStack: PrepFrame[] = [];

    // slotIds[i] = the specific CardInstance id occupying material slot i, or null when empty.
    const slotIds: (string | null)[] = new Array(FUSION_MATERIAL_COUNT).fill(null);
    const filledCount = (): number => slotIds.filter((id) => id !== null).length;
    const firstEmptySlot = (): number => slotIds.indexOf(null);

    /** Re-seed the ring from the current inventory. Called on open and on every target change, so
     *  the ring always shows the true readiness of whatever card is centered — including a partial
     *  fill, which is exactly the "you're 3 of 5 there" signal the old auto-swap hid. */
    const refillSlots = (): void => {
      slotIds.fill(null);
      autoFillMaterials(currentTarget, invOf(), candidateOf, FUSION_MATERIAL_COUNT)
        .forEach((c, i) => { slotIds[i] = c.id; });
    };
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
    const retarget = (card: CardInstance): void => {
      currentTarget = card;
      core.feedScrollPx = 0;
      refillSlots();
      drawFusePanel();
    };

    const factionOf = (card: CardInstance | undefined): Faction | undefined =>
      card ? CARD_DEFS[card.defId]?.faction : undefined;

    /**
     * The card a prep frame centres on while it runs — the one being fused UP into the material the
     * frame owes its parent. Normally a feeder that can be fused on the spot; when the whole level
     * is too thin for that (the chain-funded case, where planPrep reached one level further down to
     * pay for the run) it falls back to any eligible copy, whose own gap state then offers the next
     * level down. That fallback is what lets the stack reach its second frame.
     */
    const chooseWorking = (faction: Faction, level: number): CardInstance | undefined =>
      pickFeeder(faction, level, invOf(), candidateOf)
      ?? Object.values(invOf()).find((c) => !c.locked && c.level === level
        && CARD_DEFS[c.defId]?.faction === faction && candidateOf(c.id)
        && !Object.values(c.gear ?? {}).some((g) => !!g));

    // ── Prep: produce the missing materials as an explicit sub-task ────────────────────────────
    /** Start a prep run for the current target. Only reachable from the gap notice's button. */
    const enterPrep = (shortfall: number, feederLevel: number): void => {
      const faction = factionOf(currentTarget);
      if (!faction || prepStack.length >= MAX_PREP_DEPTH) return;
      const feeder = chooseWorking(faction, feederLevel);
      if (!feeder) return;
      prepStack.push({
        targetId: currentTarget.id, targetLevel: currentTarget.level, needed: shortfall, produced: 0,
      });
      retarget(feeder);
    };

    /** Abandon the whole stack and go back to the card the player actually wants. */
    const cancelPrep = (): void => {
      const root = prepStack[0];
      prepStack.length = 0;
      const back = root ? invOf()[root.targetId] : undefined;
      retarget(back ?? currentTarget);
    };

    /** Rounds still worth batching at the innermost frame (capped by what's left to produce). */
    const prepRoundsLeft = (): number => {
      const top = prepStack[prepStack.length - 1];
      if (!top) return 0;
      const inv = invOf();
      const faction = factionOf(inv[top.targetId]);
      const remain = top.needed - top.produced;
      if (!faction || remain <= 0) return 0;
      return countPrepRounds(faction, top.targetLevel - 1, inv, candidateOf, remain);
    };

    /** Credit `n` produced materials to the innermost frame and unwind every frame it completes. */
    const creditPrep = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const top = prepStack[prepStack.length - 1];
        if (!top) return;
        top.produced++;
        if (top.produced < top.needed) continue;
        prepStack.pop();
        const parent = invOf()[top.targetId];
        if (parent) currentTarget = parent;
      }
    };

    const runPrepBatch = (): void => {
      const top = prepStack[prepStack.length - 1];
      if (!top) return;
      void core.doPrepBatch(
        () => {
          const inv = invOf();
          const faction = factionOf(inv[top.targetId]);
          if (!faction || top.produced >= top.needed) return null;
          const feeder = pickFeeder(faction, top.targetLevel - 1, inv, candidateOf);
          if (!feeder) return null;
          const mats = autoFillMaterials(feeder, inv, candidateOf, FUSION_MATERIAL_COUNT);
          if (mats.length < FUSION_MATERIAL_COUNT) return null;
          return { targetId: feeder.id, materialIds: mats.map((m) => m.id) };
        },
        (completed) => {
          if (completed > 0) core.render(); // materials were consumed: refresh the grid + header behind
          creditPrep(completed);
          const still = prepStack[prepStack.length - 1];
          if (still) {
            // Frame still open (the run stopped early): park on the next feeder if there is one,
            // otherwise unwind one level so the player isn't left staring at a consumable.
            const faction = factionOf(invOf()[still.targetId]);
            const next = faction ? chooseWorking(faction, still.targetLevel - 1) : undefined;
            if (next) { retarget(next); return; }
            prepStack.pop();
            const parent = invOf()[still.targetId];
            retarget(parent ?? currentTarget);
            return;
          }
          retarget(invOf()[currentTarget.id] ?? currentTarget);
        },
      );
    };

    /**
     * After a single fuse resolves. The card keeps its instance id and is now one level higher, so
     * the panel simply stays on it — no hopping. The only movement is prep bookkeeping: a fuse that
     * lands a card ON the innermost frame's target level has produced one of the materials that
     * frame exists to make.
     */
    const onFuseSettled = (success: boolean): void => {
      // The fuse request can resolve after the scene was torn down (player backed out of the roster
      // while it was in flight) — bail before touching modalLayer/detailId on an already-destroyed
      // scene (2026-08-03 fix; mirrors the `if (this.destroyed) return` guard every other deferred
      // completion in this codebase uses).
      if (core.destroyed) return;
      const inv = invOf();
      const upgraded = inv[currentTarget.id];
      if (!success || !upgraded) { drawFusePanel(); return; }
      // The panel no longer closes on settle, so nothing else refreshes the roster grid + header
      // capacity/coin readout behind it — do it here. render() leaves the ring alone while
      // fuseRingOpen is set (see ../CardScene.ts's render dispatch), so this can't clobber the modal.
      core.render();
      currentTarget = upgraded;
      const top = prepStack[prepStack.length - 1];
      if (top && currentTarget.id !== top.targetId && currentTarget.level === top.targetLevel) {
        creditPrep(1);
        const still = prepStack[prepStack.length - 1];
        if (still) {
          const faction = factionOf(invOf()[still.targetId]);
          const next = faction ? chooseWorking(faction, still.targetLevel - 1) : undefined;
          if (next) { retarget(next); return; }
          prepStack.pop();
          const parent = invOf()[still.targetId];
          retarget(parent ?? currentTarget);
          return;
        }
      }
      retarget(currentTarget);
    };

    const groupsOf = (): FuseGroup[] => {
      const used = new Set(slotIds.filter((id): id is string => id !== null));
      const map = new Map<string, FuseGroup>();
      for (const c of readyMaterials(currentTarget, invOf(), candidateOf)) {
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

    const drawFusePanel = (): void => {
      // Reachable after teardown: it is both `core.feedRedraw` and the 'loaded' callback for the
      // ring/list card art below, so a late texture decode would otherwise tear down an already-
      // destroyed modalLayer from inside a PIXI Runner and kill Ticker.shared.
      if (core.destroyed) return;
      tearDownChildren(ml);
      core.modalHits = [];

      const save = core.cb.getSave();
      const inv = save.cardInv ?? {};
      const def = CARD_DEFS[currentTarget.defId];
      if (!def) { core.closeModal(); core.render(); return; }

      const topLimit = core.headerH + 4;
      const bottomLimit = h - 8;
      const availH = Math.max(0, bottomLimit - topLimit);
      const groups = groupsOf();
      const listRows = Math.min(Math.max(groups.length, 1), 4);

      // Which optional blocks are on this frame — decided before S, since they change the budget.
      const poolSize = readyMaterials(currentTarget, inv, candidateOf).length;
      const maxed = currentTarget.level >= MAX_CARD_LEVEL;
      const prep = maxed ? null : planPrep(currentTarget, inv, candidateOf);
      const showGap = !maxed && poolSize < FUSION_MATERIAL_COUNT;
      const batchRounds = showGap ? 0 : prepRoundsLeft();
      const showBatch = batchRounds > 1;
      const recommend = prepStack.length
        ? []
        : listFusableTargets(inv, candidateOf, currentTarget.defId).filter((c) => c.id !== currentTarget.id);
      const showStrip = recommend.length > 0;

      // The panel fills 80% of the primary viewport axis — height in landscape, width in portrait —
      // and S scales the whole panel (ring, rows, fonts) so the content grows to match, while the
      // secondary axis stays content-driven (2026-07-20). The *U constants below are authored at S=1.
      // Landscape's left column is narrower than portrait, so its hint line can wrap to 2 lines (see
      // drawHeaderAndRing's wordWrap) — a taller header block keeps the ring from crowding it.
      const headerBlockU = core.landscape ? 52 : 40;
      const ringU = 130, rowU = 40, footerBlockU = 52;
      const crumbU = prepStack.length ? CRUMB_U : 0;
      const actionU = showGap || showBatch ? GAP_U : 0;
      const stripU = showStrip ? STRIP_U : 0;
      const leftU = headerBlockU + ringU + 8;
      const rightU = listRows * rowU + actionU + stripU + footerBlockU + 8;
      const S = core.landscape
        ? Math.min(h * 0.8, availH) / (crumbU + Math.max(leftU, rightU))
        : (w * 0.8) / 340;
      const headerBlockH = headerBlockU * S;
      const ringH = ringU * S;
      const rowH = rowU * S;
      const footerBlockH = footerBlockU * S;
      const crumbH = crumbU * S;
      const actionH = actionU * S;
      const stripH = stripU * S;

      /** Ring + header, drawn by ./feedRing.ts; keeps the geometry the fusion animation replays over. */
      const drawRing = (colX: number, colW: number, topY: number): void => {
        this.fuseRingGeom = drawHeaderAndRing(
          ml, currentTarget, def, inv, slotIds,
          { colX, colW, topY, headerBlockH, ringH, S }, artHooked,
          (rect, action) => core.modalHits.push({ rect, action }),
          unassign, () => core.feedRedraw?.(),
        );
      };

      /** Candidate list + action block + strip + Fuse/Cancel footer, within [colX, colX+colW). */
      const drawListAndFooter = (colX: number, colW: number, listTopY: number, panelBottomY: number): void => {
        const listY = listTopY;
        // Clamp the viewport so it always cuts mid-row when groups overflow the budget — a partial
        // next row peeks above the fold instead of landing flush with the last full row.
        const listAvailH = Math.max(0, panelBottomY - footerBlockH - stripH - actionH - listY);
        const listH = peekViewportH(listAvailH, rowH, groups.length * rowH);
        if (groups.length === 0 && poolSize === 0) {
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
        const pushPlainHit = (rect: Rect, action: () => void): void => {
          core.modalHits.push({ rect, action });
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

        // ── Action block: the shortfall notice, or the batch-prep button while prepping ──
        const actionY = panelBottomY - footerBlockH - stripH - actionH;
        if (showGap) {
          drawGapNotice(
            ml, FUSION_MATERIAL_COUNT - poolSize, currentTarget.level, prep,
            colX, actionY, colW, S, core.bt.busy, prepStack.length < MAX_PREP_DEPTH, pushPlainHit,
            () => { if (prep) enterPrep(prep.shortfall, prep.feederLevel); },
          );
        } else if (showBatch) {
          drawPrepBatchBtn(ml, batchRounds, colX, actionY, colW, S, core.bt.busy, pushPlainHit, runPrepBatch);
        }

        // ── Recommendation strip: what the player COULD fuse, offered rather than applied ──
        if (showStrip) {
          drawRecommendStrip(
            ml, recommend, (id) => !candidateOf(id), colX, panelBottomY - footerBlockH - stripH,
            colW, S, artHooked, pushPlainHit,
            (card) => { if (!core.bt.busy) retarget(card); },
            () => core.feedRedraw?.(),
          );
        }

        // ── Footer: Fuse / Cancel (./feedGap.ts) ──
        // Cancel must not abort an in-flight fuse request (2026-08-03 fix): the request itself
        // isn't cancellable, so letting the player close/re-open other cards while it's still
        // pending left onFuseSettled's stale closure (currentTarget/slotIds/prepStack) free to
        // clobber whatever the player navigated to by the time it resolved. Both the footer's
        // buttons and the backdrop below are gated on the same `core.bt.busy` as Confirm.
        drawFuseFooter(
          ml, filledCount(), colX, panelBottomY, colW, S, core.bt.busy, pushPlainHit,
          () => void core.doFuse(currentTarget.id, slotIds.filter((id): id is string => id !== null), onFuseSettled),
          () => { core.closeModal(); core.render(); },
        );
      };

      let mw: number, mh: number, mx: number, my: number;
      if (core.landscape) {
        // Left column: title/hint + ring. Right column: candidate list + action + strip + footer.
        // Side by side so the wide aspect is used instead of stacking down the middle (2026-07-20).
        const gap = 12 * S;
        let leftW = 180 * S;
        let rightW = 220 * S;
        const maxTotal = w - 24;
        if (leftW + gap + rightW > maxTotal) {
          const k = Math.max(0, maxTotal - gap) / (leftW + rightW);
          leftW *= k; rightW *= k;
        }
        mw = leftW + gap + rightW;
        mh = Math.min(crumbH + Math.max(leftU, rightU) * S, availH);
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
        divider.moveTo(mx + leftW + gap / 2, my + crumbH + 8 * S).lineTo(mx + leftW + gap / 2, my + mh - 8 * S);
        ml.addChild(divider);

        drawRing(mx, leftW, my + crumbH);
        drawListAndFooter(mx + leftW + gap, rightW, my + crumbH + 8 * S, my + mh);
      } else {
        mw = Math.min(340 * S, w - 24);
        const headerRingH = headerBlockH + ringH;
        mh = Math.min(crumbH + headerRingH + listRows * rowH + actionH + stripH + footerBlockH, availH);
        mx = (w - mw) / 2;
        my = topLimit + (availH - mh) / 2;

        const dim = new PIXI.Graphics();
        dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
        ml.addChild(dim);
        const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.gold, width: 2 * S, seed: seedFor(0, 18, mw) });
        panel.x = mx; panel.y = my;
        ml.addChild(panel);

        drawRing(mx, mw, my + crumbH);
        drawListAndFooter(mx, mw, my + crumbH + headerRingH, my + mh);
      }

      // Breadcrumb last so it paints over the panel body, and only while a prep run is open.
      if (prepStack.length) {
        drawPrepCrumb(
          ml, prepStack, inv, mx, my + 3 * S, mw, S, core.bt.busy,
          (rect, action) => core.modalHits.push({ rect, action }),
          cancelPrep,
        );
      }

      // Dismiss on backdrop — suppressed while a fuse is in flight, same reasoning as Cancel above.
      core.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
      if (!core.bt.busy) {
        core.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { core.closeModal(); core.render(); } });
      }
    };

    core.feedRedraw = drawFusePanel;
    refillSlots();
    drawFusePanel();
  }
}
