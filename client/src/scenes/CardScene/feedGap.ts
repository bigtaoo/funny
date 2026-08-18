// The fuse panel's new chrome (2026-08-18, CHARACTER_CARDS_DESIGN §3.2): the prep breadcrumb, the
// shortfall notice, and the recommendation strip. All three exist to serve one contract — the
// panel's target changes ONLY when the player taps, and the card he originally opened stays on
// screen the whole time. Before this, a target with no materials was never shown at all: the panel
// silently swapped to a different card and toasted about it.
//
// Split out of feed.ts as form ① (independent functions, no domain class) per
// claudedocs/client-modules.md, same reasoning as ./feedList.ts — feed.ts owns the state machine,
// these own pixels, and neither needs the other's locals beyond explicit params.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { FACTION_COLOR } from '../../render/factionIcon';
import { cardInstanceArtUrl, getArtTexture } from '../../render/cardArt';
import { buildLevelStars } from '../../render/levelStars';
import type { Rect } from '../../layout/ILayout';
import { CARD_DEFS, FUSION_MATERIAL_COUNT } from '../../game/meta/cardDefs';
import type { CardInstance } from '../../game/meta/SaveData';
import type { PrepPlan } from './feedPlan';

/** One level of "I am fusing X only so it can become material for Y" — see feed.ts's prep stack. */
export interface PrepFrame {
  /** Card this frame is producing materials FOR. */
  targetId: string;
  /** Level the produced cards must reach (= the frame target's own level). */
  targetLevel: number;
  /** How many cards at targetLevel this frame set out to produce. */
  needed: number;
  /** How many it has produced so far. */
  produced: number;
}

/** Height units (at S=1) the caller must reserve when the matching block is shown. */
export const CRUMB_U = 15;
export const GAP_U = 30;
export const STRIP_U = 36;

/**
 * Breadcrumb bar: the card the player actually wants, plus this prep run's progress, pinned to the
 * top of the panel for as long as prep is active. This bar IS the reason target-switching stopped
 * being confusing — the swap itself was never the problem, losing sight of the original goal was.
 */
export function drawPrepCrumb(
  ml: PIXI.Container,
  stack: readonly PrepFrame[],
  inv: Record<string, CardInstance>,
  x: number,
  y: number,
  w: number,
  S: number,
  busy: boolean,
  pushHit: (rect: Rect, action: () => void) => void,
  onCancel: () => void,
): void {
  const root = stack[0];
  const rootCard = inv[root.targetId];
  const rootName = rootCard ? t(`card.${rootCard.defId}.name` as TranslationKey) : '';
  const bar = new PIXI.Graphics();
  bar.beginFill(C.gold, 0.14).drawRect(x + 4 * S, y, w - 8 * S, CRUMB_U * S).endFill();
  ml.addChild(bar);

  // Deeper frames collapse into a trailing "← Lv.N (a/b)" so a 2-level stack still fits one line.
  const tail = stack.slice(1)
    .map((f) => ` < Lv.${f.targetLevel} (${f.produced}/${f.needed})`)
    .join('');
  const label = t('roster.fusePrepCrumb', {
    name: rootName,
    lv: root.targetLevel,
    done: root.produced,
    need: root.needed,
  }) + tail;
  const lbl = txt(label, snapFont(9 * S), C.dark, true);
  lbl.anchor.set(0, 0.5);
  lbl.x = x + 10 * S;
  lbl.y = y + (CRUMB_U * S) / 2;
  const maxW = w - 20 * S - 44 * S;
  if (lbl.width > maxW) lbl.scale.set(maxW / lbl.width);
  ml.addChild(lbl);

  const cancelLbl = txt(t('roster.fusePrepCancel'), snapFont(8.5 * S), C.mid);
  cancelLbl.anchor.set(1, 0.5);
  cancelLbl.x = x + w - 10 * S;
  cancelLbl.y = y + (CRUMB_U * S) / 2;
  ml.addChild(cancelLbl);
  // Registered only while idle, same rule as the Fuse/Cancel footer: an in-flight fuse is not
  // cancellable server-side, and leaving a live-but-inert rect here would be an invisible dead zone.
  if (!busy) {
    pushHit(
      { x: cancelLbl.x - cancelLbl.width - 6 * S, y, w: cancelLbl.width + 12 * S, h: CRUMB_U * S },
      onCancel,
    );
  }
}

/**
 * Shortfall notice: how many materials are missing, and — when the player owns enough cards one
 * level down — a button that starts a prep run instead of leaving him at a dead end. When prep
 * isn't affordable the same block states the concrete cost anyway ("18 needed, you have 8") and
 * points at the acquisition channels, which is still strictly more useful than an empty list.
 */
