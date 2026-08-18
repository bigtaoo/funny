// Main content stack — split out of build.ts (2026-08-12, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) purely to keep build.ts under the
// 500-line convention. Draws the vertically-centred column between the header and the bottom nav:
// the hero "start match" button (+ ambient hero-figure silhouette), the campaign/world pillars, and
// the right-side engagement strip (Daily/Mail/Events/Feedback/Auction). Only ever called from
// BuildPanel's own build(), so this takes `core`/`badges` explicitly instead of becoming its own
// domain class — it needs `badges` one-way to paint the strip's red dots into the layer it creates.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { SketchPen } from '../../render/sketch';
import { buildIcon, IconKind, RasterIconVariant } from '../../render/icons';
import { StickmanRuntime } from '../../render/stickman/StickmanRuntime';
import { randomHeroAssetUrl } from '../../render/heroSilhouette';
import { fitContentToBox } from '../../render/fitToBox';
import { Rect } from '../../layout/ILayout';
import { C, txt, sketchPanel, drawBtn, type LobbySceneCore } from './core';
import type { BadgesPanel } from './badges';
import { headerMetrics } from './format';
import { snapFont } from '../../render/fontScale';

export function drawMainContent(core: LobbySceneCore, badges: BadgesPanel): void {
  const { w, h } = core;
  const { tbH } = headerMetrics(w, h, core.portrait);

  const navH = Math.round(h * 0.105);

  // Right-side strip: present only when online (daily wired implies online).
  const hasSideStrip = !!core.cb.onOpenDaily && !core.cb.offline;
  const sideItemSz = hasSideStrip ? Math.round(h * 0.082) : 0;  // square icon cell
  const sideGap    = hasSideStrip ? Math.round(w * 0.018) : 0;

  // Content narrows to make room for the strip; left margin unchanged.
  // Portrait screens are narrower in absolute terms, so the fixed side
  // margins read as proportionally larger — widen to 93% there (the identity
  // chip band collapsing to one row freed some width too; landscape keeps its
  // original 82%, plenty of width to spare already).
  const fullContentW = Math.round(w * (core.portrait ? 0.93 : 0.82));
  const contentX     = Math.round((w - fullContentW) / 2);
  const contentW     = fullContentW - sideItemSz - sideGap;
  const sideX        = contentX + contentW + sideGap;

  // Portrait's identity chip band collapsed from a two-row stack to one row
  // (see headerMetrics), freeing header height — spend a slice of it here so
  // the hero/pillar buttons read slightly larger, not just repositioned.
  const heroH   = Math.round(h * (core.portrait ? 0.175 : 0.165));
  const pillarH = Math.round(h * (core.portrait ? 0.165 : 0.155));
  const gapA    = Math.round(h * 0.04);  // hero → pillars

  const stackH  = heroH + gapA + pillarH;
  const usableTop = tbH;
  const usableH   = (h - navH) - tbH;
  // Bias upward (0.40 instead of 0.5): push the hero up to close the large gap below the header.
  const startY = usableTop + Math.max(Math.round(h * 0.035), Math.round((usableH - stackH) * 0.40));

  const heroY    = startY;
  const pillarsY = heroY + heroH + gapA;

  // 1. Hero — start match. Offline → local AI match; online → PvP ranked.
  core.btnRect = { x: contentX, y: heroY, w: contentW, h: heroH };
  core.btnBg = new PIXI.Graphics();
  drawBtn(core.btnBg, contentW, heroH, true);
  core.btnBg.x = contentX; core.btnBg.y = heroY;
  core.container.addChild(core.btnBg);

  // Crossed-pencils motif stamped on the right of the hero (faint accent ink on
  // the dark fill) — adds content without a photo, off-centre to clear the label.
  // `variant: 'active'` (white ink) is passed explicitly rather than left to `tabIconVariant`'s colour
  // test: this motif sits on the hero button's near-black fill, and any accent colour we'd pass as a
  // hint reads "dark" by luma and would select the paper-grey art, which vanishes there.
  const heroMotifS = Math.round(heroH * 1.05);
  const heroMotif = buildIcon('duelTabIcon', heroMotifS, C.light, { variant: 'active' });
  heroMotif.alpha = 0.22;
  heroMotif.x = Math.round(contentX + contentW - heroMotifS * 1.15);
  heroMotif.y = Math.round(heroY + heroH / 2 - heroMotifS / 2);
  core.container.addChild(heroMotif);

  core.btnLabel = txt(core.cb.offline ? t('lobby.startVsAI') : t('lobby.startMatch'), snapFont(Math.round(heroH * 0.30)), 0xffffff, true);
  core.btnLabel.anchor.set(0.5, 0.5);
  core.btnLabel.x = contentX + contentW / 2;
  core.btnLabel.y = heroY + heroH * 0.38;
  core.container.addChild(core.btnLabel);

  // Ambient character silhouette on the left of the hero (mirrors the pencils
  // motif above): a random playable unit, flat-black + faded, cycling through
  // random animation clips (§ hero-decoration). Loads async — appears a frame
  // or two after the rest of the button since the .tao bundle must be fetched.
  // Centred horizontally 1/3 of the way from the button's left edge to the
  // label's left edge (not flush against the edge) so it reads as a companion
  // beside the text.
  //
  // Sizing must be by the RENDERED PIXELS, not asset.naturalHeight: that value
  // is the skeleton *joint* extent, so head/foot/weapon art overhanging the
  // joints is invisible to it and each rig ends up a different on-screen height,
  // off-centre. Instead we measure the figure's true drawn bounds (unioned over
  // all clips → pose-stable, same basis for every rig) and fit it to exactly
  // 90% of the button height, centred on the button's centre. No ground shadow —
  // it floats inside the button (showShadow:false).
  const HERO_FIGURE_FRAC = 0.90;                            // silhouette height = 90% of button
  const heroFigureH    = Math.round(heroH * HERO_FIGURE_FRAC);   // outline-calibration hint only
  const labelLeftEdge  = core.btnLabel.x - core.btnLabel.width / 2;
  const heroFigureX    = Math.round(contentX + (labelLeftEdge - contentX) / 3);
  const heroFigureInsertAfter = heroMotif;
  StickmanRuntime.loadAsset(randomHeroAssetUrl(), heroFigureH).then(asset => {
    if (core.destroyed) return;
    const runtime = new StickmanRuntime(asset, { showShadow: false });
    runtime.setSilhouette(0x000000);
    runtime.container.alpha = 0.22;
    // Fit the true rendered extent to 90% of the button height, centred both
    // axes (fitContentToBox — measured box, never an assumed origin).
    const fit = fitContentToBox(
      runtime.getRenderedLocalBounds(),
      { top: heroY, height: heroH, centerX: heroFigureX },
      HERO_FIGURE_FRAC,
    );
    runtime.container.scale.set(fit.scale, fit.scale);
    runtime.container.x = fit.x;
    runtime.container.y = fit.y;
    const idx = core.container.getChildIndex(heroFigureInsertAfter);
    core.container.addChildAt(runtime.container, idx + 1);
    core.heroFigureClips = [...asset.clips.keys()];
    if (core.heroFigureClips.length) {
      runtime.play(core.heroFigureClips[Math.floor(Math.random() * core.heroFigureClips.length)]!);
    }
    core.heroFigureSwapTimer = 1.6 + Math.random() * 1.6;
    core.heroFigure = runtime;
  }).catch(() => { /* decorative-only: missing/broken .tao must not crash the lobby */ });

  const heroSubKey: TranslationKey = core.cb.offline
    ? 'lobby.match.subSolo'
    : (core.cb.online ? 'lobby.match.subRanked' : 'lobby.match.subAI');
  const heroSub = txt(t(heroSubKey), snapFont(Math.round(heroH * 0.15)), C.light);
  heroSub.anchor.set(0.5, 0.5);
  heroSub.x = contentX + contentW / 2;
  heroSub.y = heroY + heroH * 0.70;
  core.container.addChild(heroSub);

  // 2. Pillars: Campaign (gold, PvE) | World map (accent, SLG). The world map needs an account,
  // so it's hidden in offline mode — Campaign then takes the full content width.
  const showWorld = !core.cb.offline && !!core.cb.onOpenWorld;
  const pillarGap = Math.round(w * 0.05);
  const pw = showWorld ? Math.round((contentW - pillarGap) / 2) : contentW;

  // Shared backdrop behind both pillars — a single hand-drawn panel that reads as
  // one grouped block, with the individual pillar cards sitting on top of it.
  if (showWorld) {
    const pad = Math.round(pillarH * 0.08);
    const backdrop = sketchPanel(contentW + 2 * pad, pillarH + 2 * pad,
      { fill: C.paper, border: C.mid, width: 1.6, seed: 52 });
    backdrop.x = contentX - pad; backdrop.y = pillarsY - pad;
    core.container.addChild(backdrop);
  }

  core.campaignBtnRect = { x: contentX, y: pillarsY, w: pw, h: pillarH };
  drawPillar(core, contentX, pillarsY, pw, pillarH, C.gold, 'campaignTabIcon',
    t('lobby.campaign'), t('lobby.campaign.sub'), 51);

  if (showWorld) {
    const worldX = contentX + pw + pillarGap;
    core.worldPillarRect = { x: worldX, y: pillarsY, w: pw, h: pillarH };
    // Soft gate (§4): chapter one not cleared → greyed accent + subtitle changed to "clear chapter one to unlock".
    const locked = !!core.cb.worldLocked;
    drawPillar(core, worldX, pillarsY, pw, pillarH, locked ? C.light : C.accent, 'worldTabIcon',
      t('lobby.world'), locked ? t('lobby.world.locked') : t('lobby.world.sub'), 53,
      locked ? 'inactive' : 'content');
  } else {
    core.worldPillarRect = { x: 0, y: 0, w: 0, h: 0 };
  }

  // 3. Right-side vertical strip — Daily / Mail / Events / Feedback / Auction (P2).
  // Replaces the old horizontal engagement chip row. Items are compact sketch
  // panels stacked vertically alongside the hero + pillars area, each with a
  // short 2-char label and a red dot when actionable.
  core.dailyBtnRect   = { x: 0, y: 0, w: 0, h: 0 };
  core.eventsBtnRect  = { x: 0, y: 0, w: 0, h: 0 };
  core.mailStripRect  = { x: 0, y: 0, w: 0, h: 0 };
  core.feedbackStripRect = { x: 0, y: 0, w: 0, h: 0 };
  core.auctionStripRect = { x: 0, y: 0, w: 0, h: 0 };
  if (hasSideStrip) {
    const hasEvents   = !!core.cb.onOpenEvents && core.eventsAvailable;
    const hasMail     = !!(core.cb.onOpenMail ?? core.cb.onOpenSocial);
    const hasFeedback = !!core.cb.onOpenFeedback;
    const hasAuction  = !!core.cb.onOpenAuction;

    type StripEntry = { label: string; border: number; seed: number; tag: 'daily' | 'mail' | 'events' | 'feedback' | 'auction' };
    const entries: StripEntry[] = [];
    entries.push({ label: t('daily.title'),         border: C.gold,  seed: 71, tag: 'daily'    });
    if (hasMail)     entries.push({ label: t('lobby.strip.mail'),    border: C.gold,  seed: 72, tag: 'mail'     });
    if (hasEvents)   entries.push({ label: t('lobby.strip.events'),  border: C.red,   seed: 73, tag: 'events'   });
    if (hasFeedback) entries.push({ label: t('lobby.strip.feedback'),border: C.accent,seed: 74, tag: 'feedback' });
    if (hasAuction)  entries.push({ label: t('lobby.strip.auction'), border: C.green, seed: 75, tag: 'auction'  });

    const itemGap  = Math.round(h * 0.014);
    const totalH   = entries.length * sideItemSz + (entries.length - 1) * itemGap;
    // Vertically centre the strip within the hero+pillars block.
    const stripTopY = Math.round(heroY + (stackH - totalH) / 2);
    const fontSize  = snapFont(Math.round(sideItemSz * 0.30));

    entries.forEach((entry, i) => {
      const iy = stripTopY + i * (sideItemSz + itemGap);
      const bg = sketchPanel(sideItemSz, sideItemSz, { fill: C.paper, border: entry.border, width: 1.8, seed: entry.seed });
      bg.x = sideX; bg.y = iy;
      core.container.addChild(bg);

      const lbl = txt(entry.label, fontSize, C.dark, true);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = sideX + sideItemSz / 2; lbl.y = iy + sideItemSz / 2;
      // Scale down if label doesn't fit (e.g. longer EN strings).
      const maxW = sideItemSz * 0.88;
      if (lbl.width > maxW) lbl.scale.set(maxW / lbl.width);
      core.container.addChild(lbl);

      const rect: Rect = { x: sideX, y: iy, w: sideItemSz, h: sideItemSz };
      switch (entry.tag) {
        case 'daily':    core.dailyBtnRect      = rect; break;
        case 'mail':     core.mailStripRect      = rect; break;
        case 'events':   core.eventsBtnRect      = rect; break;
        case 'feedback': core.feedbackStripRect  = rect; break;
        case 'auction':  core.auctionStripRect    = rect; break;
      }
    });

    // Badge layer for cheap dot redraws (no full rebuild needed for state changes).
    core.sideStripBadgeLayer = new PIXI.Container();
    core.container.addChild(core.sideStripBadgeLayer);
    badges.drawSideStripBadges();
  }
}

