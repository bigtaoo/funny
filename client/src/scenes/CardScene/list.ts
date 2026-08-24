// Roster list view: the [Cards|Equipment] sidebar rail, the header currency/capacity readout, the
// scrolling icon-card grid, and the per-card cell renderer. Depends on DetailPanel (openDetail) —
// see ../CardScene.ts assembly for the construction order.
//
// The grid is INCREMENTAL (2026-08-24, see design/game/CHARACTER_CARDS_DESIGN_IMPL.md §10.5). Three
// invariants make that work, and breaking any one of them puts the per-frame cost back:
//   1. Cells live in `core.gridLayer`, not `core.bodyLayer` — the assembly's render() tears
//      bodyLayer down wholesale, so a cell parked there could never survive a re-render.
//   2. A cell is rebuilt only when its ./rosterCell signature changes. Scrolling moves the
//      cell CONTAINER (one `position.set`) and nothing else; the ~7 text nodes inside it are
//      untouched. Anything a cell draws must therefore appear in the signature, or it will go
//      stale — that is the one maintenance burden this design adds.
//   3. Cell contents are laid out in CELL-LOCAL coordinates (origin at the cell's top-left), which
//      is what lets (2) move a whole cell by setting one position. Hit rects come back from
//      ./rosterCell in local space and are offset into screen space by syncCells.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawHeaderCurrency } from '../../ui/widgets/SceneHeader';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { SaveData, CardInstance } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import { CARD_INV_CAP, CARD_INV_OVERFLOW_BUFFER } from '../../game/meta/cardDefs';
import { CardSceneCore, CARD_CELL_H, CARD_CELL_W_TARGET, sortCards } from './core';
import { renderCardCell, cellSignature, type LocalHit } from './rosterCell';
import type { DetailPanel } from './detail';

// Roster grid packs a fixed 5 cards per row (was auto-fit ~6) with roomier gaps than the shared CELL_GAP.
const ROSTER_COLS = 5;
const ROSTER_GAP = 24;
/** Extra rows kept built above/below the viewport so a drag doesn't build cells at the edge. */
const ROW_MARGIN = 1;

/** Everything about the grid that a scroll step does NOT change — recomputed only by renderList. */
interface GridLayout {
  cols: number;
  cellW: number;
  /** Left edge of column 0, and the width of the whole grid column (for the scroll indicator). */
  left: number;
  avail: number;
  /** Top of the scroll viewport (= headerH) and its height. */
  listY: number;
  availH: number;
  /** Card ids in grid order (row-major), from sortCards. */
  order: string[];
  maxScroll: number;
}

interface CellRec {
  container: PIXI.Container;
  /** {@link cellSignature} value the current contents were drawn from. */
  sig: string;
  hits: LocalHit[];
}

/** List domain (see ../CardScene.ts assembly + ./core.ts for the shared state). */
export class ListPanel {
  /** Materialized cells, keyed by card instance id. Only rows near the viewport are present. */
  private cells = new Map<string, CellRec>();
  /**
   * Per-card cell container + on-screen rect from the last syncCells pass. Kept as plain mirrors of
   * {@link cells} because they are the roster's test seam (see test/ui/cardRoster*.ui.ts) and are
   * read by nothing else.
   */
  private cellContainers = new Map<string, PIXI.Container>();
  private cellRects = new Map<string, { x: number; y: number; w: number }>();

  private layout: GridLayout | null = null;
  /**
   * Length of core.hitRects once the static chrome (back button, tab rail) has registered — the
   * grid owns everything past it, and syncCells truncates back to here before re-emitting, so a
   * scroll step can't accumulate stale cell hits.
   */
  private hitBase = 0;
  /** Scroll indicator from the last draw, so a scroll step can replace just that one Graphics. */
  private indicator: PIXI.Graphics | null = null;

  constructor(
    private readonly core: CardSceneCore,
    private readonly detail: DetailPanel,
  ) {}

