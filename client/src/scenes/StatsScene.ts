import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren, marginLineX } from '../render/sketchUi';
import { buildIcon, type IconKind } from '../render/icons';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawCareerTabs } from '../ui/widgets/CareerTabs';
import { MATERIAL_ORDER } from '../game/balance/pveUpgrades';
import type { MatchHistoryEntry } from '../net/ApiClient';

// ── StatsScene — match record / stats page (lobby "stats" nav) ───────────────────
//
// Local data from SaveData (ranked standing, campaign progress, collection count,
// materials) plus the "match history" section, which is wired to the server via
// GET /match/history (ApiClient.getMatchHistory; createAppCore fetches when online).

export interface StatsView {
  /** Ranked standing (SaveData.pvp). */
  pvp: { rank: string; elo: number; wins: number; losses: number; streak: number };
  /** Campaign levels cleared / total available. */
  cleared: number;
  totalLevels: number;
  /** Total stars earned across cleared levels. */
  stars: number;
  /** Owned skins count (inventory.skins). */
  skinsOwned: number;
  /** Material stockpile (materials record). */
  materials: Record<string, number>;
}

export interface StatsCallbacks {
  onBack(): void;
  getStats(): StatsView;
  /**
   * Fetch recent match history from the server. Omitted when offline / not logged
   * in (the history section then shows an "offline" hint instead of records).
   */
  loadHistory?(): Promise<MatchHistoryEntry[]>;
  /** Watch a recorded match by roomId (fetch + decode server replay). Omitted when offline. */
  onWatchReplay?(roomId: string): void;
  /** Open the achievement wall (S9-5). Shown as a top-right header button. */
  onOpenAchievements?(): void;
  /** Red dot on the achievements header button when any tier is claimable. */
  hasClaimableAchievement?: boolean;
  /** Open the global leaderboard (SE-6). Shown in the ranked section when online. */
  onOpenLeaderboard?(): void;
  /**
   * Fetch the player's own ladder position (1-based) for the current season, or null when
   * outside the ranked leaderboard. Shown as a row in the ranked section next to the
   * leaderboard link. Omitted when offline.
   */
  getMyRank?(): Promise<number | null>;
  /** The player's own display name, used for the "me vs opponent" match-history line. */
  playerName?: string;
  /** Open the titles wall (S10). Shown as a header button to the left of achievements. */
  onOpenTitles?(): void;
  /** Current season info for the banner (SE-6). */
  season?: { seasonNo: number; endAt: number };
}

interface Hit { rect: Rect; fn: () => void; }
interface Row { label: string; value: string; valueColor?: number; rowHit?: () => void; valueIcon?: IconKind; }