/**
 * A pillar card for the main lobby grid (Campaign / World map): hand-drawn panel +
 * coloured left-edge ink stroke + a line-art icon, title and subtitle. Shares the
 * notebook-doodle language with the feature panels and VS cards.
 *
 * The motif is AI raster art since batch 6, so it no longer takes `accent`'s colour — the card's
 * left-edge stroke, border and (for the world card) subtitle already carry gold-vs-blue, so the
 * watermark drops to plain ink rather than earning the pack script two more baked colours.
 * `iconVariant` is therefore explicit: `'content'` (full-strength ink) for a live card, `'inactive'`
 * (the de-emphasised grey) for the soft-gated world card, matching its greyed border.
 */
function drawPillar(
  core: LobbySceneCore,
  x: number, y: number, w: number, h: number,
  accent: number, icon: IconKind, title: string, sub: string, seed: number,
  iconVariant: RasterIconVariant = 'content',
): void {
  const bg = sketchPanel(w, h, { fill: C.paper, border: accent, width: 2.6, seed });
  bg.x = x; bg.y = y;
  core.container.addChild(bg);
  // Coloured ink accent stroke down the left edge.
  new SketchPen(bg, seed ^ 0x55).line(4, 6, 4, h - 6, { color: accent, width: 5, jitter: 0.8, taper: 0.85 });

  // Large hand-drawn motif filling the card's upper half (replaces the old small icon):
  // accent-ink colour at low alpha as a "card doodle"; the title text drawn over it remains legible.
  const iconSize = Math.round(h * 0.6);
  const glyph = buildIcon(icon, iconSize, accent, { variant: iconVariant });
  glyph.alpha = 0.6;
  glyph.x = Math.round(x + w / 2 - iconSize / 2);
  glyph.y = Math.round(y + h * 0.40 - iconSize / 2);
  core.container.addChild(glyph);

  const titleLbl = txt(title, snapFont(Math.round(h * 0.22)), C.dark, true);
  titleLbl.anchor.set(0.5, 0.5);
  titleLbl.x = x + w / 2; titleLbl.y = y + h * 0.70;
  core.container.addChild(titleLbl);

  const subLbl = txt(sub, snapFont(Math.round(h * 0.12)), C.mid);
  subLbl.anchor.set(0.5, 0.5);
  subLbl.x = x + w / 2; subLbl.y = y + h * 0.88;
  core.container.addChild(subLbl);
}
