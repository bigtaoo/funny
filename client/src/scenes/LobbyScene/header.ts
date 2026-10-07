// Header chrome — split out of build.ts (2026-08-12, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) purely to keep build.ts under the
// 500-line convention. Draws the logo+title lockup, the top-left profile chip, the boiling-line
// title underline, and the top-right account/coin/rank chips. Only ever called from BuildPanel's
// own build(), so this takes `core` explicitly instead of becoming its own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { palette } from '../../render/theme';
import { buildIcon } from '../../render/icons';
import { BoilingSprite } from '../../render/boil';
import { buildAvatar } from '../../render/avatar';
import logoUrl from '../../assets/logo.png';
import { C, TIER_COLORS, txt, fmtCoins, sketchPanel, type LobbySceneCore } from './core';
import { headerMetrics } from './format';
import { FS, snapFont, snapFontDown, currentFontFloor } from '../../render/fontScale';
import { fitToWidth } from '../../ui/widgets/truncateText';
import { measuredWidth } from '../../render/pixiText';

/**
 * How far the profile name may shrink before it is cut with an ellipsis instead. Shrinking alone
 * took a ten-glyph CJK name next to a seven-digit coin chip down to ~0.6x (about 7 CSS px on a
 * 390-wide phone); past this floor the rest of the name is dropped rather than made unreadable.
 */
