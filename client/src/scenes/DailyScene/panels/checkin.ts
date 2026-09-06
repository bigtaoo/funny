// The check-in tab's 30-cell month grid, split out of panels/index.ts (2026-09-06, 500-line
// convergence — see claudedocs/client-modules.md "单文件 500 行收敛") as its own form① module: by
// far the biggest of the four panel-renderers and self-contained (reads only DailyPanelCtx + save +
// nowMs, same as its siblings).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { ui as C, txt, scaledTxt, sketchPanel, seedFor } from '../../../render/sketchUi';
import { buildIcon } from '../../../render/icons';
import { buildRasterTabIcon, CHECKIN_CUE_ART } from '../../../render/icons/tabIconRaster';
import { buildRewardIcon } from '../../../render/rewardIcon';
import { FS, snapFont } from '../../../render/fontScale';
import type { SaveData } from '../../../game/meta/SaveData';
import { nextCheckinDay, makeMonthKey } from '../../../game/meta/retention';
import type { DailyPanelCtx } from '../types';

/**
 * The claimable check-in cell's idle breathe: the only moving thing on the page, and the strongest
 * of the four channels that make it the focal point (see {@link renderCheckin}'s colour table).
 *
 * Scale, never alpha — same call as BoardView's base breathe (`render/BoardView/bases.ts`, where a
 * 2026-07-25 user report found an alpha breathe reads as a flicker/rendering fault rather than as
 * "alive"). `min` sits above 1 so the cell is *always* larger than its neighbours: the size step is
 * a static channel that survives a paused ticker, and the breathe rides on top of it.
 */
export const CHECKIN_PULSE = { min: 1.03, max: 1.09, periodSec: 1.4 } as const;

