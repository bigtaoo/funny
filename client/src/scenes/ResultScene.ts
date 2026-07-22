import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../render/pixiText';
import { Scene } from './SceneManager';
import { OwnerId, PlayerStats } from '../game/types';
import { t, TranslationKey } from '../i18n';
import { ProfilePopup, type ProfileData } from '../render/ProfilePopup';
import { ui, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildIcon, IconKind } from '../render/icons';
import { SketchPen } from '../render/sketch';
import { getTitleKeys, formatLadderTitle } from '../game/meta/titles';
import { buildDecorCLayer } from '../render/decorCLayer';
import { getDecorTexture, isDecorReady, decorFrameNames } from '../render/decorAtlas';
import { bake } from '../render/bake';
import { Prng } from '../game/math/prng';
import { drawSceneHeader, type SceneHeaderResult } from '../ui/widgets/SceneHeader';
import { FS, snapFont } from '../render/fontScale';

/** Optional player identities for the result screen's tap-to-view profile popup. */
export interface ResultProfiles {
  opponent?: ProfileData;
  local?: ProfileData;
}

/** Server-authoritative ELO result (ranked only, from match_over.elo). */
export interface EloResult {
  delta: number;
  after: number;
  rankAfter: string;
}

// ─── Badge definitions ────────────────────────────────────────────────────────

interface Badge {
  key: string;
  /** Hand-drawn glyph shown on the badge medallion. */
  icon: IconKind;
  /** Resolved lazily via t() so the active locale is applied at build time. */
  title: () => string;
  detail: (s: PlayerStats) => string;
  /** Bare stat number for the medallion (no unit/sentence). */
  value: (s: PlayerStats) => string;
  score: (s: PlayerStats) => number;
}

/**
 * Divisors below calibrate each badge's raw stat to a roughly comparable "how
 * notable was this" scale (~1.0 = a solid performance). Without this, raw
 * magnitudes aren't comparable across units — e.g. BUILDER's tick-sum over
 * every surviving building dwarfs a base-HP-scale damage number by 30-100x,
 * so it silently won almost every match regardless of actual performance.
 */
const REF_DAMAGE   = 150; // ~1.5x BASE_HP=100, a strong hit/defense on the enemy/own base
const REF_UNITS    = 60;  // units sent in a busy match
const REF_BUILD_S  = 250; // seconds of building-survival summed across buildings
const REF_HITS     = 5;   // spell hits in a spell-heavy match
// kills-per-100-ink ratio. EFFICIENT is the only badge scored as an (unbounded)
// *rate* rather than a bounded magnitude, so its reference must match REAL play
// or it silently wins almost every match: a solid game runs ~8-13 kills/100 ink
// (a unit costs ~4-6 ink and typically trades for ≥1 enemy), so REF=5 scored
// ~1.6-2.6x while the other badges peak near ~1.0. Calibrated to 12 so a solid
// game centers at ~1.0 and it only wins when you were genuinely ink-efficient.
const REF_EFFICIENT = 12; // kills-per-100-ink ratio (see note above)

