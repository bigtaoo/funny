import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildIcon, type IconKind } from '../render/icons';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawCareerTabs } from '../ui/widgets/CareerTabs';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../ui/widgets/HubTabs';
import type { AchievementsView, Achievement } from '../net/ApiClient';
import { tierState, achievementClaimable, type TierState } from '../game/meta/achievements';

/** Category → hand-drawn tab glyph (pve = notebook, pvp = crossed swords, collection = brush, progression = trophy). */
const CATEGORY_ICON: Record<Achievement['category'], IconKind> = {
  pve: 'book',
  pvp: 'swords',
  collection: 'brush',
  progression: 'trophy',
};

// ── AchievementScene — achievement wall (personal view, ACHIEVEMENT_DESIGN §7) ──────────────────────
//
// Entry: the "achievements" button at the top of StatsScene. Category tabs (pve/pvp/collection/progression)
// + achievement cards (each card: three-tier progress + per-tier state: not-yet/claimable[claim]/claimed)
// + red dots (tab/card). Personal view only — not shown to others (public bragging goes through the title system).
// defs/stats/progress are served by GET /achievements; the client computes the tier state locally (§4.1).
// Landscape: cards laid out in two columns to make full use of the wide screen.

/** Category tab order (categories with no achievements are auto-hidden). */
const CATEGORY_ORDER: Achievement['category'][] = ['pve', 'pvp', 'collection', 'progression'];

const TIER_LABELS = ['I', 'II', 'III'];

export interface AchievementCallbacks {
  onBack(): void;
  /**
   * Fetch achievements (definitions + stats + progress). Omit when offline/not logged in → shows "log in to view".
   */
  loadAchievements?(): Promise<AchievementsView>;
  /**
   * Claim a specific tier of an achievement; returns the coins granted this time (server-authoritative).
   * The caller is responsible for updating the shared save (wallet). Omit when offline (claim button not shown).
   */
  onClaim?(achId: string, tier: number): Promise<number>;
  /**
   * Career hub peer navigation (LOBBY_IA_REDESIGN P1.5): when both are present, a
   * [Stats|Titles|Achievements] strip is drawn above the category sub-tabs in the left margin gutter,
   * itself active. Omitted from standalone entry points that shouldn't advertise the sibling pages.
   */
  onOpenStats?(): void;
  onOpenTitles?(): void;
  /** Open the card codex (LOBBY_IA_REDESIGN §15, folded in from the retired CollectionScene). */
  onOpenCodex?(): void;
}

interface Hit { rect: Rect; fn: () => void; }

