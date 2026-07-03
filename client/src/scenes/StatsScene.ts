import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildIcon, type IconKind } from '../render/icons';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
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
  /** null = not fetched yet (loading); [] = fetched, empty. Only meaningful when loadHistory is provided. */
  private history: MatchHistoryEntry[] | null = null;

  constructor(layout: ILayout, input: InputManager, cb: StatsCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    if (this.cb.loadHistory) void this.fetchHistory();
  }

  private async fetchHistory(): Promise<void> {
    try {
      this.history = (await this.cb.loadHistory!()).slice(0, 10);
    } catch {
      this.history = [];
    }
    this.render();
  }

  update(): void { /* static */ }
  destroy(): void { this.unsubs.forEach((u) => u()); }

  private handleDown(x: number, y: number): void {
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private render(): void {
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

    // Top-bar right side: achievements (far right) + titles (to its left); both provided only when online.
    // Layout accumulates nextRight right-to-left to handle the case where one is absent.
    const rightPad = Math.round(w * 0.04);
    const btnGap = Math.round(w * 0.03);
    let nextRight = w - rightPad;

    if (this.cb.onOpenAchievements) {
      const ach = txt(t('stats.achievements'), Math.round(h * 0.026), C.gold, true);
      ach.anchor.set(1, 0.5); ach.x = nextRight; ach.y = tbH / 2;
      this.container.addChild(ach);
      this.hits.push({
        rect: { x: nextRight - ach.width - Math.round(w * 0.02), y: 0, w: ach.width + Math.round(w * 0.04), h: tbH },
        fn: () => this.cb.onOpenAchievements!(),
      });
      if (this.cb.hasClaimableAchievement) {
        const dot = new PIXI.Graphics();
        const r = Math.round(h * 0.011);
        dot.beginFill(0xee3333); dot.drawCircle(0, 0, r); dot.endFill();
        dot.x = nextRight + r; dot.y = tbH / 2 - Math.round(h * 0.016);
        this.container.addChild(dot);
      }
      nextRight = nextRight - ach.width - btnGap;
    }

    if (this.cb.onOpenTitles) {
      const titl = txt(t('stats.titles'), Math.round(h * 0.026), C.gold, true);
      titl.anchor.set(1, 0.5); titl.x = nextRight; titl.y = tbH / 2;
      this.container.addChild(titl);
      this.hits.push({
        rect: { x: nextRight - titl.width - Math.round(w * 0.02), y: 0, w: titl.width + Math.round(w * 0.04), h: tbH },
        fn: () => this.cb.onOpenTitles!(),
      });
    }

    const pad = Math.round(w * 0.04);
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
      // ── Landscape: two columns ───────────────────────────────────────────────────
      const colGap = Math.round(w * 0.025);
      const totalW = w - pad * 2;
      const leftW = Math.round(totalW * 0.54);
      const rightW = totalW - leftW - colGap;
      const leftX = pad;
      const rightX = pad + leftW + colGap;

      // Left: ranked + campaign
      let ly = this.drawSection(leftX, topY, leftW, t('stats.pvp'), C.accent, pvpRows);
      ly += gap;
      this.drawSection(leftX, ly, leftW, t('stats.campaign'), C.gold, campaignRows);

      // Right: collection + history
      let ry = this.drawSection(rightX, topY, rightW, t('stats.collection'), C.green, collectionRows);
      ry += gap;
      this.drawSection(rightX, ry, rightW, t('stats.history'), C.mid, this.historyRows());
    } else {
      // ── Portrait: single column with narrower margins ───────────────────────────
      const secW = w - pad * 2;
      let y = topY;
      y = this.drawSection(pad, y, secW, t('stats.pvp'), C.accent, pvpRows); y += gap;
      y = this.drawSection(pad, y, secW, t('stats.campaign'), C.gold, campaignRows); y += gap;
      y = this.drawSection(pad, y, secW, t('stats.collection'), C.green, collectionRows); y += gap;
      this.drawSection(pad, y, secW, t('stats.history'), C.mid, this.historyRows());
    }
  }

  /** Rows for the match-history section, reflecting fetch state. */
  private historyRows(): Row[] {
    if (!this.cb.loadHistory) {
      return [{ label: '', value: t('stats.historyOffline'), valueColor: C.mid }];
    }
    if (this.history === null) {
      return [{ label: '', value: t('stats.historyLoading'), valueColor: C.mid }];
    }
    if (this.history.length === 0) {
      return [{ label: '', value: t('stats.historyEmpty'), valueColor: C.mid }];
    }
    return this.history.map((m) => {
      const opp =
        m.opponentName || (m.opponentPublicId ? `#${m.opponentPublicId}` : t('stats.historyUnknownOpp'));
      const res =
        m.result === 'win' ? t('stats.win') : m.result === 'loss' ? t('stats.loss') : '—';
      const elo =
        m.eloDelta !== undefined ? ` (${m.eloDelta >= 0 ? '+' : ''}${m.eloDelta})` : '';
      return {
        label: opp,
        value: res + elo,
        valueColor: m.result === 'win' ? C.green : m.result === 'loss' ? C.red : C.mid,
        ...(this.cb.onWatchReplay ? { rowHit: () => this.cb.onWatchReplay!(m.roomId) } : {}),
      };
    });
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
