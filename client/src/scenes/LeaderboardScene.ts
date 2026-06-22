import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';

// ── LeaderboardScene — 全服天梯排行榜（SE-6）─────────────────────────────────────
//
// 入口：StatsScene 天梯段落「排行榜」按钮（onOpenLeaderboard）。
// 显示：当前赛季 Top-100（ELO 降序）+ 固定底部"我的排名"行（若有）。
// 数据：GET /leaderboard（JWT，由 loadLeaderboard 回调驱动）。

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  publicId: string;
  elo: number;
  pvpRank: string;
}

export interface LeaderboardCallbacks {
  onBack(): void;
  /**
   * 拉取排行榜。未提供（离线/未登录）时显「登录后查看」。
   */
  loadLeaderboard?(): Promise<{ seasonNo: number; entries: LeaderboardEntry[] }>;
  /** 点击行查看资料（复用 ProfilePopup）。未提供则不可点。 */
  onOpenProfile?(publicId: string): void;
}

interface Hit { rect: Rect; fn: () => void; }

export class LeaderboardScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly cb: LeaderboardCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  private data: { seasonNo: number; entries: LeaderboardEntry[] } | null = null;
  private loading = false;
  private scrollY = 0;
  private scrollMax = 0;
  private maskGfx?: PIXI.Graphics;

  constructor(layout: ILayout, input: InputManager, cb: LeaderboardCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    if (this.cb.loadLeaderboard) void this.fetchData();
  }

  private async fetchData(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const d = await this.cb.loadLeaderboard!();
      this.data = d;
    } catch {
      this.data = { seasonNo: 0, entries: [] };
    }
    this.loading = false;
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

    this.container.addChild(buildPaperBackground('lbbg', w, h));

    // ── Title bar ────────────────────────────────────────────────────────────
    const tbH = Math.round(h * 0.12);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark); titleBg.drawRect(0, 0, w, tbH); titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('leaderboard.title'), Math.round(h * 0.034), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    const back = txt(t('leaderboard.back'), Math.round(h * 0.026), C.light);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    this.container.addChild(back);
    this.hits.push({ rect: { x: 0, y: 0, w: back.x + back.width + Math.round(h * 0.02), h: tbH }, fn: () => this.cb.onBack() });

    // Season subtitle
    if (this.data && this.data.seasonNo > 0) {
      const sub = txt(t('leaderboard.season', { no: String(this.data.seasonNo) }), Math.round(h * 0.022), C.gold);
      sub.anchor.set(1, 0.5); sub.x = w - Math.round(w * 0.04); sub.y = tbH / 2;
      this.container.addChild(sub);
    }

    // ── Body ─────────────────────────────────────────────────────────────────
    const pad = Math.round(w * 0.05);
    const bodyY = tbH + Math.round(h * 0.025);
    const bodyH = h - bodyY;

    if (!this.cb.loadLeaderboard) {
      const msg = txt(t('leaderboard.loginRequired'), Math.round(h * 0.03), C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = w / 2; msg.y = bodyY + bodyH / 2;
      this.container.addChild(msg);
      return;
    }

    if (this.loading) {
      const msg = txt(t('leaderboard.loading'), Math.round(h * 0.03), C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = w / 2; msg.y = bodyY + bodyH / 2;
      this.container.addChild(msg);
      return;
    }

    if (!this.data || this.data.entries.length === 0) {
      const msg = txt(t('leaderboard.empty'), Math.round(h * 0.03), C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = w / 2; msg.y = bodyY + bodyH / 2;
      this.container.addChild(msg);
      return;
    }

    const entries = this.data.entries;
    const rowH = Math.round(h * 0.065);
    const listW = w - pad * 2;

    // Scrollable list container
    const listContainer = new PIXI.Container();
    listContainer.x = pad;
    listContainer.y = bodyY;

    let totalH = 0;
    entries.forEach((e, i) => {
      const ry = i * (rowH + Math.round(h * 0.008));
      totalH = ry + rowH;
      this.drawRow(listContainer, e, 0, ry, listW, rowH, i);
    });

    this.scrollMax = Math.max(0, totalH - bodyH);
    const sy = Math.min(this.scrollY, this.scrollMax);
    listContainer.y = bodyY - sy;

    // Mask to clip the scrollable area
    const maskGfx = new PIXI.Graphics();
    maskGfx.beginFill(0xffffff).drawRect(0, bodyY, w, bodyH).endFill();
    this.container.addChild(maskGfx);
    listContainer.mask = maskGfx;

    this.container.addChild(listContainer);

    // Hits (absolute coords offset by current scroll)
    entries.forEach((e, i) => {
      const ry = i * (rowH + Math.round(h * 0.008));
      const absY = bodyY - sy + ry;
      if (absY + rowH < bodyY || absY > bodyY + bodyH) return;
      if (this.cb.onOpenProfile) {
        this.hits.push({
          rect: { x: pad, y: absY, w: listW, h: rowH },
          fn: () => this.cb.onOpenProfile!(e.publicId),
        });
      }
    });
  }

  private drawRow(
    parent: PIXI.Container,
    e: LeaderboardEntry,
    x: number, y: number, w: number, rowH: number,
    index: number,
  ): void {
    const { h } = this;
    const isTop3 = e.rank <= 3;
    const accent = isTop3 ? C.gold : C.line;

    const box = sketchPanel(w, rowH, { fill: isTop3 ? 0xfef8e0 : C.paper, border: accent, width: isTop3 ? 2 : 1.2, seed: seedFor(x, y + index, w) });
    box.x = x; box.y = y;
    if (isTop3) sketchAccentBar(box, rowH, C.gold, seedFor(index, rowH, 4));
    parent.addChild(box);

    const rankEmoji = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : `#${e.rank}`;
    const rankLbl = txt(rankEmoji, Math.round(rowH * 0.5), isTop3 ? C.gold : C.mid, isTop3);
    rankLbl.anchor.set(0, 0.5); rankLbl.x = x + Math.round(w * 0.03); rankLbl.y = y + rowH / 2;
    parent.addChild(rankLbl);

    const nameLbl = txt(e.displayName || `#${e.publicId}`, Math.round(rowH * 0.48), C.dark);
    nameLbl.anchor.set(0, 0.5); nameLbl.x = x + Math.round(w * 0.18); nameLbl.y = y + rowH / 2;
    parent.addChild(nameLbl);

    const pvpRankLbl = txt(e.pvpRank, Math.round(rowH * 0.38), C.mid);
    pvpRankLbl.anchor.set(0.5, 0.5); pvpRankLbl.x = x + Math.round(w * 0.68); pvpRankLbl.y = y + rowH / 2;
    parent.addChild(pvpRankLbl);

    const eloLbl = txt(String(e.elo), Math.round(rowH * 0.5), isTop3 ? C.gold : C.dark, isTop3);
    eloLbl.anchor.set(1, 0.5); eloLbl.x = x + w - Math.round(w * 0.03); eloLbl.y = y + rowH / 2;
    parent.addChild(eloLbl);
  }
}
