import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, buildPaperBackground, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawCareerTabs } from '../ui/widgets/CareerTabs';
import { sidebarNavW, bottomNavH } from '../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { wheelScrollY } from '../ui/wheelScroll';
import { MATERIAL_ORDER } from '@nw/engine/balance/pveUpgrades';
import type { MatchHistoryEntry } from '../net/ApiClient';
import { type Row, sectionHeight, historyHeight, drawHistorySection, drawSection } from './StatsScene/panels';
import { dispatchHit, type Hit } from '../ui/hits';

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
  /** Open the card codex (LOBBY_IA_REDESIGN §15, folded in from the retired CollectionScene). */
  onOpenCodex?(): void;
  /** Current season info for the banner (SE-6). */
  season?: { seasonNo: number; endAt: number };
}

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

  // Portrait scroll state — landscape's two-column layout fits one screen so it stays
  // static (immediate tap-on-down, as before); portrait stacks all four sections in a
  // single column that can exceed the viewport, so it needs the same drag/wheel scroll
  // + masked viewport every other Career-hub page already has (TitlesScene/CardCodexScene).
  private body: PIXI.Container = new PIXI.Container();
  private bodyMask: PIXI.Graphics | null = null;
  private scrollY = 0;
  private scrollMax = 0;
  private scrollDirty = false;
  private dragStart: { x: number; y: number; scroll: number; moved: boolean } | null = null;
  /** Scrollable viewport y-bounds (set each render), gates mouse-wheel scroll. */
  private regionTop = 0;
  private regionBottom = 0;

  constructor(layout: ILayout, input: InputManager, cb: StatsCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.unsubs.push(input.onWheel((_x, y, deltaY) => this.handleWheel(y, deltaY)));
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

  update(): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
  }
  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  private handleDown(x: number, y: number): void {
    // Landscape's single static layout keeps the old immediate tap-on-down dispatch —
    // there's nothing to scroll, so deferring to onUp would only add latency.
    if (this.landscape) {
      dispatchHit(this.hits, x, y);
      return;
    }
    this.dragStart = { x, y, scroll: this.scrollY, moved: false };
  }

  private handleMove(y: number): void {
    if (this.landscape || !this.dragStart) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.dragStart.moved = true;
      this.scrollY = Math.max(0, Math.min(this.scrollMax, this.dragStart.scroll - dy));
      this.scrollDirty = true;
    }
  }

  private handleUp(x: number, y: number): void {
    if (this.landscape) return;
    if (this.dragStart && !this.dragStart.moved) {
      dispatchHit(this.hits, x, y);
    }
    this.dragStart = null;
  }

  /** Mouse-wheel scroll over the portrait body (browser/PC only — see wheelScroll.ts). */
  private handleWheel(y: number, deltaY: number): void {
    if (this.landscape) return;
    const next = wheelScrollY(this.regionTop, this.regionBottom, y, deltaY, this.scrollY, this.scrollMax);
    if (next !== null) { this.scrollY = next; this.scrollDirty = true; }
  }

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h, landscape } = this;
    const s = this.cb.getStats();

    // Landscape only for now, and only when the Career hub peer strip is actually shown — see
    // ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const hasSidebar = !!(this.cb.onOpenTitles && this.cb.onOpenAchievements && this.cb.onOpenCodex);
    const railX = landscape && hasSidebar ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('statsbg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t('stats.title'), { icon: 'statsTabIcon' });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, sound: 'sfx.ui.back', fn: () => this.cb.onBack() });

    // The Career hub peer strip [Stats|Titles|Achievements] (LOBBY_IA_REDESIGN P1.5 peer-tab
    // convention, see CareerTabs.ts): landscape stacks it in the notebook-margin gutter below the
    // header so the stat panels start clear of the red margin rule; portrait draws it as a bottom
    // nav bar instead (§18) — content no longer reserves any horizontal width for it there, so it
    // falls back to a flat margin, same as CardCodexScene/TitlesScene when there's no sidebar.
    // Drawn last (after body content) so the portrait bottom bar always paints on top even if a
    // tall stats page would otherwise run under it.
    const sidebarTop = tbH + Math.round(h * 0.02);
    const drawCareer = () => {
      if (this.cb.onOpenTitles && this.cb.onOpenAchievements && this.cb.onOpenCodex) {
        const { hits } = drawCareerTabs(this.container, w, h, landscape, sidebarTop, 'stats', {
          onOpenStats: () => {},
          onOpenTitles: this.cb.onOpenTitles,
          onOpenAchievements: this.cb.onOpenAchievements,
          onOpenCodex: this.cb.onOpenCodex,
          hasClaimableAchievement: this.cb.hasClaimableAchievement,
        });
        // Portrait draws this last (visually on top of body content) but hit-testing is first-match
        // in push order — unshift so an accidental rect overlap still resolves to the nav bar, not
        // whatever body content happens to sit underneath it.
        if (landscape) this.hits.push(...hits); else this.hits.unshift(...hits);
      }
    };
    if (landscape) drawCareer();

    const pad = Math.round(w * 0.04);
    const contentX = landscape && hasSidebar ? sidebarNavW(w, h, true) + Math.round(w * 0.025) : Math.round(w * 0.06);
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
      let ly = drawSection(this.container, this.hits, this.h, leftX, topY, leftW, t('stats.pvp'), C.accent, pvpRows);
      ly += gap;
      ly = drawSection(this.container, this.hits, this.h, leftX, ly, leftW, t('stats.campaign'), C.gold, campaignRows);
      ly += gap;
      drawSection(this.container, this.hits, this.h, leftX, ly, leftW, t('stats.collection'), C.green, collectionRows);

      // Right: match history
      drawHistorySection(this.container, this.hits, this.h, this.cb, this.history, rightX, topY, rightW);
    } else {
      // ── Portrait: single column with narrower margins, scrollable when the four ────
      // stacked sections (ranked/campaign/collection/history) overflow the screen — the
      // stat panels alone can already exceed one viewport, and match history adds up to
      // HISTORY_LIMIT more rows on top. Mirrors TitlesScene/CardCodexScene's masked-body
      // drag/wheel scroll so the tail of the page (history) is reachable instead of
      // silently clipped/hidden behind the bottom nav bar.
      const secW = w - contentX - pad;

      // Pure height calc (no drawing) so the viewport + scrollMax can be sized up front.
      const totalContentH =
        sectionHeight(this.h, pvpRows) + gap +
        sectionHeight(this.h, campaignRows) + gap +
        sectionHeight(this.h, collectionRows) + gap +
        historyHeight(this.h, !!this.cb.loadHistory, this.history);

      const bottomReserve = hasSidebar ? bottomNavH(h) : 0;
      const viewTop = topY;
      const viewH = Math.max(0, h - viewTop - Math.round(h * 0.02) - bottomReserve);
      this.regionTop = viewTop;
      this.regionBottom = viewTop + viewH;
      this.scrollMax = Math.max(0, totalContentH - viewH);
      this.scrollY = Math.max(0, Math.min(this.scrollY, this.scrollMax));

      this.body = new PIXI.Container();
      this.container.addChild(this.body);
      const mask = new PIXI.Graphics();
      mask.beginFill(0xffffff).drawRect(0, viewTop, w, viewH).endFill();
      this.container.addChild(mask);
      this.body.mask = mask;
      this.bodyMask = mask;

      let y = viewTop - this.scrollY;
      y = drawSection(this.body, this.hits, this.h, contentX, y, secW, t('stats.pvp'), C.accent, pvpRows); y += gap;
      y = drawSection(this.body, this.hits, this.h, contentX, y, secW, t('stats.campaign'), C.gold, campaignRows); y += gap;
      y = drawSection(this.body, this.hits, this.h, contentX, y, secW, t('stats.collection'), C.green, collectionRows); y += gap;
      drawHistorySection(this.body, this.hits, this.h, this.cb, this.history, contentX, y, secW);

      drawScrollIndicator(this.container, { x: contentX, y: viewTop, w: secW, h: viewH }, this.scrollY, this.scrollMax);
      drawCareer();
    }
  }

}
