import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../render/pixiText';
import { Scene } from './SceneManager';
import { OwnerId, PlayerStats } from '@nw/engine/types';
import { t, TranslationKey } from '../i18n';
import { ProfilePopup, type ProfileData, type ProfileExtra } from '../ui/dialogs/ProfilePopup';
import { ui, buildPaperBackground, tearDownChildren } from '../render/sketchUi';
import { buildIcon, IconKind } from '../render/icons';
import { computeBadges } from './ResultScene/badges';
import { buildRewardIcon, preloadRewardIconArt, type RewardLike } from '../render/rewardIcon';
import { buildDecorCLayer } from '../render/decorCLayer';
import { FS } from '../render/fontScale';
import {
  buildMarginDeco, buildBadgeMedallion, addMoodDeco, addProfileLine, addVersusLine,
  addPrimaryButton, addSecondaryButton, addHeader, addEloProtectLine, type EloProtectFields,
} from './ResultScene/builders';
import { UI_FONT_FAMILY } from '../render/theme';

/** Optional player identities for the result screen's tap-to-view profile popup. */
export interface ResultProfiles {
  opponent?: ProfileData;
  local?: ProfileData;
}

/** Server-authoritative ELO result (ranked only, from match_over.elo). */
export interface EloResult extends EloProtectFields {
  delta: number;
  after: number;
  rankAfter: string;
}

/** The "come back tomorrow" check-in hook (RETENTION_LAUNCH_PLAN.md §3.3) — see AppViews.ts's doc. */
export interface ResultRetentionPreview {
  /** 1-based check-in calendar slot (server/shared/src/retention.ts CHECKIN_REWARDS index + 1). */
  day: number;
  reward: RewardLike;
}

// ─── ResultScene ──────────────────────────────────────────────────────────────

export interface ResultSceneCallbacks {
  onPlayAgain(): void;
  /** Top-left back chip — always shown, always exits straight to the lobby regardless of what onPlayAgain does. */
  onBack(): void;
  /** When set, a "watch replay" button is shown (locally-recorded matches, S1-RP). */
  onWatchReplay?(): void;
  /** When set, a "share this match" button is shown (state-stream sharing, REPLAY_SHARE_DESIGN §4.3). */
  onShare?(): void;
  /** Override the "play again" button label (e.g. campaign uses 'Back to Map'). */
  playAgainLabel?: string;
  /**
   * An extra entry at the head of the secondary row — campaign's "back to map" once a defeat turns
   * the primary CTA into "retry".
   */
  secondaryAction?: { label: string; icon: IconKind; onTap(): void };
  /** Unified profile-popup extras (rank/ELO + family/sect) — see ProfilePopup's `fetchExtra`. Omitted offline/AI. */
  getProfileExtra?(publicId: string): Promise<ProfileExtra>;
  /**
   * Seconds before the primary button presses itself, a bar filling along its foot meanwhile
   * (ONBOARDING_DESIGN §13 — campaign's first clear of a level, where the primary is "next level").
   * Counts from when the result itself is on screen, never during the outro; any tap on the screen's
   * other controls cancels it.
   */
  autoContinueSec?: number;
  /**
   * The compact first-win screen (ONBOARDING_DESIGN §15.4) — a first clear of an early campaign level:
   * only the hero badge, no medallion row, and an "up next" teaser naming the level the primary CTA
   * leads to, so the screen reads as one step of a run rather than a stats page.
   */
  firstWin?: { nextName: string };
}

/** Outro screens advance on their own after this long plus {@link OUTRO_SEC_PER_CHAR} per character. */
const OUTRO_BASE_SEC = 2.5;
const OUTRO_SEC_PER_CHAR = 0.045;
const OUTRO_MAX_SEC = 10;

export class ResultScene implements Scene {
  readonly container: PIXI.Container;
  /** Menu/shell screen: painted only when the stage changes (render/renderPolicy.ts). */
  readonly paint = 'reactive' as const;

  private readonly w: number;
  private readonly h: number;

  private readonly localOwner: OwnerId;
  private readonly elo?: EloResult;
  private readonly profiles?: ResultProfiles;
  private readonly retentionPreview?: ResultRetentionPreview;
  private readonly popup: ProfilePopup;