const BADGES: Badge[] = [
  {
    key:    'TOP_DMG',
    icon:   'swords',
    title:  () => t('badge.topDmg.title'),
    detail: (s) => t('badge.topDmg.detail', { n: s.damageDealtToBase }),
    value:  (s) => t('badge.topDmg.short', { n: s.damageDealtToBase }),
    score:  (s) => s.damageDealtToBase / REF_DAMAGE,
  },
  {
    key:    'IRON_WALL',
    icon:   'armor',
    title:  () => t('badge.ironWall.title'),
    detail: (s) => t('badge.ironWall.detail', { n: s.damageTakenByBase }),
    value:  (s) => t('badge.ironWall.short', { n: s.damageTakenByBase }),
    // Was `-damageTakenByBase`, which is never > 0 for a real damage value — this
    // badge could never actually be picked. Score rewards taking less than REF_DAMAGE.
    score:  (s) => (REF_DAMAGE - s.damageTakenByBase) / REF_DAMAGE,
  },
  {
    key:    'FLOOD',
    icon:   'flag',
    title:  () => t('badge.flood.title'),
    detail: (s) => t('badge.flood.detail', { n: s.unitsSent }),
    value:  (s) => t('badge.flood.short', { n: s.unitsSent }),
    score:  (s) => s.unitsSent / REF_UNITS,
  },
  {
    key:    'BUILDER',
    icon:   'castle',
    title:  () => t('badge.builder.title'),
    detail: (s) => t('badge.builder.detail', { n: Math.round(s.buildingSurvivalTicks / 30) }),
    value:  (s) => t('badge.builder.short', { n: Math.round(s.buildingSurvivalTicks / 30) }),
    score:  (s) => (s.buildingSurvivalTicks / 30) / REF_BUILD_S,
  },
  {
    key:    'PRECISION',
    icon:   'atkspd',
    title:  () => t('badge.precision.title'),
    detail: (s) => t('badge.precision.detail', { n: s.spellHits }),
    value:  (s) => t('badge.precision.short', { n: s.spellHits }),
    score:  (s) => s.spellHits / REF_HITS,
  },
  {
    key:    'EFFICIENT',
    icon:   'coin',
    title:  () => t('badge.efficient.title'),
    detail: (s) => t('badge.efficient.detail', { n: s.unitsKilled }),
    value:  (s) => t('badge.efficient.short', { n: s.unitsKilled }),
    score:  (s) => (s.goldSpent > 0 ? (s.unitsKilled / s.goldSpent * 100) / REF_EFFICIENT : 0),
  },
];

function computeBadges(stats: PlayerStats): Badge[] {
  // Return up to 3 badges with score > 0, sorted by score descending
  return BADGES
    .filter((b) => b.score(stats) > 0)
    .sort((a, b) => b.score(stats) - a.score(stats))
    .slice(0, 3);
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
}