const NAME_MIN_SCALE = 0.8;

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

  // Landscape's band is a fraction of the design height, which is 720–860 on a phone held sideways
  // (ADR-105) — so the title is held to the band there, or `display` crowds the subtitle under it.
  // At the classic 1080 height this is still `display`.
  const titleSize = core.portrait ? FS.display : Math.min(FS.display, snapFontDown(tbH * 0.42));
  const title = txt(t('lobby.brandTitle'), titleSize, 0xffffff, true);
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
  const nameSize = snapFont(Math.round(chipBandH * 0.24));
  const nameLabel = txt(core.cb.playerName, nameSize, 0xffffff, true);
  nameLabel.anchor.set(0, 0.5);
  nameLabel.x = avX + av + nameGap;
  nameLabel.y = chipMidY;
  core.container.addChild(nameLabel);

  const pad = Math.round(chipBandH * 0.12);
  // Fits the name into `maxW` (shrink, then cut past NAME_MIN_SCALE) and sizes the profile chip's
  // tap rect to what is actually drawn. Called again by the portrait branch once the coin/rank chips
  // on the same row have been measured — their width depends on the balance, which the fixed
  // `nameMaxFactor` cannot know.
  const fitName = (maxW: number): void => {
    nameLabel.text = core.cb.playerName;
    nameLabel.scale.set(1);
    const fullW = measuredWidth(nameLabel);
    if (fullW > maxW) {
      const scale = maxW / fullW;
      if (scale >= NAME_MIN_SCALE) {
        nameLabel.scale.set(scale);
      } else {
        nameLabel.text = fitToWidth(core.cb.playerName, nameSize, maxW / NAME_MIN_SCALE, true);
        nameLabel.scale.set(NAME_MIN_SCALE);
      }
    }
    core.profileChipRect = {
      x: avX - pad, y: avY - pad,
      w: av + nameGap + nameLabel.width + 2 * pad, h: av + 2 * pad,
    };
  };
  // Keep the profile chip clear of the brand lockup (portrait: half the band;
  // landscape: leave room for the centered lockup).
  // Landscape also stops the name at the brand lockup's left edge: on a narrow design (1280 wide
  // on a phone held sideways, ADR-105) the fixed factor alone ran a long CJK name under the logo.
  const lockupClear = core.portrait ? Infinity : lockupLeft - nameGap - nameLabel.x;
  const nameMax = Math.min(w * nameMaxFactor - (av + nameGap), lockupClear);
  fitName(nameMax);

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

  // The subtitle's row is a fraction of the band, but the title above it is a snapped token and the
  // underline hangs off the title's bottom: on a shorter landscape design (926 tall at 1100x574 since
  // 2026-10-07) the marker stroke ran through the subtitle's caps. Put the caps (≈ 0.4 em above the
  // centre) under the stroke's lower edge (≈ 0.75 ulH into the sprite) — the 1080 layout already
  // clears this, so it does not move — and step the subtitle down the scale only if the band cannot
  // hold it there.
  if (!core.portrait) {
    const strokeBottom = core.titleBoil.y + ulH * 0.75 + 1;
    const bandBottom = tbH - 2;
    let subFs = Number(subtitle.style.fontSize);
    const fits = (fs: number): boolean => strokeBottom + fs * 0.4 + fs * 0.6 <= bandBottom;
    while (!fits(subFs) && subFs > currentFontFloor()) subFs = snapFontDown(subFs - 1);
    if (subFs !== Number(subtitle.style.fontSize)) subtitle.style.fontSize = subFs;
    subtitle.y = Math.max(subtitleY, Math.ceil(strokeBottom + subFs * 0.4));
  }

  // Top-right account chip (SA-4): offline → login/register entry; online →
  // server-authoritative ladder badge with a small logout affordance.
  const chipX = w - Math.round(w * 0.04);
  if (core.cb.offline) {
    // No entry at all when the platform has no login screen (IPlatform.silentAccountOnly).
    if (!core.cb.onLogin) return;
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
      // Podium glyph, not a trophy: the chip's tap target IS the leaderboard, so it reuses
      // `leaderboardTabIcon` rather than earning a 4th trophy-ish piece of art next to
      // `achievementTabIcon`/`honorTabIcon`/`medal` (batch 6 review, 2026-08-17). The raster ink is
      // baked, so the icon no longer carries the tier colour — no information is lost, the chip's
      // border and the `青铜 · 1425` label beside it are both still drawn in `tierColor`. Forced to
      // the white `active` art: this sits on the near-black header bar, and `tierColor` would read
      // "dark" by luma (gold ≈ 0.59) and select the paper-grey variant.
      const rankIcon = buildIcon('leaderboardTabIcon', iconSz, C.light, { variant: 'active' });
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
        const coinIcon = buildIcon('coin', iconSz, C.gold);
        coinIcon.x = coinChipX + chipPad; coinIcon.y = coinIconY;
        core.container.addChild(coinIcon);
        coinLbl.anchor.set(0, 0.5);
        coinLbl.x = coinChipX + chipPad + iconSz + iconGap; coinLbl.y = chipMidY;
        core.container.addChild(coinLbl);
      }
      // Same row as the name: stop it short of whichever chip is leftmost, by the profile chip's own
      // padding, so its tap rect (which extends `pad` past the text) ends at that chip's edge.
      const rowLeft = coinLbl ? rankChipX - chipGap - (iconSz + iconGap + coinLbl.width + 2 * chipPad) : rankChipX;
      fitName(Math.min(nameMax, rowLeft - pad - nameLabel.x));
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
        // Coin icon at the shared left edge — same AI raster glyph as the shop header, resolved
        // straight through `buildIcon` (TAB_ICON_RASTER carries this kind — no separate wrapper).
        const coinIcon = buildIcon('coin', iconSz, C.gold);
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
      // Rank icon at the same left edge as the coin icon so both chips read as
      // the same component with a swapped glyph. See the portrait branch above for why this is
      // the leaderboard podium in fixed white ink rather than a tier-coloured trophy.
      const rankIcon = buildIcon('leaderboardTabIcon', iconSz, C.light, { variant: 'active' });
      rankIcon.x = contentLeft; rankIcon.y = rankIconY;
      core.container.addChild(rankIcon);
      badgeLabel.anchor.set(0, 0.5);
      badgeLabel.x = contentLeft + iconSz + iconGap; badgeLabel.y = rankY;
      core.container.addChild(badgeLabel);
    }
  }
}
