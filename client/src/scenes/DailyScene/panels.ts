// DailyScene's four tab bodies (checkin/tasks/weekly/ads), extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛" — same shape as StatsScene/panels.ts /
// ResultScene/builders.ts): each takes an explicit `DailyPanelCtx` + geometry params instead of
// closing over `this`, so DailyScene.ts's own render() stays a thin per-tab dispatcher.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt, scaledTxt, sketchPanel, seedFor } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { buildRewardIcon } from '../../render/rewardIcon';
import { FS, snapFont } from '../../render/fontScale';
import type { SaveData } from '../../game/meta/SaveData';
import type { RetentionView } from '../../net/ApiClient';
import { nextCheckinDay, dailyRewardClaimable, makeDayKey, makeMonthKey, weeklyPoints, weeklyClaimableTiers, WEEKLY_CHEST_THRESHOLDS } from '../../game/meta/retention';
import type { DailyCallbacks } from './types';
export type { Hit } from '../../ui/hits';
import type { Hit } from '../../ui/hits';


/** Everything the four panel-renderers below need out of DailyScene — passed explicitly instead
 *  of closing over `this` (form①). `doXxx` are the scene's own busy-tracked action wrappers, not
 *  `cb.onXxx` directly (the scene still owns bt/retention/toast/reload around each action). */
export interface DailyPanelCtx {
  container: PIXI.Container;
  hits: Hit[];
  h: number;
  landscape: boolean;
  retention: RetentionView | null;
  cb: DailyCallbacks;
  doCheckin(): void;
  doClaim(): void;
  doClaimWeekly(threshold: number): void;
  doWatchAd(): void;
  /** Hands the scene the check-in grid's claimable cell (or null) so `update(dt)` can breathe it — see {@link CHECKIN_PULSE}. */
  setPulseTarget(cell: PIXI.Container | null): void;
}

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

/** Formats a remaining-ms duration as "mm:ss" for the ads-tab cooldown button label. */
export function formatCooldown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

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

export function renderDailyTasks(ctx: DailyPanelCtx, areaX: number, top: number, areaW: number, areaH: number, save: SaveData, nowMs: number): void {
  const { container, hits, h, retention } = ctx;
  const sec = txt(t('daily.tasks.title'), FS.title, C.dark, true);
  sec.x = areaX + areaW * 0.05; sec.y = top;
  container.addChild(sec);

  const taskLabels: [string, string][] = [
    ['pve.clear', 'daily.tasks.pveLabel'],
    ['pvp.match', 'daily.tasks.pvpLabel'],
    ['gacha.draw', 'daily.tasks.gachaLabel'],
  ];

  const dayKey = makeDayKey(nowMs);
  const daily = save.retention?.daily?.dayKey === dayKey ? save.retention.daily : null;
  const completedTasks: Record<string, number> = daily?.completedTasks ?? {};
  const taskPoints = daily?.taskPoints ?? 0;
  const isClaimable = dailyRewardClaimable(save, nowMs);
  const isClaimed = daily?.rewardClaimed ?? false;

  const cardH = areaH * 0.22;
  const cardY0 = top + sec.height + h * 0.015;
  const PAD = areaX + areaW * 0.05;
  const cardW = areaW * 0.9;

  taskLabels.forEach(([taskId, labelKey], i) => {
    const done = (completedTasks[taskId] ?? 0) > 0;
    const fillColor = done ? 0xe0ecd8 : 0xf5f0e8;
    const cy = cardY0 + i * (cardH + h * 0.008);
    const bg = sketchPanel(cardW, cardH, { fill: fillColor, border: C.line, width: 1.2, seed: seedFor(PAD, cy, i) });
    bg.x = PAD; bg.y = cy;
    container.addChild(bg);

    // Label is wrapped and width-capped to the left ~62% of the card so long
    // labels (e.g. "Clear any PvE level") can never grow into the right-aligned state text.
    const label = makeText(t(labelKey as TranslationKey), {
      fontSize: snapFont(Math.round(cardH * 0.3)), fill: 0x333333, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: cardW * 0.6, breakWords: true,
    });
    label.anchor.set(0, 0.5);
    label.x = PAD + cardW * 0.05;
    label.y = cy + cardH * 0.5;
    container.addChild(label);

    const state = txt(done ? t('daily.tasks.done') : t('daily.tasks.pending'), snapFont(Math.round(cardH * 0.3)), done ? 0x336644 : 0x888888);
    state.anchor.set(1, 0.5);
    state.x = PAD + cardW * 0.96;
    state.y = cy + cardH * 0.5;
    container.addChild(state);
  });

  const summaryY = cardY0 + taskLabels.length * (cardH + h * 0.008) + h * 0.01;
  const ptTxt = txt(`${taskPoints} / 3`, FS.title, taskPoints >= 3 ? 0x226622 : C.mid);
  ptTxt.anchor.set(0, 0.5);
  ptTxt.x = PAD; ptTxt.y = summaryY + cardH * 0.5;
  container.addChild(ptTxt);

  if (ctx.cb.onClaimDaily) {
    const btnH = cardH * 0.85;
    const coinsReward = retention?.defs?.dailyCoinsReward ?? 2;
    const btnLabel = txt(
      isClaimed ? t('daily.tasks.rewardClaimed') : t('daily.tasks.rewardCoins', { n: coinsReward }),
      snapFont(Math.round(btnH * 0.36)), 0xffffff,
    );
    // Button width must fit whichever label is showing. A fixed cardW*0.45 fraction (kept below
    // as a floor, for landscape's squat cards where it was already comfortably wide) undersized
    // in portrait: cardH — and thus this label's font, sized off btnH — scales with the screen's
    // *height*, while cardW scales with its much narrower portrait *width*, so the same fraction
    // yields a big font in a narrow box. "Claimed today" spilled past the button's right edge
    // there (2026-08-10 bug report, screenshot). Sizing the floor's ceiling-breaker off the
    // label's actual measured width makes the fix orientation- and locale-agnostic instead of
    // retuning yet another magic fraction for portrait (or for German's longer strings).
    const btnPad = btnH * 0.5;
    const btnW = Math.max(cardW * 0.45, btnLabel.width + btnPad);
    const btnX = PAD + cardW - btnW;
    const btnY = summaryY + cardH * 0.08;
    const btnFill = isClaimed ? 0xaaaaaa : isClaimable ? 0x336644 : 0xaaaaaa;
    const btnBg = sketchPanel(btnW, btnH, { fill: btnFill, border: 0x666666, width: 1.5, seed: seedFor(btnX, btnY, 0) });
    btnBg.x = btnX; btnBg.y = btnY;
    btnLabel.anchor.set(0.5, 0.5);
    btnLabel.x = btnX + btnW / 2; btnLabel.y = btnY + btnH / 2;
    container.addChild(btnBg, btnLabel);

    if (isClaimable) {
      hits.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, sound: 'sfx.ui.reward', fn: () => ctx.doClaim() });
    }
  }
}

