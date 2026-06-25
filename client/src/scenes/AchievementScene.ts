import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import type { AchievementsView, Achievement } from '../net/ApiClient';
import { tierState, achievementClaimable, type TierState } from '../game/meta/achievements';

// ── AchievementScene — 成就墙（自看，ACHIEVEMENT_DESIGN §7）──────────────────────
//
// 入口：StatsScene 顶部「成就」按钮。分类 tab（pve/pvp/collection/progression）+ 成就卡
// （每卡三阶进度 + 各阶状态：未达/可领[领取]/已领）+ 红点（tab/卡）。仅自看，不对外展示
// （对外炫耀走称号系统）。defs/stats/进度由 GET /achievements 服务端下发，客户端本地算阶（§4.1）。

/** 分类 tab 顺序（无成就的分类自动隐藏）。 */
const CATEGORY_ORDER: Achievement['category'][] = ['pve', 'pvp', 'collection', 'progression'];

const TIER_LABELS = ['I', 'II', 'III'];

export interface AchievementCallbacks {
  onBack(): void;
  /**
   * 拉取成就（定义 + stats + 进度）。离线/未登录时省略 → 显「登录后查看」。
   */
  loadAchievements?(): Promise<AchievementsView>;
  /**
   * 领取某成就某阶；返回本次发放金币（服务器权威）。调用方负责更新共享存档（wallet）。
   * 离线时省略（此时不显领取按钮）。
   */
  onClaim?(achId: string, tier: number): Promise<number>;
}

interface Hit { rect: Rect; fn: () => void; }

