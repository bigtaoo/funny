import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { buildIcon } from '../render/icons';
import { FS, snapFont } from '../render/fontScale';
import { formatLadderTitle, getTitleKeys } from '../game/meta/titles';

// ── LeaderboardScene — global ladder leaderboard (SE-6) ─────────────────────────
//
// Entry: StatsScene ladder section "Leaderboard" button (onOpenLeaderboard).
// Displays: current season Top-100 (ELO descending), drag-scrollable, with the
// caller's own rank pinned under the season label (even when outside the Top-100).
// Data: GET /leaderboard (JWT, driven by the loadLeaderboard callback).

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  publicId: string;
  elo: number;
  pvpRank: string;
  equippedTitle?: string;
}

/** The caller's own standing (may fall outside the Top-100). */
export interface LeaderboardMe {
  rank: number;
  elo: number;
  pvpRank: string;
}

export interface LeaderboardCallbacks {
  onBack(): void;
  /**
   * Fetch the leaderboard. When absent (offline / not logged in), shows a "log in to view" message.
   */
  loadLeaderboard?(): Promise<{ seasonNo: number; entries: LeaderboardEntry[]; me?: LeaderboardMe }>;
  /** Tap a row to view the profile (reuses ProfilePopup). Absent = rows are not tappable. */
  onOpenProfile?(publicId: string): void;
}

interface Hit { rect: Rect; fn: () => void; }

/** Pointer travel (design px) beyond which a press becomes a drag rather than a tap. */
const DRAG_THRESHOLD = 8;