  /** Seconds since construction — the clock for both timers below. */
  private time = 0;
  /** The outro screen on display: when it advances on its own, and how (same path as a tap). */
  private outroAuto: { at: number; advance: () => void } | null = null;
  /** The primary button's auto-press: when it started, how long it runs, the bar, the press. */
  private autoContinue: {
    from: number; sec: number; bar: PIXI.Graphics; rect: { x: number; y: number; w: number; h: number }; press: () => void;
  } | null = null;

  constructor(
    w: number,
    h: number,
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    cb: ResultSceneCallbacks,
    localOwner: OwnerId = 0,
    elo?: EloResult,
    profiles?: ResultProfiles,
    outroTexts?: string[],
    retentionPreview?: ResultRetentionPreview,
  ) {
    this.container = new PIXI.Container();
    this.w  = w;
    this.h  = h;
    this.localOwner = localOwner;
    this.elo = elo;
    this.profiles = profiles;
    this.retentionPreview = retentionPreview;
    this.popup = new ProfilePopup(w, h, cb.getProfileExtra);
    if (retentionPreview) void preloadRewardIconArt(); // best-effort; buildRewardIcon degrades gracefully if art isn't decoded yet

    if (outroTexts && outroTexts.length > 0) {
      this.buildOutroOverlay(outroTexts, 0, () => {
        this.build(winner, stats, cb);
        this.container.addChild(this.popup.container);
      });
    } else {
      this.build(winner, stats, cb);
      this.container.addChild(this.popup.container); // topmost overlay
    }
  }

  update(dt: number): void {
    this.time += dt;
    if (this.outroAuto && this.time >= this.outroAuto.at) this.outroAuto.advance();
    const ac = this.autoContinue;
    if (!ac) return;
    const p = Math.min(1, (this.time - ac.from) / ac.sec);
    const inset = ac.rect.h * 0.3; // clear of the panel's rounded corners
    const barH = Math.max(3, Math.round(ac.rect.h * 0.07));
    ac.bar.clear();
    ac.bar.beginFill(0xffffff, 0.8);
    ac.bar.drawRect(ac.rect.x + inset, ac.rect.y + ac.rect.h - barH * 2, (ac.rect.w - inset * 2) * p, barH);
    ac.bar.endFill();
    if (p >= 1) { this.autoContinue = null; ac.press(); }
  }

  destroy(): void {
    this.popup.destroy();
    this.container.destroy({ children: true });
  }