export class AchievementScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: AchievementCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  /** null = 未拉取（loading）；否则已拉取的数据。仅当 loadAchievements 提供时有意义。 */
  private data: AchievementsView | null = null;
  /** 当前分类 tab。 */
  private activeCat: Achievement['category'] = 'pve';
  /** 领取中（防重复点）。 */
  private claiming = false;
  /** 一次性提示（领取成功 / 错误），淡出。 */
  private toast: string | null = null;
  private toastTimer = 0;

  constructor(layout: ILayout, input: InputManager, cb: AchievementCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    if (this.cb.loadAchievements) void this.fetch();
  }

  private async fetch(): Promise<void> {
    try {
      const d = await this.cb.loadAchievements!();
      this.data = d;
      // 默认选第一个非空分类，避免初始 tab 空着。
      const first = this.categories(d)[0];
      if (first) this.activeCat = first;
    } catch {
      this.data = { defs: [], stats: {}, achievements: {} };
    }
    this.render();
  }

  update(dt: number): void {
    if (this.toast !== null) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) { this.toast = null; this.render(); }
    }
  }

  destroy(): void { this.unsubs.forEach((u) => u()); }

  private handleDown(x: number, y: number): void {
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private flash(msg: string): void {
    this.toast = msg;
    this.toastTimer = 2.2;
    this.render();
  }

  /** 出现在 defs 中的分类（按固定顺序，空分类隐藏）。 */
  private categories(d: AchievementsView): Achievement['category'][] {
    return CATEGORY_ORDER.filter((c) => d.defs.some((def) => def.category === c && !def.hidden));
  }

  private claimedOf(achId: string): number[] {
    return this.data?.achievements?.[achId]?.claimedTiers ?? [];
  }

  private async claim(achId: string, tier: number): Promise<void> {
    if (this.claiming || !this.cb.onClaim) return;
    this.claiming = true;
    try {
      const granted = await this.cb.onClaim(achId, tier);
      // 本地标记已领（服务器权威已落，避免再拉一次）。
      if (this.data) {
        const cur = this.data.achievements ?? (this.data.achievements = {});
        const rec = cur[achId] ?? (cur[achId] = { claimedTiers: [] });
        if (!rec.claimedTiers.includes(tier)) rec.claimedTiers.push(tier);
      }
      this.flash(t('achievement.claimToast', { coins: granted }));
    } catch {
      this.flash(t('achievement.claimFailed'));
    } finally {
      this.claiming = false;
      this.render();
    }
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────────

  private render(): void {
    this.container.removeChildren();
    this.hits = [];
    const { w, h } = this;

    this.container.addChild(buildPaperBackground('achbg', w, h));

    // 标题栏（统一 SceneHeader：返回左上 + 缓存 chrome，UI_DESIGN §3.1/§2.1）。
    const hdr = drawSceneHeader(this.container, w, h, t('achievement.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // 离线 / 加载中。
    if (!this.cb.loadAchievements) { this.drawCentered(tbH, t('achievement.loginRequired')); return; }
    if (this.data === null) { this.drawCentered(tbH, t('achievement.loading')); return; }

    const cats = this.categories(this.data);
    if (cats.length === 0) { this.drawCentered(tbH, t('achievement.empty')); this.drawToast(); return; }
    if (!cats.includes(this.activeCat)) this.activeCat = cats[0]!;

    // 分类 tab 行。
    let y = tbH + Math.round(h * 0.025);
    y = this.drawTabs(cats, y);
    y += Math.round(h * 0.02);

    // 当前分类下的成就卡。
    const pad = Math.round(w * 0.06);
    const cardW = w - pad * 2;
    const gap = Math.round(h * 0.02);
    const defs = this.data.defs.filter((d) => d.category === this.activeCat && !d.hidden);
    for (const def of defs) {
      y = this.drawCard(def, pad, y, cardW);
      y += gap;
    }

    this.drawToast();
  }

  private drawCentered(tbH: number, msg: string): void {
    const m = txt(msg, Math.round(this.h * 0.028), C.mid);
    m.anchor.set(0.5, 0.5); m.x = this.w / 2; m.y = tbH + (this.h - tbH) / 2;
    this.container.addChild(m);
  }

  private drawTabs(cats: Achievement['category'][], y: number): number {
    const { w, h } = this;
    const pad = Math.round(w * 0.04);
    const gap = Math.round(w * 0.02);
    const tabW = Math.round((w - pad * 2 - gap * (cats.length - 1)) / cats.length);
    const tabH = Math.round(h * 0.05);
    cats.forEach((cat, i) => {
      const x = pad + i * (tabW + gap);
      const on = cat === this.activeCat;
      const box = sketchPanel(tabW, tabH, {
        fill: on ? C.accent : C.paper, border: on ? C.accent : C.line,
        width: on ? 2 : 1.4, seed: seedFor(x, y, tabW),
      });
      box.x = x; box.y = y;
      this.container.addChild(box);

      const lbl = txt(t(('achievement.category.' + cat) as TranslationKey), Math.round(tabH * 0.42), on ? 0xffffff : C.dark, on);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + tabW / 2; lbl.y = y + tabH / 2;
      this.container.addChild(lbl);

      // tab 红点：该分类任一成就可领。
      const hasDot = this.data!.defs.some(
        (d) => d.category === cat && !d.hidden && achievementClaimable(d, this.data!.stats, this.data!.achievements),
      );
      if (hasDot) this.drawDot(x + tabW - Math.round(tabH * 0.22), y + Math.round(tabH * 0.22), Math.round(tabH * 0.16));

      this.hits.push({ rect: { x, y, w: tabW, h: tabH }, fn: () => { this.activeCat = cat; this.render(); } });
    });
    return y + tabH;
  }

  private drawCard(def: Achievement, x: number, y: number, w: number): number {
    const { h } = this;
    const claimed = this.claimedOf(def.id);
    const states = tierState(def, this.data!.stats, claimed);
    const cur = this.data!.stats?.[def.statKey] ?? 0;

    const titleH = Math.round(h * 0.032);
    const descH = Math.round(h * 0.026);
    const tierRowH = Math.round(h * 0.044);
    const padV = Math.round(h * 0.014);
    const cardH = padV * 2 + titleH + descH + states.length * tierRowH;

    const claimable = states.some((s) => s.claimable);
    const box = sketchPanel(w, cardH, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    sketchAccentBar(box, cardH, claimable ? C.gold : C.accent, seedFor(x, cardH, 7));
    this.container.addChild(box);

    const innerX = x + Math.round(w * 0.05);

    // 成就名 + 卡片红点。
    const name = txt(t(('achievement.' + def.id + '.name') as TranslationKey), Math.round(titleH * 0.74), C.dark, true);
    name.anchor.set(0, 0); name.x = innerX; name.y = y + padV;
    this.container.addChild(name);
    if (claimable) this.drawDot(innerX + name.width + Math.round(h * 0.012), y + padV + titleH * 0.32, Math.round(h * 0.008));

    // 描述。
    const desc = txt(t(('achievement.' + def.id + '.desc') as TranslationKey), Math.round(descH * 0.62), C.mid);
    desc.anchor.set(0, 0); desc.x = innerX; desc.y = y + padV + titleH;
    this.container.addChild(desc);

    // 三阶行。
    let ry = y + padV + titleH + descH;
    for (const s of states) {
      this.drawTierRow(def, s, cur, innerX, ry, x + w - Math.round(w * 0.05), tierRowH);
      ry += tierRowH;
    }
    return y + cardH;
  }

  private drawTierRow(def: Achievement, s: TierState, cur: number, x: number, y: number, rightX: number, rowH: number): void {
    const cy = y + rowH / 2;

    // 阶位徽记。
    const tierLbl = txt(TIER_LABELS[s.tier - 1] ?? String(s.tier), Math.round(rowH * 0.4), s.reached ? C.gold : C.mid, true);
    tierLbl.anchor.set(0, 0.5); tierLbl.x = x; tierLbl.y = cy;
    this.container.addChild(tierLbl);

    // 进度条 + 进度文字。
    const barX = x + Math.round(rowH * 0.6);
    const barW = Math.round((rightX - barX) * 0.52);
    const barH = Math.round(rowH * 0.22);
    const barY = cy - barH / 2;
    const bg = new PIXI.Graphics();
    bg.beginFill(C.light); bg.drawRect(barX, barY, barW, barH); bg.endFill();
    const ratio = s.threshold > 0 ? Math.min(1, s.progress / s.threshold) : 0;
    if (ratio > 0) {
      bg.beginFill(s.reached ? C.green : C.accent);
      bg.drawRect(barX, barY, Math.round(barW * ratio), barH);
      bg.endFill();
    }
    this.container.addChild(bg);

    const prog = txt(`${Math.min(cur, s.threshold)}/${s.threshold}`, Math.round(rowH * 0.3), C.mid);
    prog.anchor.set(0, 0.5); prog.x = barX; prog.y = barY - Math.round(rowH * 0.24);
    this.container.addChild(prog);

    // 右侧状态 / 领取按钮。
    if (s.claimable && this.cb.onClaim) {
      const bw = Math.round(rowH * 1.9);
      const bh = Math.round(rowH * 0.66);
      const bx = rightX - bw;
      const by = cy - bh / 2;
      const btn = sketchPanel(bw, bh, { fill: C.gold, border: C.gold, width: 1.6, seed: seedFor(bx, by, bw) });
      btn.x = bx; btn.y = by;
      this.container.addChild(btn);
      const lbl = txt(t('achievement.claim', { coins: s.coins }), Math.round(bh * 0.42), 0xffffff, true);
      lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
      this.container.addChild(lbl);
      this.hits.push({ rect: { x: bx, y: by, w: bw, h: bh }, fn: () => void this.claim(def.id, s.tier) });
    } else {
      const label = s.claimed ? t('achievement.claimed') : t('achievement.reward', { coins: s.coins });
      const color = s.claimed ? C.green : C.mid;
      const st = txt(label, Math.round(rowH * 0.34), color, s.claimed);
      st.anchor.set(1, 0.5); st.x = rightX; st.y = cy;
      this.container.addChild(st);
    }
  }

  private drawDot(x: number, y: number, r: number): void {
    const g = new PIXI.Graphics();
    g.beginFill(C.red); g.drawCircle(x, y, r); g.endFill();
    this.container.addChild(g);
  }

  private drawToast(): void {
    if (this.toast === null) return;
    const { w, h } = this;
    const tw = Math.round(w * 0.7);
    const th = Math.round(h * 0.07);
    const tx = (w - tw) / 2;
    const ty = Math.round(h * 0.82);
    const box = sketchPanel(tw, th, { fill: C.dark, border: C.dark, width: 1.6, seed: seedFor(tx, ty, tw) });
    box.x = tx; box.y = ty;
    this.container.addChild(box);
    const lbl = txt(this.toast, Math.round(th * 0.34), 0xffffff, true);
    lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = ty + th / 2;
    this.container.addChild(lbl);
  }
}
