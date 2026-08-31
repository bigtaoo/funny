import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { buildPaperBackground, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { cardArtUrl, preloadL1CardArtTextures } from '../render/cardArt';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawCareerTabs, type CareerNavCallbacks } from '../ui/widgets/CareerTabs';
import { sidebarNavW, bottomNavH } from '../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { wheelScrollY } from '../ui/wheelScroll';
import { CARD_DEFINITIONS } from '@nw/engine/config';
import { CardType, type CardDefinition } from '@nw/engine/types';
import { type CodexEntry, codexFaceBox, storyText, drawTileFace, drawCardTile } from './CardCodexScene/tile';
import { runHit, type Hit as BaseHit } from '../ui/hits';

/** This scene has a single scrollable region, so `scroll` degrades to a boolean (see ui/hits.ts). */
type Hit = BaseHit<boolean>;

// ── CardCodexScene — read-only full card compendium ─────────────────────────────
//
// Folded in from the retired CollectionScene's "Cards" tab (LOBBY_IA_REDESIGN §15): every card in the
// battle pool (CARD_DEFINITIONS), collapsed one entry per display name. Unit cards the player hasn't
// unlocked yet (no owned Hero Roster instance of that character — bridged via `ownedUnitTypes`) render
// greyed out with a lock badge; buildings/spells have no roster-ownership concept and always show
// unlocked. Lives in the Career hub (peer of Stats/Titles/Achievements) since it's a goals/collection
// page, not an operation on the player's own roster (that's CardScene/"Develop").
//
// Tile layout (redesigned 14.07.2026): the illustration fills the full tile height on the left; the
// card's info (name / type·cost / stat chips) sits in its own separately-drawn panel on the right.
// Tapping an unlocked card's illustration plays a squash-flip (borrowed from CardScene/detail.ts's
// flipDetailPortrait) that swaps the art for the card's story text in place; tapping again flips back.
// The flip is driven by PIXI.Ticker.shared, and the per-tile flipped state lives in `flipped` so it
// survives the full re-renders triggered by async art loads / resizes.

export interface CardCodexCallbacks {
  onBack(): void;
  /** UnitTypes with ≥1 owned Hero Roster card instance — drives the locked/unlocked split. */
  getOwnedUnitTypes(): Set<string>;
  onOpenStats?(): void;
  onOpenTitles?(): void;
  onOpenAchievements?(): void;
  hasClaimableAchievement?: boolean;
}