export function renderCheckin(ctx: DailyPanelCtx, areaX: number, top: number, areaW: number, areaH: number, save: SaveData, nowMs: number): void {
  const { container, hits, h, landscape, retention } = ctx;
  const sec = txt(t('daily.checkin.title'), FS.title, C.dark, true);
  sec.x = areaX + areaW * 0.05; sec.y = top;
  container.addChild(sec);

  // Portrait: 5 columns (6 rows) instead of landscape's 6 columns (5 rows) — user report
  // (2026-08-09, screenshot): with 6 columns the narrow portrait width capped cellW hard, and
  // since cellH is itself capped by cellW*0.8 (see below), cells stayed small while the leftover
  // vertical space widened into a big gap between rows. Fewer, wider columns raise the cellW cap,
  // which raises cellH too — bigger cells that eat more of the available height, leaving less to
  // spread as row gaps. Landscape's width was never the constraint, so it keeps 6/5 unchanged.
  const COLS = landscape ? 6 : 5;
  const ROWS = Math.ceil(30 / COLS);
  const innerPad = areaW * 0.04;
  const cellW = (areaW - innerPad * 2) / COLS;
  const cellH = Math.min(areaH * 0.78 / ROWS, cellW * 0.8);
  const gridTop = top + sec.height + h * 0.015;

  // Portrait's cells are still capped by the cellW*0.8 aspect ratio (now a looser cap thanks to
  // the 5-col width above, but rarely the exact areaH/ROWS fit), which used to leave the fixed
  // h*0.006 row gap from landscape and bunch all rows into the page's top third with a blank void
  // below (user report, 2026-08-09). Landscape's areaH is already ~consumed by ROWS*cellH so this
  // is a no-op there — spread only kicks in when portrait's leftover vertical space is positive.
  let rowGap = h * 0.006;
  if (!landscape) {
    const gridAvailH = top + areaH - gridTop;
    const spread = gridAvailH - ROWS * cellH;
    if (spread > 0) rowGap = spread / (ROWS - 1);
  }

  const monthKey = makeMonthKey(nowMs);
  const claimedDays = (save.retention?.checkin?.monthKey === monthKey
    ? save.retention.checkin.claimedDays
    : []) as number[];
  const claimable = nextCheckinDay(save, nowMs);
  const rewards = retention?.defs?.rewards ?? [];
  const milestones = new Set([7, 14, 21, 30]);
  // Already checked in today (or the month is full) → no claimable cell at all. Point at the slot
  // that unlocks next instead, so the eye still has somewhere to land (it would otherwise fall back
  // to whichever cell is loudest, i.e. a milestone — the very bug this pass fixes). Same
  // "next slot = claimed count + 1" arithmetic nextCheckinDay() uses, minus its same-day gate.
  const tomorrow = claimable === null && claimedDays.length < 30 ? claimedDays.length + 1 : null;

  // ── Visual weight, most prominent first (2026-09-05 user report + screenshot) ────────────────
  // The eye used to land on the milestone cells and the claimed block before the one cell the
  // player is here to tap: claimable owned exactly ONE channel (a pale mint fill) while a milestone
  // owned three (warm fill + a 1.8px gold border that snapped to the atlas's 2.0 weight + the gold
  // bonus badge), and the claimed fill was the darkest — therefore heaviest — swatch on the grid.
  // So the ranking is now enforced instead of incidental: claimable is the only cell that gets the
  // heaviest border weight, a second traced-again frame, a bold number, a size step and the
  // breathe; a milestone keeps a warm tint and nothing else; claimed recedes into the paper.
  const FILL_CLAIMABLE = 0x86d29a;   // was 0xb8e0c0 — too close to the paper's own value to win
  const FILL_MILESTONE = 0xf7f0dc;   // was 0xfaf0c8
  const FILL_CLAIMED   = 0xe6e2d8;   // was 0xd0ccc0 (darkest fill on the page)
  const FILL_LOCKED    = 0xf2ede0;   // unchanged — the baseline every other cell is read against
  const FILL_TOMORROW  = 0xeaf3ec;
  const INK_CLAIMABLE  = 0x2e7d32;
  const INK_MILESTONE  = 0xc9b47a;   // was 0x8a7020
  const INK_TOMORROW   = 0x8ab89a;
  // panelFrame.ts bakes three stroke weights (1.2 / 2.0 / 2.6) and snaps `width` to the nearest;
  // these are those exact values, so the step between them is the real rendered step.
  const W_CLAIMABLE = 2.6;
  const W_TOMORROW = 2.0;
  const W_PLAIN = 1.2;

  // The claimable cell is drawn into its own container appended AFTER the loop — it has to sit on
  // top of its neighbours (its border is heavier and its box is scaled past the cell bounds, so
  // being overdrawn by day+1's frame would clip exactly the channels that make it stand out), and
  // the scene needs one node to breathe. `pivot === position` keeps the children's absolute
  // coordinates while scaling around the cell's centre.
  let claimableCell: PIXI.Container | null = null;

  // Names the focal cell in words, on the title line: the grid is 30 near-identical boxes, and
  // "which one is mine" is faster to read than to search for. Right-aligned to the content column
  // and dropped entirely if it would run into the section title (long locales, narrow portrait) —
  // it is a redundant cue, so losing it costs nothing; overlapping the title would cost more.
  const hintDay = claimable ?? tomorrow;
  if (hintDay !== null) {
    const hint = txt(
      t(claimable !== null ? 'daily.checkin.claimHint' : 'daily.checkin.tomorrowHint', { n: hintDay }),
      snapFont(Math.round(FS.title * 0.8)),
      claimable !== null ? INK_CLAIMABLE : C.mid,
      claimable !== null,
    );
    hint.x = areaX + areaW * 0.95 - hint.width;
    hint.y = sec.y + sec.height - hint.height;
    if (hint.x > sec.x + sec.width + areaW * 0.02) container.addChild(hint);
    else hint.destroy({ texture: true, baseTexture: true });
  }

  for (let day = 1; day <= 30; day++) {
    const col = (day - 1) % COLS;
    const row = Math.floor((day - 1) / COLS);
    const cx = areaX + innerPad + col * cellW + cellW * 0.5;
    const cy = gridTop + row * (cellH + rowGap) + cellH * 0.5;
    const x = cx - cellW * 0.46;
    const y = cy - cellH * 0.46;
    const cw = cellW * 0.92;
    const ch = cellH * 0.92;

    // Sequential accumulation model: claimed cells (≤ claimed count) get a checkmark;
    // the next unclaimed cell = claimable (highlighted); the rest = locked (dimmed).
    // claimable is provided by nextCheckinDay, may be null (already claimed today / month full) → no highlighted cell.
    const isClaimed = claimedDays.includes(day);
    const isClaimable = claimable !== null && day === claimable;
    const isTomorrow = tomorrow !== null && day === tomorrow;
    const isLocked = !isClaimed && !isClaimable;
    const isMilestone = milestones.has(day);

    // Everything below draws into `cell`, which is the shared container for all 29 ordinary cells
    // and a dedicated one for the claimable cell (positioned + breathed after the loop).
    let cell = container;
    if (isClaimable) {
      cell = claimableCell = new PIXI.Container();
      // pivot === position → children keep the absolute coordinates every cell is laid out in,
      // while scale grows the box around the cell's own centre.
      cell.pivot.set(cx, cy);
      cell.position.set(cx, cy);
      cell.scale.set(CHECKIN_PULSE.min);

      // Hand-drawn starburst behind the cell (art doc: design/product/checkin-focus-cue-art.md).
      // Added first = under the cell's own fill, so only the ray tips show. It reaches over the
      // neighbouring cells, which is the point — a burst that stopped at the cell's edge would just
      // be a border. Masked at the grid's top edge because a row-0 cell's upward rays otherwise
      // strike straight through the "签到月历" section title (measured on day 1, 2026-09-05).
      // Nothing clips the other three sides: sideways and downwards it only ever reaches paper.
      const burstSize = cellH * 1.5;
      const burst = buildRasterTabIcon(CHECKIN_CUE_ART.burst, burstSize, burstSize);
      burst.x = cx - burstSize / 2; burst.y = cy - burstSize / 2;
      burst.alpha = 0.4;
      const clip = new PIXI.Graphics();
      clip.beginFill(0xffffff).drawRect(cx - burstSize, gridTop, burstSize * 2, burstSize * 2).endFill();
      burst.mask = clip;
      cell.addChild(clip, burst);
    }
    // Text inside a container scaled past 1 blurs (rasterised glyph canvas, see sketchUi's
    // scaledTxt doc) — so the claimable cell's labels rasterise at the breathe's peak scale and are
    // only ever displayed at or below their native size.
    const mkTxt = isClaimable ? scaledTxt(CHECKIN_PULSE.max) : txt;

    let fillColor: number = FILL_LOCKED;
    let borderColor: number = C.line;
    let borderW: number = W_PLAIN;
    if (isClaimable) {
      // A milestone that happens to be today's slot stays green: it used to switch to a gold fill
      // (0xffd88a) with no green anywhere, i.e. the focal cue vanished on days 7/14/21/30. Its
      // milestone identity is already carried by the bonus-coin badge below.
      fillColor = FILL_CLAIMABLE; borderColor = INK_CLAIMABLE; borderW = W_CLAIMABLE;
    } else if (isClaimed) {
      fillColor = FILL_CLAIMED;
    } else if (isTomorrow) {
      fillColor = FILL_TOMORROW; borderColor = INK_TOMORROW; borderW = W_TOMORROW;
    } else if (isMilestone) {
      fillColor = FILL_MILESTONE; borderColor = INK_MILESTONE;
    }

    const bg = sketchPanel(cw, ch, { fill: fillColor, border: borderColor, width: borderW, seed: seedFor(x, y, day) });
    bg.x = x; bg.y = y;
    cell.addChild(bg);

    // Traced a second time, just inside the first — the notebook idiom for "this one", and the one
    // way to get more border weight than the atlas's heaviest baked stroke (2.6px) without leaving
    // the sketch pipeline. Fill-less so the cell's own fill still shows through.
    if (isClaimable) {
      const inset = Math.max(2, ch * 0.05);
      const trace = sketchPanel(cw - inset * 2, ch - inset * 2, {
        fill: FILL_CLAIMABLE, fillAlpha: 0, border: INK_CLAIMABLE, width: W_PLAIN, seed: seedFor(x, y, day + 100),
      });
      trace.x = x + inset; trace.y = y + inset;
      cell.addChild(trace);
    }

    const numTxt = mkTxt(
      String(day), snapFont(Math.round(ch * 0.32)),
      isClaimable ? 0x1b4d20 : isClaimed ? 0x999999 : isTomorrow ? 0x4a7a58 : isLocked ? 0xaaaaaa : 0x333333,
      isClaimable,
    );
    numTxt.anchor.set(0.5, 0);
    numTxt.x = cx; numTxt.y = y + ch * 0.06;
    cell.addChild(numTxt);

    const reward = rewards[day - 1];
    if (reward) {
      // Card/equipment milestones are single items (drawn randomly at claim time) — glyph only,
      // no "+1" (mirrors BattlePassScene's skin reward: single item, no count).
      const singleItem = reward.kind === 'card' || reward.kind === 'equipment';
      const baseY = y + ch * 0.92;
      const rc = Math.round(ch * 0.26);
      // Darker ink on the claimable cell: 0x336644 is a mid green that half-disappears against that
      // cell's saturated green fill (measured on the day-30 shield glyph, 2026-09-05 screenshot).
      const ink = reward.kind === 'coins' ? C.gold : isClaimable ? 0x14401a : 0x336644;
      const ic = buildRewardIcon(reward, rc, ink);
      if (ic) {
        if (singleItem) {
          ic.x = cx - rc / 2; ic.y = baseY - rc;
          cell.addChild(ic);
        } else {
          const rt = mkTxt(`+${reward.count}`, snapFont(Math.round(ch * 0.24)), reward.kind === 'coins' ? 0x8a7020 : ink);
          const groupW = rc + Math.round(ch * 0.03) + rt.width;
          const gx = cx - groupW / 2;
          ic.x = gx; ic.y = baseY - rc;
          rt.anchor.set(0, 1);
          rt.x = gx + rc + Math.round(ch * 0.03); rt.y = baseY;
          cell.addChild(ic, rt);
        }
      } else {
        // No glyph for this reward kind (or its art hasn't decoded yet) — count only, centred.
        const rt = mkTxt(`+${reward.count}`, snapFont(Math.round(ch * 0.24)), isClaimable ? 0x14401a : 0x336644);
        rt.anchor.set(0.5, 1);
        rt.x = cx; rt.y = baseY;
        cell.addChild(rt);
      }
    }

    // Milestone bonus coins (R1b, 2026-08-01): small badge in the cell's top-right corner,
    // alongside (not replacing) the primary reward drawn above.
    // Muted to 0x9a8a55 / 0.16em (was 0x8a7020 / 0.18em) — this badge was the third channel making
    // milestones outshout the claimable cell. It still carries real information, so it stays; it
    // just stops competing. On the claimable cell it keeps a dark ink instead, because the muted
    // gold has too little contrast against that cell's saturated green fill.
    if (reward?.bonusCoins) {
      const rc = Math.round(ch * 0.16);
      const ic = buildIcon('coin', rc, C.gold);
      const rt = mkTxt(`+${reward.bonusCoins}`, snapFont(Math.round(ch * 0.16)), isClaimable ? 0x5c4a10 : 0x9a8a55);
      rt.anchor.set(0, 0);
      const groupW = rc + Math.round(ch * 0.02) + rt.width;
      const gx = x + cw - ch * 0.05 - groupW;
      const gy = y + ch * 0.04;
      ic.x = gx; ic.y = gy;
      rt.x = gx + rc + Math.round(ch * 0.02); rt.y = gy;
      cell.addChild(ic, rt);
    }

    // Claimed cell: stamp a green checkmark (user feedback: tick the claimed date after collecting).
    // Smaller and fainter than it was (0.42em / 0.6 alpha, was 0.5em / 0.85): a run of claimed days
    // is a block of cells, and at the old weight that block read as the page's second focal point.
    if (isClaimed) {
      const tickSz = Math.round(ch * 0.42);
      const tick = buildIcon('check', tickSz, 0x2e7d32);
      tick.x = cx - tickSz / 2; tick.y = cy - tickSz / 2;
      tick.alpha = 0.6;
      container.addChild(tick);
    }

    // Hand-drawn arrow curling into the cell's lower outward corner. The source art points down and
    // right, so the two other directions used here are flips of it (mirroring a Container scales
    // around its own origin, hence the position compensation).
    //
    // Always from BELOW, and sideways towards the page edge: every other approach walks onto
    // content. From above it would cross the section title on row 0, and a milestone's gold bonus
    // badge sits in the top-right corner of its cell — exactly where an arrow coming down from the
    // row above lands. Below, the tail falls on a neighbour's number-free lower half, or (last row)
    // on empty paper.
    if (isClaimable) {
      const aSize = cellH * 0.45;
      const fromLeft = col < COLS / 2;
      const arrow = buildRasterTabIcon(CHECKIN_CUE_ART.arrow, aSize, aSize);
      const tipX = fromLeft ? x + cw * 0.12 : x + cw - cw * 0.12;
      const tipY = y + ch - ch * 0.16;
      arrow.scale.set(fromLeft ? 1 : -1, -1);
      arrow.x = fromLeft ? tipX - aSize : tipX + aSize;
      arrow.y = tipY + aSize;
      cell.addChild(arrow);
    }

    if (isClaimable && ctx.cb.onCheckin) {
      // Sized off the breathe's floor, not the base cell: the cell is never drawn at 1.0, so a
      // 1.0-sized rect would leave a rim of visibly-green pixels that don't respond to a tap.
      const hitW = cw * CHECKIN_PULSE.min;
      const hitH = ch * CHECKIN_PULSE.min;
      hits.push({ rect: { x: cx - hitW / 2, y: cy - hitH / 2, w: hitW, h: hitH }, fn: () => ctx.doCheckin() });
    }
  }

  // Appended last = drawn over its neighbours; see `claimableCell`'s declaration above. Handed to
  // the scene even when null, so a tab switch or a claim clears the previous frame's target instead
  // of leaving `update(dt)` writing into a torn-down node.
  if (claimableCell) container.addChild(claimableCell);
  ctx.setPulseTarget(claimableCell);
}