  /**
   * Patch the SLG-derived parts of the grid (+ the detail modal, if open) after
   * cb.getCardState()/getTeamName() data changes — e.g. game.ts' goCardRoster's worldsvc fetch
   * resolving after the roster already gave up and opened without it.
   *
   * Deliberately not a full render(): the grid's LAYOUT (card order/position/size) never depends on
   * SLG state, so rebuilding the sidebar/header/scroll position would just be wasted work (and
   * would reset scroll position — a visible regression a full re-render would cause). syncCells
   * picks up the change on its own, because cb.getCardState() feeds the cell signature: the cells
   * whose troop count / team / injury changed are redrawn in place (same container object), the
   * rest are left untouched.
   */
  applyCardState(): void {
    const core = this.core;
    if (core.tab !== 'list' || !this.layout) return;
    this.syncCells();
    // Same fuseRingOpen guard as the assembly's render() modal dispatch (2026-08-03 fix) — a late
    // SLG fetch resolving while the fusion ring is open must not reopen the plain detail popup over it.
    if (core.detailId && !core.fuseRingOpen) this.detail.ensureDetail(core.detailId);
  }

  /**
   * Progression group nav [Cards|Equipment?|Skins] (LOBBY_IA_REDESIGN §15). Landscape draws a
   * vertical rail stacked inside the left notebook-margin gutter (`marginLineX`), below the
   * header; portrait draws it as a bottom nav bar instead (§18). Equipment only appears when
   * injected (openEquipmentBag, server-authoritative → online-only); Cards/Skins are always
   * reachable (including offline, reading the local save mirror).
   */
  renderSidebar(): void {
    const core = this.core;
    const { w, h, landscape } = core;
    const hasEquip = !!core.cb.openEquipmentBag;
    const tabs: HubTab[] = [
      { label: t('roster.title'), active: core.tab === 'list', icon: 'rosterIcon' },
      ...(hasEquip ? [{ label: t('equip.title'), active: false, icon: 'equipIcon' as const }] : []),
      { label: t('roster.tab.skins'), active: core.tab === 'skins', icon: 'skinIcon' },
    ];
    const onSelect = (i: number): void => {
      if (i === 0) { core.tab = 'list'; core.render(); return; }
      if (hasEquip && i === 1) { core.cb.openEquipmentBag?.(); return; }
      core.tab = 'skins'; core.render();
    };
    if (!landscape) {
      const barH = bottomNavH(h);
      const { hits } = drawBottomNavTabs(core.bodyLayer, w, h - barH, barH, tabs, onSelect);
      for (const hit of hits) core.hitRects.push({ rect: hit.rect, action: hit.fn });
      return;
    }
    const sidebarW = sidebarNavW(w, h, true);
    const { hits } = drawSidebarTabs(core.bodyLayer, sidebarW, core.headerH, h, tabs, onSelect);
    for (const hit of hits) core.hitRects.push({ rect: hit.rect, action: hit.fn });
  }

  /**
   * Coin balance + card-capacity readout drawn into the header row itself (same treatment as
   * EquipmentScene's renderHeaderCurrency), so the currency HUD stays visible and aligned with
   * the title when navigating between the card-inventory/equipment peer scenes instead of popping in/out.
   */
  renderHeaderCurrency(): void {
    const core = this.core;
    tearDownChildren(core.headerOverlayLayer);
    const save = core.cb.getSave();
    const count = Object.keys(save.cardInv ?? {}).length;
    const warn = count >= CARD_INV_CAP - CARD_INV_OVERFLOW_BUFFER;
    const full = count >= CARD_INV_CAP;
    // Keep the coin + capacity readout at a compact absolute size (matches EquipmentScene, its
    // [Cards|Equipment] peer) rather than scaling it up with the taller unified header.
    drawHeaderCurrency(core.headerOverlayLayer, core.w, core.headerH, save.wallet.coins, [], {
      text: `${t('roster.capacity').replace('{cur}', String(count)).replace('{cap}', String(CARD_INV_CAP))}`,
      color: full ? C.red : warn ? C.gold : C.mid,
    }, 100 / core.headerH);
  }

  /** Tear the whole grid down — leaving the roster tab (skins) or an emptied inventory. */
  clearGrid(): void {
    for (const rec of this.cells.values()) {
      rec.container.parent?.removeChild(rec.container);
      tearDownChildren(rec.container);
      rec.container.destroy();
    }
    this.cells.clear();
    this.cellContainers.clear();
    this.cellRects.clear();
    this.layout = null;
    this.indicator = null;
    this.core.scrollRedraw = null;
  }

