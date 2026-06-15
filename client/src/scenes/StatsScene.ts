import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';
import { MATERIAL_ORDER } from '../game/balance/pveUpgrades';
import type { MatchHistoryEntry } from '../net/ApiClient';

// ── StatsScene — 战绩 / 统计页 (lobby "stats" nav) ──────────────────────────────
//
// Step 1: purely local data from SaveData (ranked standing, campaign progress,
// collection count, materials). No backend. The "match history" section is a
// placeholder until the server endpoint lands (step 2: enrich matches archive +
// GET /match/history + ApiClient.getMatchHistory).

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
}

interface Hit { rect: Rect; fn: () => void; }
interface Row { label: string; value: string; valueColor?: number; rowHit?: () => void; }

export class StatsScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: StatsCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** null = not fetched yet (loading); [] = fetched, empty. Only meaningful when loadHistory is provided. */
  private history: MatchHistoryEntry[] | null = null;

  constructor(layout: ILayout, input: InputManager, cb: StatsCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
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
    this.container.removeChildren();
    this.hits = [];
    const { w, h } = this;
    const s = this.cb.getStats();

    this.container.addChild(buildPaperBackground('statsbg', w, h));

    const tbH = Math.round(h * 0.12);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark); titleBg.drawRect(0, 0, w, tbH); titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('stats.title'), Math.round(h * 0.034), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    const back = txt(t('stats.back'), Math.round(h * 0.026), C.light);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    this.container.addChild(back);
    this.hits.push({ rect: { x: 0, y: 0, w: back.x + back.width + Math.round(h * 0.02), h: tbH }, fn: () => this.cb.onBack() });

    // Sections, stacked.
    const pad = Math.round(w * 0.06);
    const secW = w - pad * 2;
    let y = tbH + Math.round(h * 0.035);
    const gap = Math.round(h * 0.022);

    // 1. Ranked
    const total = s.pvp.wins + s.pvp.losses;
    const winrate = total > 0 ? `${Math.round((s.pvp.wins / total) * 100)}%` : '—';
    const streak = s.pvp.streak > 0 ? t('stats.streakWin', { n: s.pvp.streak })
      : s.pvp.streak < 0 ? t('stats.streakLose', { n: -s.pvp.streak })
      : t('stats.streakNone');
    const rankName = t(('rank.' + s.pvp.rank) as TranslationKey);
    y = this.drawSection(pad, y, secW, t('stats.pvp'), C.accent, [
      { label: t('stats.rank'), value: rankName, valueColor: C.gold },
      { label: t('stats.elo'), value: String(s.pvp.elo) },
      { label: t('stats.record'), value: `${s.pvp.wins} / ${s.pvp.losses}` },
      { label: t('stats.winrate'), value: winrate },
      { label: t('stats.streak'), value: streak, valueColor: s.pvp.streak > 0 ? C.green : s.pvp.streak < 0 ? C.red : C.mid },
    ]);
    y += gap;

    // 2. Campaign
    y = this.drawSection(pad, y, secW, t('stats.campaign'), C.gold, [
      { label: t('stats.cleared'), value: `${s.cleared} / ${s.totalLevels}` },
      { label: t('stats.stars'), value: `★ ${s.stars}` },
    ]);
    y += gap;

    // 3. Collection + materials (combined panel)
    const matRows: Row[] = MATERIAL_ORDER.map((id) => ({
      label: t(('material.' + id) as TranslationKey),
      value: String(s.materials[id] ?? 0),
    }));
    y = this.drawSection(pad, y, secW, t('stats.collection'), C.green, [
      { label: t('stats.skins'), value: String(s.skinsOwned) },
      ...matRows,
    ]);
    y += gap;

    // 4. Match history — fetched from the server (GET /match/history).
    this.drawSection(pad, y, secW, t('stats.history'), C.mid, this.historyRows());
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
      val.anchor.set(1, 0.5); val.x = x + w - Math.round(w * 0.05); val.y = ry + rowH / 2;
      this.container.addChild(val);
      // 可看回放的行：左侧画 ▶ 提示 + 整行命中区。
      if (row.rowHit) {
        const play = txt('▶', Math.round(rowH * 0.6), accent, true);
        play.anchor.set(0, 0.5); play.x = x + Math.round(w * 0.035); play.y = ry + rowH / 2;
        this.container.addChild(play);
        this.hits.push({ rect: { x, y: ry, w, h: rowH }, fn: row.rowHit });
      }
      ry += rowH;
    }

    return y + panelH;
  }
}