/**
 * Weekly active chest tab (§12.3): three threshold tiers, each an independently claimable card —
 * same card+progress+button layout as renderDailyTasks, just one card per WEEKLY_CHEST_THRESHOLDS
 * entry instead of one per DailyTaskId. Reward defs (kind/count/id) come from the server
 * (`retention.defs.weeklyChestTiers`); claimed/points state comes from `save` (works even
 * before the first getRetention() round-trip resolves, same as the other tabs).
 */
export function renderWeekly(ctx: DailyPanelCtx, areaX: number, top: number, areaW: number, areaH: number, save: SaveData, nowMs: number): void {
  const { container, hits, h, retention } = ctx;
  const sec = txt(t('daily.weekly.title'), FS.title, C.dark, true);
  sec.x = areaX + areaW * 0.05; sec.y = top;
  container.addChild(sec);

  const points = weeklyPoints(save, nowMs);
  const claimableTiers = new Set(weeklyClaimableTiers(save, nowMs));
  const weekKey = save.retention?.weekly?.weekKey;
  const claimedTiers = new Set(weekKey ? save.retention?.weekly?.claimedTiers ?? [] : []);
  const tierDefs = retention?.defs?.weeklyChestTiers ?? [];

  const cardH = areaH * 0.22;
  const cardY0 = top + sec.height + h * 0.015;
  const PAD = areaX + areaW * 0.05;
  const cardW = areaW * 0.9;

  WEEKLY_CHEST_THRESHOLDS.forEach((threshold, i) => {
    const def = tierDefs.find((td) => td.threshold === threshold);
    const isClaimed = claimedTiers.has(threshold);
    const isClaimable = claimableTiers.has(threshold);
    const fillColor = isClaimed ? 0xe0ecd8 : isClaimable ? 0xfaf0c8 : 0xf5f0e8;
    const cy = cardY0 + i * (cardH + h * 0.008);
    const bg = sketchPanel(cardW, cardH, { fill: fillColor, border: isClaimable ? 0x8a7020 : C.line, width: isClaimable ? 1.8 : 1.2, seed: seedFor(PAD, cy, i) });
    bg.x = PAD; bg.y = cy;
    container.addChild(bg);

    // Wrapped and width-capped to the left ~55% of the card (mirrors renderDailyTasks' label
    // cap above) — the card is much taller in portrait than landscape (both share the same
    // areaH-derived cardH, but portrait's design height stretches far past landscape's), so
    // this font (sized off cardH) renders large enough to run the unwrapped progress string
    // straight into the "Claim" button sitting at cardW*0.65 (09.08.2026 bug report: button
    // looked "misplaced" in portrait because the text was drawn on top of/through it — the
    // button was fine, the label just wasn't clipped to make room for it). Landscape's cardH
    // is small enough that the string already fits on one line well inside the cap, so this
    // is a no-op there.
    const label = txt(
      t('daily.weekly.pointsProgress', { n: Math.min(points, threshold), threshold }),
      snapFont(Math.round(cardH * 0.28)), 0x333333, false, cardW * 0.55,
    );
    label.x = PAD + cardW * 0.05;
    label.y = cy + cardH * 0.14;
    container.addChild(label);

    if (def) {
      const singleItem = def.reward.kind === 'equipment' || def.reward.kind === 'card';
      const iconY = cy + cardH * 0.58;
      const rc = Math.round(cardH * 0.3);
      const ic = buildRewardIcon(def.reward, rc, 0x336644);
      if (ic) {
        ic.x = PAD + cardW * 0.05; ic.y = iconY;
        container.addChild(ic);
        if (!singleItem) {
          const rt = txt(`+${def.reward.count}`, snapFont(Math.round(cardH * 0.26)), 0x336644);
          rt.x = PAD + cardW * 0.05 + rc + cardW * 0.02; rt.y = iconY + rc * 0.5 - rt.height / 2;
          container.addChild(rt);
        }
      }
    }

    const btnW = cardW * 0.32;
    const btnH = cardH * 0.55;
    const btnX = PAD + cardW - btnW - cardW * 0.03;
    const btnY = cy + (cardH - btnH) / 2;
    const btnFill = isClaimed ? 0xaaaaaa : isClaimable ? 0x336644 : 0xaaaaaa;
    const btnBg = sketchPanel(btnW, btnH, { fill: btnFill, border: 0x666666, width: 1.5, seed: seedFor(btnX, btnY, 0) });
    btnBg.x = btnX; btnBg.y = btnY;
    const btnLabel = txt(
      isClaimed ? t('daily.tasks.rewardClaimed') : t('daily.weekly.claim'),
      snapFont(Math.round(btnH * 0.36)), 0xffffff,
    );
    btnLabel.anchor.set(0.5, 0.5);
    btnLabel.x = btnX + btnW / 2; btnLabel.y = btnY + btnH / 2;
    container.addChild(btnBg, btnLabel);

    if (isClaimable && ctx.cb.onClaimWeekly) {
      hits.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, sound: 'sfx.ui.reward', fn: () => ctx.doClaimWeekly(threshold) });
    }
  });
}

