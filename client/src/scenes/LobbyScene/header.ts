// Header chrome — split out of build.ts (2026-08-12, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) purely to keep build.ts under the
// 500-line convention. Draws the logo+title lockup, the top-left profile chip, the boiling-line
// title underline, and the top-right account/coin/rank chips. Only ever called from BuildPanel's
// own build(), so this takes `core` explicitly instead of becoming its own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { palette } from '../../render/theme';
import { buildIcon } from '../../render/icons';
import { buildCoinIcon } from '../../render/atlas/coinIconAtlas';
import { BoilingSprite } from '../../render/boil';
import { buildAvatar } from '../../render/avatar';
import logoUrl from '../../assets/logo.png';
import { C, TIER_COLORS, txt, fmtCoins, sketchPanel, type LobbySceneCore } from './core';
import { headerMetrics } from './format';
import { FS, snapFont } from '../../render/fontScale';

/**
 * Draws the full header band (logo/title/subtitle lockup, boiling underline, profile chip, and the
 * top-right account/coin/rank chips) directly onto `core.container`. Populates
 * `core.titleBoil`/`core.profileChipRect`/`core.accountChipRect`/`core.accountChipFn`/
 * `core.coinsChipRect`/`core.rankChipRect` — callers (BuildPanel.build()) run this before the main
 * content stack so those rects/refs exist by the time input routing needs them.
 */