export class LeaderboardScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly cb: LeaderboardCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async fetchData() re-render can't paint into a torn-down container. */
  private destroyed = false;

  private data: { seasonNo: number; entries: LeaderboardEntry[]; me?: LeaderboardMe } | null = null;
  private loading = false;
  private scrollY = 0;
  private scrollMax = 0;
  private maskGfx?: PIXI.Graphics;

  // Drag-to-scroll state.
  private pointerActive = false;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private dragStartScroll = 0;

  // Scroll-drag fast path (avoids full tearDownChildren+redraw of every row per pointermove):
  // onPointerMove only repositions the already-built listContainer and recomputes hit rects
  // from cached row defs; render() still does the full rebuild for actual data changes.
  private listContainer: PIXI.Container | null = null;
  private listTop = 0;
  private listH = 0;
  private rowDefs: Array<{ y: number; h: number; fn: () => void }> = [];
  private scrollbar: PIXI.Graphics | null = null;

  // Row virtualization: entries can number in the hundreds, and every row draws several
  // PIXI.Text + a hand-sketched panel border — building all of them up front blew past
  // iOS Safari's WebGL texture/GPU-object budget and crashed the tab. Only rows within
  // one viewport-height of the visible area are actually built; the rest exist only as
  // rowDefs (cheap hit-test metadata).
  private entries: LeaderboardEntry[] = [];
  private rowH = 0;
  private rowGap = 0;
  private listW = 0;
  private builtRows: Map<number, PIXI.Container> = new Map();

  constructor(layout: ILayout, input: InputManager, cb: LeaderboardCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.onPointerDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.onPointerMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.onPointerUp(x, y)));
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

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.builtRows.clear();
    this.container.destroy({ children: true });
  }

  private onPointerDown(x: number, y: number): void {
    this.pointerActive = true;
    this.dragging = false;
    this.downX = x;
    this.downY = y;
    this.dragStartScroll = this.scrollY;
  }

  private onPointerMove(x: number, y: number): void {
    if (!this.pointerActive) return;
    if (!this.dragging && Math.hypot(x - this.downX, y - this.downY) > DRAG_THRESHOLD) {
      this.dragging = true;
    }
    if (this.dragging && this.scrollMax > 0) {
      const next = Math.max(0, Math.min(this.scrollMax, this.dragStartScroll + (this.downY - y)));
      if (next !== this.scrollY) { this.scrollY = next; this.updateScrollPosition(); }
    }
  }

  /** Cheap per-move update: reposition the already-built list container and redraw the scroll indicator. */
  private updateScrollPosition(): void {
    if (!this.listContainer) return;
    const sy = Math.min(this.scrollY, this.scrollMax);
    this.listContainer.y = this.listTop - sy;
    if (this.scrollbar) { this.scrollbar.destroy(); this.scrollbar = null; }
    const pad = Math.round(this.w * 0.05);
    this.scrollbar = drawScrollIndicator(this.container, { x: pad, y: this.listTop, w: this.w - pad * 2, h: this.listH }, sy, this.scrollMax);
    this.hits = this.hits.filter((hit) => !this.rowDefs.some((rd) => rd.fn === hit.fn));
    for (const rd of this.rowDefs) {
      const absY = this.listTop - sy + rd.y;
      if (absY + rd.h < this.listTop || absY > this.listTop + this.listH) continue;
      this.hits.push({ rect: { x: pad, y: absY, w: this.w - pad * 2, h: rd.h }, fn: rd.fn });
    }
    this.updateVisibleRows();
  }

  /** Builds/destroys row visuals so only entries within one viewport-height of the visible
   *  area actually exist as PIXI DisplayObjects. See the `builtRows` field comment for why. */
  private updateVisibleRows(): void {
    if (!this.listContainer) return;
    const sy = Math.min(this.scrollY, this.scrollMax);
    const buffer = this.listH * 0.5;
    const viewTop = sy - buffer;
    const viewBottom = sy + this.listH + buffer;
    const stride = this.rowH + this.rowGap;
    const needed = new Set<number>();
    for (let i = 0; i < this.entries.length; i++) {
      const ry = i * stride;
      if (ry + this.rowH < viewTop || ry > viewBottom) continue;
      needed.add(i);
      if (!this.builtRows.has(i)) {
        const rowC = new PIXI.Container();
        rowC.y = ry;
        this.drawRow(rowC, this.entries[i], 0, 0, this.listW, this.rowH, i);
        this.listContainer.addChild(rowC);
        this.builtRows.set(i, rowC);
      }
    }
    for (const [i, rowC] of this.builtRows) {
      if (needed.has(i)) continue;
      rowC.destroy({ children: true });
      this.builtRows.delete(i);
    }
  }

  private onPointerUp(x: number, y: number): void {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (this.dragging) { this.dragging = false; return; }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    this.scrollMax = 0;
    this.listContainer = null;
    this.rowDefs = [];
    this.scrollbar = null; // torn down with the container above; drop the stale ref
    const { w, h } = this;

    this.container.addChild(buildPaperBackground('lbbg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    // ── Title bar ────────────────────────────────────────────────────────────
    const hdr = drawSceneHeader(this.container, w, h, t('leaderboard.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Season subtitle
    if (this.data && this.data.seasonNo > 0) {
      const sub = txt(t('leaderboard.season', { no: String(this.data.seasonNo) }), FS.label, C.gold);
      sub.anchor.set(1, 0.5); sub.x = w - Math.round(w * 0.04); sub.y = tbH / 2;
      this.container.addChild(sub);
    }

    // ── Body ─────────────────────────────────────────────────────────────────
    const pad = Math.round(w * 0.05);
    const bodyY = tbH + Math.round(h * 0.025);
    const bodyH = h - bodyY;

    if (!this.cb.loadLeaderboard) {
      const msg = txt(t('leaderboard.loginRequired'), FS.title, C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = w / 2; msg.y = bodyY + bodyH / 2;
      this.container.addChild(msg);
      return;
    }

    if (this.loading) {
      const msg = txt(t('leaderboard.loading'), FS.title, C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = w / 2; msg.y = bodyY + bodyH / 2;
      this.container.addChild(msg);
      return;
    }

    if (!this.data || this.data.entries.length === 0) {
      const msg = txt(t('leaderboard.empty'), FS.title, C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = w / 2; msg.y = bodyY + bodyH / 2;
      this.container.addChild(msg);
      return;
    }

    const entries = this.data.entries;
    const rowH = Math.round(h * 0.065);
    const rowGap = Math.round(h * 0.008);
    const listW = w - pad * 2;
    this.entries = entries;
    this.rowH = rowH;
    this.rowGap = rowGap;
    this.listW = listW;
    this.builtRows.clear();

    // ── "My rank" line — right-aligned, just below the season label ────────────
    const meText = this.data.me
      ? `${t('leaderboard.myRank', { rank: String(this.data.me.rank) })}   ${this.data.me.elo}`
      : t('leaderboard.myRankNone');
    const meLbl = txt(meText, FS.heading, C.accent, true);
    meLbl.anchor.set(1, 0.5);
    meLbl.x = w - Math.round(w * 0.04);
    meLbl.y = tbH + Math.round(h * 0.028);
    this.container.addChild(meLbl);

    // The scrollable list starts below the "my rank" strip.
    const listTop = tbH + Math.round(h * 0.06);
    const listH = h - listTop;
    this.listTop = listTop;
    this.listH = listH;

    // Scrollable list container
    const listContainer = new PIXI.Container();
    listContainer.x = pad;
    listContainer.y = listTop;

    const totalH = entries.length > 0 ? (entries.length - 1) * (rowH + rowGap) + rowH : 0;
    entries.forEach((e, i) => {
      const ry = i * (rowH + rowGap);
      if (this.cb.onOpenProfile) {
        this.rowDefs.push({ y: ry, h: rowH, fn: () => this.cb.onOpenProfile!(e.publicId) });
      }
    });

    this.scrollMax = Math.max(0, totalH - listH);
    const sy = Math.min(this.scrollY, this.scrollMax);
    listContainer.y = listTop - sy;

    // Mask to clip the scrollable area
    const maskGfx = new PIXI.Graphics();
    maskGfx.beginFill(0xffffff).drawRect(0, listTop, w, listH).endFill();
    this.container.addChild(maskGfx);
    listContainer.mask = maskGfx;

    this.container.addChild(listContainer);
    this.listContainer = listContainer;

    // Hits (absolute coords offset by current scroll) + scroll indicator via the shared fast path.
    this.updateScrollPosition();
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

    // Top-3: a rank medal tinted gold / silver / bronze; below that, plain "#N" text.
    if (isTop3) {
      const medalColor = e.rank === 1 ? 0xf0c040 : e.rank === 2 ? 0xc2c6cc : 0xcd8a4b;
      const medalSz = Math.round(rowH * 0.62);
      const medal = buildIcon('medal', medalSz, medalColor);
      medal.x = x + Math.round(w * 0.03); medal.y = y + rowH / 2 - medalSz / 2;
      parent.addChild(medal);
    } else {
      const rankLbl = txt(`#${e.rank}`, snapFont(Math.round(rowH * 0.5)), C.mid);
      rankLbl.anchor.set(0, 0.5); rankLbl.x = x + Math.round(w * 0.03); rankLbl.y = y + rowH / 2;
      parent.addChild(rankLbl);
    }

    const nameLbl = txt(e.displayName || `#${e.publicId}`, snapFont(Math.round(rowH * 0.48)), C.dark);
    nameLbl.anchor.set(0, 0.5); nameLbl.x = x + Math.round(w * 0.18); nameLbl.y = y + rowH / 2;
    parent.addChild(nameLbl);

    if (e.equippedTitle) {
      const keys = getTitleKeys(e.equippedTitle);
      const tLabel = keys
        ? (t(keys.shortKey as import('../i18n').TranslationKey) || formatLadderTitle(e.equippedTitle))
        : formatLadderTitle(e.equippedTitle);
      const titleLbl = txt(`「${tLabel}」`, snapFont(Math.round(rowH * 0.3)), C.mid);
      titleLbl.anchor.set(0, 0.5); titleLbl.x = nameLbl.x + nameLbl.width + 4; titleLbl.y = y + rowH / 2;
      parent.addChild(titleLbl);
    }

    const pvpRankLbl = txt(e.pvpRank, snapFont(Math.round(rowH * 0.38)), C.mid);
    pvpRankLbl.anchor.set(0.5, 0.5); pvpRankLbl.x = x + Math.round(w * 0.68); pvpRankLbl.y = y + rowH / 2;
    parent.addChild(pvpRankLbl);

    const eloLbl = txt(String(e.elo), snapFont(Math.round(rowH * 0.5)), isTop3 ? C.gold : C.dark, isTop3);
    eloLbl.anchor.set(1, 0.5); eloLbl.x = x + w - Math.round(w * 0.03); eloLbl.y = y + rowH / 2;
    parent.addChild(eloLbl);
  }
}
