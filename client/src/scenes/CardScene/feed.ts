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
// Auto-retarget + auto-continue (2026-07-20, revised 2026-07-22, toast trimmed 2026-07-25, ranking
// extended 2026-08-02): if the tapped target doesn't have 5 eligible materials on hand, the panel
// silently swaps in the best fusable card instead and toasts the player. After a successful fuse of a
// level-1/2 target, the panel prefers to KEEP the just-upgraded card (it retains its id, now one level
// higher) as the target and continue on it while it's still fusable; only when it can't be fused
// further does it drop back to another card that still has materials — silently, no toast (the ring
// already shows the swap by changing which portrait sits at the center; the "auto-continue" fast-forward
// hits this branch on nearly every fuse, so a toast here fired far too often — see roster.fuseAutoRetarget
// below, which stays toasted since it only fires once per panel-open). "Best fusable card" is ranked by
// findAutoTarget: same character line first, then same faction, then currently-deployed-to-a-team (the
// target may be deployed even though deployed cards can never be materials), then highest level — see
// its doc comment below for the full rationale. Level-3+ targets fuse once and close, requiring the
// player to reopen the dialog for the next round.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { FACTION_COLOR } from '../../render/factionIcon';
import { cardInstanceArtUrl, getArtTexture } from '../../render/cardArt';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { buildIcon } from '../../render/icons';
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
 * material portraits converging on the target before the burst plays. Carries each slot's/the
 * target's art URL + the ring's own radii so the animation can fly the *actual* portraits inward
 * instead of anonymous dots (2026-08-01: "everyone giving their power" reads a lot stronger when
 * you can see whose power it is). */
interface FuseRingGeom {
  center: { x: number; y: number };
  slots: { x: number; y: number }[];
  color: number;
  centerR: number;
  slotR: number;
  slotArtUrl: (string | null)[];
  targetArtUrl: string | null;
}