export function drawHeaderChrome(core: LobbySceneCore): void {
  const { w, h } = core;
  const { chipBandH, chipBandY, tbH, brandMidY, logoSize, subtitleY, nameMaxFactor, ulH } =
    headerMetrics(w, h, core.portrait);
  const titleBg = new PIXI.Graphics();
  titleBg.beginFill(C.cover);
  titleBg.drawRect(0, 0, w, tbH);
  titleBg.endFill();
  core.container.addChild(titleBg);

  const title = txt(t('lobby.brandTitle'), FS.display, 0xffffff, true);
  title.anchor.set(0, 0.5);

  const subtitle = txt(t('lobby.subtitle'), FS.label, C.light);
  subtitle.anchor.set(0.5, 0.5); subtitle.y = subtitleY;
  core.container.addChild(subtitle);

  // Center the logo+title lockup on its midline. Scale the title down only if the
  // lockup would exceed ~90% of the width (so it never clips the edges — long
  // brand strings run wide in monospace).
  const logoGap = Math.round(w * 0.015);
  const maxTitleW = Math.round(w * 0.9) - logoSize - logoGap;
  if (title.width > maxTitleW) title.scale.set(maxTitleW / title.width);
  const lockupW = logoSize + logoGap + title.width;
  const lockupLeft = Math.round(w / 2 - lockupW / 2);
  const titleX = lockupLeft + logoSize + logoGap;

  const logo = PIXI.Sprite.from(logoUrl as string);
  logo.anchor.set(1, 0.5);
  logo.width = logoSize; logo.height = logoSize;
  logo.x = titleX - logoGap; logo.y = brandMidY;
  core.container.addChild(logo);

  title.x = titleX; title.y = brandMidY;
  core.container.addChild(title);

  subtitle.x = titleX + title.width / 2;

  // Top-left profile chip (avatar + name) — opens the personal settings screen.
  // Lives in the chip band (landscape: shares the single header row with the
  // centered lockup; portrait: its own row below the brand row — chipBandY offsets it).
  const chipMidY = chipBandY + chipBandH * 0.5;
  const av = Math.round(chipBandH * 0.46);
  const avX = Math.round(w * 0.03);
  const avY = Math.round(chipMidY - av / 2);
  const avatar = buildAvatar(av, core.cb.playerName, 21, core.cb.avatarId);
  avatar.x = avX; avatar.y = avY;
  core.container.addChild(avatar);

  const nameGap = Math.round(w * 0.02);
  const nameLabel = txt(core.cb.playerName, snapFont(Math.round(chipBandH * 0.24)), 0xffffff, true);
  nameLabel.anchor.set(0, 0.5);
  nameLabel.x = avX + av + nameGap;
  nameLabel.y = chipMidY;
  // Keep the profile chip clear of the brand lockup (portrait: half the band;
  // landscape: leave room for the centered lockup).
  const nameMax = w * nameMaxFactor - (av + nameGap);
  if (nameLabel.width > nameMax) nameLabel.scale.set(nameMax / nameLabel.width);
  core.container.addChild(nameLabel);

  const pad = Math.round(chipBandH * 0.12);
  core.profileChipRect = {
    x: avX - pad, y: avY - pad,
    w: av + nameGap + nameLabel.width + 2 * pad, h: av + 2 * pad,
  };

  // Boiling-line title underline (art-direction §5.4) — a hand-drawn marker
  // stroke that subtly wobbles ~8fps. Cycles baked variants; near-zero cost.
  const ulW = Math.min(w * 0.6, title.width * 1.15);
  core.titleBoil = new BoilingSprite(ulW, ulH, (pen) => {
    pen.stroke(
      [{ x: 2, y: ulH * 0.5 }, { x: ulW - 2, y: ulH * 0.5 }],
      { color: palette.marker, width: Math.max(4, ulH * 0.5), taper: 0.6, double: false },
    );
  }, { tag: 'lobby-title', variants: 3, fps: 8 });
  core.titleBoil.x = title.x + title.width / 2 - ulW / 2;
  core.titleBoil.y = brandMidY + title.height / 2;
  core.container.addChild(core.titleBoil);

  // Top-right account chip (SA-4): offline → login/register entry; online →
  // server-authoritative ladder badge with a small logout affordance.
  const chipX = w - Math.round(w * 0.04);
  if (core.cb.offline) {
    const login = txt(t('auth.loginEntry'), FS.heading, C.gold, true);
    login.anchor.set(1, 0.5); login.x = chipX; login.y = chipMidY;
    core.container.addChild(login);
    const loginPad = Math.round(h * 0.02);
    core.accountChipRect = {
      x: login.x - login.width - loginPad, y: chipMidY - login.height / 2 - loginPad,
      w: login.width + 2 * loginPad, h: login.height + 2 * loginPad,
    };
    core.accountChipFn = core.cb.onLogin ?? null;
  } else if (core.cb.pvp) {
    const pvp = core.cb.pvp;
    // Logout intentionally omitted here — it sat right below the rank badge and
    // players fat-fingered it while tapping through to the leaderboard; log out
    // still lives in SettingsScene.
    const chipPad = Math.round(h * 0.012);
    const iconSz  = Math.round(h * 0.032);
    const iconGap = Math.round(h * 0.01);

    const coins = core.cb.getCoins?.();
    const coinLbl = typeof coins === 'number'
      ? txt(fmtCoins(coins), FS.label, C.gold, true) : null;
    const rankName = t(('rank.' + pvp.rank) as TranslationKey);
    const badge = pvp.rank === 'unranked' ? rankName : `${rankName} · ${pvp.elo}`;
    const tierColor = TIER_COLORS[pvp.rank] ?? C.light;
    const badgeLabel = txt(badge, FS.label, tierColor, true);

    if (core.portrait) {
      // Portrait: coins + rank sit SIDE BY SIDE in the identity row (avatar/name
      // is on the left of the same row — see chipMidY above), right-aligned as
      // two separate chips instead of stacked in a top-right corner.
      const chipGap = Math.round(w * 0.02);
      const rankIconY = Math.round(chipMidY - iconSz / 2);
      const rankChipW = iconSz + iconGap + badgeLabel.width + 2 * chipPad;
      const rankChipX = chipX - rankChipW;

      if (core.cb.onOpenLeaderboard) {
        core.rankChipRect = { x: rankChipX, y: rankIconY - chipPad, w: rankChipW, h: iconSz + 2 * chipPad };
        const rankBg = sketchPanel(core.rankChipRect.w, core.rankChipRect.h,
          { fill: C.paper, border: tierColor, width: 1.6, seed: 74 });
        rankBg.alpha = 0.32;
        rankBg.x = core.rankChipRect.x; rankBg.y = core.rankChipRect.y;
        core.container.addChild(rankBg);
      }
      const rankIcon = buildIcon('trophy', iconSz, tierColor);
      rankIcon.x = rankChipX + chipPad; rankIcon.y = rankIconY;
      core.container.addChild(rankIcon);
      badgeLabel.anchor.set(0, 0.5);
      badgeLabel.x = rankChipX + chipPad + iconSz + iconGap; badgeLabel.y = chipMidY;
      core.container.addChild(badgeLabel);

      if (coinLbl) {
        const coinIconY = Math.round(chipMidY - iconSz / 2);
        const coinChipW = iconSz + iconGap + coinLbl.width + 2 * chipPad;
        const coinChipX = rankChipX - chipGap - coinChipW;
        if (core.cb.onOpenRecharge) {
          core.coinsChipRect = { x: coinChipX, y: coinIconY - chipPad, w: coinChipW, h: iconSz + 2 * chipPad };
          const coinBg = sketchPanel(core.coinsChipRect.w, core.coinsChipRect.h,
            { fill: C.paper, border: C.gold, width: 1.6, seed: 73 });
          coinBg.alpha = 0.32;
          coinBg.x = core.coinsChipRect.x; coinBg.y = core.coinsChipRect.y;
          core.container.addChild(coinBg);
        }
        const coinIcon = buildCoinIcon('coin', iconSz, C.gold);
        coinIcon.x = coinChipX + chipPad; coinIcon.y = coinIconY;
        core.container.addChild(coinIcon);
        coinLbl.anchor.set(0, 0.5);
        coinLbl.x = coinChipX + chipPad + iconSz + iconGap; coinLbl.y = chipMidY;
        core.container.addChild(coinLbl);
      }
    } else {
      // Landscape: two stacked chips in the header's right column: coins · ladder rank.
      // Pulled further apart (was 0.26/0.58 of chipBandH) so the two chip
      // frames read as clearly separate buttons rather than a huddled pair.
      // Gap between the two frames: 0.26/0.70 of the band leaves a moderate
      // seam (~a quarter chip-height). 0.20/0.74 read as drifting apart;
      // 0.26/0.58 overlapped ("huddled"). This sits between the two.
      const coinsY = chipBandY + chipBandH * 0.26;
      const rankY  = chipBandY + chipBandH * 0.70;

      // Measure both labels up front so the two chips can share ONE width and
      // one left edge — they used to be fit to each label independently
      // ("98948k" vs "Gold · 1271"), which left the frames ragged and
      // misaligned. Icons align on a common left edge; text is left-anchored
      // right after the icon; both frames end flush at chipX (+chipPad).
      const maxLabelW = Math.max(coinLbl ? coinLbl.width : 0, badgeLabel.width);
      const contentLeft = Math.round(chipX - (iconSz + iconGap + maxLabelW));
      const chipRectX = contentLeft - chipPad;
      const chipRectW = (chipX - contentLeft) + 2 * chipPad;

      // Soft-currency balance (server-authoritative mirror) — only meaningful online.
      if (coinLbl) {
        const coinIconY = Math.round(coinsY - iconSz / 2);
        if (core.cb.onOpenRecharge) {
          core.coinsChipRect = {
            x: chipRectX, y: coinIconY - chipPad, w: chipRectW, h: iconSz + 2 * chipPad,
          };
          // Standard chip frame (§ shared sketchPanel) behind the coin readout so it
          // reads as a real button, not bare text floating on the dark title bar.
          const coinBg = sketchPanel(core.coinsChipRect.w, core.coinsChipRect.h,
            { fill: C.paper, border: C.gold, width: 1.6, seed: 73 });
          coinBg.alpha = 0.32;
          coinBg.x = core.coinsChipRect.x; coinBg.y = core.coinsChipRect.y;
          core.container.addChild(coinBg);
        }
        // Coin icon at the shared left edge — same AI atlas glyph as the shop header
        // (falls back to the procedural buildIcon draw until coinIconAtlas loads).
        const coinIcon = buildCoinIcon('coin', iconSz, C.gold);
        coinIcon.x = contentLeft; coinIcon.y = coinIconY;
        core.container.addChild(coinIcon);
        coinLbl.anchor.set(0, 0.5);
        coinLbl.x = contentLeft + iconSz + iconGap; coinLbl.y = coinsY;
        core.container.addChild(coinLbl);
      }

      // Ladder rank badge — its own tier color (not the currency gold, not flat
      // grey) so a glance tells coins and rank apart even before reading the text.
      const rankIconY = Math.round(rankY - iconSz / 2);
      if (core.cb.onOpenLeaderboard) {
        core.rankChipRect = {
          x: chipRectX, y: rankIconY - chipPad, w: chipRectW, h: iconSz + 2 * chipPad,
        };
        const rankBg = sketchPanel(core.rankChipRect.w, core.rankChipRect.h,
          { fill: C.paper, border: tierColor, width: 1.6, seed: 74 });
        rankBg.alpha = 0.32;
        rankBg.x = core.rankChipRect.x; rankBg.y = core.rankChipRect.y;
        core.container.addChild(rankBg);
      }
      // Trophy icon at the same left edge as the coin icon so both chips read as
      // the same component with a swapped glyph/color.
      const rankIcon = buildIcon('trophy', iconSz, tierColor);
      rankIcon.x = contentLeft; rankIcon.y = rankIconY;
      core.container.addChild(rankIcon);
      badgeLabel.anchor.set(0, 0.5);
      badgeLabel.x = contentLeft + iconSz + iconGap; badgeLabel.y = rankY;
      core.container.addChild(badgeLabel);
    }
  }
}
