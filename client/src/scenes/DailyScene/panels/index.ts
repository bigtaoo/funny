// DailyScene's four tab bodies (checkin/tasks/weekly/ads), extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛" — same shape as StatsScene/panels.ts /
// ResultScene/builders.ts): each takes an explicit `DailyPanelCtx` + geometry params instead of
// closing over `this`, so DailyScene.ts's own render() stays a thin per-tab dispatcher.
//
// renderCheckin (by far the biggest of the four, and self-contained) lives in ./checkin — split out
// 2026-09-06 to keep this file under the 500-line convention; DailyPanelCtx/Hit/CHECKIN_PULSE are
// re-exported here so `./DailyScene/panels` stays the one import path both DailyScene.ts and the
// UI tests use.
import { makeText, measuredWidth } from '../../../render/pixiText';
import { t, TranslationKey } from '../../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../../render/sketchUi';
import { drawButtonLabel, buttonLabelIconW } from '../../../ui/widgets/buttonLabel';
import { drawStatusTag } from '../../../ui/widgets/statusTag';
import { buildRewardIcon } from '../../../render/rewardIcon';
import { FS, snapFont, fitFont } from '../../../render/fontScale';
import type { SaveData } from '../../../game/meta/SaveData';
import { dailyRewardClaimable, makeDayKey, weeklyPoints, weeklyClaimableTiers, WEEKLY_CHEST_THRESHOLDS } from '../../../game/meta/retention';
import type { DailyPanelCtx } from '../types';

export type { Hit } from '../../../ui/hits';
export type { DailyPanelCtx } from '../types';
export { renderCheckin, CHECKIN_PULSE } from './checkin';