  renderList(): void {
    const core = this.core;
    const { w, h } = core;
    const save = core.cb.getSave();
    const cardState = core.cb.getCardState?.() ?? {};
    const cards = Object.values(save.cardInv ?? {});
    const listY = core.headerH;
    // Portrait's sidebar nav is a bottom bar instead (§18) — reserve bottomNavH off the height
    // (the sidebar always shows, so this always applies in portrait) instead of width.
    const availH = h - listY - 8 - (core.landscape ? 0 : bottomNavH(h));

    if (cards.length === 0) {
      const lbl = txt(t('roster.empty'), FS.heading, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + availH / 2;
      lbl.style.wordWrap = true; lbl.style.wordWrapWidth = w - 32;
      core.bodyLayer.addChild(lbl);
      core.maxScroll = 0;
      this.clearGrid();
      return;
    }

    const sorted = sortCards(cards, save.equipmentInv ?? {}, cardState);
    // Landscape starts the grid right of the sidebar rail; portrait has no side rail (the nav
    // moves to a bottom bar, §18) so the grid instead fills 90% of the screen width, centered —
    // same portrait content-column convention as Lobby's `fullContentW` (LobbyScene/build.ts) —
    // instead of the old notebook-margin-based left offset, which read as an off-center ~9%
    // left / ~2% right gap rather than a deliberately inset column (2026-08-09 fix).
    let left: number, avail: number;
    if (core.landscape) {
      left = sidebarNavW(w, h, true) + ROSTER_GAP;
      avail = w - left - ROSTER_GAP;
    } else {
      avail = Math.round(w * 0.9);
      left = Math.round((w - avail) / 2);
    }
    // Fixed 5-per-row roster (was auto-fit ~6): wider cards, roomier gaps. Clamp down on narrow viewports.
    const cols = Math.max(1, Math.min(ROSTER_COLS, Math.floor((avail + ROSTER_GAP) / (CARD_CELL_W_TARGET + ROSTER_GAP))));
    const cellW = (avail - ROSTER_GAP * (cols - 1)) / cols;
    const rows = Math.ceil(sorted.length / cols);
    const totalH = rows * (CARD_CELL_H + ROSTER_GAP) + ROSTER_GAP;
    // Row windowing below is still cull-only (syncCells builds whole rows, never cropped ones) —
    // peekViewportH's mid-row shrink is for grids that *rely on* a crop to show a genuine partial
    // row; applied here it would just exclude a row that would otherwise render in full within the
    // naive viewport, leaving a dead gap at the bottom that pops the row in only once scrolling
    // pushes it past the shrunk cutoff (2026-07-23 roster bug) — so availH stays the plain reserved
    // height, not a peekViewportH() result. Also the wheel-scroll viewport bounds, see wheelScroll.ts.
    const maxScroll = Math.max(0, totalH - availH);
    core.scrollY = Math.max(0, Math.min(core.scrollY, maxScroll));
    core.scrollRegionTop = listY;
    core.scrollRegionBottom = listY + availH;
    core.maxScroll = maxScroll;

    this.layout = { cols, cellW, left, avail, listY, availH, order: sorted.map((c) => c.id), maxScroll };

    // Cells draw into core.gridLayer, masked to the viewport so a row straddling the availH edge
    // (or one of the ROW_MARGIN rows built just outside it) never paints over the portrait bottom
    // nav bar drawn just below — mirrors EquipmentScene InventoryMixin's identical clip treatment
    // (2026-08-09 fix). The layer and its mask are persistent (core.build); only the rect moves.
    core.gridClip.clear().beginFill(0xffffff).drawRect(0, listY, w, availH).endFill();

    this.hitBase = core.hitRects.length;
    this.syncCells();
    this.drawIndicator();
    // From here on a drag/wheel step only has to re-place the cells and the indicator.
    core.scrollRedraw = () => this.syncScroll();
  }

  /** Scroll fast path (core.scrollRedraw): re-place cells, build any row that just came into range. */
  private syncScroll(): void {
    const core = this.core;
    const layout = this.layout;
    if (!layout) { core.render(); return; }
    core.scrollY = Math.max(0, Math.min(core.scrollY, layout.maxScroll));
    this.syncCells();
    this.drawIndicator();
  }

  private drawIndicator(): void {
    const layout = this.layout;
    if (!layout) return;
    // bodyLayer is torn down by every render(), so the previous indicator may already be dead —
    // only detach one that is still live (and still parented), never resurrect a destroyed node.
    if (this.indicator && !this.indicator.destroyed) {
      this.indicator.parent?.removeChild(this.indicator);
      this.indicator.destroy();
    }
    this.indicator = drawScrollIndicator(
      this.core.bodyLayer,
      { x: layout.left, y: layout.listY, w: layout.avail, h: layout.availH },
      this.core.scrollY, layout.maxScroll,
    );
  }

  /**
   * Bring the materialized cell set in line with the current scrollY: build/rebuild the rows within
   * ROW_MARGIN of the viewport, drop the rest, and re-emit every live cell's hit rects in screen
   * space. Cheap by design — for a plain scroll every cell hits the signature fast path and the
   * whole pass is one `position.set` plus one hit-rect object per cell.
   */
  private syncCells(): void {
    const core = this.core;
    const layout = this.layout;
    if (!layout) return;
    const save = core.cb.getSave();
    const cardState = core.cb.getCardState?.() ?? {};
    const now = Date.now();
    const rowH = CARD_CELL_H + ROSTER_GAP;
    const rowTop = (row: number): number => layout.listY + ROSTER_GAP + row * rowH - core.scrollY;

    const lastRow = Math.ceil(layout.order.length / layout.cols) - 1;
    const firstVisible = Math.floor((core.scrollY - ROSTER_GAP) / rowH);
    const lastVisible = Math.floor((core.scrollY + layout.availH - ROSTER_GAP) / rowH);
    const from = Math.max(0, firstVisible - ROW_MARGIN);
    const to = Math.min(lastRow, lastVisible + ROW_MARGIN);

    core.hitRects.length = this.hitBase;
    const live = new Set<string>();
    for (let row = from; row <= to; row++) {
      const y = rowTop(row);
      for (let col = 0; col < layout.cols; col++) {
        const id = layout.order[row * layout.cols + col];
        if (id === undefined) break;
        const card = save.cardInv?.[id];
        if (!card) continue;
        const x = layout.left + col * (layout.cellW + ROSTER_GAP);
        live.add(id);
        const rec = this.ensureCell(card, cardState[id], now, save);
        rec.container.position.set(x, y);
        this.cellRects.set(id, { x, y, w: layout.cellW });
        for (const hit of rec.hits) {
          core.hitRects.push({
            rect: { x: x + hit.rect.x, y: y + hit.rect.y, w: hit.rect.w, h: hit.rect.h },
            action: hit.action,
            owner: id,
          });
        }
      }
    }

    for (const [id, rec] of [...this.cells]) {
      if (live.has(id)) continue;
      rec.container.parent?.removeChild(rec.container);
      tearDownChildren(rec.container);
      rec.container.destroy();
      this.cells.delete(id);
      this.cellContainers.delete(id);
      this.cellRects.delete(id);
    }
  }

  /**
   * The cell for `card`, drawn if it doesn't exist and redrawn IN PLACE (same container object) if
   * anything it depends on changed. Reusing the container is what lets applyCardState patch a cell
   * without disturbing the rest of the scene graph.
   */
  private ensureCell(
    card: CardInstance, state: CardSLGState | undefined, now: number, save: SaveData,
  ): CellRec {
    const cellW = this.layout!.cellW;
    const sig = cellSignature(this.core, card, state, now, save, cellW);
    const existing = this.cells.get(card.id);
    if (existing && existing.sig === sig) return existing;

    const container = existing?.container ?? new PIXI.Container();
    if (existing) tearDownChildren(container);
    else this.core.gridLayer.addChild(container);
    const hits = renderCardCell(
      this.core, card, container, cellW, state, now, save, (id) => this.detail.openDetail(id),
    );
    const rec: CellRec = { container, sig, hits };
    this.cells.set(card.id, rec);
    this.cellContainers.set(card.id, container);
    return rec;
  }

}
