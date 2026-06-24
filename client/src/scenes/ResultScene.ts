import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { OwnerId, PlayerStats } from '../game/types';
import { t, TranslationKey } from '../i18n';
import { ProfilePopup, type ProfileData } from '../render/ProfilePopup';
import { ui, buildPaperBackground, sketchPanel, seedFor } from '../render/sketchUi';
import { getTitleKeys, formatLadderTitle } from '../game/meta/titles';

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
  /** Resolved lazily via t() so the active locale is applied at build time. */
  title: () => string;
  detail: (s: PlayerStats) => string;
  score: (s: PlayerStats) => number;
}

const BADGES: Badge[] = [
  {
    key:    'TOP_DMG',
    title:  () => t('badge.topDmg.title'),
    detail: (s) => t('badge.topDmg.detail', { n: s.damageDealtToBase }),
    score:  (s) => s.damageDealtToBase,
  },
  {
    key:    'IRON_WALL',
    title:  () => t('badge.ironWall.title'),
    detail: (s) => t('badge.ironWall.detail', { n: s.damageTakenByBase }),
    score:  (s) => -s.damageTakenByBase,
  },
  {
    key:    'FLOOD',
    title:  () => t('badge.flood.title'),
    detail: (s) => t('badge.flood.detail', { n: s.unitsSent }),
    score:  (s) => s.unitsSent,
  },
  {
    key:    'BUILDER',
    title:  () => t('badge.builder.title'),
    detail: (s) => t('badge.builder.detail', { n: Math.round(s.buildingSurvivalTicks / 30) }),
    score:  (s) => s.buildingSurvivalTicks,
  },
  {
    key:    'PRECISION',
    title:  () => t('badge.precision.title'),
    detail: (s) => t('badge.precision.detail', { n: s.spellHits }),
    score:  (s) => s.spellHits,
  },
  {
    key:    'EFFICIENT',
    title:  () => t('badge.efficient.title'),
    detail: (s) => t('badge.efficient.detail', { n: s.unitsKilled }),
    score:  (s) => (s.goldSpent > 0 ? s.unitsKilled / s.goldSpent * 100 : 0),
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
    this.container.removeAllListeners();
    this.popup.destroy();
  }

  /** Full-screen tap-through outro overlay; calls onDone to reveal the result. */
  private buildOutroOverlay(text: string, onDone: () => void): void {
    const { w, h } = this;

    const bg = new PIXI.Graphics();
    bg.beginFill(0x1a1408, 0.97); bg.drawRect(0, 0, w, h); bg.endFill();
    this.container.addChild(bg);

    const margin = Math.round(w * 0.08);
    const fontSize = Math.round(h * 0.026);
    const body = new PIXI.Text(text, {
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

    const hint = new PIXI.Text(t('story.tapToContinue'), {
      fontSize: Math.round(h * 0.022),
      fill: 0x8a7a60,
      fontFamily: 'monospace',
    });
    hint.anchor.set(0.5, 1);
    hint.x = w / 2;
    hint.y = h - Math.round(h * 0.06);
    this.container.addChild(hint);

    this.container.interactive = true;
    this.container.once('pointerdown', () => {
      this.container.interactive = false;
      this.container.removeChildren();
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

    // Win / lose / draw headline
    const isDraw  = winner === null;
    const isWin   = winner === this.localOwner;
    const headline = isDraw ? t('result.draw') : (isWin ? t('result.victory') : t('result.defeat'));
    const headlineColor = isDraw ? 0x888888 : (isWin ? 0x226622 : 0xaa2222);

    const title = new PIXI.Text(headline, {
      fontSize: Math.round(h * 0.1),
      fill: headlineColor,
      fontWeight: 'bold',
      fontFamily: 'serif',
    });
    title.anchor.set(0.5, 0);
    title.x = w / 2;
    title.y = h * 0.07;
    this.container.addChild(title);

    // Ranked ELO result line (server-authoritative, ranked only).
    let headerBottom = title.y + title.height;
    if (this.elo) {
      const sign = this.elo.delta >= 0 ? '+' : '';
      const rankName = t(('rank.' + this.elo.rankAfter) as TranslationKey);
      const eloLine = new PIXI.Text(
        t('result.eloDelta', { delta: `${sign}${this.elo.delta}`, after: this.elo.after, rank: rankName }),
        {
          fontSize: Math.round(h * 0.032),
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
    if (local) {
      headerBottom = this.addProfileLine(
        local.name + ' ' + t('profile.you'), headerBottom, local, 0x2c2c2a);
    }
    const opp = this.profiles?.opponent;
    if (opp && opp.name) {
      headerBottom = this.addProfileLine(
        t('result.vs', { name: opp.name }), headerBottom, opp, 0xaa2222);
    }

    // Badges
    const badges = computeBadges(playerStats);

    if (badges.length > 0) {
      // Hero badge — the top one, shown large with detail text
      const hero = badges[0]!;
      const heroText = new PIXI.Text(hero.title(), {
        fontSize: Math.round(h * 0.045),
        fill: 0x222222,
        fontWeight: 'bold',
      });
      heroText.anchor.set(0.5, 0);
      heroText.x = w / 2;
      heroText.y = headerBottom + h * 0.04;
      this.container.addChild(heroText);

      const heroDetail = new PIXI.Text(`「${hero.detail(playerStats)}」`, {
        fontSize: Math.round(h * 0.028),
        fill: 0x444444,
        fontStyle: 'italic',
      });
      heroDetail.anchor.set(0.5, 0);
      heroDetail.x = w / 2;
      heroDetail.y = heroText.y + heroText.height + h * 0.01;
      this.container.addChild(heroDetail);

      // Secondary badges (up to 2 more)
      let yOff = heroDetail.y + heroDetail.height + h * 0.04;
      for (let i = 1; i < badges.length; i++) {
        const badge = badges[i]!;
        const card  = this.buildBadgeCard(badge, playerStats, w * 0.8);
        card.x = w / 2 - card.width / 2;
        card.y = yOff;
        this.container.addChild(card);
        yOff += card.height + h * 0.015;
      }
    } else {
      // No notable stats
      const no = new PIXI.Text(t('result.keepGoing'), {
        fontSize: Math.round(h * 0.035),
        fill: 0x888888,
        fontFamily: 'monospace',
      });
      no.anchor.set(0.5, 0);
      no.x = w / 2;
      no.y = headerBottom + h * 0.06;
      this.container.addChild(no);
    }

    // "Play again" button (and an optional "watch replay" above it, S1-RP).
    const btnW = Math.round(w * 0.65);
    const btnH = Math.round(h * 0.07);
    const btnX = (w - btnW) / 2;
    const btnY = h * 0.82;

    // Stack optional buttons above "play again": watch-replay then share (top-most).
    let stackY = btnY;
    if (cb.onWatchReplay) {
      stackY -= btnH + h * 0.02;
      this.addButton(btnX, stackY, btnW, btnH, t('result.watchReplay'), 0x33503a, cb.onWatchReplay);
    }
    if (cb.onShare) {
      stackY -= btnH + h * 0.02;
      this.addButton(btnX, stackY, btnW, btnH, t('share.button'), 0x2a4a6a, () => cb.onShare!());
    }
    this.addButton(btnX, btnY, btnW, btnH, cb.playAgainLabel ?? t('result.playAgain'), 0x2c2c2a, () => cb.onPlayAgain());
  }

  /** A centred, tappable "name #id" line that opens its profile card. Returns new bottom y. */
  private addProfileLine(label: string, top: number, data: ProfileData, color: number): number {
    const { w, h } = this;
    const line = new PIXI.Text(label, {
      fontSize: Math.round(h * 0.03),
      fill: color,
      fontFamily: 'monospace',
      fontWeight: 'bold',
    });
    line.anchor.set(0.5, 0);
    line.x = w / 2;
    line.y = top + h * 0.018;
    line.interactive = true;
    line.cursor = 'pointer';
    line.on('pointertap', () => this.popup.show(data));
    this.container.addChild(line);
    let bottom = line.y + line.height;
    if (data.equippedTitle) {
      const keys = getTitleKeys(data.equippedTitle);
      const titleLabel = keys
        ? t(keys.shortKey as TranslationKey) || formatLadderTitle(data.equippedTitle)
        : formatLadderTitle(data.equippedTitle);
      const sub = new PIXI.Text(`「${titleLabel}」`, {
        fontSize: Math.round(h * 0.022),
        fill: 0x8a7020,
        fontFamily: 'monospace',
      });
      sub.anchor.set(0.5, 0);
      sub.x = w / 2;
      sub.y = bottom + h * 0.004;
      this.container.addChild(sub);
      bottom = sub.y + sub.height;
    }
    return bottom;
  }

  private addButton(
    x: number, y: number, w: number, h: number, text: string, fill: number, onTap: () => void,
  ): void {
    const bg = sketchPanel(w, h, { fill, border: ui.btnOff, width: 2.2, seed: seedFor(x, y, w) });
    bg.x = x;
    bg.y = y;
    bg.interactive = true;
    bg.cursor = 'pointer';
    bg.on('pointertap', onTap);

    const label = new PIXI.Text(text, {
      fontSize: Math.round(h * 0.44),
      fill: 0xffffff,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    label.anchor.set(0.5, 0.5);
    label.x = x + w / 2;
    label.y = y + h / 2;

    this.container.addChild(bg, label);
  }

  private buildBadgeCard(badge: Badge, stats: PlayerStats, width: number): PIXI.Container {
    const h   = Math.round(this.h * 0.07);
    const c   = new PIXI.Container();
    const gfx = sketchPanel(width, h, { fill: ui.paper, border: ui.line, width: 1.6, seed: seedFor(width, h, badge.score(stats)) });

    const label = new PIXI.Text(`${badge.title()}  ·  ${badge.detail(stats)}`, {
      fontSize: Math.round(h * 0.36),
      fill: 0x333333,
    });
    label.anchor.set(0, 0.5);
    label.x = width * 0.05;
    label.y = h / 2;

    c.addChild(gfx, label);
    return c;
  }
}