/** Formats a remaining-ms duration as "mm:ss" for the ads-tab cooldown button label. */
export function formatCooldown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
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

    // State tag first, so the label below knows how much of the card is already spoken for
    // (the ordering `BattlePassScene/cell.ts` had to adopt for the same reason).
    //
    // A pending task draws NOTHING. The three tasks are binary — one point each, done once
    // (server/shared/src/retention.ts DAILY_TASKS) — so "In progress" only ever meant "not the
    // other state", which the paper-vs-green fill and the `n / 3` tally under the cards already
    // say. Replacing it with an hourglass would have been the same non-statement in fewer pixels;
    // dropping it hands the whole right half of the card back to the label, which is what was
    // actually short of room.
    const stateFS = snapFont(Math.round(cardH * 0.3));
    const reserve = done
      ? drawStatusTag(container, PAD, cy, cardW * 0.96, cardH, t('daily.tasks.done'), 'check', 0x336644, stateFS)
      : 0;

    // Wrapped only against whatever the tag left over, instead of the flat 60% cap this carried
    // while every card had a state word on it: "Clear any PvE level" needed two lines in portrait
    // purely to clear "In progress", and there is no longer anything there to clear.
    const label = makeText(t(labelKey as TranslationKey), {
      fontSize: stateFS, fill: 0x333333, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: Math.max(cardW * 0.3, cardW * 0.87 - reserve), breakWords: true,
    });
    label.anchor.set(0, 0.5);
    label.x = PAD + cardW * 0.05;
    label.y = cy + cardH * 0.5;
    container.addChild(label);
  });

  const summaryY = cardY0 + taskLabels.length * (cardH + h * 0.008) + h * 0.01;
  const ptTxt = txt(`${taskPoints} / 3`, FS.title, taskPoints >= 3 ? 0x226622 : C.mid);
  ptTxt.anchor.set(0, 0.5);
  ptTxt.x = PAD; ptTxt.y = summaryY + cardH * 0.5;
  container.addChild(ptTxt);

  if (ctx.cb.onClaimDaily) {
    const btnH = cardH * 0.85;
    const coinsReward = retention?.defs?.dailyCoinsReward ?? 2;
    const btnLabelText = isClaimed
      ? t('daily.tasks.rewardClaimed')
      : t('daily.tasks.rewardCoins', { n: coinsReward });
    const btnLabel = txt(btnLabelText, snapFont(Math.round(btnH * 0.36)), 0xffffff);
    // Button width must fit whichever label is showing. A fixed cardW*0.45 fraction (kept below
    // as a floor, for landscape's squat cards where it was already comfortably wide) undersized
    // in portrait: cardH — and thus this label's font, sized off btnH — scales with the screen's
    // *height*, while cardW scales with its much narrower portrait *width*, so the same fraction
    // yields a big font in a narrow box. "Claimed today" spilled past the button's right edge
    // there (2026-08-10 bug report, screenshot). Sizing the floor's ceiling-breaker off the
    // label's actual measured width makes the fix orientation- and locale-agnostic instead of
    // retuning yet another magic fraction for portrait (or for German's longer strings).
    //
    // ...bounded by the row, which the ceiling-breaker above did not do. The summary row is the
    // progress counter on the left and this button on the right, and a width derived from the
    // label alone knows nothing about the counter: German's "+5 Münzen abholen" grew the button
    // until its left edge sat ON the `1 / 3` — drawn first, so the sweep reported the counter as
    // 40% `covered` (§55.1). `btnPad` is what made it so hungry: it is half the button's HEIGHT,
    // and in portrait that height is 22% of the screen. Capping at the room that is actually left
    // keeps the padding a request rather than a claim, and `drawButtonLabel` degrades from there
    // the way it does everywhere else (shrink to the floor, drop the glyph, wrap) instead of the
    // row silently losing its counter. The `cardW * 0.45` floor stays OUTSIDE the cap: a row too
    // narrow even for that is a layout bug the sweep should report, not one to hide by shrinking.
    const btnPad = btnH * 0.5;
    const roomW = cardW - ptTxt.width - cardW * 0.05;
    const btnW = Math.max(
      cardW * 0.45,
      Math.min(roomW, btnLabel.width + buttonLabelIconW(snapFont(Math.round(btnH * 0.36))) + btnPad),
    );
    const btnX = PAD + cardW - btnW;
    const btnY = summaryY + cardH * 0.08;
    const btnFill = isClaimed ? 0xaaaaaa : isClaimable ? 0x336644 : 0xaaaaaa;
    const btnBg = sketchPanel(btnW, btnH, { fill: btnFill, border: 0x666666, width: 1.5, seed: seedFor(btnX, btnY, 0) });
    btnBg.x = btnX; btnBg.y = btnY;
    btnLabel.destroy();
    container.addChild(btnBg);
    drawButtonLabel(container, btnX, btnY, btnW, btnH, btnLabelText, 'gift', 0xffffff,
      snapFont(Math.round(btnH * 0.36)), { bold: false });

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

  // Geometry every card shares: the Claim button, and the strip left of it that the progress label
  // and the reward row under it have to share.
  const btnW = cardW * 0.32;
  const btnH = cardH * 0.55;
  const btnX = PAD + cardW - btnW - cardW * 0.03;
  const labelX = PAD + cardW * 0.05;
  const labelW = btnX - labelX - cardW * 0.03;
  const labelText = (threshold: number): string =>
    t('daily.weekly.pointsProgress', { n: Math.min(points, threshold), threshold });

  // The font is sized off cardH, which in portrait is large next to a narrow cardW, so the label is
  // (1) stepped down the font scale until it fits that strip on one line, and only wraps if even the
  // legibility floor does not fit; and (2) the reward row follows the label's REAL bottom instead of
  // a fixed `cardH * 0.58`. The flat `cardW * 0.55` wrap this replaces broke German's
  // "9 / 9 Aktivitätspunkte" into three lines on 360x640, and the third ("te") landed on the reward
  // icon and its "+20" (2026-09-15 sweep, fixed 2026-09-29). One size for all three cards, fitted to
  // the widest, so a shorter "9 / 9" does not come out a step larger than "12 / 15" under it.
  const labelFS0 = snapFont(Math.round(cardH * 0.28));
  let labelFS = labelFS0;
  for (const threshold of WEEKLY_CHEST_THRESHOLDS) {
    const probe = txt(labelText(threshold), labelFS0, 0x333333);
    labelFS = Math.min(labelFS, fitFont(labelFS0, measuredWidth(probe), labelW));
    probe.destroy({ texture: true, baseTexture: true });
  }

  WEEKLY_CHEST_THRESHOLDS.forEach((threshold, i) => {
    const def = tierDefs.find((td) => td.threshold === threshold);
    const isClaimed = claimedTiers.has(threshold);
    const isClaimable = claimableTiers.has(threshold);
    const fillColor = isClaimed ? 0xe0ecd8 : isClaimable ? 0xfaf0c8 : 0xf5f0e8;
    const cy = cardY0 + i * (cardH + h * 0.008);
    const bg = sketchPanel(cardW, cardH, { fill: fillColor, border: isClaimable ? 0x8a7020 : C.line, width: isClaimable ? 1.8 : 1.2, seed: seedFor(PAD, cy, i) });
    bg.x = PAD; bg.y = cy;
    container.addChild(bg);

    const btnY = cy + (cardH - btnH) / 2;

    const label = txt(labelText(threshold), labelFS, 0x333333, false, labelW);
    label.x = labelX;
    label.y = cy + cardH * 0.14;
    container.addChild(label);

    if (def) {
      const singleItem = def.reward.kind === 'equipment' || def.reward.kind === 'card';
      const iconY = Math.max(cy + cardH * 0.58, label.y + label.height + cardH * 0.04);
      const rc = Math.round(cardH * 0.3);
      const ic = buildRewardIcon(def.reward, rc, 0x336644);
      if (ic) {
        ic.x = labelX; ic.y = iconY;
        container.addChild(ic);
        if (!singleItem) {
          const rt = txt(`+${def.reward.count}`, snapFont(Math.round(cardH * 0.26)), 0x336644);
          rt.x = labelX + rc + cardW * 0.02; rt.y = iconY + rc * 0.5 - rt.height / 2;
          container.addChild(rt);
        }
      }
    }

    const btnFill = isClaimed ? 0xaaaaaa : isClaimable ? 0x336644 : 0xaaaaaa;
    const btnBg = sketchPanel(btnW, btnH, { fill: btnFill, border: 0x666666, width: 1.5, seed: seedFor(btnX, btnY, 0) });
    btnBg.x = btnX; btnBg.y = btnY;
    container.addChild(btnBg);
    drawButtonLabel(container, btnX, btnY, btnW, btnH,
      isClaimed ? t('daily.tasks.rewardClaimed') : t('daily.weekly.claim'), 'gift', 0xffffff,
      // Same margin as the ads button below: with the default 10 px inset German's "Heute abgeholt"
      // ran border to border (2026-09-29).
      snapFont(Math.round(btnH * 0.36)), { bold: false, inset: Math.round(btnW * 0.14) });

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
  // The font follows the (tall) button's height, so in English the [icon][label] group is as wide
  // as the button; the default 10 px inset left "Watch Ad" touching both borders on a 390-wide
  // portrait (2026-09-29). Reserve a margin that scales with the button like the other callers do.
  drawButtonLabel(container, btnX, btnY, btnW, btnH, btnLabelText, 'adsTabIcon', 0xffffff,
    snapFont(Math.round(btnH * 0.32)), { bold: false, inset: Math.round(btnW * 0.14) });

  if (available && ctx.cb.onWatchAd) {
    hits.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, fn: () => ctx.doWatchAd() });
  }
}
