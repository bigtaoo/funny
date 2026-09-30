import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, type Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../render/sketchUi';
import { showToastMessage, type ToastKind } from '../net/log';
import { buildIcon, type IconKind } from '../render/icons';
import { preloadRewardIconArt } from '../render/rewardIcon';
import { FS, snapFont, iconFloorPx } from '../render/fontScale';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawCareerTabs } from '../ui/widgets/CareerTabs';
import { drawStatusTag } from '../ui/widgets/statusTag';
import { drawSidebarTabs, drawHubTabs, hubTabsHeight, sidebarNavW, bottomNavH, type HubTab } from '../ui/widgets/HubTabs';
import type { AchievementsView, Achievement } from '../net/ApiClient';
import { tierState, achievementClaimable, type TierState } from '../game/meta/achievements';
import { hitAction, type Hit } from '../ui/hits';
import { ScrollTapGesture } from '../ui/scrollTapGesture';
import { wheelScrollY } from '../ui/wheelScroll';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { scrollRegionLayer } from '../ui/widgets/scrollRegionLayer';
import { drawButtonLabel, buttonLabelIconW } from '../ui/widgets/buttonLabel';
import { measuredWidth } from '../render/pixiText';
import { CATEGORY_ICON, CATEGORY_ORDER, TIER_LABELS, widestTierLabelW } from './AchievementScene/tiers';

// ── AchievementScene — achievement wall (personal view, ACHIEVEMENT_DESIGN §7) ──────────────────────
//
// Entry: the "achievements" button at the top of StatsScene. Category tabs (pve/pvp/collection/progression)
// + achievement cards (each card: three-tier progress + per-tier state: not-yet/claimable[claim]/claimed)
// + red dots (tab/card). Personal view only — not shown to others (public bragging goes through the title system).
// defs/stats/progress are served by GET /achievements; the client computes the tier state locally (§4.1).
// Landscape: cards laid out in two columns to make full use of the wide screen.

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


export class AchievementScene implements Scene {
  readonly container: PIXI.Container;
  /** Menu/shell screen: painted only when the stage changes (render/renderPolicy.ts). */
  readonly paint = 'reactive' as const;

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

  // ── Card list scroll ──────────────────────────────────────────────────────────
  // The list used to be drawn straight onto the page with no clip and no bottom reserve, so in
  // portrait the third pvp card ran under the Career bottom bar and could not be reached
  // (2026-09-29). Cards now go into a masked layer between the category tabs and the bar.
  private scrollY = 0;
  private scrollMax = 0;
  /** Viewport of the card list; zero-sized while no list is drawn (loading / empty). */
  private scrollView: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private scrollLayer: PIXI.Container | null = null;
  private scrollbar: PIXI.Graphics | null = null;
  /** Taps are deferred to pointer-up only while the list can scroll, so a drag is never a claim. */
  private readonly gesture = new ScrollTapGesture();
  /** Where card content is drawn: the scroll layer while cards are built, the page otherwise. */
  private body: PIXI.Container;
  /** Card hits in unscrolled coordinates; `applyScroll` offsets and clips them into `hits`. */
  private cardHits: Hit[] = [];
  /** Everything that does not scroll: back, category tabs, the Career bar. */
  private fixedHits: Hit[] = [];