export class StatsScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly landscape: boolean;
  private readonly cb: StatsCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async fetchHistory()/fetchMyRank() re-render can't paint into a torn-down container. */
  private destroyed = false;
  /** null = not fetched yet (loading); [] = fetched, empty. Only meaningful when loadHistory is provided. */
  private history: MatchHistoryEntry[] | null = null;
  /** undefined = not fetched yet; null = unranked / fetch failed; number = 1-based ladder position. */
  private myRank: number | null | undefined = undefined;

  /** Match history is capped at the most recent 10 games. */
  private static readonly HISTORY_LIMIT = 10;

  constructor(layout: ILayout, input: InputManager, cb: StatsCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    if (this.cb.loadHistory) void this.fetchHistory();
    if (this.cb.getMyRank) void this.fetchMyRank();
  }

  private async fetchHistory(): Promise<void> {
    try {
      this.history = (await this.cb.loadHistory!()).slice(0, StatsScene.HISTORY_LIMIT);
    } catch {
      this.history = [];
    }
    this.render();
  }

  private async fetchMyRank(): Promise<void> {
    try {
      this.myRank = await this.cb.getMyRank!();
    } catch {
      this.myRank = null;
    }
    this.render();
  }

  update(): void { /* static */ }
  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  private handleDown(x: number, y: number): void {
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;
    const s = this.cb.getStats();

    this.container.addChild(buildPaperBackground('statsbg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t('stats.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Left margin rail: the Career hub peer strip [生涯统计|称号|成就] (LOBBY_IA_REDESIGN P1.5
    // peer-tab convention, see CareerTabs.ts), stacked inside the notebook-margin gutter below
    // the header (CardScene/EquipmentScene sidebar convention), so the stat panels start clear
    // of the red margin rule instead of the rule cutting through them.
    const sidebarW = marginLineX(w);
    const sidebarTop = tbH + Math.round(h * 0.02);
    if (this.cb.onOpenTitles && this.cb.onOpenAchievements) {
      const { hits } = drawCareerTabs(this.container, sidebarW, sidebarTop, h, 'stats', {
        onOpenStats: () => {},
        onOpenTitles: this.cb.onOpenTitles,
        onOpenAchievements: this.cb.onOpenAchievements,
        hasClaimableAchievement: this.cb.hasClaimableAchievement,
      });
      this.hits.push(...hits);
    }

    const pad = Math.round(w * 0.04);
    const contentX = sidebarW + Math.round(w * 0.025);
    const topY = tbH + Math.round(h * 0.035);
    const gap = Math.round(h * 0.022);

    // Shared row data ─────────────────────────────────────────────────────────
    const total = s.pvp.wins + s.pvp.losses;
    const winrate = total > 0 ? `${Math.round((s.pvp.wins / total) * 100)}%` : '—';
    const streak = s.pvp.streak > 0 ? t('stats.streakWin', { n: s.pvp.streak })
      : s.pvp.streak < 0 ? t('stats.streakLose', { n: -s.pvp.streak })
      : t('stats.streakNone');
    const rankName = t(('rank.' + s.pvp.rank) as TranslationKey);

    let seasonBannerStr = '';
    if (this.cb.season) {
      const { seasonNo, endAt } = this.cb.season;
      const daysLeft = Math.ceil((endAt - Date.now()) / (1000 * 60 * 60 * 24));
      seasonBannerStr = daysLeft > 0
        ? t('season.banner', { no: String(seasonNo), days: String(daysLeft) })
        : t('season.bannerEnded', { no: String(seasonNo) });
    }

    const pvpRows: Row[] = [
      ...(seasonBannerStr ? [{ label: '', value: seasonBannerStr, valueColor: C.gold }] : []),
      { label: t('stats.rank'), value: rankName, valueColor: C.gold },
      { label: t('stats.elo'), value: String(s.pvp.elo) },
      { label: t('stats.record'), value: `${s.pvp.wins} / ${s.pvp.losses}` },
      { label: t('stats.winrate'), value: winrate },
      { label: t('stats.streak'), value: streak, valueColor: s.pvp.streak > 0 ? C.green : s.pvp.streak < 0 ? C.red : C.mid },
      ...(this.cb.getMyRank
        ? [{
            label: t('stats.myRank'),
            value: this.myRank === undefined ? '…' : this.myRank === null ? t('stats.rankUnranked') : `#${this.myRank}`,
            valueColor: typeof this.myRank === 'number' ? C.gold : C.mid,
          }]
        : []),
      ...(this.cb.onOpenLeaderboard ? [{ label: '', value: t('leaderboard.openLeaderboard') + ' →', valueColor: C.accent, rowHit: () => this.cb.onOpenLeaderboard!() }] : []),
    ];

    const matRows: Row[] = MATERIAL_ORDER.map((id) => ({
      label: t(('material.' + id) as TranslationKey),
      value: String(s.materials[id] ?? 0),
    }));
    const collectionRows: Row[] = [{ label: t('stats.skins'), value: String(s.skinsOwned) }, ...matRows];
    const campaignRows: Row[] = [
      { label: t('stats.cleared'), value: `${s.cleared} / ${s.totalLevels}` },
      { label: t('stats.stars'), value: String(s.stars), valueIcon: 'star' },
    ];

    if (this.landscape) {
      // ── Landscape: profile column (compact stat panels) + match-history column ────
      // Left stacks the three read-at-a-glance panels (ranked / campaign / collection);
      // the right column is dedicated to the taller match-history feed. This keeps each
      // column's content roughly the same height instead of leaving the old layout's
      // large empty gap under the short campaign panel.
      const colGap = Math.round(w * 0.025);
      const totalW = w - contentX - pad;
      const leftW = Math.round(totalW * 0.46);
      const rightW = totalW - leftW - colGap;
      const leftX = contentX;
      const rightX = contentX + leftW + colGap;

      // Left: ranked + campaign + collection
      let ly = this.drawSection(leftX, topY, leftW, t('stats.pvp'), C.accent, pvpRows);
      ly += gap;
      ly = this.drawSection(leftX, ly, leftW, t('stats.campaign'), C.gold, campaignRows);
      ly += gap;
      this.drawSection(leftX, ly, leftW, t('stats.collection'), C.green, collectionRows);

      // Right: match history
      this.drawHistorySection(rightX, topY, rightW);
    } else {
      // ── Portrait: single column with narrower margins ───────────────────────────
      const secW = w - contentX - pad;
      let y = topY;
      y = this.drawSection(contentX, y, secW, t('stats.pvp'), C.accent, pvpRows); y += gap;
      y = this.drawSection(contentX, y, secW, t('stats.campaign'), C.gold, campaignRows); y += gap;
      y = this.drawSection(contentX, y, secW, t('stats.collection'), C.green, collectionRows); y += gap;
      this.drawHistorySection(contentX, y, secW);
    }
  }

  /**
   * Match-history panel — the most recent {@link HISTORY_LIMIT} games, each shown as a
   * "me vs opponent" line (with a crossed-swords glyph) plus a win/loss result chip,
   * rather than the generic label:value list used by the stat panels. Empty / loading /
   * offline states render a single centred notice inside the panel.
   */
  private drawHistorySection(x: number, y: number, w: number): number {
    const { h } = this;
    const titleH = Math.round(h * 0.034);
    const entryH = Math.round(h * 0.048);
    const padV = Math.round(h * 0.012);
    const accent = C.mid;

    const notice = !this.cb.loadHistory
      ? t('stats.historyOffline')
      : this.history === null
        ? t('stats.historyLoading')
        : this.history.length === 0
          ? t('stats.historyEmpty')
          : null;
    const entries = notice ? [] : this.history!;
    const bodyRows = notice ? 1 : entries.length;
    const panelH = titleH + bodyRows * entryH + padV * 2;

    const box = sketchPanel(w, panelH, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    sketchAccentBar(box, panelH, accent, seedFor(x, panelH, 7));
    this.container.addChild(box);

    const titleLbl = txt(t('stats.history'), Math.round(titleH * 0.7), accent, true);
    titleLbl.anchor.set(0, 0); titleLbl.x = x + Math.round(w * 0.05); titleLbl.y = y + padV;
    this.container.addChild(titleLbl);

    const bodyTop = y + padV + titleH;

    if (notice) {
      const n = txt(notice, Math.round(entryH * 0.5), C.mid);
      n.anchor.set(0.5, 0.5); n.x = x + w / 2; n.y = bodyTop + entryH / 2;
      this.container.addChild(n);
      return y + panelH;
    }

    const glyphX = x + Math.round(w * 0.045);
    const matchupX = x + Math.round(w * 0.11);
    const valRight = x + w - Math.round(w * 0.05);
    const me = this.cb.playerName || t('stats.you');

    entries.forEach((m, i) => {
      const ry = bodyTop + i * entryH;

      // Hairline separator between entries (skip above the first one).
      if (i > 0) {
        const sep = new PIXI.Graphics();
        sep.lineStyle(1, C.line, 0.5);
        sep.moveTo(x + Math.round(w * 0.045), ry); sep.lineTo(valRight, ry);
        this.container.addChild(sep);
      }

      // Crossed-swords glyph marks a match; doubles as the replay affordance when watchable.
      const gsz = Math.round(entryH * 0.5);
      const glyph = buildIcon('swords', gsz, m.result === 'win' ? C.green : m.result === 'loss' ? C.red : C.mid);
      glyph.x = glyphX; glyph.y = ry + entryH / 2 - gsz / 2;
      this.container.addChild(glyph);

      // "me vs opponent" — the opponent name is truncated so the matchup never collides
      // with the result chip on the right.
      const opp = m.opponentName || (m.opponentPublicId ? `#${m.opponentPublicId}` : t('stats.historyUnknownOpp'));
      const matchup = `${this.truncate(me, 10)} vs ${this.truncate(opp, 12)}`;
      const mt = txt(matchup, Math.round(entryH * 0.42), C.dark);
      mt.anchor.set(0, 0.5); mt.x = matchupX; mt.y = ry + entryH / 2;
      this.container.addChild(mt);

      // Result chip: win/loss plus signed ELO delta (delta absent for friendly matches).
      const res = m.result === 'win' ? t('stats.win') : m.result === 'loss' ? t('stats.loss') : '—';
      const elo = m.eloDelta !== undefined ? `  ${m.eloDelta >= 0 ? '+' : ''}${m.eloDelta}` : '';
      const resColor = m.result === 'win' ? C.green : m.result === 'loss' ? C.red : C.mid;
      const rt = txt(res + elo, Math.round(entryH * 0.44), resColor, true);
      rt.anchor.set(1, 0.5); rt.x = valRight; rt.y = ry + entryH / 2;
      this.container.addChild(rt);

      if (this.cb.onWatchReplay) {
        this.hits.push({ rect: { x, y: ry, w, h: entryH }, fn: () => this.cb.onWatchReplay!(m.roomId) });
      }
    });

    return y + panelH;
  }

  /** Clip an over-long display name to `max` chars with an ellipsis, so matchup lines stay on one row. */
  private truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /**
   * A titled hand-drawn panel with label:value rows. Returns the y just below it
   * so sections stack. Height grows with row count.
   */
  private drawSection(x: number, y: number, w: number, title: string, accent: number, rows: Row[]): number {
    const { h } = this;
    const titleH = Math.round(h * 0.034);
    const rowH = Math.round(h * 0.03);
    const padV = Math.round(h * 0.012);
    const panelH = titleH + rows.length * rowH + padV * 2;

    const box = sketchPanel(w, panelH, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    sketchAccentBar(box, panelH, accent, seedFor(x, panelH, 6));
    this.container.addChild(box);

    const titleLbl = txt(title, Math.round(titleH * 0.7), accent, true);
    titleLbl.anchor.set(0, 0); titleLbl.x = x + Math.round(w * 0.05); titleLbl.y = y + padV;
    this.container.addChild(titleLbl);

    let ry = y + padV + titleH;
    for (const row of rows) {
      if (row.label) {
        const lbl = txt(row.label, Math.round(rowH * 0.62), C.mid);
        lbl.anchor.set(0, 0.5); lbl.x = x + Math.round(w * 0.07); lbl.y = ry + rowH / 2;
        this.container.addChild(lbl);
      }
      const val = txt(row.value, Math.round(rowH * 0.66), row.valueColor ?? C.dark, true);
      const valRight = x + w - Math.round(w * 0.05);
      val.anchor.set(1, 0.5); val.x = valRight; val.y = ry + rowH / 2;
      this.container.addChild(val);
      // Optional hand-drawn glyph to the left of the value (e.g. a star for the star count).
      if (row.valueIcon) {
        const isz = Math.round(rowH * 0.7);
        const ic = buildIcon(row.valueIcon, isz, row.valueColor ?? C.gold);
        ic.x = valRight - val.width - isz - 4; ic.y = ry + rowH / 2 - isz / 2;
        this.container.addChild(ic);
      }
      // Rows with a watchable replay: draw a hand-drawn play glyph on the left + a full-row hit area.
      if (row.rowHit) {
        const psz = Math.round(rowH * 0.6);
        const play = buildIcon('play', psz, accent);
        play.x = x + Math.round(w * 0.035); play.y = ry + rowH / 2 - psz / 2;
        this.container.addChild(play);
        this.hits.push({ rect: { x, y: ry, w, h: rowH }, fn: row.rowHit });
      }
      ry += rowH;
    }

    return y + panelH;
  }
}
