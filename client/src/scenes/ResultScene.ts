import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../render/pixiText';
import { Scene } from './SceneManager';
import { OwnerId, PlayerStats } from '@nw/engine/types';
import { t, TranslationKey } from '../i18n';
import { ProfilePopup, type ProfileData, type ProfileExtra } from '../ui/dialogs/ProfilePopup';
import { ui, buildPaperBackground, tearDownChildren } from '../render/sketchUi';
import { buildIcon, IconKind } from '../render/icons';
import { buildDecorCLayer } from '../render/decorCLayer';
import { FS } from '../render/fontScale';
import {
  buildMarginDeco, buildBadgeMedallion, addMoodDeco, addProfileLine, addVersusLine,
  addPrimaryButton, addSecondaryButton, addHeader,
} from './ResultScene/builders';

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

export interface Badge {
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

/**
 * Telemetry payload for the `match_badges` analytics event (ANALYTICS_DESIGN §5.8).
 * Uses the SAME {@link computeBadges} the scene renders from, so the logged `hero`/
 * `shown` can never drift from what the player actually saw. The raw stat inputs are
 * carried too so the backend can recalibrate the REF_* constants above from real
 * distributions instead of estimates (badge_dist ops dashboard).
 */
export function matchBadgeTelemetry(local: PlayerStats): Record<string, unknown> {
  const keys = computeBadges(local).map((b) => b.key);
  return {
    hero: keys[0] ?? 'none', // top badge = the "title" the player sees; 'none' if all scores ≤ 0
    shown: keys,             // up to 3 medallions shown, hero first
    kills: local.unitsKilled,
    gold_spent: local.goldSpent,
    units_sent: local.unitsSent,
    dmg_dealt: local.damageDealtToBase,
    dmg_taken: local.damageTakenByBase,
    spell_hits: local.spellHits,
    build_ticks: local.buildingSurvivalTicks,
  };
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
  /** Unified profile-popup extras (rank/ELO + family/sect) — see ProfilePopup's `fetchExtra`. Omitted offline/AI. */
  getProfileExtra?(publicId: string): Promise<ProfileExtra>;
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
    outroTexts?: string[],
  ) {
    this.container = new PIXI.Container();
    this.w  = w;
    this.h  = h;
    this.localOwner = localOwner;
    this.elo = elo;
    this.profiles = profiles;
    this.popup = new ProfilePopup(w, h, cb.getProfileExtra);

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

  update(_dt: number): void { /* static scene */ }

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
      headerBottom = addVersusLine(this.container, this.popup, w, h, local, opp, headerBottom);
    } else if (local) {
      headerBottom = addProfileLine(
        this.container, this.popup, w, h, local.name + ' ' + t('profile.you'), headerBottom, local, 0x2c2c2a);
    } else if (opp && opp.name) {
      headerBottom = addProfileLine(
        this.container, this.popup, w, h, t('result.vs', { name: opp.name }), headerBottom, opp, 0xaa2222);
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
      heroDetail.name = 'resultHeroDetail'; // test hook — see test/ui/resultScenePortraitBadgeRow.ui.ts
      this.container.addChild(heroDetail);

      // Secondary badges — a centred row of small icon medallions (no text list).
      const rest = badges.slice(1);
      if (rest.length > 0) {
        const cellW = Math.round(w * 0.24);
        const gap   = Math.round(w * 0.04);
        const rowW  = cellW * rest.length + gap * (rest.length - 1);
        const rowX  = (w - rowW) / 2;
        // Landscape tucks this row up slightly toward heroDetail (small pull-up against a
        // short h=1080). In portrait h is the long axis (>=1920), so that same pull-up
        // scales past the actual gap available and drags the row up into heroDetail's text
        // (VICTORY screenshot: badge icons overlapping "took 0 damage") — use a plain
        // downward gap there instead.
        const rowY  = isPortrait
          ? heroDetail.y + heroDetail.height + h * 0.02
          : heroDetail.y + heroDetail.height - h * 0.041;
        rest.forEach((badge, i) => {
          const medallion = buildBadgeMedallion(badge, playerStats, h);
          medallion.scale.set(1.2);
          medallion.x = rowX + i * (cellW + gap) + cellW / 2; // medallion is centred at its origin
          medallion.y = rowY;
          medallion.name = 'resultSecondaryBadge'; // test hook — see test/ui/resultScenePortraitBadgeRow.ui.ts
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
    addPrimaryButton(
      this.container, primaryX, primaryY, primaryW, primaryH,
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
        addSecondaryButton(this.container, rowX + i * (cellW + gap), rowY, cellW, cellH, s.label, s.icon, s.tap);
      });
    }
  }
}