export class ResultScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;

  private readonly localOwner: OwnerId;
  private readonly elo?: EloResult;
  private readonly profiles?: ResultProfiles;
  private readonly popup: ProfilePopup;

  constructor(
    w: number,
    h: number,
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    cb: ResultSceneCallbacks,
    localOwner: OwnerId = 0,
    elo?: EloResult,
    profiles?: ResultProfiles,
    outroText?: string,
  ) {
    this.container = new PIXI.Container();
    this.w  = w;
    this.h  = h;
    this.localOwner = localOwner;
    this.elo = elo;
    this.profiles = profiles;
    this.popup = new ProfilePopup(w, h);

    if (outroText) {
      this.buildOutroOverlay(outroText, () => {
        this.build(winner, stats, cb);
        this.container.addChild(this.popup.container);
      });
    } else {
      this.build(winner, stats, cb);
      this.container.addChild(this.popup.container); // topmost overlay
    }
  }

  update(_dt: number): void { /* static scene */ }

  destroy(): void {
    this.popup.destroy();
    this.container.destroy({ children: true });
  }

  /** Full-screen tap-through outro overlay; calls onDone to reveal the result. */
  private buildOutroOverlay(text: string, onDone: () => void): void {
    const { w, h } = this;

    const bg = new PIXI.Graphics();
    bg.beginFill(0x1a1408, 0.97); bg.drawRect(0, 0, w, h); bg.endFill();
    this.container.addChild(bg);

    const margin = Math.round(w * 0.08);
    const fontSize = FS.heading;
    const body = makeText(text, {
      fontSize,
      fill: 0xe8dfc0,
      wordWrap: true,
      wordWrapWidth: w - margin * 2,
      lineHeight: Math.round(fontSize * 1.65),
      align: 'center',
      fontFamily: 'monospace',
    });
    body.anchor.set(0.5, 0.5);
    body.x = w / 2;
    body.y = h / 2;
    this.container.addChild(body);

    const hint = makeText(t('story.tapToContinue'), {
      fontSize: FS.label,
      fill: 0x8a7a60,
      fontFamily: 'monospace',
    });
    hint.anchor.set(0.5, 1);
    hint.x = w / 2;
    hint.y = h - Math.round(h * 0.06);
    this.container.addChild(hint);

    this.container.eventMode = 'static';
    this.container.once('pointerdown', () => {
      this.container.eventMode = 'none';
      tearDownChildren(this.container);
      onDone();
    });
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  private build(
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    cb: ResultSceneCallbacks,
  ): void {
    const { w, h } = this;
    const playerStats = stats[this.localOwner]!; // the local player's stats (owner 0 or 1)

    // Background — shared hand-drawn notebook page (baked per size).
    this.container.addChild(buildPaperBackground('resultbg', w, h));

    // Standard title bar (paper chrome + embedded back button), same as every
    // other secondary scene (e.g. shop) — title is null since the big win/lose
    // headline below is this scene's title. The back chip always exits straight
    // to the lobby, independent of whatever the primary CTA below does (which
    // may re-enter a match instead).
    const hdr = this.addHeader(() => cb.onBack());

    // C-group scattered doodles across the full page (same atlas as lobby background).
    const cLayer = buildDecorCLayer(w, h);
    if (cLayer) this.container.addChild(cLayer);

    // A-group doodles in the left/right paper margins (same atlas as battle scene).
    const aLayer = this.buildMarginDeco();
    if (aLayer) this.container.addChild(aLayer);

    // Win / lose / draw headline
    const isDraw  = winner === null;
    const isWin   = winner === this.localOwner;
    const headline = isDraw ? t('result.draw') : (isWin ? t('result.victory') : t('result.defeat'));
    const headlineColor = isDraw ? 0x888888 : (isWin ? 0x226622 : 0xaa2222);

    // Mood doodles scribbled in the margins (behind the text/buttons): a little
    // notebook flourish that swings with the result — stars/sparkles on a win,
    // red cross-outs on a loss (echoes the "red-pen" art motif).
    this.addMoodDeco(isDraw ? 'draw' : (isWin ? 'win' : 'loss'));

    const title = makeText(headline, {
      fontSize: FS.display,
      fill: headlineColor,
      fontWeight: 'bold',
      fontFamily: 'serif',
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
          fontFamily: 'monospace',
        },
      );
      eloLine.anchor.set(0.5, 0);
      eloLine.x = w / 2;
      eloLine.y = headerBottom + h * 0.02;
      this.container.addChild(eloLine);
      headerBottom = eloLine.y + eloLine.height;
    }

    // Tap-to-view profile lines (netplay only — local then "vs opponent").
    const local = this.profiles?.local;
    const opp = this.profiles?.opponent;
    if (local && opp && opp.name) {
      // Both players known: single centred line "local (you)  vs  opponent",
      // with the neutral-grey "vs" sitting between the two tappable names.
      headerBottom = this.addVersusLine(local, opp, headerBottom);
    } else if (local) {
      headerBottom = this.addProfileLine(
        local.name + ' ' + t('profile.you'), headerBottom, local, 0x2c2c2a);
    } else if (opp && opp.name) {
      headerBottom = this.addProfileLine(
        t('result.vs', { name: opp.name }), headerBottom, opp, 0xaa2222);
    }

    // Badges
    const badges = computeBadges(playerStats);

    if (badges.length > 0) {
      // Hero badge — the top one, shown large: gold glyph + title + detail sentence.
      const hero = badges[0]!;
      const heroIcon = Math.round(h * 0.11);
      const glyph = buildIcon(hero.icon, heroIcon, ui.gold);
      glyph.x = (w - heroIcon) / 2;
      glyph.y = headerBottom + h * 0.03;
      this.container.addChild(glyph);

      const heroText = makeText(hero.title(), {
        fontSize: FS.display,
        fill: 0x222222,
        fontWeight: 'bold',
      });
      heroText.anchor.set(0.5, 0);
      heroText.x = w / 2;
      heroText.y = glyph.y + heroIcon + h * 0.008;
      this.container.addChild(heroText);

      const heroDetail = makeText(`「${hero.detail(playerStats)}」`, {
        fontSize: FS.title,
        fill: 0x444444,
        fontStyle: 'italic',
      });
      heroDetail.anchor.set(0.5, 0);
      heroDetail.x = w / 2;
      heroDetail.y = heroText.y + heroText.height + h * 0.01;
      this.container.addChild(heroDetail);

      // Secondary badges — a centred row of small icon medallions (no text list).
      const rest = badges.slice(1);
      if (rest.length > 0) {
        const cellW = Math.round(w * 0.24);
        const gap   = Math.round(w * 0.04);
        const rowW  = cellW * rest.length + gap * (rest.length - 1);
        const rowX  = (w - rowW) / 2;
        const rowY  = heroDetail.y + heroDetail.height - h * 0.041;
        rest.forEach((badge, i) => {
          const medallion = this.buildBadgeMedallion(badge, playerStats);
          medallion.scale.set(1.2);
          medallion.x = rowX + i * (cellW + gap) + cellW / 2; // medallion is centred at its origin
          medallion.y = rowY;
          this.container.addChild(medallion);
        });
      }
    } else {
      // No notable stats
      const no = makeText(t('result.keepGoing'), {
        fontSize: FS.headline,
        fill: 0x888888,
        fontFamily: 'monospace',
      });
      no.anchor.set(0.5, 0);
      no.x = w / 2;
      no.y = headerBottom + h * 0.06;
      this.container.addChild(no);
    }

    // ── Action buttons: one primary CTA + a row of low-key secondary entries ──
    // Primary "play again" is large and gold-filled so the eye lands on it first;
    // watch-replay / share / back-to-lobby sit beneath as a quieter ghost-style row.
    const primaryW = Math.round(w * 0.5);
    const primaryH = Math.round(h * 0.085);
    const primaryX = (w - primaryW) / 2;
    const primaryY = Math.round(h * 0.78);
    // On a win the CTA reads "fight again" (more triumphant); otherwise "play
    // again". An explicit playAgainLabel (e.g. campaign's "back to map") wins.
    const primaryLabel = cb.playAgainLabel ?? (isWin ? t('result.playAgainWin') : t('result.playAgain'));
    this.addPrimaryButton(
      primaryX, primaryY, primaryW, primaryH,
      primaryLabel, 'swords', () => cb.onPlayAgain(),
    );

    const secs: { label: string; icon: IconKind; tap: () => void }[] = [];
    if (cb.onWatchReplay)   secs.push({ label: t('result.watchReplay'), icon: 'replay', tap: () => cb.onWatchReplay!() });
    if (cb.onShare)         secs.push({ label: t('share.button'),       icon: 'share',  tap: () => cb.onShare!() });

    if (secs.length > 0) {
      const gap   = Math.round(w * 0.018);
      const rowW  = Math.round(w * 0.62);
      const cellW = Math.round((rowW - gap * (secs.length - 1)) / secs.length);
      const cellH = Math.round(h * 0.06);
      const rowX  = (w - rowW) / 2;
      const rowY  = primaryY + primaryH + Math.round(h * 0.028);
      secs.forEach((s, i) => {
        this.addSecondaryButton(rowX + i * (cellW + gap), rowY, cellW, cellH, s.label, s.icon, s.tap);
      });
    }
  }

  /** Hand-drawn margin doodles that react to the result; drawn low in the z-order. */
  private addMoodDeco(mood: 'win' | 'loss' | 'draw'): void {
    const { w, h } = this;
    const g = new PIXI.Graphics();
    const pen = new SketchPen(g, 0x9e3 + (mood === 'win' ? 1 : mood === 'loss' ? 2 : 3));

    if (mood === 'win') {
      // A scatter of celebratory hand-drawn five-point stars in warm marker-gold.
      const gold = ui.gold;
      const star = (cx: number, cy: number, r: number, alpha: number): void => {
        const inner = r * 0.42;                     // classic 5-point star waist
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < 5; i++) {
          const ao = -Math.PI / 2 + (i * 2 * Math.PI) / 5;   // outer tip
          const ai = ao + Math.PI / 5;                       // inner notch
          pts.push({ x: cx + Math.cos(ao) * r, y: cy + Math.sin(ao) * r });
          pts.push({ x: cx + Math.cos(ai) * inner, y: cy + Math.sin(ai) * inner });
        }
        // Close the loop by hand — overshoot back past the first tip.
        pts.push(pts[0]!, pts[1]!);
        pen.stroke(pts, { color: gold, width: Math.max(1.4, r * 0.13), jitter: 0.35, taper: 0.9, double: false, alpha });
      };
      // Scattered inside the content frame only — never out to the page edges,
      // so nothing bleeds into the margins. Position is re-rolled on every view;
      // a minimum-distance floor between picks keeps them from clumping into one
      // bright patch. Each star's centre is inset by its own radius (see below)
      // so the whole star, not just its centre, stays within the frame.
      const starCount = 6;
      // Inner frame bounds (fractions of the page) the stars must stay within.
      const frameL = w * 0.13;
      const frameR = w * 0.87;
      const frameT = h * 0.13;
      const frameB = h * 0.94;
      const minDist = Math.min(w, h) * 0.1;
      const placed: { x: number; y: number }[] = [];
      for (let i = 0; i < starCount; i++) {
        const sr = h * (0.028 + Math.random() * 0.034);
        // Sampling box inset by the star radius so tips don't cross the frame.
        const loX = frameL + sr, hiX = frameR - sr;
        const loY = frameT + sr, hiY = frameB - sr;
        let sx = 0;
        let sy = 0;
        for (let attempt = 0; attempt < 20; attempt++) {
          sx = loX + Math.random() * (hiX - loX);
          sy = loY + Math.random() * (hiY - loY);
          if (placed.every((p) => Math.hypot(p.x - sx, p.y - sy) >= minDist)) break;
        }
        placed.push({ x: sx, y: sy });
        // Celebratory stars are faded to 38% opacity so they read as a soft
        // backdrop behind the result text rather than competing with it.
        const sa = (0.6 + Math.random() * 0.35) * 0.38;
        star(sx, sy, sr, sa);
      }
    } else if (mood === 'loss') {
      // A couple of red cross-out scribbles (echoes the "red-pen" art motif).
      const red = ui.red;
      // Red cross-out scribbles upper-right.
      const xout = (cx: number, cy: number, s: number, alpha: number): void => {
        pen.line(cx - s, cy - s * 0.6, cx + s, cy + s * 0.6, { color: red, width: Math.max(1.6, s * 0.18), jitter: 0.6, taper: 0.85, double: false, alpha });
        pen.line(cx - s, cy + s * 0.6, cx + s, cy - s * 0.6, { color: red, width: Math.max(1.6, s * 0.18), jitter: 0.6, taper: 0.85, double: false, alpha });
      };
      xout(w * 0.82, h * 0.22, h * 0.05,  0.60);
      xout(w * 0.88, h * 0.34, h * 0.035, 0.50);
      xout(w * 0.12, h * 0.18, h * 0.042, 0.50);
      xout(w * 0.14, h * 0.72, h * 0.036, 0.42);
      xout(w * 0.86, h * 0.60, h * 0.030, 0.38);
    } else {
      // Draw — a neutral hand-drawn equals/tilde mark in the corner.
      const ink = ui.line;
      pen.line(w * 0.80, h * 0.20, w * 0.90, h * 0.20, { color: ink, width: Math.max(2, h * 0.01), jitter: 0.5, taper: 0.9, double: false, alpha: 0.6 });
      pen.line(w * 0.80, h * 0.24, w * 0.90, h * 0.24, { color: ink, width: Math.max(2, h * 0.01), jitter: 0.5, taper: 0.9, double: false, alpha: 0.6 });
    }

    this.container.addChild(g);
  }

  /** A centred, tappable "name #id" line that opens its profile card. Returns new bottom y. */
  private addProfileLine(label: string, top: number, data: ProfileData, color: number): number {
    const { w, h } = this;
    const line = makeText(label, {
      fontSize: FS.title,
      fill: color,
      fontFamily: 'monospace',
      fontWeight: 'bold',
    });
    line.anchor.set(0.5, 0);
    line.x = w / 2;
    line.y = top + h * 0.018;
    line.eventMode = 'static';
    line.cursor = 'pointer';
    line.on('pointertap', () => this.popup.show(data));
    this.container.addChild(line);
    return this.addTitleSub(data, w / 2, line.y + line.height);
  }

  /**
   * Single centred versus line: "local (you)  vs  opponent". Each name is
   * tappable to open its profile popup; the "vs" separator sits between them in
   * a neutral grey. Any equipped titles render beneath their respective names.
   */
  private addVersusLine(local: ProfileData, opp: ProfileData, top: number): number {
    const { w, h } = this;
    const y = top + h * 0.018;
    const makeName = (label: string, color: number, data: ProfileData): PIXI.Text => {
      const txt = makeText(label, {
        fontSize: FS.title,
        fill: color,
        fontFamily: 'monospace',
        fontWeight: 'bold',
      });
      txt.anchor.set(0, 0);
      txt.eventMode = 'static';
      txt.cursor = 'pointer';
      txt.on('pointertap', () => this.popup.show(data));
      return txt;
    };
    const leftTxt = makeName(local.name + ' ' + t('profile.you'), 0x2c2c2a, local);
    const vsTxt = makeText('vs', {
      fontSize: FS.title,
      fill: 0x888888,
      fontFamily: 'monospace',
      fontWeight: 'bold',
    });
    vsTxt.anchor.set(0, 0);
    const rightTxt = makeName(opp.name, 0xaa2222, opp);

    const gap = Math.round(w * 0.022);
    const totalW = leftTxt.width + gap + vsTxt.width + gap + rightTxt.width;
    let x = (w - totalW) / 2;
    const rowH = Math.max(leftTxt.height, vsTxt.height, rightTxt.height);
    for (const txt of [leftTxt, vsTxt, rightTxt]) {
      txt.x = x;
      txt.y = y + (rowH - txt.height) / 2;
      this.container.addChild(txt);
      x += txt.width + gap;
    }

    const bottom = y + rowH;
    return Math.max(
      this.addTitleSub(local, leftTxt.x + leftTxt.width / 2, bottom),
      this.addTitleSub(opp, rightTxt.x + rightTxt.width / 2, bottom),
    );
  }

  /** Optional "「title」" sub-line centred at centerX beneath a name. */
  private addTitleSub(data: ProfileData, centerX: number, top: number): number {
    if (!data.equippedTitle) return top;
    const keys = getTitleKeys(data.equippedTitle);
    const titleLabel = keys
      ? t(keys.shortKey as TranslationKey) || formatLadderTitle(data.equippedTitle)
      : formatLadderTitle(data.equippedTitle);
    const sub = makeText(`「${titleLabel}」`, {
      fontSize: FS.label,
      fill: 0x8a7020,
      fontFamily: 'monospace',
    });
    sub.anchor.set(0.5, 0);
    sub.x = centerX;
    sub.y = top + this.h * 0.004;
    this.container.addChild(sub);
    return sub.y + sub.height;
  }

  /** Primary call-to-action: gold-filled, bold white label with a leading icon. */
  private addPrimaryButton(
    x: number, y: number, w: number, h: number, text: string, icon: IconKind, onTap: () => void,
  ): void {
    const bg = sketchPanel(w, h, { fill: ui.gold, border: 0x6a5000, width: 2.6, seed: seedFor(x, y, w) });
    bg.x = x;
    bg.y = y;
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    bg.on('pointertap', onTap);
    this.container.addChild(bg);
    this.addIconLabel(x, y, w, h, text, icon, 0xfffdf4, snapFont(Math.round(h * 0.40)), true);
  }

  /** Quieter secondary entry: paper-fill ghost panel, ink line border + ink label/icon. */
  private addSecondaryButton(
    x: number, y: number, w: number, h: number, text: string, icon: IconKind, onTap: () => void,
  ): void {
    const bg = sketchPanel(w, h, { fill: ui.paper, border: ui.line, width: 1.8, seed: seedFor(x, y, w) });
    bg.x = x;
    bg.y = y;
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    bg.on('pointertap', onTap);
    this.container.addChild(bg);
    this.addIconLabel(x, y, w, h, text, icon, 0x444444, snapFont(Math.round(h * 0.34)), false);
  }

  /** Centre an icon + label pair inside the button box. */
  private addIconLabel(
    x: number, y: number, w: number, h: number,
    text: string, icon: IconKind, color: number, fontSize: number, bold: boolean,
  ): void {
    const iconSize = Math.round(h * 0.62);
    const label = makeText(text, {
      fontSize,
      fill: color,
      fontWeight: bold ? 'bold' : 'normal',
      fontFamily: 'monospace',
    });
    label.anchor.set(0, 0.5);

    const gap = Math.round(w * 0.04);
    const totalW = iconSize + gap + label.width;
    const startX = x + (w - totalW) / 2;

    const glyph = buildIcon(icon, iconSize, color);
    glyph.x = startX;
    glyph.y = y + (h - iconSize) / 2;

    label.x = startX + iconSize + gap;
    label.y = y + h / 2;

    this.container.addChild(glyph, label);
  }

  /**
   * Standard title bar (shared {@link drawSceneHeader} chrome — paper fill,
   * accent rule, embedded back pill), same as shop/gacha/equipment/etc. The
   * helper only draws the chrome and returns the back button's hit rect — it
   * does not wire up interactivity, since most callers run their own manual
   * hit-testing pipeline. This scene uses plain PIXI interactive/pointertap
   * everywhere else, so lay a transparent hit-area graphic over the chip instead.
   */
  private addHeader(onTap: () => void): SceneHeaderResult {
    const hdr = drawSceneHeader(this.container, this.w, this.h, null);
    const hit = new PIXI.Graphics();
    hit.beginFill(0x000000, 0.001);
    hit.drawRect(hdr.backRect.x, hdr.backRect.y, hdr.backRect.w, hdr.backRect.h);
    hit.endFill();
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.name = 'resultBackChip'; // test hook — see test/ui/scenes.ui.ts "top-left back chip"
    hit.on('pointertap', onTap);
    this.container.addChild(hit);
    return hdr;
  }

  /** A-group doodles scattered in the left/right paper margins, mirroring the battle-scene look. */
  private buildMarginDeco(): PIXI.Container | null {
    if (!isDecorReady()) return null;
    const frames = decorFrameNames();
    if (frames.length === 0) return null;

    const { w, h } = this;
    const bandW = Math.round(w * 0.11);
    const bandY = Math.round(h * 0.12);
    const bandH = Math.round(h * 0.72);
    const size  = Math.max(16, Math.min(64, Math.round(bandW * 0.72)));
    const pitch = size * 1.9;
    const slots = Math.floor(bandH / pitch);
    const frand = (p: Prng) => p.nextInt(1_000_000) / 1_000_000;
    const prng  = new Prng(0xDEAD_BEEF);

    const content = new PIXI.Container();
    for (const side of ['left', 'right'] as const) {
      const bandX = side === 'left' ? 0 : w - bandW;
      for (let i = 0; i < slots; i++) {
        if (frand(prng) < 0.15) continue;
        const name = frames[prng.nextInt(frames.length)]!;
        const tex  = getDecorTexture(name);
        if (!tex) continue;

        const spr = new PIXI.Sprite(tex);
        spr.anchor.set(0.5);
        const longest = Math.max(tex.width, tex.height) || size;
        spr.scale.set((size * (1 + (frand(prng) * 2 - 1) * 0.3)) / longest);
        spr.rotation = (frand(prng) * 2 - 1) * 0.22;
        spr.alpha    = 0.30 + frand(prng) * 0.20;
        spr.x = bandX + bandW / 2 + (frand(prng) * 2 - 1) * bandW * 0.25;
        spr.y = bandY + pitch * i  + frand(prng) * pitch * 0.5;
        content.addChild(spr);
      }
    }

    if (content.children.length === 0) { content.destroy(); return null; }

    const root = new PIXI.Container();
    root.interactiveChildren = false;
    const tex = bake(`result-margin:${Math.round(w)}x${Math.round(h)}`, content, w, h);
    content.destroy({ children: true });
    if (tex) root.addChild(new PIXI.Sprite(tex));
    return root;
  }

  /**
   * A small vertical badge medallion — glyph over its title over the bare stat
   * value. The container origin is the horizontal centre / top, so callers set
   * `.x` to the intended centre and `.y` to the top edge.
   */
  private buildBadgeMedallion(badge: Badge, stats: PlayerStats): PIXI.Container {
    const { h } = this;
    const c = new PIXI.Container();

    const iconSize = Math.round(h * 0.065);
    const glyph = buildIcon(badge.icon, iconSize, 0x555555);
    glyph.x = -iconSize / 2;
    glyph.y = 0;
    c.addChild(glyph);

    const title = makeText(badge.title(), {
      fontSize: FS.heading,
      fill: 0x555555,
      fontFamily: 'monospace',
    });
    title.anchor.set(0.5, 0);
    title.x = 0;
    title.y = iconSize + h * 0.008;
    c.addChild(title);

    const value = makeText(badge.value(stats), {
      fontSize: FS.title,
      fill: 0x222222,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    value.anchor.set(0.5, 0);
    value.x = 0;
    value.y = title.y + title.height + h * 0.004;
    c.addChild(value);

    return c;
  }
}
