// Main content stack — split out of build.ts (2026-08-12, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) purely to keep build.ts under the
// 500-line convention. Draws the vertically-centred column between the header and the bottom nav:
// the hero "start match" button (+ ambient hero-figure silhouette), the campaign/world pillars, and
// the engagement strip (Daily/Mail/Events/Feedback/Auction). Only ever called from
// BuildPanel's own build(), so this takes `core`/`badges` explicitly instead of becoming its own
// domain class — it needs `badges` one-way to paint the strip's red dots into the layer it creates.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { SketchPen } from '../../render/sketch';
import { inkLayer } from '../../render/sketchUi';
import { buildIcon, IconKind, RasterIconVariant } from '../../render/icons';
import { StickmanRuntime } from '../../render/stickman/StickmanRuntime';
import { MENU_POSE_FPS } from '../../render/stickman/constants';
import { randomHeroAssetUrl } from '../../render/heroSilhouette';
import { fitContentToBox } from '../../render/fitToBox';
import { Rect } from '../../layout/ILayout';
import { C, txt, sketchPanel, drawBtn, type LobbySceneCore } from './core';
import type { BadgesPanel } from './badges';
import { drawButtonLabel } from '../../ui/widgets/buttonLabel';
import { headerMetrics } from './format';
import { snapFont } from '../../render/fontScale';

/**
 * One shortcut in the engagement strip. `icon` is the same glyph the destination screen wears on its
 * own title bar / tab, so the strip reads as five shortcuts rather than five words. Feedback is the
 * one that is not a destination's own glyph: a megaphone drawn for it in batch 11, since a speech
 * bubble would have been `channel` (the family/sect chat) a second time.
 */
type StripEntry = { label: string; border: number; seed: number; icon: IconKind | null; tag: 'daily' | 'mail' | 'events' | 'feedback' | 'auction' };

/**
 * Which shortcuts the strip shows, in order. Resolved before any geometry because the COUNT decides
 * geometry now: portrait's row divides the content width by it, and both forms size themselves to
 * fit. Depends only on the callbacks bag, never on layout.
 */
function stripEntries(core: LobbySceneCore): StripEntry[] {
  const hasEvents   = !!core.cb.onOpenEvents && core.eventsAvailable;
  const hasMail     = !!(core.cb.onOpenMail ?? core.cb.onOpenSocial);
  const hasFeedback = !!core.cb.onOpenFeedback;
  const hasAuction  = !!core.cb.onOpenAuction;

  const entries: StripEntry[] = [];
  entries.push({ label: t('daily.title'),         border: C.gold,  seed: 71, icon: 'checkinTabIcon', tag: 'daily'    });
  if (hasMail)     entries.push({ label: t('lobby.strip.mail'),    border: C.gold,  seed: 72, icon: 'mailTabIcon',    tag: 'mail'     });
  if (hasEvents)   entries.push({ label: t('lobby.strip.events'),  border: C.red,   seed: 73, icon: 'eventTabIcon',   tag: 'events'   });
  if (hasFeedback) entries.push({ label: t('lobby.strip.feedback'),border: C.accent,seed: 74, icon: 'megaphone',      tag: 'feedback' });
  if (hasAuction)  entries.push({ label: t('lobby.strip.auction'), border: C.green, seed: 75, icon: 'auctionTabIcon', tag: 'auction'  });
  return entries;
}