/** "Watch an ad for coins" tab (ECONOMY_NUMBERS §6.2): watched/cap counter + reward button, or a live cooldown countdown once the per-ad interval gate is active. */
export function renderAds(ctx: DailyPanelCtx, areaX: number, top: number, areaW: number, areaH: number, nowMs: number): void {
  const { container, hits, h, retention } = ctx;
  const sec = txt(t('daily.ads.title'), FS.title, C.dark, true);
  sec.x = areaX + areaW * 0.05; sec.y = top;
  container.addChild(sec);

  const ads = retention?.ads;
  const PAD = areaX + areaW * 0.05;
  const cardW = areaW * 0.9;
  const cardH = areaH * 0.24;
  const cardY = top + sec.height + h * 0.02;

  const watched = ads?.watchedToday ?? 0;
  const cap = ads?.cap ?? 0;
  const rewardCoins = ads?.rewardCoins ?? 0;
  const nextAvailableAt = ads?.nextAvailableAt ?? 0;
  const capReached = cap > 0 && watched >= cap;
  const cooling = nextAvailableAt > nowMs;
  const available = !!ads && !capReached && !cooling;

  const countTxt = txt(t('daily.ads.watchedCount', { n: watched, cap }), FS.title, capReached ? 0xaa4444 : C.mid);
  countTxt.x = PAD; countTxt.y = cardY;
  container.addChild(countTxt);

  const bg = sketchPanel(cardW, cardH, { fill: available ? 0xe0ecd8 : 0xf5f0e8, border: C.line, width: 1.2, seed: seedFor(PAD, cardY, 0) });
  bg.x = PAD; bg.y = cardY + countTxt.height + h * 0.015;
  container.addChild(bg);

  const rewardTxt = txt(t('daily.ads.rewardCoins', { n: rewardCoins }), snapFont(Math.round(cardH * 0.3)), 0x333333);
  rewardTxt.x = bg.x + cardW * 0.05;
  rewardTxt.y = bg.y + cardH * 0.5 - rewardTxt.height / 2;
  container.addChild(rewardTxt);

  const btnW = cardW * 0.4;
  const btnH = cardH * 0.6;
  const btnX = bg.x + cardW - btnW - cardW * 0.05;
  const btnY = bg.y + cardH * 0.5 - btnH / 2;
  const btnBg = sketchPanel(btnW, btnH, { fill: available ? 0x336644 : 0xaaaaaa, border: 0x666666, width: 1.5, seed: seedFor(btnX, btnY, 0) });
  btnBg.x = btnX; btnBg.y = btnY;
  container.addChild(btnBg);

  let btnLabelText: string;
  if (capReached) btnLabelText = t('daily.ads.capReached');
  else if (cooling) btnLabelText = t('daily.ads.cooldown', { time: formatCooldown(nextAvailableAt - nowMs) });
  else btnLabelText = t('daily.ads.watch');
  const btnLabel = txt(btnLabelText, snapFont(Math.round(btnH * 0.32)), 0xffffff);
  btnLabel.anchor.set(0.5, 0.5);
  btnLabel.x = btnX + btnW / 2; btnLabel.y = btnY + btnH / 2;
  container.addChild(btnLabel);

  if (available && ctx.cb.onWatchAd) {
    hits.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, fn: () => ctx.doWatchAd() });
  }
}