export function FeedMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<FeedHandlers> {
  return class extends Base {
    private fuseRingGeom: FuseRingGeom | null = null;

    /** In-engine fusion animation: the 5 material portraits swoop into the target one after another
     * (each on a bowed path with a fading ink trail, so the motion reads as "energy flow" rather than
     * "shape sliding"), each arrival ripples the target, then the target itself punches outward in a
     * gold burst. Program-art stand-in — a dedicated VFX-editor asset replaces this call site once
     * authored (feed.ts owns the whole visual, so the swap is local); this version reuses the cards'
     * own portrait textures + plain Graphics strokes (no new art, no extra texture uploads or additive
     * blending) to stay cheap on low-end/WeChat devices (2026-08-01). */
    async playFusionAnim(): Promise<void> {
      const ml = this.modalLayer;
      const { w, h } = this;
      const geom = this.fuseRingGeom;
      const cx = geom?.center.x ?? w / 2;
      const cy = geom?.center.y ?? h / 2;
      const color = geom?.color ?? C.gold;
      const centerR = geom?.centerR ?? 24;
      const slotR = geom?.slotR ?? 15;

      // Phase 1: the 5 material portraits swoop into the target, staggered so they read as distinct
      // contributions instead of one synchronized slide; each arrival ripples the target.
      if (geom && geom.slots.length > 0) {
        const STAGGER_MS = 60;
        const FLIGHT_MS = 360;
        const RIPPLE_MS = 240;
        const BOW = 30; // px the path bows sideways before straightening into the target

        const dots = geom.slots.map((s, i) => {
          const artUrl = geom.slotArtUrl[i];
          const tex = artUrl ? getArtTexture(artUrl) : null;
          let display: PIXI.Sprite | PIXI.Graphics;
          if (tex && tex.baseTexture.valid) {
            const sp = new PIXI.Sprite(tex);
            sp.anchor.set(0.5);
            sp.scale.set(Math.min((slotR * 2) / tex.width, (slotR * 2) / tex.height));
            display = sp;
          } else {
            const g = new PIXI.Graphics();
            g.beginFill(color).drawCircle(0, 0, slotR * 0.7).endFill();
            display = g;
          }
          display.position.set(s.x, s.y);
          display.visible = false; // hidden until its stagger delay elapses
          ml.addChild(display);
          const trail = new PIXI.Graphics();
          ml.addChild(trail);
          return {
            display, trail, from: s, delay: i * STAGGER_MS, history: [] as { x: number; y: number }[],
            bowSign: i % 2 === 0 ? 1 : -1, baseScaleX: display.scale.x, baseScaleY: display.scale.y, done: false,
          };
        });
        const ripples: { start: number; g: PIXI.Graphics }[] = [];

        await new Promise<void>((resolve) => {
          const start = performance.now();
          const cleanupAndResolve = (): void => {
            for (const d of dots) { if (!d.display.destroyed) d.display.destroy(); if (!d.trail.destroyed) d.trail.destroy(); }
            for (const r of ripples) if (!r.g.destroyed) r.g.destroy();
            resolve();
          };
          const tick = (): void => {
            // If anything tore down the modal layer (scene destroy, a texture-load redraw) mid-flight,
            // the still-live dots become destroyed graphics; touching them would throw. Bail cleanly.
            if (ml.destroyed || dots.some((d) => !d.done && d.display.destroyed)) { cleanupAndResolve(); return; }
            const now = performance.now();
            let allDone = true;
            for (const d of dots) {
              if (d.done) continue;
              const localT = now - start - d.delay;
              if (localT < 0) { allDone = false; continue; } // still waiting for its turn
              d.display.visible = true;
              const f = Math.min(1, localT / FLIGHT_MS);
              const e = 1 - (1 - f) * (1 - f); // ease-out
              const dx = cx - d.from.x, dy = cy - d.from.y;
              const len = Math.hypot(dx, dy) || 1;
              const bow = Math.sin(f * Math.PI) * BOW * d.bowSign; // bows out then straightens on arrival
              const x = d.from.x + dx * e + (-dy / len) * bow;
              const y = d.from.y + dy * e + (dx / len) * bow;
              d.display.position.set(x, y);
              d.display.scale.set(d.baseScaleX * (1 - 0.6 * e), d.baseScaleY * (1 - 0.6 * e));
              d.display.alpha = 1 - 0.3 * e;
              d.history.unshift({ x, y });
              if (d.history.length > 6) d.history.length = 6;
              d.trail.clear();
              for (let i = 0; i < d.history.length - 1; i++) {
                const a = d.history[i], b = d.history[i + 1];
                const t = i / d.history.length;
                d.trail.lineStyle(Math.max(1, slotR * 0.5 * (1 - t)), color, (1 - t) * 0.35);
                d.trail.moveTo(a.x, a.y).lineTo(b.x, b.y);
              }
              if (f >= 1) {
                d.done = true;
                d.display.destroy();
                d.trail.destroy();
                ripples.push({ start: now, g: ml.addChild(new PIXI.Graphics()) });
              } else {
                allDone = false;
              }
            }
            for (const r of ripples) {
              const rf = Math.min(1, (now - r.start) / RIPPLE_MS);
              if (rf < 1) allDone = false;
              r.g.clear();
              r.g.lineStyle(3, color, 1 - rf);
              r.g.drawCircle(cx, cy, centerR * 0.5 + rf * centerR * 0.9);
            }
            if (allDone) cleanupAndResolve(); else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }

      // Phase 2: the target absorbs it all — screen flash, expanding ring + radiating spokes, and the
      // target portrait itself punches outward (squash/stretch) so the payoff reads as impact, not just
      // a shape pulsing in empty space. That shockwave is a symmetric sin pulse (0 → 1 → 0), so its own
      // last frame is exactly invisible — fine for a shockwave, but it left the animation with nothing
      // to land on. A separate gold "seal" halo fixes that: fixed geometry (drawn ONCE below, radius
      // never changes) that blooms in alongside the shockwave, holds at full strength for a beat once
      // the shockwave has faded, then eases out — every frame after the first is a single `alpha`
      // write, no clear+redraw, so the extra hold time is essentially free (2026-08-02).
      const flash = new PIXI.Graphics();
      flash.beginFill(0xffe28a, 0).drawRect(0, 0, w, h).endFill();
      ml.addChild(flash);
      const burst = new PIXI.Graphics();
      ml.addChild(burst);
      const haloR = centerR + 12;
      const halo = new PIXI.Graphics();
      halo.lineStyle(3, C.gold, 1).drawCircle(cx, cy, haloR);
      halo.beginFill(C.gold, 0.14).drawCircle(cx, cy, haloR).endFill();
      halo.alpha = 0;
      ml.addChild(halo);
      let targetOverlay: PIXI.Sprite | null = null;
      let targetBaseScale = 1;
      if (geom?.targetArtUrl) {
        const tex = getArtTexture(geom.targetArtUrl);
        if (tex.baseTexture.valid) {
          targetOverlay = new PIXI.Sprite(tex);
          targetOverlay.anchor.set(0.5);
          targetBaseScale = Math.min((centerR * 2) / tex.width, (centerR * 2) / tex.height);
          targetOverlay.scale.set(targetBaseScale);
          targetOverlay.position.set(cx, cy);
          ml.addChild(targetOverlay);
        }
      }
      const SPOKES = 8;
      const BURST_MS = 700;
      const HALO_PEAK_ALPHA = 0.8;
      const HALO_FADE_IN_MS = BURST_MS * 0.6; // blooms in while the shockwave is still visible
      const HALO_HOLD_MS = 220; // ...then holds solid for a beat once the shockwave's gone — the "landing" frame
      const HALO_FADE_OUT_MS = 260;
      const TOTAL_MS = BURST_MS + HALO_HOLD_MS + HALO_FADE_OUT_MS;
      let burstLive = true;
      await new Promise<void>((resolve) => {
        const start = performance.now();
        const tick = (): void => {
          // flash/burst are destroyed intentionally below once the shockwave finishes, well before
          // halo — so only halo (+ modal-layer teardown) indicates an external abort worth bailing on.
          if (ml.destroyed || halo.destroyed || (targetOverlay && targetOverlay.destroyed)) { resolve(); return; }
          const elapsed = performance.now() - start;

          if (burstLive) {
            const f = Math.min(1, elapsed / BURST_MS);
            const pulse = Math.sin(f * Math.PI); // 0 → 1 → 0
            flash.alpha = pulse * 0.5;
            burst.clear();
            burst.lineStyle(4, C.gold, pulse);
            burst.drawCircle(cx, cy, centerR + pulse * 70);
            burst.lineStyle(2, color, pulse * 0.8);
            for (let i = 0; i < SPOKES; i++) {
              const ang = (i * 2 * Math.PI) / SPOKES;
              const r0 = centerR + pulse * 18, r1 = centerR + pulse * 100;
              burst.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
              burst.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
            }
            if (targetOverlay) {
              const punch = Math.sin(Math.min(1, f * 1.6) * Math.PI) * 0.22 * (1 - f * 0.5);
              targetOverlay.scale.set(targetBaseScale * (1 + punch), targetBaseScale * (1 - punch * 0.6));
            }
            if (f >= 1) { burstLive = false; flash.destroy(); burst.destroy(); }
          }

          // Halo geometry was drawn once above; every frame here is just an alpha write.
          if (elapsed < HALO_FADE_IN_MS) {
            const e = elapsed / HALO_FADE_IN_MS;
            halo.alpha = HALO_PEAK_ALPHA * e * e; // ease-in
          } else if (elapsed < BURST_MS + HALO_HOLD_MS) {
            halo.alpha = HALO_PEAK_ALPHA;
          } else {
            const fadeF = Math.min(1, (elapsed - BURST_MS - HALO_HOLD_MS) / HALO_FADE_OUT_MS);
            halo.alpha = HALO_PEAK_ALPHA * (1 - fadeF);
          }

          if (elapsed >= TOTAL_MS) {
            if (!flash.destroyed) flash.destroy();
            if (!burst.destroyed) burst.destroy();
            halo.destroy();
            targetOverlay?.destroy();
            resolve();
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      });
    }

    openFuseSelect(initialTarget: CardInstance): void {
      const cardState = this.cb.getCardState?.() ?? {};
      const candidateOf = (id: string): boolean => !cardState[id]?.teamId; // deployed cards cannot be fused

      /** Best owned card to fuse right now: unlocked, below max level, with >= FUSION_MATERIAL_COUNT
       * eligible same-faction same-level materials already on hand. The target itself MAY be deployed
       * (only materials must be free — `candidateOf` below gates the material count, not the target).
       * Ranked lexicographically, most-significant first (2026-08-02): (1) same `defId` as `preferDefId`
       * (the card the player was already fusing), so auto-retarget/auto-continue keep working the same
       * character line when another copy is still fusable; (2) same faction as that card, so falling
       * back never jumps to an unrelated faction just because it happens to rank higher on some other
       * axis (e.g. mid-fusing a Tao-faction card should never auto-switch to an Anna-faction one); (3)
       * currently deployed to an SLG team, so auto-continue prioritizes strengthening the active roster
       * over bench copies; (4) highest level. */
      const findAutoTarget = (requireLevel?: number, preferDefId?: string): CardInstance | null => {
        const inv = this.cb.getSave().cardInv ?? {};
        const preferFaction = preferDefId ? CARD_DEFS[preferDefId]?.faction : undefined;
        const rankOf = (c: CardInstance): [number, number, number, number] => [
          preferDefId && c.defId === preferDefId ? 1 : 0,
          preferFaction && CARD_DEFS[c.defId]?.faction === preferFaction ? 1 : 0,
          candidateOf(c.id) ? 0 : 1,
          c.level,
        ];
        const isBetter = (a: readonly number[], b: readonly number[]): boolean => {
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
          return false;
        };
        let best: CardInstance | null = null;
        let bestRank: [number, number, number, number] | null = null;
        for (const c of Object.values(inv)) {
          if (c.locked || c.level >= MAX_CARD_LEVEL || !CARD_DEFS[c.defId]) continue;
          if (requireLevel !== undefined && c.level !== requireLevel) continue;
          const cnt = fusionMaterialCandidates(c, inv).filter((m) => candidateOf(m.id)).length;
          if (cnt < FUSION_MATERIAL_COUNT) continue;
          const rank = rankOf(c);
          if (!best || isBetter(rank, bestRank!)) { best = c; bestRank = rank; }
        }
        return best;
      };

      let currentTarget = initialTarget;
      const initialCandidateCount = fusionMaterialCandidates(currentTarget, this.cb.getSave().cardInv ?? {})
        .filter((c) => candidateOf(c.id)).length;
      if (initialCandidateCount < FUSION_MATERIAL_COUNT) {
        const alt = findAutoTarget(undefined, currentTarget.defId);
        if (alt) {
          currentTarget = alt;
          this.showToast(t('roster.fuseAutoRetarget'), C.gold);
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
      this.fuseRingOpen = true;
      this.feedScrollPx = 0;
      const artHooked = new Set<string>();

      /** After a fuse settles: continue with another same-level target when the auto-continue rule
       * applies and one is available, otherwise close like before (doFuse's old default behavior). */
      const onFuseSettled = (success: boolean): void => {
        // The fuse request can resolve after the scene was torn down (player backed out of the
        // roster while it was in flight) — bail before touching modalLayer/detailId on an already-
        // destroyed scene (2026-08-03 fix; mirrors the `if (this.destroyed) return` guard every
        // other deferred completion in this codebase uses).
        if (this.destroyed) return;
        if (success && autoContinue) {
          const inv = this.cb.getSave().cardInv ?? {};
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
          // (list.ts) / detail modal (detail.ts) convention: one filled star per level, capped at 9.
          const stars = new PIXI.Container();
          stars.name = 'levelStars';
          const starN = Math.max(1, Math.min(9, currentTarget.level));
          const starSize = 8 * S;
          const starGap = 2 * S;
          for (let i = 0; i < starN; i++) {
            const st = buildIcon('star', starSize, C.gold);
            st.x = i * (starSize + starGap);
            stars.addChild(st);
          }
          const starsW = starN * starSize + (starN - 1) * starGap;
          stars.x = ringCx - starsW / 2; stars.y = ringCy + centerR + 2 * S;
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
              this.modalHits.push({
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
              const artUrl = cardInstanceArtUrl({ defId: g.defId });
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

            // Level suffix dropped (2026-07-25): every row already matches the target's current level
            // (fusionMaterialCandidates enforces it), and the level itself now shows once as stars on
            // the ring target above — restating "Lv.N" per row was redundant.
            const matName = t(`card.${g.defId}.name` as TranslationKey);
            const nameLbl = txt(matName, snapFont(11 * S), C.dark, true);
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
          // Cancel must not abort an in-flight fuse request (2026-08-03 fix): the request itself
          // isn't cancellable, so letting the player close/re-open other cards while it's still
          // pending left onFuseSettled's stale closure (currentTarget/slotIds/autoContinue) free to
          // clobber whatever the player navigated to by the time it resolved. Same busy-gate as the
          // Confirm button above.
          const cancelOn = !this.bt.busy;
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
          if (cancelOn) {
            this.modalHits.push({ rect: { x: cancelX, y: btnY, w: cancelBtnW, h: btnH }, action: () => { this.closeModal(); this.render(); } });
          }
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

        // Dismiss on backdrop — suppressed while a fuse is in flight, same reasoning as Cancel above.
        this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
        if (!this.bt.busy) {
          this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.closeModal(); this.render(); } });
        }
      };

      this.feedRedraw = drawFusePanel;
      drawFusePanel();
    }
  };
}