  /**
   * Full-screen tap-through outro overlay; pages through `texts` one screen per tap, then calls
   * onDone to reveal the result. Every level but ch6_lv10 passes a single-element array, so this
   * behaves exactly like the old one-screen overlay for them.
   */
  private buildOutroOverlay(texts: string[], index: number, onDone: () => void): void {
    const { w, h } = this;

    const bg = new PIXI.Graphics();
    bg.beginFill(0x1a1408, 0.97); bg.drawRect(0, 0, w, h); bg.endFill();
    this.container.addChild(bg);

    const margin = Math.round(w * 0.08);
    const fontSize = FS.heading;
    const body = makeText(texts[index]!, {
      fontSize,
      fill: 0xe8dfc0,
      wordWrap: true,
      wordWrapWidth: w - margin * 2,
      lineHeight: Math.round(fontSize * 1.65),
      align: 'center',
      fontFamily: UI_FONT_FAMILY,
    });
    body.anchor.set(0.5, 0.5);
    body.x = w / 2;
    body.y = h / 2;
    this.container.addChild(body);

    const hint = makeText(t('story.tapToContinue'), {
      fontSize: FS.label,
      fill: 0x8a7a60,
      fontFamily: UI_FONT_FAMILY,
    });
    hint.anchor.set(0.5, 1);
    hint.x = w / 2;
    hint.y = h - Math.round(h * 0.06);
    this.container.addChild(hint);

    // A tap advances; so does time (ONBOARDING_DESIGN §13) — a full-screen text page after a win
    // that waits for a tap read as the end of the game, and the first CrazyGames week lost players
    // on exactly this screen after ch1_lv1.
    const advance = (): void => {
      this.container.off('pointerdown', advance);
      this.outroAuto = null;
      // Restore the container's default eventMode ('passive') rather than 'none' — PIXI's
      // EventBoundary prunes the *entire* subtree under an eventMode:'none' node (see
      // EventBoundary._interactivePrune), so leaving it 'none' after this tap permanently
      // swallows every click on whatever onDone() builds next (badges/buttons never respond).
      this.container.eventMode = 'passive';
      tearDownChildren(this.container);
      if (index + 1 < texts.length) {
        this.buildOutroOverlay(texts, index + 1, onDone);
      } else {
        onDone();
      }
    };
    this.container.eventMode = 'static';
    this.container.on('pointerdown', advance);
    const dwell = Math.min(OUTRO_MAX_SEC, OUTRO_BASE_SEC + texts[index]!.length * OUTRO_SEC_PER_CHAR);
    this.outroAuto = { at: this.time + dwell, advance };
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  private build(
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    cb: ResultSceneCallbacks,
  ): void {
    const { w, h } = this;
    const playerStats = stats[this.localOwner]!; // the local player's stats (owner 0 or 1)
    // Portrait's design space swaps which axis is "short": h is the long axis (>=1920,
    // vs. landscape's fixed 1080), so h-fraction offsets tuned against landscape's short
    // h blow up in portrait. Only the spots that actually overflowed get a portrait branch
    // below — everything else scales fine since it grows/shrinks together with the extra room.
    const isPortrait = h > w;

    // Background — shared hand-drawn notebook page (baked per size).
    this.container.addChild(buildPaperBackground('resultbg', w, h));

    // Standard title bar (paper chrome + embedded back button), same as every
    // other secondary scene (e.g. shop) — title is null since the big win/lose
    // headline below is this scene's title. The back chip always exits straight
    // to the lobby, independent of whatever the primary CTA below does (which
    // may re-enter a match instead).
    const hdr = addHeader(this.container, w, h, () => cb.onBack());

    // C-group scattered doodles across the full page (same atlas as lobby background).
    const cLayer = buildDecorCLayer(w, h);
    if (cLayer) this.container.addChild(cLayer);

    // A-group doodles in the left/right paper margins (same atlas as battle scene).
    const aLayer = buildMarginDeco(w, h);
    if (aLayer) this.container.addChild(aLayer);

    // Win / lose / draw headline
    const isDraw  = winner === null;
    const isWin   = winner === this.localOwner;
    const headline = isDraw ? t('result.draw') : (isWin ? t('result.victory') : t('result.defeat'));
    const headlineColor = isDraw ? 0x888888 : (isWin ? 0x226622 : 0xaa2222);

    // Mood doodles scribbled in the margins (behind the text/buttons): a little
    // notebook flourish that swings with the result — stars/sparkles on a win,
    // red cross-outs on a loss (echoes the "red-pen" art motif).
    addMoodDeco(this.container, w, h, isDraw ? 'draw' : (isWin ? 'win' : 'loss'));

    const title = makeText(headline, {
      fontSize: FS.display,
      fill: headlineColor,
      fontWeight: 'bold', // family: makeText's UI_FONT_FAMILY default
    });
    title.anchor.set(0.5, 0);
    title.x = w / 2;
    title.y = hdr.headerH + h * 0.02;
    this.container.addChild(title);

    // Ranked ELO result line (server-authoritative, ranked only).
    let headerBottom = title.y + title.height;
    if (this.elo) {
      const sign = this.elo.delta >= 0 ? '+' : '';
      const rankName = t(('rank.' + this.elo.rankAfter) as TranslationKey);
      const eloLine = makeText(
        t('result.eloDelta', { delta: `${sign}${this.elo.delta}`, after: this.elo.after, rank: rankName }),
        {
          fontSize: FS.title,
          fill: this.elo.delta >= 0 ? 0x226622 : 0xaa2222,
          fontWeight: 'bold',
          fontFamily: UI_FONT_FAMILY,
        },
      );
      eloLine.anchor.set(0.5, 0);
      eloLine.x = w / 2;
      eloLine.y = headerBottom + h * 0.02;
      this.container.addChild(eloLine);
      headerBottom = eloLine.y + eloLine.height;
      headerBottom = addEloProtectLine(this.container, w, h, headerBottom, this.elo);
    }

    // Tap-to-view profile lines (netplay only — local then "vs opponent").
    const local = this.profiles?.local;
    const opp = this.profiles?.opponent;
    if (local && opp && opp.name) {
      // Both players known: single centred line "local (you)  vs  opponent",
      // with the neutral-grey "vs" sitting between the two tappable names.
      headerBottom = addVersusLine(this.container, this.popup, w, h, local, opp, headerBottom);
    } else if (local) {
      headerBottom = addProfileLine(
        this.container, this.popup, w, h, local.name + ' ' + t('profile.you'), headerBottom, local, 0x2c2c2a);
    } else if (opp && opp.name) {
      headerBottom = addProfileLine(
        this.container, this.popup, w, h, t('result.vs', { name: opp.name }), headerBottom, opp, 0xaa2222);
    }

    // Badges — every node of the block is collected so it can be shrunk to fit above the CTA.
    const badges = computeBadges(playerStats, isDraw ? 'draw' : (isWin ? 'win' : 'loss'));
    const badgeTop = headerBottom;
    const badgeBlock: PIXI.DisplayObject[] = [];

    if (badges.length > 0) {
      // Hero badge — the top one, shown large: gold glyph + title + detail sentence.
      const hero = badges[0]!;
      const heroIcon = Math.round(h * 0.11);
      const glyph = buildIcon(hero.icon, heroIcon, ui.gold);
      glyph.x = (w - heroIcon) / 2;
      glyph.y = headerBottom + h * 0.03;
      this.container.addChild(glyph);
      badgeBlock.push(glyph);

      const heroText = makeText(hero.title(), {
        fontSize: FS.display,
        fill: 0x222222,
        fontWeight: 'bold',
      });
      heroText.anchor.set(0.5, 0);
      heroText.x = w / 2;
      heroText.y = glyph.y + heroIcon + h * 0.008;
      this.container.addChild(heroText);
      badgeBlock.push(heroText);

      const heroDetail = makeText(t('result.badgeQuote', { text: hero.detail(playerStats) }), {
        fontSize: FS.title,
        fill: 0x444444,
        fontStyle: 'italic',
      });
      heroDetail.anchor.set(0.5, 0);
      heroDetail.x = w / 2;
      heroDetail.y = heroText.y + heroText.height + h * 0.01;
      heroDetail.name = 'resultHeroDetail'; // test hook — see test/ui/resultScenePortraitBadgeRow.ui.ts
      this.container.addChild(heroDetail);
      badgeBlock.push(heroDetail);

      // Secondary badges — a centred row of small icon medallions (no text list).
      // The compact first-win screen keeps only the hero badge (§15.4).
      const rest = cb.firstWin ? [] : badges.slice(1);
      if (rest.length > 0) {
        const cellW = Math.round(w * 0.24);
        const gap   = Math.round(w * 0.04);
        const rowW  = cellW * rest.length + gap * (rest.length - 1);
        const rowX  = (w - rowW) / 2;
        // Landscape tucks this row up slightly toward heroDetail (small pull-up against a
        // short h=1080). In portrait h is the long axis (>=1920), so that same pull-up
        // scales past the actual gap available and drags the row up into heroDetail's text
        // (VICTORY screenshot: badge icons overlapping "took 0 damage") — use a plain
        // downward gap there instead. The pull-up also needs heroDetail to end short of the
        // nearest icon: under the phone type boost the quote widens into the icons (722×406
        // portal frame: the castle glyph sat on the closing quote mark).
        const iconHalf = (Math.round(h * 0.065) * 1.2) / 2;
        const nearestIcon = Math.min(...rest.map((_, i) => Math.abs(rowX + i * (cellW + gap) + cellW / 2 - w / 2)));
        const clearsDetail = heroDetail.width / 2 + w * 0.01 <= nearestIcon - iconHalf;
        const rowY  = isPortrait || !clearsDetail
          ? heroDetail.y + heroDetail.height + h * 0.02
          : heroDetail.y + heroDetail.height - h * 0.041;
        rest.forEach((badge, i) => {
          // The cell in the medallion's own coordinates — it is scaled up by 1.2 right after.
          const medallion = buildBadgeMedallion(badge, playerStats, h, cellW / 1.2);
          medallion.scale.set(1.2);
          medallion.x = rowX + i * (cellW + gap) + cellW / 2; // medallion is centred at its origin
          medallion.y = rowY;
          medallion.name = 'resultSecondaryBadge'; // test hook — see test/ui/resultScenePortraitBadgeRow.ui.ts
          this.container.addChild(medallion);
          badgeBlock.push(medallion);
        });
      }
    } else {
      // No notable stats
      const no = makeText(t('result.keepGoing'), {
        fontSize: FS.headline,
        fill: 0x888888,
        fontFamily: UI_FONT_FAMILY,
      });
      no.anchor.set(0.5, 0);
      no.x = w / 2;
      no.y = headerBottom + h * 0.06;
      this.container.addChild(no);
      badgeBlock.push(no);
    }

    // "Up next" teaser on the compact first-win screen — the last line of the block, so it shrinks
    // with the badges if the phone type boost pushes the block into the CTA.
    if (cb.firstWin) {
      const last = badgeBlock[badgeBlock.length - 1];
      const lastBottom = last ? last.getBounds().bottom : headerBottom;
      const teaser = makeText(t('result.upNext', { name: cb.firstWin.nextName }), {
        fontSize: FS.headline, fill: 0x226622, fontWeight: 'bold', fontFamily: UI_FONT_FAMILY,
      });
      teaser.anchor.set(0.5, 0);
      teaser.x = w / 2;
      teaser.y = lastBottom + h * 0.035;
      teaser.name = 'resultUpNext';
      this.container.addChild(teaser);
      badgeBlock.push(teaser);
    }

    // ── Action buttons: one primary CTA + a row of low-key secondary entries ──
    // Primary "play again" is large and gold-filled so the eye lands on it first;
    // watch-replay / share / back-to-lobby sit beneath as a quieter ghost-style row.
    const primaryW = Math.round(w * 0.5);
    const primaryH = Math.round(h * 0.085);
    const primaryX = (w - primaryW) / 2;
    const primaryY = Math.round(h * 0.78);
    const hasRetentionRow = isWin && !!this.retentionPreview;

    // The badge block is sized in font tokens, which the phone type boost lifts up to 1.4x
    // (render/fontScale.ts) while the CTA stays pinned at 78% — on a 722×406 portal frame the
    // secondary medallions' "[Unit Flood] 5 units" ran under PLAY AGAIN. Shrink the block about its
    // top centre until it clears whatever sits above the CTA.
    const badgeLimit = (hasRetentionRow ? primaryY - Math.round(h * 0.06) - Math.round(h * 0.04) : primaryY)
      - Math.round(h * 0.02);
    fitBlockAbove(badgeBlock, w / 2, badgeTop, badgeLimit);

    // "Come back tomorrow" check-in hook (RETENTION_LAUNCH_PLAN.md §3.3) — a one-line reward
    // preview sitting just above the primary CTA, independent of the badges block above it (which
    // varies in height) so it never collides regardless of how many badges this match earned.
    if (hasRetentionRow && this.retentionPreview) {
      const { day, reward } = this.retentionPreview;
      const rowY = primaryY - Math.round(h * 0.06);
      const rc = Math.round(h * 0.04);
      const ink = 0x8a7020;
      const gap = Math.round(w * 0.012);
      // Same icon+count convention as DailyScene's calendar cells: card/equipment are single-item
      // milestone draws (no "+N"), everything else pairs the glyph with its amount.
      const singleItem = reward.kind === 'card' || reward.kind === 'equipment';
      const icon = buildRewardIcon(reward, rc, ink);
      const countTxt = !singleItem
        ? makeText(`+${reward.count ?? 0}`, { fontSize: FS.label, fill: ink, fontFamily: UI_FONT_FAMILY })
        : null;
      const label = makeText(t('result.tomorrowReward', { day }), { fontSize: FS.label, fill: 0x555544, fontFamily: UI_FONT_FAMILY });

      const groupW = (icon ? rc + gap : 0) + (countTxt ? countTxt.width + gap : 0) + label.width;
      let x = (w - groupW) / 2;
      if (icon) { icon.x = x; icon.y = rowY - rc / 2; this.container.addChild(icon); x += rc + gap; }
      if (countTxt) { countTxt.anchor.set(0, 0.5); countTxt.x = x; countTxt.y = rowY; this.container.addChild(countTxt); x += countTxt.width + gap; }
      label.anchor.set(0, 0.5);
      label.x = x; label.y = rowY;
      this.container.addChild(label);
    }

    // On a win the CTA reads "fight again" (more triumphant); otherwise "play
    // again". An explicit playAgainLabel (e.g. campaign's "back to map") wins.
    const primaryLabel = cb.playAgainLabel ?? (isWin ? t('result.playAgainWin') : t('result.playAgain'));
    addPrimaryButton(
      this.container, primaryX, primaryY, primaryW, primaryH,
      primaryLabel, 'swords', () => { this.autoContinue = null; cb.onPlayAgain(); },
    );
    if (cb.autoContinueSec) {
      const bar = new PIXI.Graphics();
      this.container.addChild(bar);
      this.autoContinue = {
        from: this.time, sec: cb.autoContinueSec, bar,
        rect: { x: primaryX, y: primaryY, w: primaryW, h: primaryH },
        press: () => cb.onPlayAgain(),
      };
      // Any touch means the player is here and will choose: another control (back, replay, share, a
      // profile) or just a tap on the page. A passive container only hears taps that land on an
      // interactive child, so a full-screen catcher sits at the bottom for the countdown's lifetime.
      // Not `container.eventMode = 'static'` + hitArea: that makes PIXI hit-test every child as
      // interactive, and the label drawn over each button then swallows the button's own tap.
      const catcher = new PIXI.Container();
      catcher.eventMode = 'static';
      catcher.hitArea = new PIXI.Rectangle(0, 0, w, h);
      this.container.addChildAt(catcher, 0);
      const cancel = (): void => {
        this.container.off('pointerdown', cancel);
        catcher.destroy();
        if (!this.autoContinue) return;
        this.autoContinue = null;
        bar.clear();
      };
      this.container.on('pointerdown', cancel);
    }

    const secs: { label: string; icon: IconKind; tap: () => void }[] = [];
    if (cb.secondaryAction) secs.push({ label: cb.secondaryAction.label, icon: cb.secondaryAction.icon, tap: () => cb.secondaryAction!.onTap() });
    if (cb.onWatchReplay)  secs.push({ label: t('result.watchReplay'), icon: 'replay', tap: () => cb.onWatchReplay!() });
    if (cb.onShare)         secs.push({ label: t('share.button'),       icon: 'share',  tap: () => cb.onShare!() });

    if (secs.length > 0) {
      const gap   = Math.round(w * 0.018);
      const rowW  = Math.round(w * 0.62);
      const cellW = Math.round((rowW - gap * (secs.length - 1)) / secs.length);
      const cellH = Math.round(h * 0.06);
      const rowX  = (w - rowW) / 2;
      const rowY  = primaryY + primaryH + Math.round(h * 0.028);
      secs.forEach((s, i) => {
        addSecondaryButton(this.container, rowX + i * (cellW + gap), rowY, cellW, cellH, s.label, s.icon, s.tap);
      });
    }
  }
}

/**
 * Shrinks `nodes` (direct children laid out in the scene's own space) about (`cx`, `top`) so their
 * lowest edge sits at or above `limit`. A no-op when they already fit, so every layout that never
 * overflowed keeps its exact positions.
 */
function fitBlockAbove(nodes: PIXI.DisplayObject[], cx: number, top: number, limit: number): void {
  if (nodes.length === 0) return;
  // Parent-space extents (the scene container may itself be scaled on stage, so not getBounds()).
  const bottom = Math.max(...nodes.map((n) => { const b = n.getLocalBounds(); return n.y + (b.y + b.height) * n.scale.y; }));
  if (bottom <= limit || bottom <= top) return;
  const s = Math.max(0.5, (limit - top) / (bottom - top));
  for (const n of nodes) {
    n.x = cx + (n.x - cx) * s;
    n.y = top + (n.y - top) * s;
    n.scale.set(n.scale.x * s, n.scale.y * s);
  }
}