export class CardCodexScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly landscape: boolean;
  private readonly cb: CardCodexCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  private readonly artHooked = new Set<string>();
  private destroyed = false;

  private layer!: PIXI.Container;
  private scrollY = 0;
  private maxScroll = 0;
  private regionTop = 0;
  /** Scroll viewport rect + indicator handle (redrawn in the drag fast-path). */
  private scrollView: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private scrollbar: PIXI.Graphics | null = null;
  private pointerActive = false;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private dragStartScroll = 0;
  /** Per-tile flip state (keyed by card.nameKey — the dedup key): art (false) ⇄ story text (true). */
  private readonly flipped = new Set<string>();
  /** Active flip animation cleanups, keyed by the same nameKey, so a re-render can cancel in-flight ticks. */
  private readonly flipCleanups = new Map<string, () => void>();

  // Row virtualization (2026-08-12, same fix as BattlePassScene/LeaderboardScene): CARD_DEFINITIONS
  // dedups to a small fixed set today (~16 cards), never a crash risk in practice, but
  // renderCards() had the same missing-viewport-cull shape everything else in this bug class did —
  // every tile's frame/face/info-panel/stat-chips got built unconditionally regardless of scroll
  // position. Unlike DeckBuilderScene/CityScene (which rebuild everything on every scroll-drag
  // frame anyway), this scene's drag/wheel handlers only reposition `layer.y` without a full
  // render() — so virtualizing needs the same Map-based incremental build/destroy BattlePassScene
  // uses, keyed by grid row index; `codexEntries`/`codexGeom` cache the (cheap, content-fixed)
  // measure pass so handleMove/handleWheel can re-run just the build/destroy step on every scroll
  // tick without a full tearDownChildren+rebuild. `faces` inside each built row lets flipTileAt()
  // find a tapped tile's illustration container without capturing a stale reference at hit-creation
  // time (hits are computed once per render() for every unlocked entry — cheap, pure geometry — and
  // only ever fire for on-screen taps, so the looked-up row is guaranteed to be currently built).
  private codexEntries: CodexEntry[] = [];
  private codexGeom: { left: number; top: number; tileW: number; tileH: number; colGap: number; rowGap: number; cols: number } | null = null;
  private readonly tileRows: Map<number, { container: PIXI.Container; faces: Map<number, PIXI.Container> }> = new Map();

  constructor(layout: ILayout, input: InputManager, cb: CardCodexCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.unsubs.push(input.onWheel((x, y, deltaY) => this.handleWheel(x, y, deltaY)));
    this.render();
    void preloadL1CardArtTextures();
  }

  update(): void { /* static — flip animation runs off PIXI.Ticker.shared */ }
  destroy(): void {
    this.destroyed = true;
    this.cancelAllFlips();
    this.unsubs.forEach((u) => u());
    this.tileRows.clear();
    this.container.destroy({ children: true });
  }

  private hasSidebar(): boolean {
    return !!(this.cb.onOpenStats && this.cb.onOpenTitles && this.cb.onOpenAchievements);
  }

  private handleDown(x: number, y: number): void {
    this.pointerActive = true;
    this.dragging = false;
    this.downX = x; this.downY = y;
    this.dragStartScroll = this.scrollY;
  }

  private handleMove(x: number, y: number): void {
    if (!this.pointerActive || this.maxScroll <= 0) return;
    if (!this.dragging && Math.hypot(x - this.downX, y - this.downY) > 8) this.dragging = true;
    if (!this.dragging) return;
    const next = Math.max(0, Math.min(this.dragStartScroll + (this.downY - y), this.maxScroll));
    if (next !== this.scrollY) {
      this.scrollY = next;
      this.layer.y = -this.scrollY;
      if (this.scrollbar) { this.scrollbar.destroy(); this.scrollbar = null; }
      this.scrollbar = drawScrollIndicator(this.container, this.scrollView, this.scrollY, this.maxScroll);
      this.updateVisibleTiles();
    }
  }

  /** Desktop mouse-wheel scroll over the card grid (browser only — see wheelScroll.ts). */
  private handleWheel(x: number, y: number, deltaY: number): void {
    if (x < this.scrollView.x || x > this.scrollView.x + this.scrollView.w) return;
    const next = wheelScrollY(this.scrollView.y, this.scrollView.y + this.scrollView.h, y, deltaY, this.scrollY, this.maxScroll);
    if (next === null) return;
    this.scrollY = next;
    this.layer.y = -this.scrollY;
    if (this.scrollbar) { this.scrollbar.destroy(); this.scrollbar = null; }
    this.scrollbar = drawScrollIndicator(this.container, this.scrollView, this.scrollY, this.maxScroll);
    this.updateVisibleTiles();
  }

  private handleUp(x: number, y: number): void {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (this.dragging) { this.dragging = false; return; }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (hit.scroll && y < this.regionTop) continue;
      const py = hit.scroll ? y + this.scrollY : y;
      if (x >= r.x && x <= r.x + r.w && py >= r.y && py <= r.y + r.h) { runHit(hit); return; }
    }
  }

  private render(): void {
    if (this.destroyed) return;
    // A re-render rebuilds every tile's faceLayer from scratch; cancel any in-flight flip tick first so
    // it can't keep mutating a now-detached container. Settled flip state is preserved in `flipped`.
    this.cancelAllFlips();
    tearDownChildren(this.container);
    this.hits = [];
    this.tileRows.clear(); // rows already destroyed by tearDownChildren above; just drop refs
    const { w, h } = this;
    const hasSidebar = this.hasSidebar();

    const railX = this.landscape && hasSidebar ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('codexbg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    // Same `rosterIcon` the Career strip's Codex tab uses (CareerTabs.ts) — the codex is a card
    // compendium, so the page title and the tab that opens it show the same picture.
    const hdr = drawSceneHeader(this.container, w, h, t('collection.title'), { icon: 'rosterIcon' });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, sound: 'sfx.ui.back', fn: () => this.cb.onBack() });

    if (hasSidebar) {
      const sidebarTop = tbH + Math.round(h * 0.02);
      const { hits } = drawCareerTabs(this.container, w, h, this.landscape, sidebarTop, 'codex', {
        onOpenStats: this.cb.onOpenStats!,
        onOpenTitles: this.cb.onOpenTitles!,
        onOpenAchievements: this.cb.onOpenAchievements!,
        onOpenCodex: () => {},
        hasClaimableAchievement: this.cb.hasClaimableAchievement,
      } as CareerNavCallbacks);
      this.hits.push(...hits);
    }

    // Portrait's Career peer strip is a bottom nav bar (§18), not a left rail — content no longer
    // reserves width for it (falls back to the same flat margin as "no sidebar"), and the scroll
    // viewport/clip stops `bottomNavH` short of the screen bottom instead so scrolled cards never
    // slide in behind the bar.
    //
    // Portrait's own margin (below) is a centred 90%-wide column — the same convention LobbyScene
    // uses for its portrait content (build.ts's `fullContentW`) — rather than landscape's flat
    // left/right margins, which read as too narrow once there's no rail eating into the width (09.08.2026).
    const fullContentW = Math.round(w * 0.9);
    const contentX = this.landscape
      ? (hasSidebar ? sidebarNavW(w, h, true) + Math.round(w * 0.025) : Math.round(w * 0.06))
      : Math.round((w - fullContentW) / 2);
    const contentTop = tbH + Math.round(h * 0.02);
    const bottomBarH = !this.landscape && hasSidebar ? bottomNavH(h) : 0;
    const viewBottom = h - bottomBarH;
    this.regionTop = contentTop;
    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff).drawRect(contentX, contentTop, w - contentX, viewBottom - contentTop).endFill();
    this.container.addChild(clip);
    const layer = new PIXI.Container();
    layer.mask = clip;
    this.container.addChild(layer);
    this.layer = layer;

    const avail = this.landscape ? w - contentX - Math.round(w * 0.03) : fullContentW;
    const bottom = this.measureCodex(contentX, contentTop, avail);

    const bottomPad = Math.round(h * 0.03);
    this.maxScroll = Math.max(0, bottom + bottomPad - viewBottom);
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll));
    layer.y = -this.scrollY;

    this.scrollView = { x: contentX, y: contentTop, w: w - contentX, h: viewBottom - contentTop };
    this.scrollbar = drawScrollIndicator(this.container, this.scrollView, this.scrollY, this.maxScroll);
    this.updateVisibleTiles();
    this.hits.push(...this.computeTileHits());
  }

  // ── Cards codex ────────────────────────────────────────────────────────────────

  /**
   * Measure pass only — computes `codexEntries`/`codexGeom` (cached for updateVisibleTiles() and
   * every subsequent scroll tick) and returns the total content height. Builds nothing.
   */
  private measureCodex(left: number, top: number, avail: number): number {
    const { w, h } = this;
    const owned = this.cb.getOwnedUnitTypes();

    const seen = new Set<string>();
    const entries: CodexEntry[] = [];
    for (const card of CARD_DEFINITIONS) {
      if (seen.has(card.nameKey)) continue;
      seen.add(card.nameKey);
      const locked = card.cardType === CardType.Unit && card.unitType !== undefined && !owned.has(card.unitType);
      entries.push({ card, locked });
    }

    const cols = 2;
    const gap = Math.round(avail * 0.045);
    const tileW = Math.round((avail - gap) / cols);
    // The tile's illustration is a square spanning the full tile height (see drawCardTile), so tileH
    // doubles as that square's side length. It must read off the design canvas's *short* edge — the
    // same axis sidebarNavW keys off (its own doc comment explains why: designWidth/designHeight swap
    // meaning between orientations, portrait 1080x1920 vs landscape 1920x1080). Landscape's short edge
    // is `h`, so `h * 0.19` was correct there — but portrait's short edge is `w`, and using `h` (the
    // long edge, 1920) instead produced a tile-height square nearly twice too tall, squeezing the
    // right-hand info panel down to a sliver too narrow for a card name to fit (09.08.2026 fix).
    const tileH = Math.round((this.landscape ? h : w) * 0.19);
    const rowGap = Math.round(h * 0.022);

    this.codexEntries = entries;
    this.codexGeom = { left, top, tileW, tileH, colGap: gap, rowGap, cols };

    const rows = Math.ceil(entries.length / cols);
    return rows > 0 ? top + rows * tileH + (rows - 1) * rowGap : top;
  }

  /**
   * Builds/destroys tile-row visuals so only rows within one viewport of the visible band actually
   * exist as PIXI DisplayObjects — see the `tileRows` field doc for why. Called once at the end of
   * render() and again on every scroll tick (handleMove/handleWheel).
   */
  private updateVisibleTiles(): void {
    const geom = this.codexGeom;
    if (!geom) return;
    const { left, top, tileW, tileH, colGap, rowGap, cols } = geom;
    const stride = tileH + rowGap;
    const viewH = this.scrollView.h;
    const buffer = viewH * 0.5;
    // rowY below is `top`-relative (absolute content-space, same as `layer`'s children — layer.y
    // is set to `-scrollY`, NOT `top - scrollY`), so the visible screen band [top, top+viewH] in
    // content-space is [top + scrollY, top + scrollY + viewH] — offset by `top`, not just scrollY.
    // (Caught by a unit test forcing a tiny synthetic viewport — real screen sizes have generous
    // enough buffer margins that this offset error stayed masked in practice.)
    const viewTop = top + this.scrollY - buffer;
    const viewBottom = top + this.scrollY + viewH + buffer;
    const rows = Math.ceil(this.codexEntries.length / cols);
    const needed = new Set<number>();
    for (let r = 0; r < rows; r++) {
      const rowY = top + r * stride;
      if (rowY + tileH < viewTop || rowY > viewBottom) continue;
      needed.add(r);
      if (!this.tileRows.has(r)) {
        const rowC = new PIXI.Container();
        rowC.y = rowY;
        const faces = new Map<number, PIXI.Container>();
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const entry = this.codexEntries[idx];
          if (!entry) continue;
          const x = left + c * (tileW + colGap);
          const face = drawCardTile(entry, x, 0, tileW, tileH, rowC, this.flipped, this.artHooked, () => this.render());
          if (face) faces.set(c, face);
        }
        this.layer.addChild(rowC);
        this.tileRows.set(r, { container: rowC, faces });
      }
    }
    for (const [r, row] of this.tileRows) {
      if (needed.has(r)) continue;
      row.container.destroy({ children: true });
      this.tileRows.delete(r);
    }
  }

  /**
   * Flip-tap hit rects for every unlocked entry, computed unconditionally from geometry alone (no
   * PIXI objects touched — cheap, mirrors BattlePassScene's scrollCellDefs). A hit can only ever
   * fire for an on-screen tap, and anything on-screen is guaranteed built by updateVisibleTiles()'s
   * buffer margin, so flipTileAt() looking up the row from `tileRows` at call time is always safe.
   */
  private computeTileHits(): Hit[] {
    const geom = this.codexGeom;
    if (!geom) return [];
    const { left, top, tileW, tileH, colGap, rowGap, cols } = geom;
    const stride = tileH + rowGap;
    const hits: Hit[] = [];
    this.codexEntries.forEach((entry, i) => {
      if (entry.locked) return;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = left + col * (tileW + colGap);
      const y = top + row * stride;
      hits.push({ scroll: true, rect: { x, y, w: tileH, h: tileH }, fn: () => this.flipTileAt(i) });
    });
    return hits;
  }

  private flipTileAt(i: number): void {
    const geom = this.codexGeom;
    const entry = this.codexEntries[i];
    if (!geom || !entry || entry.locked) return;
    const row = Math.floor(i / geom.cols);
    const col = i % geom.cols;
    const face = this.tileRows.get(row)?.faces.get(col);
    if (!face) return; // scrolled away between tap-down and tap-up; no-op
    const art = cardArtUrl(entry.card);
    const story = storyText(entry.card);
    this.flipTile(entry.card.nameKey, face, codexFaceBox(geom.tileH), entry.card, art, story);
  }

  /** Squash-flip a tile's illustration (scaleX 1→0→1, swapping art⇄story at the midpoint) via PIXI.Ticker.shared. */
  private flipTile(key: string, container: PIXI.Container, box: number, card: CardDefinition, art: string | null, story: string): void {
    this.cancelFlip(key);
    const DUR_MS = 260;
    let elapsed = 0;
    let swapped = false;
    const tick = (): void => {
      elapsed += PIXI.Ticker.shared.deltaMS;
      const p = Math.min(1, elapsed / DUR_MS);
      if (!swapped && p >= 0.5) {
        swapped = true;
        if (this.flipped.has(key)) this.flipped.delete(key); else this.flipped.add(key);
        drawTileFace(container, box, card, art, story, this.flipped.has(key), this.artHooked, () => this.render());
      }
      container.scale.x = Math.max(0.02, p < 0.5 ? 1 - p / 0.5 : (p - 0.5) / 0.5);
      if (p >= 1) {
        container.scale.x = 1;
        this.cancelFlip(key);
      }
    };
    this.flipCleanups.set(key, () => PIXI.Ticker.shared.remove(tick));
    PIXI.Ticker.shared.add(tick);
  }

  private cancelFlip(key: string): void {
    const c = this.flipCleanups.get(key);
    if (c) { c(); this.flipCleanups.delete(key); }
  }

  private cancelAllFlips(): void {
    this.flipCleanups.forEach((c) => c());
    this.flipCleanups.clear();
  }
}