export function drawMainContent(core: LobbySceneCore, badges: BadgesPanel): void {
  const { w, h } = core;
  const { tbH } = headerMetrics(w, h, core.portrait);

  const navH = Math.round(h * 0.105);

  // Engagement strip: present only when online (daily wired implies online). It runs as a COLUMN
  // down the right edge in landscape, and as a ROW under the pillars in portrait — see
  // `stripIsRow`'s note below for why the two orientations differ.
  const hasStrip = !!core.cb.onOpenDaily && !core.cb.offline;
  const entries  = hasStrip ? stripEntries(core) : [];
  /**
   * Portrait puts the strip in a row beneath the pillars instead of a column beside them.
   *
   * The column costs `sideItemSz + sideGap` of WIDTH — 176 of portrait's 1080 design px, 16% of the
   * screen — which is the axis a phone has least of: it squeezed the content column to 828 and each
   * pillar card to 387. Meanwhile the band between header and bottom nav is 1315 tall and the
   * hero+pillars stack only fills 730 of it, so 44% of the vertical budget sat empty (2026-09-15
   * measurement, on the real 1080×1920 portrait canvas). Moving the five shortcuts into that empty
   * band spends the axis that has room to spare and hands the width back: content 828 → 972, pillar
   * cards 387 → 459, and the empty band drops from 585px to 351px of plain margin. Landscape keeps
   * the column — width is the axis it has spare, and the empty band under its pillars is shallower.
   */
  const stripIsRow = hasStrip && core.portrait;
  const stripIsCol = hasStrip && !core.portrait;
  const sideItemSz = hasStrip ? Math.round(h * 0.082) : 0;  // square icon cell
  const sideGap    = stripIsCol ? Math.round(w * 0.018) : 0;

  // Content narrows to make room for the COLUMN form of the strip only; the row form sits below the
  // content and costs it no width. Left margin unchanged either way.
  // Portrait screens are narrower in absolute terms, so the fixed side margins read as
  // proportionally larger — hence a wider fraction there than landscape's 82%, which has width to
  // spare already. Portrait sat at 93% while the strip column was eating 176px off the far side;
  // now that the strip is a row and the whole fraction reaches the content, it returns to the 90%
  // this codebase uses for every other portrait content column (roster grid, codex, shop group —
  // LOBBY_IA_REDESIGN.md §21/§23/§24). At 93% the pillars' shared backdrop, which overhangs the
  // column by `pad` on each side, ended up 13px from the paper's edge.
  const fullContentW = Math.round(w * (core.portrait ? 0.90 : 0.82));
  const contentX     = Math.round((w - fullContentW) / 2);
  const contentW     = fullContentW - (stripIsCol ? sideItemSz + sideGap : 0);
  const sideX        = contentX + contentW + sideGap;

  // Portrait's identity chip band collapsed from a two-row stack to one row
  // (see headerMetrics), freeing header height — spend a slice of it here so
  // the hero/pillar buttons read slightly larger, not just repositioned.
  const heroH   = Math.round(h * (core.portrait ? 0.175 : 0.165));
  const pillarH = Math.round(h * (core.portrait ? 0.165 : 0.155));
  const gapA    = Math.round(h * 0.04);  // hero → pillars

  // Row form: cells keep their square size unless the row would outgrow the content width, which is
  // what the five-entry case (an event window is live) does — 5×157 + 4×54 = 1001 against a 972-wide
  // column on the real portrait canvas, so the cells give up 6px each and the row fits at 971.
  const rowGap  = Math.round(w * 0.05);  // matches pillarGap, so the row reads as part of the block
  const rowCell = stripIsRow
    ? Math.min(sideItemSz, Math.floor((contentW - (entries.length - 1) * rowGap) / entries.length))
    : 0;
  const gapB    = stripIsRow ? gapA : 0;  // pillars → strip row

  const stackH  = heroH + gapA + pillarH + gapB + rowCell;
  const usableTop = tbH;
  const usableH   = (h - navH) - tbH;
  // Bias upward (0.40 instead of 0.5): push the hero up to close the large gap below the header.
  const startY = usableTop + Math.max(Math.round(h * 0.035), Math.round((usableH - stackH) * 0.40));

  const heroY    = startY;
  const pillarsY = heroY + heroH + gapA;

  // 1. Hero — start match. Offline → local AI match; online → PvP ranked.
  core.btnRect = { x: contentX, y: heroY, w: contentW, h: heroH };
  core.btnBg = new PIXI.Container();
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
    const runtime = new StickmanRuntime(asset, { showShadow: false, poseFps: MENU_POSE_FPS });
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
  // Fit inside the button: the font is a fraction of `heroH`, which grows with portrait's stretchy
  // height axis, while the string's length is fixed — on a tall phone "Ranked · 5-10 min per game"
  // (longer still in German) grew past `contentW` and bled out both sides of the card, centred
  // anchor and all (2026-08-18 store-screenshot pass).
  const heroSubMaxW = contentW * 0.92;
  if (heroSub.width > heroSubMaxW) heroSub.scale.set(heroSubMaxW / heroSub.width);
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

  // 3. Engagement strip — Daily / Mail / Events / Feedback / Auction (P2).
  // Replaces the old horizontal engagement chip row. Items are compact sketch panels, each with a
  // short 2-char label and a red dot when actionable: a column beside the hero + pillars area in
  // landscape, a row beneath them in portrait (see `stripIsRow` above for the why).
  core.dailyBtnRect   = { x: 0, y: 0, w: 0, h: 0 };
  core.eventsBtnRect  = { x: 0, y: 0, w: 0, h: 0 };
  core.mailStripRect  = { x: 0, y: 0, w: 0, h: 0 };
  core.feedbackStripRect = { x: 0, y: 0, w: 0, h: 0 };
  core.auctionStripRect = { x: 0, y: 0, w: 0, h: 0 };
  if (hasStrip) {
    // Where each cell lands, and how big it is — the only thing the two orientations disagree on.
    const cellSz = stripIsRow ? rowCell : sideItemSz;
    let cellAt: (i: number) => { x: number; y: number };
    if (stripIsRow) {
      // Centred under the pillars: with four entries the row is narrower than the content column,
      // and hanging it off the left edge would read as a fifth slot missing on the right.
      const rowW = entries.length * cellSz + (entries.length - 1) * rowGap;
      const rowX = contentX + Math.round((contentW - rowW) / 2);
      const rowY = pillarsY + pillarH + gapB;
      cellAt = (i) => ({ x: rowX + i * (cellSz + rowGap), y: rowY });
    } else {
      const itemGap = Math.round(h * 0.014);
      const totalH  = entries.length * cellSz + (entries.length - 1) * itemGap;
      // Vertically centre the column within the hero+pillars block. Note that five entries (i.e. an
      // event window is live) make the column TALLER than that block — 505 vs 388 design px — so it
      // then overhangs the hero's top and the pillars' bottom by ~59px each. Measured 2026-09-15: it
      // still lands well inside the band between header and bottom nav at every aspect (both scale
      // with `h`), so it is an alignment wart, not a collision, and landscape is left as it was.
      const stripTopY = Math.round(heroY + (stackH - totalH) / 2);
      cellAt = (i) => ({ x: sideX, y: stripTopY + i * (cellSz + itemGap) });
    }
    const fontSize = snapFont(Math.round(cellSz * 0.30));

    entries.forEach((entry, i) => {
      const { x: ix, y: iy } = cellAt(i);
      const bg = sketchPanel(cellSz, cellSz, { fill: C.paper, border: entry.border, width: 1.8, seed: entry.seed });
      bg.x = ix; bg.y = iy;
      core.container.addChild(bg);

      // Square cell → glyph stacked over the label (a row would leave neither any room).
      drawButtonLabel(core.container, ix, iy, cellSz, cellSz, entry.label, entry.icon,
        C.dark, fontSize, { stack: true, inset: cellSz * 0.12 });

      const rect: Rect = { x: ix, y: iy, w: cellSz, h: cellSz };
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
  // `inkLayer`, not `bg` itself: a panel is a container of frame sprites now (see core.ts's
  // drawBtn/sketchPanel), so there is no single Graphics to stroke into. Same call vsOverlay.ts
  // already makes for its own accent stroke.
  new SketchPen(inkLayer(bg), seed ^ 0x55).line(4, 6, 4, h - 6, { color: accent, width: 5, jitter: 0.8, taper: 0.85 });

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
  fitToCard(titleLbl, w);
  core.container.addChild(titleLbl);

  const subLbl = txt(sub, snapFont(Math.round(h * 0.12)), C.mid);
  subLbl.anchor.set(0.5, 0.5);
  subLbl.x = x + w / 2; subLbl.y = y + h * 0.88;
  fitToCard(subLbl, w);
  core.container.addChild(subLbl);
}

/**
 * Shrink a centred pillar label to the card, the same way the hero subtitle above already fits
 * itself to `contentW`.
 *
 * Without this the world pillar's locked subtitle ("Clear Chapter 1 to unlock", and longer in
 * German) ran ~70px past a 145px-wide card in portrait and straight through the Auction shortcut
 * in the side strip — measured on all three portrait viewports, 2026-09-11. In landscape the card
 * is wide enough that nothing ever clipped, which is why it stood this long.
 */
function fitToCard(label: PIXI.Text, cardW: number): void {
  const maxW = cardW * 0.9;
  if (label.width > maxW) label.scale.set(maxW / label.width);
}
