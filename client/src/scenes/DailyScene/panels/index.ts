// DailyScene's four tab bodies (checkin/tasks/weekly/ads), extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛" — same shape as StatsScene/panels.ts /
// ResultScene/builders.ts): each takes an explicit `DailyPanelCtx` + geometry params instead of
// closing over `this`, so DailyScene.ts's own render() stays a thin per-tab dispatcher.
//
// renderCheckin (by far the biggest of the four, and self-contained) lives in ./checkin — split out
// 2026-09-06 to keep this file under the 500-line convention; DailyPanelCtx/Hit/CHECKIN_PULSE are
// re-exported here so `./DailyScene/panels` stays the one import path both DailyScene.ts and the
// UI tests use.
import { makeText } from '../../../render/pixiText';
import { t, TranslationKey } from '../../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../../render/sketchUi';
import { drawButtonLabel, buttonLabelIconW } from '../../../ui/widgets/buttonLabel';
import { buildRewardIcon } from '../../../render/rewardIcon';
import { FS, snapFont } from '../../../render/fontScale';
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

    // Label is wrapped and width-capped to the left ~62% of the card so long labels
    // (e.g. "Clear any PvE level") can never grow into the right-aligned state text.
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
    const btnPad = btnH * 0.5;
    const btnW = Math.max(cardW * 0.45, btnLabel.width + buttonLabelIconW(snapFont(Math.round(btnH * 0.36))) + btnPad);
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
    container.addChild(btnBg);
    drawButtonLabel(container, btnX, btnY, btnW, btnH,
      isClaimed ? t('daily.tasks.rewardClaimed') : t('daily.weekly.claim'), 'gift', 0xffffff,
      snapFont(Math.round(btnH * 0.36)), { bold: false });

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
  drawButtonLabel(container, btnX, btnY, btnW, btnH, btnLabelText, 'adsTabIcon', 0xffffff,
    snapFont(Math.round(btnH * 0.32)), { bold: false });

  if (available && ctx.cb.onWatchAd) {
    hits.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, fn: () => ctx.doWatchAd() });
  }
}