export function drawGapNotice(
  ml: PIXI.Container,
  shortfall: number,
  targetLevel: number,
  plan: PrepPlan | null,
  x: number,
  y: number,
  w: number,
  S: number,
  busy: boolean,
  pushHit: (rect: Rect, action: () => void) => void,
  onPrep: () => void,
): void {
  const need = txt(t('roster.fuseNeedMore', { n: shortfall, lv: targetLevel }), snapFont(10 * S), C.dark, true);
  need.anchor.set(0.5, 0);
  need.x = x + w / 2;
  need.y = y + 2 * S;
  if (need.width > w - 12 * S) need.scale.set((w - 12 * S) / need.width);
  ml.addChild(need);

  const subY = y + 14 * S;
  if (plan?.affordable && plan.hasFeeder) {
    const btnH = 15 * S;
    const cost = txt(
      t('roster.fusePrepCost', { avail: plan.avail, lv: plan.feederLevel, cost: plan.cost }),
      snapFont(8 * S), C.mid,
    );
    cost.anchor.set(0, 0.5);
    const btnLbl = txt(t('roster.fusePrepBtn'), snapFont(8.5 * S), busy ? C.mid : C.light, true);
    const btnW = Math.min(w * 0.44, btnLbl.width + 16 * S);
    const totalW = Math.min(w - 12 * S, cost.width + 6 * S + btnW);
    const startX = x + (w - totalW) / 2;
    cost.x = startX;
    cost.y = subY + btnH / 2;
    if (cost.width > totalW - btnW - 6 * S) cost.scale.set((totalW - btnW - 6 * S) / cost.width);
    ml.addChild(cost);

    const btnX = startX + totalW - btnW;
    const btn = sketchPanel(btnW, btnH, {
      fill: busy ? C.btnOff : C.dark, border: C.gold, seed: seedFor(0, 26, btnW),
    });
    btn.x = btnX; btn.y = subY;
    ml.addChild(btn);
    btnLbl.anchor.set(0.5, 0.5);
    btnLbl.x = btnX + btnW / 2;
    btnLbl.y = subY + btnH / 2;
    if (btnLbl.width > btnW - 6 * S) btnLbl.scale.set((btnW - 6 * S) / btnLbl.width);
    ml.addChild(btnLbl);
    if (!busy) pushHit({ x: btnX, y: subY, w: btnW, h: btnH }, onPrep);
    return;
  }

  // A plan the player can't fund states the concrete gap; one he could fund but has no eligible
  // feeder for (every copy at that level is geared) falls back to the acquisition channels, since
  // "you need 6 and have 6" would read as a contradiction.
  const hint = plan && !plan.affordable
    ? t('roster.fusePrepShort', { cost: plan.cost, lv: plan.feederLevel, avail: plan.avail })
    : t('roster.fuseNoSource');
  const hintLbl = txt(hint, snapFont(8 * S), C.mid);
  hintLbl.anchor.set(0.5, 0);
  hintLbl.x = x + w / 2;
  hintLbl.y = subY;
  if (hintLbl.width > w - 12 * S) hintLbl.scale.set((w - 12 * S) / hintLbl.width);
  ml.addChild(hintLbl);
}

/**
 * Fuse / Cancel footer. Both buttons go dead while `busy` — an in-flight fuse is not cancellable
 * server-side, so closing the panel mid-request would leave feed.ts's settle closure free to fire
 * against whatever the player had navigated to by the time it resolved (2026-08-03 fix).
 */
export function drawFuseFooter(
  ml: PIXI.Container,
  filled: number,
  colX: number,
  panelBottomY: number,
  colW: number,
  S: number,
  busy: boolean,
  pushHit: (rect: Rect, action: () => void) => void,
  onConfirm: () => void,
  onCancel: () => void,
): void {
  const btnH = 26 * S;
  const btnPadX = 14 * S;
  const btnGap = 8 * S;
  const btnY = panelBottomY - 32 * S;

  const confirmOn = filled === FUSION_MATERIAL_COUNT && !busy;
  const confirmLbl = txt(`${t('roster.fuseBtn')} (${filled}/${FUSION_MATERIAL_COUNT})`, snapFont(10 * S), confirmOn ? C.light : C.mid);
  const cancelLbl = txt(t('equip.cancel'), snapFont(10 * S), busy ? C.mid : C.dark);
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
  if (confirmOn) pushHit({ x: confirmX, y: btnY, w: confirmBtnW, h: btnH }, onConfirm);

  const cancelBtn = sketchPanel(cancelBtnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 21, cancelBtnW) });
  cancelBtn.x = cancelX; cancelBtn.y = btnY;
  ml.addChild(cancelBtn);
  cancelLbl.anchor.set(0.5, 0.5); cancelLbl.x = cancelX + cancelBtnW / 2; cancelLbl.y = btnY + btnH / 2;
  ml.addChild(cancelLbl);
  if (!busy) pushHit({ x: cancelX, y: btnY, w: cancelBtnW, h: btnH }, onCancel);
}

