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
import { wheelScrollY } from '../ui/wheelScroll';

// ── LeaderboardScene — global ladder leaderboard (SE-6) ─────────────────────────
//
// Entry: StatsScene ladder section "Leaderboard" button (onOpenLeaderboard).
// Displays: current season Top-100 (ELO descending), drag-scrollable, with the
// caller's own rank pinned under the season label (even when outside the Top-100).
// Data: GET /leaderboard (JWT, driven by the loadLeaderboard callback).

/**
 * Row column geometry, split out as a pure function so it can be tested without a renderer.
 *
 * Why this exists (2026-08-16, TITLE_DESIGN §6 note): the row used to derive its **font sizes**
 * from `rowH` (which tracks screen *height*) while placing its **columns** at fractions of `w`
 * (screen *width*). Landscape is ~16:9 so nothing showed; portrait is ~1:2, so the height-driven
 * type ran far wider than the width-driven grid — measured against real `monospace` metrics, a row
 * with the default `Player1234` name and any equipped title pushed the title label 58px (zh) to
 * 182px (de `Rangliste`) into the rank-tier column, in every locale, on every portrait phone, and
 * worse on taller ones.
 *
 * Portrait now gives each row two lines (name on top; title / tier / ELO beneath), which is what
 * actually buys the space back. The single-line landscape form is unchanged. Both paths hand the
 * name+title block a hard right boundary and clamp into it via {@link fitNameAndTitle}, so an
 * unusually long display name cannot reintroduce the collision — worth having, since no
 * server-side length cap on `displayName` was found.
 */
export interface RowGeom {
  twoLine: boolean;
  rankX: number; rankCY: number; rankFs: number; medalSize: number;
  nameX: number; nameCY: number; nameFs: number;
  titleCY: number; titleFs: number;
  /** Right boundary the name+title block must not cross (the tier column's left edge). */
  contentRight: number;
  tierCX: number; tierCY: number; tierFs: number;
  eloRightX: number; eloCY: number; eloFs: number;
}

export function leaderboardRowGeom(w: number, rowH: number, twoLine: boolean): RowGeom {
  const rankX = Math.round(w * 0.03);
  const nameX = Math.round(w * 0.18);
  const eloRightX = w - Math.round(w * 0.03);

  if (!twoLine) {
    const tierFs = snapFont(Math.round(rowH * 0.38));
    const tierCX = w * 0.68;
    return {
      twoLine: false,
      rankX, rankCY: rowH / 2, rankFs: snapFont(Math.round(rowH * 0.5)), medalSize: Math.round(rowH * 0.62),
      nameX, nameCY: rowH / 2, nameFs: snapFont(Math.round(rowH * 0.48)),
      titleCY: rowH / 2, titleFs: snapFont(Math.round(rowH * 0.3)),
      // Half a tier label of clearance: the tier text is centre-anchored on tierCX.
      contentRight: tierCX - tierFs,
      tierCX, tierCY: rowH / 2, tierFs,
      eloRightX, eloCY: rowH / 2, eloFs: snapFont(Math.round(rowH * 0.5)),
    };
  }

  // Portrait: line 1 carries the name, line 2 the title / tier / ELO. Type is sized off rowH as
  // before, but from the *line* share of it rather than the whole row, so the fonts stay in the
  // same visual ballpark as the old single-line row instead of doubling with the height.
  const line1CY = rowH * 0.34;
  const line2CY = rowH * 0.74;
  const tierFs = snapFont(Math.round(rowH * 0.16));
  const tierCX = w * 0.62;
  return {
    twoLine: true,
    rankX, rankCY: rowH / 2, rankFs: snapFont(Math.round(rowH * 0.26)), medalSize: Math.round(rowH * 0.42),
    nameX, nameCY: line1CY, nameFs: snapFont(Math.round(rowH * 0.23)),
    titleCY: line2CY, titleFs: snapFont(Math.round(rowH * 0.16)),
    contentRight: tierCX - tierFs,
    tierCX, tierCY: line2CY, tierFs,
    eloRightX, eloCY: line2CY, eloFs: snapFont(Math.round(rowH * 0.22)),
  };
}

/**
 * Fit a measured name and title into `avail` px, returning the scale to apply to each and where
 * the title starts. Takes measured widths rather than strings so it stays renderer-free.
 *
 * When both fit, nothing is scaled — the common case must be pixel-identical to no clamping at
 * all. When they do not, the title is capped at a minority share of the space (the name is the
 * identifying field and gets the remainder) and each is scaled down to its budget, the same
 * shrink-to-fit TitlesScene already uses for its own overlong labels.
 */