  constructor(layout: ILayout, input: InputManager, cb: AchievementCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.body = this.container;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    this.unsubs.push(input.onWheel((x, y, deltaY) => {
      const v = this.scrollView;
      if (x < v.x || x > v.x + v.w) return;
      const next = wheelScrollY(v.y, v.y + v.h, y, deltaY, this.scrollY, this.scrollMax);
      if (next !== null) { this.scrollY = next; this.applyScroll(); }
    }));
    this.render();
    // The category strip's AI tab icons + the reward coin glyph are raster art — warm them and
    // repaint once decoded, else the first frame draws blanks / procedural fallbacks.
    void preloadRewardIconArt().then(() => { if (!this.destroyed) this.render(); });
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

  update(_dt: number): void { /* no per-frame work; toasts are global (GlobalToast) */ }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  private handleDown(x: number, y: number): void {
    const act = hitAction(this.hits, x, y);
    // Nothing to scroll: keep firing on press, exactly as before the list could scroll.
    if (this.scrollMax <= 0) { act?.(); return; }
    this.gesture.down(this.scrollY, y, act);
  }

  private handleMove(y: number): void {
    const next = this.gesture.move(y);
    if (next !== null) { this.scrollY = Math.min(this.scrollMax, next); this.applyScroll(); }
  }

  private handleUp(): void {
    this.gesture.up()?.();
  }

  /** Move the card layer and rebuild `hits` from the fixed hits plus the card hits still in view. */
  private applyScroll(): void {
    if (!this.scrollLayer) return;
    const sy = Math.min(this.scrollY, this.scrollMax);
    this.scrollLayer.y = -sy;
    const top = this.scrollView.y;
    const bottom = top + this.scrollView.h;
    const visible: Hit[] = [];
    for (const hit of this.cardHits) {
      const y0 = Math.max(top, hit.rect.y - sy);
      const y1 = Math.min(bottom, hit.rect.y - sy + hit.rect.h);
      if (y1 > y0) visible.push({ ...hit, rect: { ...hit.rect, y: y0, h: y1 - y0 } });
    }
    this.hits = this.fixedHits.concat(visible);
    this.scrollbar?.destroy();
    this.scrollbar = drawScrollIndicator(this.container, this.scrollView, sy, this.scrollMax);
  }

  private flash(msg: string, kind: ToastKind = 'success'): void {
    showToastMessage(msg, kind);
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
      this.flash(t('achievement.claimFailed'), 'error');
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
    this.cardHits = [];
    this.fixedHits = [];
    this.scrollLayer = null;
    this.scrollbar = null; // torn down with the container above
    this.scrollMax = 0;
    this.scrollView = { x: 0, y: 0, w: 0, h: 0 };
    this.body = this.container;
    const { w, h, landscape } = this;

    // Landscape only for now, and only when the Career hub peer strip is actually shown — see
    // ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const hasSidebar = !!(this.cb.onOpenStats && this.cb.onOpenTitles && this.cb.onOpenCodex);
    const railX = landscape && hasSidebar ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('achbg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    // Title bar (unified SceneHeader: back top-left + cached chrome, UI_DESIGN §3.1/§2.1).
    const hdr = drawSceneHeader(this.container, w, h, t('achievement.title'), { icon: 'achievementTabIcon' });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, sound: 'sfx.ui.back', fn: () => this.cb.onBack() });

    // Career hub peer strip [Stats|Titles|Achievements] (LOBBY_IA_REDESIGN P1.5, see CareerTabs.ts).
    // Landscape draws it above the category sub-tabs in the left margin gutter regardless of load
    // state, so the sibling pages never vanish while achievements are loading/offline/empty.
    // Portrait draws it as a bottom nav bar instead (§18); since it no longer nests the category
    // sub-tabs beneath it there (those move to a header strip — see drawCategoryTabs), it's deferred
    // to `drawPortraitCareerBar()` called on every render() exit path, last, so it always paints on
    // top of whatever content this render produced.
    let sidebarBottom = tbH + Math.round(h * 0.02);
    const hasCareerNav = !!(this.cb.onOpenStats && this.cb.onOpenTitles && this.cb.onOpenCodex);
    const careerCb = { onOpenStats: this.cb.onOpenStats!, onOpenTitles: this.cb.onOpenTitles!, onOpenAchievements: () => {}, onOpenCodex: this.cb.onOpenCodex! };
    if (hasCareerNav && landscape) {
      const { hits, bottom } = drawCareerTabs(this.container, w, h, true, sidebarBottom, 'achievements', careerCb);
      this.hits.push(...hits);
      sidebarBottom = bottom + Math.round(h * 0.03);
    }
    const drawPortraitCareerBar = (): void => {
      if (!hasCareerNav || landscape) return;
      const { hits } = drawCareerTabs(this.container, w, h, false, 0, 'achievements', careerCb);
      // Drawn last (visually on top), but hit-testing is first-match in push order — unshift so an
      // accidental rect overlap with a tall category's cards still resolves to the nav bar.
      this.hits.unshift(...hits);
    };

    // Offline / loading state.
    if (!this.cb.loadAchievements) { this.drawCentered(tbH, t('achievement.loginRequired')); drawPortraitCareerBar(); return; }
    if (this.data === null) { this.drawCentered(tbH, t('achievement.loading')); drawPortraitCareerBar(); return; }

    const cats = this.categories(this.data);
    if (cats.length === 0) { this.drawCentered(tbH, t('achievement.empty')); drawPortraitCareerBar(); return; }
    if (!cats.includes(this.activeCat)) this.activeCat = cats[0]!;

    // Category tabs: landscape nests a second-tier sidebar under the Career hub peer strip (mirrors
    // Equipment's Inventory/Craft sub-tabs, see HubTabs.drawSidebarTabs `sub` option); portrait draws
    // them as a `drawHubTabs` strip under the header instead, since the peer strip itself moved to
    // the bottom nav bar and there's nothing left to nest under in the left margin.
    const catStripTop = tbH + Math.round(h * 0.02);
    const catStripH = hubTabsHeight(h);
    const top = landscape ? tbH + Math.round(h * 0.025) : catStripTop + catStripH + Math.round(h * 0.02);
    this.drawCategoryTabs(cats, landscape ? sidebarBottom : catStripTop, catStripH);

    // Achievement cards for the current category, in a masked layer that ends above the portrait
    // Career bar. Drawn at unscrolled coordinates; `applyScroll` moves the layer.
    const contentX = landscape ? sidebarNavW(w, h, true) + Math.round(w * 0.025) : Math.round(w * 0.06);
    const padRight = landscape ? Math.round(w * 0.04) : Math.round(w * 0.06);
    const gap = Math.round(h * 0.02);
    const viewBottom = h - (hasCareerNav && !landscape ? bottomNavH(h) : 0) - Math.round(h * 0.01);
    this.scrollView = { x: 0, y: top, w, h: Math.max(0, viewBottom - top) };
    const { layer } = scrollRegionLayer(this.container, this.scrollView);
    this.scrollLayer = layer;
    this.body = layer;
    let y = top;
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
        y = Math.max(y, cardBottom);
      }
    } else {
      // Portrait: single column
      const cardW = w - contentX - padRight;
      for (const def of defs) {
        y = this.drawCard(def, contentX, y, cardW) + gap;
      }
      y -= gap;
    }
    this.body = this.container;
    // The last card's bottom may scroll up to a gap above the viewport's bottom edge.
    this.scrollMax = Math.max(0, Math.round(y + gap - viewBottom));
    this.scrollY = Math.min(this.scrollY, this.scrollMax);

    drawPortraitCareerBar();
    this.fixedHits = this.hits;
    this.applyScroll();
  }

  private drawCentered(tbH: number, msg: string): void {
    const m = txt(msg, FS.title, C.mid);
    m.anchor.set(0.5, 0.5); m.x = this.w / 2; m.y = tbH + (this.h - tbH) / 2;
    this.container.addChild(m);
  }

  /**
   * Category tabs. Landscape draws them as a second-tier sidebar nested under the Career hub peer
   * strip (LOBBY_IA_REDESIGN P1.5; see HubTabs.drawSidebarTabs `sub` option and Equipment's
   * Inventory/Craft sub-tabs), left of the notebook's red margin rule — achievement content is
   * drawn to its right, see `contentX` in render(). Portrait draws them as a `drawHubTabs` strip
   * under the header instead (§18): the peer strip moved to the bottom nav bar, so there's no
   * left-rail parent left to nest under, and a horizontal strip is the existing convention for
   * "sub-view switch within one scene" everywhere else in the game.
   */
  private drawCategoryTabs(cats: Achievement['category'][], top: number, stripH: number): void {
    const tabs: HubTab[] = cats.map((cat) => ({
      label: t(('achievement.category.' + cat) as TranslationKey),
      active: cat === this.activeCat,
      icon: CATEGORY_ICON[cat],
      // Tab badge: shown when any achievement in this category is claimable.
      badge: this.data!.defs.some(
        (d) => d.category === cat && !d.hidden && achievementClaimable(d, this.data!.stats, this.data!.achievements),
      ),
    }));
    const onSelect = (i: number): void => {
      this.activeCat = cats[i];
      this.scrollY = 0;
      this.render();
    };
    if (!this.landscape) {
      const hits = drawHubTabs(this.container, this.w, top, stripH, tabs, onSelect);
      this.hits.push(...hits);
      return;
    }
    const { hits } = drawSidebarTabs(this.container, sidebarNavW(this.w, this.h, true), top, this.h, tabs, onSelect, { sub: true });
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
    this.body.addChild(box);

    const innerX = x + Math.round(w * 0.05);

    // Achievement name + card-level red dot.
    const name = txt(t(('achievement.' + def.id + '.name') as TranslationKey), snapFont(Math.round(titleH * 0.74)), C.dark, true);
    name.anchor.set(0, 0); name.x = innerX; name.y = y + padV;
    this.body.addChild(name);
    if (claimable) this.drawDot(innerX + name.width + Math.round(h * 0.012), y + padV + titleH * 0.32, Math.round(h * 0.008));

    // Description.
    const desc = txt(t(('achievement.' + def.id + '.desc') as TranslationKey), snapFont(Math.round(descH * 0.62)), C.mid);
    desc.anchor.set(0, 0); desc.x = innerX; desc.y = y + padV + titleH;
    this.body.addChild(desc);

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
    const tierFS = snapFont(Math.round(rowH * 0.4));
    const tierLbl = txt(TIER_LABELS[s.tier - 1] ?? String(s.tier), tierFS, s.reached ? C.gold : C.mid, true);
    tierLbl.anchor.set(0, 0.5); tierLbl.x = x; tierLbl.y = cy;
    this.body.addChild(tierLbl);

    // Progress bar + progress text. The bar starts past the WIDEST tier label, not at a fixed
    // `rowH * 0.6`: three bold glyphs at `rowH * 0.4` are ~0.72 rowH wide, so "III" ran into the bar
    // (2026-09-29). Measured against the widest label so the bars of one card still line up.
    const barX = x + Math.max(Math.round(rowH * 0.6), Math.ceil(widestTierLabelW(tierFS) + rowH * 0.15));
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
    this.body.addChild(bg);

    const prog = txt(`${Math.min(cur, s.threshold)}/${s.threshold}`, snapFont(Math.round(rowH * 0.3)), C.mid);
    prog.anchor.set(0, 0.5); prog.x = barX; prog.y = barY - Math.round(rowH * 0.24);
    this.body.addChild(prog);

    // Right-side status / claim button.
    if (s.claimable && this.cb.onClaim) {
      const bh = Math.round(rowH * 0.66);
      const bfs = snapFont(Math.round(bh * 0.42));
      const label = t('achievement.claim', { coins: s.coins });
      // Sized to the label it is actually holding, with `rowH * 1.9` kept only as a floor.
      // A fixed width could not hold "Claim +200" on a phone held sideways: the row is short there,
      // so `bh` — and the font derived from it — is small in DESIGN px but the viewport renders at
      // 0.36x, and `drawButtonLabel` stops shrinking at the legibility floor and lets the label
      // overflow rather than go under it (its header, §50.12). The label then ran out of both ends
      // of the gold box. Same fix, same reasoning as DailyScene's claim button.
      const probe = txt(label, bfs, 0xffffff, true);
      const bw = Math.max(Math.round(rowH * 1.9), Math.ceil(probe.width + buttonLabelIconW(bfs) + bh * 0.5));
      probe.destroy({ texture: true, baseTexture: true });
      const bx = rightX - bw;
      const by = cy - bh / 2;
      const btn = sketchPanel(bw, bh, { fill: C.gold, border: C.gold, width: 1.6, seed: seedFor(bx, by, bw) });
      btn.x = bx; btn.y = by;
      this.body.addChild(btn);
      drawButtonLabel(this.container, bx, by, bw, bh, label, 'gift', 0xffffff, bfs);
      this.cardHits.push({ rect: { x: bx, y: by, w: bw, h: bh }, sound: 'sfx.ui.reward', fn: () => void this.claim(def.id, s.tier) });
    } else if (s.claimed) {
      // The claim BUTTON above keeps its word at every width; this is the state it leaves behind,
      // so it degrades to the check alone on a row too narrow for both (ui/widgets/statusTag.ts).
      const stateFS = snapFont(Math.round(rowH * 0.34));
      const tagH = Math.round(stateFS * 1.35);
      // The band right of the progress bar, which is all this row ever had — the same width the
      // claim button occupies on a claimable tier, so the two states sit in the same column.
      const tagX = barX + barW + Math.round(rowH * 0.3);
      drawStatusTag(this.container, tagX, cy - tagH / 2, rightX - tagX, tagH,
        t('achievement.claimed'), 'check', C.green, stateFS);
    } else {
      // Not yet reached: coin glyph + reward amount (replaces "reward N coins" text).
      const amt = txt(String(s.coins), snapFont(Math.round(rowH * 0.34)), C.mid);
      amt.anchor.set(1, 0.5); amt.x = rightX; amt.y = cy;
      this.body.addChild(amt);
      // Floored, not just proportional: a compact row (phone landscape, 844x390) computes 19
      // design px = 6.9 CSS px for this coin, under the floor the `snapFont` call two lines up
      // already gives the amount beside it. Reported by the layout audit's icon gate (2026-09-14).
      const icS = iconFloorPx(rowH * 0.4);
      const ic = buildIcon('coin', icS, C.gold);
      ic.x = rightX - amt.width - Math.round(rowH * 0.15) - icS; ic.y = cy - icS / 2;
      this.body.addChild(ic);
    }
  }

  private drawDot(x: number, y: number, r: number): void {
    const g = new PIXI.Graphics();
    g.beginFill(C.red); g.drawCircle(x, y, r); g.endFill();
    this.body.addChild(g);
  }

}