/**
 * Batch-prep button, shown in the action block's slot while a prep run has more than one round
 * left. Producing the materials for one high-level fusion can take a dozen-plus identical
 * lower-level fuses with no decision in any of them; this collapses the whole remainder into one
 * tap the player has already authorized by starting the prep. The round count is stated on the
 * button so "how much of my roster is about to be spent" is never a surprise.
 */
export function drawPrepBatchBtn(
  ml: PIXI.Container,
  rounds: number,
  x: number,
  y: number,
  w: number,
  S: number,
  busy: boolean,
  pushHit: (rect: Rect, action: () => void) => void,
  onRun: () => void,
): void {
  const btnH = 17 * S;
  const btnY = y + (GAP_U * S - btnH) / 2;
  const lbl = txt(t('roster.fusePrepAll', { n: rounds }), snapFont(9 * S), busy ? C.mid : C.light, true);
  const btnW = Math.min(w - 16 * S, Math.max(110 * S, lbl.width + 20 * S));
  const btnX = x + (w - btnW) / 2;
  const btn = sketchPanel(btnW, btnH, {
    fill: busy ? C.btnOff : C.dark, border: C.gold, seed: seedFor(0, 28, btnW),
  });
  btn.x = btnX; btn.y = btnY;
  ml.addChild(btn);
  lbl.anchor.set(0.5, 0.5);
  lbl.x = btnX + btnW / 2;
  lbl.y = btnY + btnH / 2;
  if (lbl.width > btnW - 8 * S) lbl.scale.set((btnW - 8 * S) / lbl.width);
  ml.addChild(lbl);
  if (!busy) pushHit({ x: btnX, y: btnY, w: btnW, h: btnH }, onRun);
}

/**
 * Recommendation strip: the cards that CAN be fused right now, best-first (see
 * feedPlan.listFusableTargets). Tapping one retargets the panel — which is fine precisely because
 * the player did the tapping. This is where the old auto-retarget ranking ended up: same order,
 * offered instead of applied.
 */
export function drawRecommendStrip(
  ml: PIXI.Container,
  cards: readonly CardInstance[],
  deployedOf: (id: string) => boolean,
  x: number,
  y: number,
  w: number,
  S: number,
  artHooked: Set<string>,
  pushHit: (rect: Rect, action: () => void) => void,
  onPick: (card: CardInstance) => void,
  onArtLoaded: () => void,
): void {
  const title = txt(t('roster.fuseReadyList'), snapFont(8 * S), C.mid);
  title.anchor.set(0, 0);
  title.x = x + 6 * S;
  title.y = y;
  ml.addChild(title);

  const chipH = 22 * S;
  const chipY = y + 11 * S;
  const chipW = 34 * S;
  const gap = 4 * S;
  // Cap the visible chips at whatever fits and let a trailing "+N" carry the rest, rather than
  // adding a second scrollable viewport inside a modal that already has one.
  const maxChips = Math.max(1, Math.min(cards.length, Math.floor((w - 12 * S + gap) / (chipW + gap))));
  const overflow = cards.length - maxChips;
  const shown = overflow > 0 ? cards.slice(0, maxChips - 1) : cards.slice(0, maxChips);

  let cx = x + 6 * S;
  for (const card of shown) {
    const def = CARD_DEFS[card.defId];
    const frame = sketchPanel(chipW, chipH, {
      fill: 0xf5f3ec,
      border: deployedOf(card.id) ? C.gold : (def ? FACTION_COLOR[def.faction] : C.mid),
      seed: seedFor(0, 27, chipW),
    });
    frame.x = cx; frame.y = chipY;
    ml.addChild(frame);

    const artUrl = cardInstanceArtUrl(card);
    if (artUrl) {
      const tex = getArtTexture(artUrl);
      if (tex.baseTexture.valid) {
        const box = chipH - 9 * S;
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(Math.min(box / tex.width, box / tex.height));
        sp.position.set(cx + chipW / 2, chipY + box / 2 + 2 * S);
        ml.addChild(sp);
      } else if (!artHooked.has(artUrl)) {
        artHooked.add(artUrl);
        tex.baseTexture.once('loaded', onArtLoaded);
      }
    }

    // Level as stars, matching the ring target / roster grid / detail modal convention (2026-07-25).
    const { container: stars } = buildLevelStars(card.level, chipW - 4 * S, 3.5 * S, 1 * S);
    stars.x = cx + chipW / 2 - stars.width / 2;
    stars.y = chipY + chipH - 6 * S;
    ml.addChild(stars);

    pushHit({ x: cx, y: chipY, w: chipW, h: chipH }, () => onPick(card));
    cx += chipW + gap;
  }

  if (overflow > 0) {
    const more = txt(`+${overflow}`, snapFont(9 * S), C.mid, true);
    more.anchor.set(0, 0.5);
    more.x = cx + 2 * S;
    more.y = chipY + chipH / 2;
    ml.addChild(more);
  }
}