export function fitNameAndTitle(
  nameW: number, titleW: number, avail: number, gap: number,
): { nameScale: number; titleScale: number; titleX: number } {
  if (nameW + gap + titleW <= avail) {
    return { nameScale: 1, titleScale: 1, titleX: nameW + gap };
  }
  const titleBudget = Math.max(0, Math.min(titleW, avail * 0.45));
  const nameBudget = Math.max(0, avail - gap - titleBudget);
  const nameScale = nameW > 0 ? Math.min(1, nameBudget / nameW) : 1;
  const titleScale = titleW > 0 ? Math.min(1, titleBudget / titleW) : 1;
  return { nameScale, titleScale, titleX: nameW * nameScale + gap };
}

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
  private landscape = true;

  constructor(layout: ILayout, input: InputManager, cb: LeaderboardCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.onPointerDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.onPointerMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.onPointerUp(x, y)));
    this.unsubs.push(input.onWheel((_x, y, deltaY) => this.onWheel(y, deltaY)));
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

  /** Mouse-wheel scroll over the ranking list (browser only, see InputManager.onWheel). Uses the same
   *  cheap reposition path as drag-scroll (updateScrollPosition), not a full render(). */
  private onWheel(y: number, deltaY: number): void {
    const next = wheelScrollY(this.listTop, this.listTop + this.listH, y, deltaY, this.scrollY, this.scrollMax);
    if (next !== null) { this.scrollY = next; this.updateScrollPosition(); }
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
    // Portrait rows carry two lines (see leaderboardRowGeom), so they need the extra height. The
    // scroll plumbing is all derived from this.rowH, so it follows automatically.
    const rowH = Math.round(h * (this.landscape ? 0.065 : 0.095));
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

    const g = leaderboardRowGeom(w, rowH, !this.landscape);

    // Top-3: a rank medal tinted gold / silver / bronze; below that, plain "#N" text.
    if (isTop3) {
      const medalColor = e.rank === 1 ? 0xf0c040 : e.rank === 2 ? 0xc2c6cc : 0xcd8a4b;
      const medal = buildIcon('medal', g.medalSize, medalColor);
      medal.x = x + g.rankX; medal.y = y + g.rankCY - g.medalSize / 2;
      parent.addChild(medal);
    } else {
      const rankLbl = txt(`#${e.rank}`, g.rankFs, C.mid);
      rankLbl.anchor.set(0, 0.5); rankLbl.x = x + g.rankX; rankLbl.y = y + g.rankCY;
      parent.addChild(rankLbl);
    }

    const nameLbl = txt(e.displayName || `#${e.publicId}`, g.nameFs, C.dark);
    nameLbl.anchor.set(0, 0.5); nameLbl.x = x + g.nameX; nameLbl.y = y + g.nameCY;
    parent.addChild(nameLbl);

    let titleLbl: PIXI.Text | null = null;
    if (e.equippedTitle) {
      const keys = getTitleKeys(e.equippedTitle);
      const tLabel = keys
        ? (t(keys.shortKey as import('../i18n').TranslationKey) || formatLadderTitle(e.equippedTitle))
        : formatLadderTitle(e.equippedTitle);
      titleLbl = txt(`「${tLabel}」`, g.titleFs, C.mid);
      titleLbl.anchor.set(0, 0.5); titleLbl.y = y + g.titleCY;
      parent.addChild(titleLbl);
    }

    // Two-line rows give the name the whole of line 1 and the title the start of line 2, so the two
    // never compete; single-line rows share one span. Either way the block is clamped to
    // `contentRight` so a long name can never push the title into the tier column.
    const gap = 4;
    if (g.twoLine) {
      const nameAvail = g.contentRight - g.nameX;
      if (nameLbl.width > nameAvail) nameLbl.scale.set(nameAvail / nameLbl.width);
      if (titleLbl) {
        titleLbl.x = x + g.nameX;
        const titleAvail = g.contentRight - g.nameX;
        if (titleLbl.width > titleAvail) titleLbl.scale.set(titleAvail / titleLbl.width);
      }
    } else {
      const fit = fitNameAndTitle(nameLbl.width, titleLbl?.width ?? 0, g.contentRight - g.nameX, gap);
      if (fit.nameScale < 1) nameLbl.scale.set(fit.nameScale);
      if (titleLbl) {
        if (fit.titleScale < 1) titleLbl.scale.set(fit.titleScale);
        titleLbl.x = x + g.nameX + fit.titleX;
      }
    }

    const pvpRankLbl = txt(t(('rank.' + e.pvpRank) as import('../i18n').TranslationKey), g.tierFs, C.mid);
    pvpRankLbl.anchor.set(0.5, 0.5); pvpRankLbl.x = x + g.tierCX; pvpRankLbl.y = y + g.tierCY;
    parent.addChild(pvpRankLbl);

    const eloLbl = txt(String(e.elo), g.eloFs, isTop3 ? C.gold : C.dark, isTop3);
    eloLbl.anchor.set(1, 0.5); eloLbl.x = x + g.eloRightX; eloLbl.y = y + g.eloCY;
    parent.addChild(eloLbl);
  }
}
