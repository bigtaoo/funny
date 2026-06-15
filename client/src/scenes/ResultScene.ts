import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { OwnerId, PlayerStats } from '../game/types';
import { t, TranslationKey } from '../i18n';
import { ProfilePopup, type ProfileData } from '../render/ProfilePopup';

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
  ) {
    this.container = new PIXI.Container();
    this.w  = w;
    this.h  = h;
    this.localOwner = localOwner;
    this.elo = elo;
    this.profiles = profiles;
    this.popup = new ProfilePopup(w, h);
    this.build(winner, stats, cb);
    this.container.addChild(this.popup.container); // topmost overlay
  }

  update(_dt: number): void { /* static scene */ }

  destroy(): void {
    this.container.removeAllListeners();
    this.popup.destroy();
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  private build(
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    cb: ResultSceneCallbacks,
  ): void {
    const { w, h } = this;
    const playerStats = stats[this.localOwner]!; // the local player's stats (owner 0 or 1)

    // Background
    const bg = new PIXI.Graphics();
    bg.beginFill(0xf5f0e8);
    bg.drawRect(0, 0, w, h);
    bg.endFill();
    this.drawNotebookLines(bg);
    this.container.addChild(bg);

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

    if (cb.onWatchReplay) {
      this.addButton(btnX, btnY - btnH - h * 0.02, btnW, btnH, t('result.watchReplay'),
        0x33503a, cb.onWatchReplay);
    }
    this.addButton(btnX, btnY, btnW, btnH, t('result.playAgain'), 0x2c2c2a, () => cb.onPlayAgain());
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
    return line.y + line.height;
  }

  private addButton(
    x: number, y: number, w: number, h: number, text: string, fill: number, onTap: () => void,
  ): void {
    const bg = new PIXI.Graphics();
    bg.beginFill(fill);
    bg.lineStyle(2, 0x444444);
    bg.drawRoundedRect(0, 0, w, h, 8);
    bg.endFill();
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
    const gfx = new PIXI.Graphics();
    gfx.beginFill(0xfaf6ee);
    gfx.lineStyle(1, 0xcccccc);
    gfx.drawRoundedRect(0, 0, width, h, 6);
    gfx.endFill();

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

  private drawNotebookLines(into: PIXI.Graphics): void {
    const spacing = Math.round(this.h / 30);
    into.lineStyle(1, 0xc8d8e8, 0.5);
    for (let y = spacing; y < this.h; y += spacing) {
      into.moveTo(0, y);
      into.lineTo(this.w, y);
    }
    into.lineStyle(1, 0xff9999, 0.4);
    into.moveTo(this.w * 0.08, 0);
    into.lineTo(this.w * 0.08, this.h);
  }
}