export class AchievementScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly landscape: boolean;
  private readonly cb: AchievementCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async fetch() re-render can't paint into a torn-down container. */
  private destroyed = false;

  /** null = not yet fetched (loading); otherwise the fetched data. Only meaningful when loadAchievements is provided. */
  private data: AchievementsView | null = null;
  /** Currently active category tab. */
  private activeCat: Achievement['category'] = 'pve';
  /** True while a claim is in flight (prevents double-tap). */
  private claiming = false;
  /** One-shot toast (claim success / error), fades out. */
  private toast: string | null = null;
  private toastTimer = 0;

  constructor(layout: ILayout, input: InputManager, cb: AchievementCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    if (this.cb.loadAchievements) void this.fetch();
  }

  private async fetch(): Promise<void> {
    try {
      const d = await this.cb.loadAchievements!();
      this.data = d;
      // Default to the first non-empty category so the initial tab is never blank.
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

  private flash(msg: string): void {
    this.toast = msg;
    this.toastTimer = 2.2;
    this.render();
  }

  /** Categories present in defs (in fixed order; empty categories are hidden). */
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
      // Mark as claimed locally (server authority already settled; avoids a redundant re-fetch).
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

  // ── Render ─────────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h, landscape } = this;

    // Landscape only for now, and only when the Career hub peer strip is actually shown — see
    // ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const hasSidebar = !!(this.cb.onOpenStats && this.cb.onOpenTitles && this.cb.onOpenCodex);
    const railX = landscape && hasSidebar ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('achbg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    // Title bar (unified SceneHeader: back top-left + cached chrome, UI_DESIGN §3.1/§2.1).
    const hdr = drawSceneHeader(this.container, w, h, t('achievement.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Career hub peer strip [Stats|Titles|Achievements] (LOBBY_IA_REDESIGN P1.5, see CareerTabs.ts),
    // drawn above the category sub-tabs in the left margin gutter regardless of load state, so
    // the sibling pages never vanish while achievements are loading/offline/empty.
    let sidebarBottom = tbH + Math.round(h * 0.02);
    if (this.cb.onOpenStats && this.cb.onOpenTitles && this.cb.onOpenCodex) {
      const { hits, bottom } = drawCareerTabs(this.container, sidebarNavW(w, h, this.landscape), sidebarBottom, h, 'achievements', {
        onOpenStats: this.cb.onOpenStats,
        onOpenTitles: this.cb.onOpenTitles,
        onOpenAchievements: () => {},
        onOpenCodex: this.cb.onOpenCodex,
      });
      this.hits.push(...hits);
      sidebarBottom = bottom + Math.round(h * 0.03);
    }

    // Offline / loading state.
    if (!this.cb.loadAchievements) { this.drawCentered(tbH, t('achievement.loginRequired')); return; }
    if (this.data === null) { this.drawCentered(tbH, t('achievement.loading')); return; }

    const cats = this.categories(this.data);
    if (cats.length === 0) { this.drawCentered(tbH, t('achievement.empty')); this.drawToast(); return; }
    if (!cats.includes(this.activeCat)) this.activeCat = cats[0]!;

    const top = tbH + Math.round(h * 0.025);

    // Category tabs: a second-tier sidebar nested under the Career hub peer strip (mirrors
    // Equipment's Inventory/Craft sub-tabs, see HubTabs.drawSidebarTabs `sub` option), to the
    // left of the notebook's red margin rule; the achievement content sits to its right.
    this.drawCategoryTabs(cats, sidebarBottom);

    // Achievement cards for the current category.
    const contentX = sidebarNavW(w, h, this.landscape) + Math.round(w * 0.025);
    const padRight = Math.round(w * 0.04);
    const y0 = top;
    let y = y0;
    const gap = Math.round(h * 0.02);
    const defs = this.data.defs.filter((d) => d.category === this.activeCat && !d.hidden);

    if (this.landscape) {
      // Landscape: two-column layout, each half the width
      const colGap = Math.round(w * 0.02);
      const halfW = Math.round((w - contentX - padRight - colGap) / 2);
      const col1X = contentX;
      const col2X = contentX + halfW + colGap;

      let col = 0;
      let rowStartY = y;
      let leftBottom = y;

      for (const def of defs) {
        const cardX = col === 0 ? col1X : col2X;
        const cardBottom = this.drawCard(def, cardX, rowStartY, halfW);
        if (col === 0) {
          leftBottom = cardBottom;
          col = 1;
        } else {
          rowStartY = Math.max(leftBottom, cardBottom) + gap;
          col = 0;
        }
      }
    } else {
      // Portrait: single column
      const cardW = w - contentX - padRight;
      for (const def of defs) {
        y = this.drawCard(def, contentX, y, cardW);
        y += gap;
      }
    }

    this.drawToast();
  }

  private drawCentered(tbH: number, msg: string): void {
    const m = txt(msg, Math.round(this.h * 0.028), C.mid);
    m.anchor.set(0.5, 0.5); m.x = this.w / 2; m.y = tbH + (this.h - tbH) / 2;
    this.container.addChild(m);
  }

  /**
   * Category tabs as a second-tier sidebar nested under the Career hub peer strip (LOBBY_IA_REDESIGN
   * P1.5; see HubTabs.drawSidebarTabs `sub` option and Equipment's Inventory/Craft sub-tabs), left of
   * the notebook's red margin rule — achievement content is drawn to its right, see `contentX` in render().
   */
  private drawCategoryTabs(cats: Achievement['category'][], top: number): void {
    const tabs: HubTab[] = cats.map((cat) => ({
      label: t(('achievement.category.' + cat) as TranslationKey),
      active: cat === this.activeCat,
      icon: CATEGORY_ICON[cat],
      // Tab badge: shown when any achievement in this category is claimable.
      badge: this.data!.defs.some(
        (d) => d.category === cat && !d.hidden && achievementClaimable(d, this.data!.stats, this.data!.achievements),
      ),
    }));
    const { hits } = drawSidebarTabs(this.container, sidebarNavW(this.w, this.h, this.landscape), top, this.h, tabs, (i) => {
      this.activeCat = cats[i];
      this.render();
    }, { sub: true });
    this.hits.push(...hits);
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

    // Achievement name + card-level red dot.
    const name = txt(t(('achievement.' + def.id + '.name') as TranslationKey), Math.round(titleH * 0.74), C.dark, true);
    name.anchor.set(0, 0); name.x = innerX; name.y = y + padV;
    this.container.addChild(name);
    if (claimable) this.drawDot(innerX + name.width + Math.round(h * 0.012), y + padV + titleH * 0.32, Math.round(h * 0.008));

    // Description.
    const desc = txt(t(('achievement.' + def.id + '.desc') as TranslationKey), Math.round(descH * 0.62), C.mid);
    desc.anchor.set(0, 0); desc.x = innerX; desc.y = y + padV + titleH;
    this.container.addChild(desc);

    // Three-tier rows.
    let ry = y + padV + titleH + descH;
    for (const s of states) {
      this.drawTierRow(def, s, cur, innerX, ry, x + w - Math.round(w * 0.05), tierRowH);
      ry += tierRowH;
    }
    return y + cardH;
  }

  private drawTierRow(def: Achievement, s: TierState, cur: number, x: number, y: number, rightX: number, rowH: number): void {
    const cy = y + rowH / 2;

    // Tier badge label.
    const tierLbl = txt(TIER_LABELS[s.tier - 1] ?? String(s.tier), Math.round(rowH * 0.4), s.reached ? C.gold : C.mid, true);
    tierLbl.anchor.set(0, 0.5); tierLbl.x = x; tierLbl.y = cy;
    this.container.addChild(tierLbl);

    // Progress bar + progress text.
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

    // Right-side status / claim button.
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
    } else if (s.claimed) {
      const st = txt(t('achievement.claimed'), Math.round(rowH * 0.34), C.green, true);
      st.anchor.set(1, 0.5); st.x = rightX; st.y = cy;
      this.container.addChild(st);
    } else {
      // Not yet reached: coin glyph + reward amount (replaces "reward N coins" text).
      const amt = txt(String(s.coins), Math.round(rowH * 0.34), C.mid);
      amt.anchor.set(1, 0.5); amt.x = rightX; amt.y = cy;
      this.container.addChild(amt);
      const icS = Math.round(rowH * 0.4);
      const ic = buildIcon('coin', icS, C.gold);
      ic.x = rightX - amt.width - Math.round(rowH * 0.15) - icS; ic.y = cy - icS / 2;
      this.container.addChild(ic);
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
