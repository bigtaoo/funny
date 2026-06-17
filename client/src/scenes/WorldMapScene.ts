// WorldMapScene — SLG 大世界地图场景（S8）
// 300×300 网格，视口裁剪 + 拖拽平移。
// 每帧只渲染可见窗口内的方格，瓦片数据按需拉取 + 缓存。
//
// 交互逻辑：
//   - 拖拽平移（right-drag，移动 > 8px 后取消点击）
//   - 点击空格 → 根据玩家状态弹出「建立主城」或「占领」确认
//   - 点击己方格 → 弹出「放弃 / 出征」菜单
//   - 底部工具栏：兵力 / 领地 / 资源；「家族」「拍卖」快捷键

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../render/sketchUi';
import type { WorldApiClient, WorldTileView, PlayerWorldView, MarchView } from '../net/WorldApiClient';
import { WorldApiError } from '../net/WorldApiClient';

// ── Public callbacks ────────────────────────────────────────────────────────

export interface WorldMapCallbacks {
  onBack(): void;
  onOpenFamily(): void;
  onOpenAuction(): void;
  worldApi: WorldApiClient;
  worldId: string;
  playerName: string;
}

// ── Tile styling ─────────────────────────────────────────────────────────────

const TILE_COLORS: Record<string, number> = {
  plains:      0xf5f0e8,
  mountain:    0xc8c0b0,
  forest:      0xb8d4a0,
  water:       0xa8cce0,
  resource:    0xd4e8a0,
  center:      0xffe88a,
  familyKeep:  0xffd060,
};

const RES_COLORS: Record<string, number> = {
  food:  0xa8d870,
  wood:  0x90b860,
  iron:  0xa0b8c8,
};

function tileColor(tile: WorldTileView, isMine: boolean): number {
  if (isMine) return 0x8ab4e8;        // ink blue tint
  if (tile.occupied) return 0xf0a0a0; // ink red tint (enemy)
  if (tile.type === 'center') return TILE_COLORS.center!;
  if (tile.type === 'familyKeep') return TILE_COLORS.familyKeep!;
  if (tile.resType) return RES_COLORS[tile.resType] ?? TILE_COLORS.resource!;
  if (tile.type === 'mountain') return TILE_COLORS.mountain!;
  if (tile.type === 'forest') return TILE_COLORS.forest!;
  if (tile.type === 'water') return TILE_COLORS.water!;
  return TILE_COLORS.plains!;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAP_SIZE = 300;
const TILE_PX  = 20;   // logical pixels per tile when fully zoomed out
const HUD_H    = 80;   // bottom HUD bar height
const MARGIN   = 4;    // margin inside modal
const CONFIRM_H = 140;

// ── Scene ─────────────────────────────────────────────────────────────────────

export class WorldMapScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: WorldMapCallbacks;

  // Pan state (world-space pixel offset)
  private panX = 0;
  private panY = 0;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragging = false;
  private dragMoved = false;

  // Tile data cache
  private tileCache: Map<string, WorldTileView> = new Map();
  private me: PlayerWorldView | null = null;
  private marches: MarchView[] = [];

  // Graphics layers
  private mapGfx!: PIXI.Graphics;
  private overlayGfx!: PIXI.Graphics;
  private hudLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;

  // Selected tile
  private selectedTile: { x: number; y: number } | null = null;

  // Toast
  private toastTimer = 0;
  private destroyed = false;

  // March poll interval
  private marchPoll: ReturnType<typeof setInterval> | null = null;

  constructor(layout: ILayout, _input: InputManager, cb: WorldMapCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.container = new PIXI.Container();
    this.build();
    this.loadData();

    // Center map on join initially; will be overridden once we know base location
    this.centerAt(Math.floor(MAP_SIZE / 2), Math.floor(MAP_SIZE / 2));

    this.marchPoll = setInterval(() => { if (!this.destroyed) this.refreshMarches(); }, 5000);
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private build(): void {
    const { w, h } = this;

    // Paper background
    const bg = buildPaperBackground('worldmap', w, h);
    this.container.addChild(bg);

    // Map area (clip to above-HUD area)
    const mapClip = new PIXI.Container();
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(0, 0, w, h - HUD_H).endFill();
    mapClip.mask = mask;
    mapClip.addChild(mask);
    this.container.addChild(mapClip);

    this.mapGfx = new PIXI.Graphics();
    mapClip.addChild(this.mapGfx);

    this.overlayGfx = new PIXI.Graphics();
    mapClip.addChild(this.overlayGfx);

    // HUD bar
    this.hudLayer = new PIXI.Container();
    this.container.addChild(this.hudLayer);

    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);

    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);

    this.renderHud();
    this.renderMap();
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  private async loadData(): Promise<void> {
    if (this.destroyed) return;
    try {
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      if (this.me.mainBaseTile) {
        const [bx, by] = this.parseTileId(this.me.mainBaseTile);
        this.centerAt(bx, by);
      }
      await this.loadMapViewport();
      await this.refreshMarches();
    } catch { /* offline OK */ }
    if (!this.destroyed) { this.renderMap(); this.renderHud(); }
  }

  private parseTileId(tileId: string): [number, number] {
    const [xs, ys] = tileId.split(':');
    return [Number(xs) || 0, Number(ys) || 0];
  }

  private async loadMapViewport(): Promise<void> {
    if (this.destroyed) return;
    const { cx, cy, r } = this.viewportCenter();
    try {
      const map = await this.cb.worldApi.getMap(this.cb.worldId, cx, cy, r);
      for (const tile of map.tiles) {
        this.tileCache.set(`${tile.x}:${tile.y}`, tile);
      }
    } catch { /* offline */ }
  }

  private async refreshMarches(): Promise<void> {
    if (this.destroyed) return;
    try {
      this.marches = await this.cb.worldApi.getMarches(this.cb.worldId);
      if (!this.destroyed) this.renderHud();
    } catch { /* offline */ }
  }

  /** Returns the tile coordinate of the viewport center + a radius to fetch. */
  private viewportCenter(): { cx: number; cy: number; r: number } {
    const cx = Math.floor(-this.panX / TILE_PX + this.w / 2 / TILE_PX);
    const cy = Math.floor(-this.panY / TILE_PX + (this.h - HUD_H) / 2 / TILE_PX);
    const r  = Math.ceil(Math.max(this.w, this.h - HUD_H) / TILE_PX / 2) + 4;
    return { cx: Math.max(0, Math.min(MAP_SIZE - 1, cx)), cy: Math.max(0, Math.min(MAP_SIZE - 1, cy)), r };
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private renderMap(): void {
    const g = this.mapGfx;
    g.clear();

    const { w, h } = this;
    const mapH = h - HUD_H;

    // Visible tile range
    const x0 = Math.floor(-this.panX / TILE_PX);
    const y0 = Math.floor(-this.panY / TILE_PX);
    const x1 = Math.ceil((-this.panX + w) / TILE_PX);
    const y1 = Math.ceil((-this.panY + mapH) / TILE_PX);

    for (let ty = Math.max(0, y0); ty <= Math.min(MAP_SIZE - 1, y1); ty++) {
      for (let tx = Math.max(0, x0); tx <= Math.min(MAP_SIZE - 1, x1); tx++) {
        const tile = this.tileCache.get(`${tx}:${ty}`);
        const px = this.panX + tx * TILE_PX;
        const py = this.panY + ty * TILE_PX;

        const isMine = tile?.mine === true;
        const color = tile ? tileColor(tile, isMine) : TILE_COLORS.plains!;

        g.beginFill(color, 0.85);
        g.lineStyle(0.5, 0xccbbaa, 0.5);
        g.drawRect(px, py, TILE_PX - 1, TILE_PX - 1);
        g.endFill();

        // Level label for resource tiles
        if (tile && tile.level > 1) {
          // Draw a small level indicator using a dot
          const dotColor = tile.mine ? 0x2266cc : (tile.occupied ? 0xcc2222 : 0x888888);
          g.beginFill(dotColor, 0.9);
          g.drawCircle(px + TILE_PX - 4, py + 4, 2);
          g.endFill();
        }
      }
    }

    // Selected tile highlight
    if (this.selectedTile) {
      const { x: tx, y: ty } = this.selectedTile;
      const px = this.panX + tx * TILE_PX;
      const py = this.panY + ty * TILE_PX;
      g.lineStyle(2, 0xffcc00, 1);
      g.beginFill(0xffff00, 0.15);
      g.drawRect(px, py, TILE_PX, TILE_PX);
      g.endFill();
    }

    // March arrows (simplified: dot at destination)
    for (const march of this.marches) {
      const [tx2, ty2] = this.parseTileId(march.toTile);
      const px = this.panX + tx2 * TILE_PX + TILE_PX / 2;
      const py = this.panY + ty2 * TILE_PX + TILE_PX / 2;
      const col = march.kind === 'return' ? 0x44cc88 : 0xcc8844;
      g.lineStyle(0);
      g.beginFill(col, 0.9);
      g.drawCircle(px, py, 4);
      g.endFill();
    }
  }

  private renderHud(): void {
    const hud = this.hudLayer;
    hud.removeChildren();
    const { w, h } = this;

    // HUD background
    const panel = sketchPanel(w, HUD_H, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) });
    panel.y = h - HUD_H;
    hud.addChild(panel);

    // Back button
    const backLbl = txt(t('world.back'), 12, C.accent);
    backLbl.x = 10; backLbl.y = h - HUD_H + 10;
    hud.addChild(backLbl);
    this.backRect = { x: 0, y: h - HUD_H, w: 80, h: 30 };

    // Resources row
    if (this.me?.joined) {
      const troops = this.me.troops ?? 0;
      const troopCap = this.me.troopCap ?? 0;
      const territory = this.me.territoryCount ?? 0;
      const infos = [
        `${t('world.troops')} ${troops}/${troopCap}`,
        `${t('world.territory')} ${territory}`,
      ];
      const res = this.me.resources ?? {};
      if (res['food'] !== undefined) infos.push(`🌾${res['food']}`);
      if (res['wood'] !== undefined) infos.push(`🪵${res['wood']}`);
      if (res['iron'] !== undefined) infos.push(`⛏️${res['iron']}`);

      let ix = 90;
      for (const info of infos) {
        const lbl = txt(info, 11, C.dark);
        lbl.x = ix; lbl.y = h - HUD_H + 10;
        hud.addChild(lbl);
        ix += lbl.width + 14;
      }
    }

    // Active marches row
    if (this.marches.length > 0) {
      const now = Date.now();
      const marchTxt = this.marches.map(m => {
        const [tx, ty] = this.parseTileId(m.toTile);
        const remaining = Math.max(0, Math.ceil((m.arriveAt - now) / 1000));
        return `→(${tx},${ty}) ${remaining}s`;
      }).join('  ');
      const lbl = txt(marchTxt, 10, C.red);
      lbl.x = 10; lbl.y = h - HUD_H + 40;
      hud.addChild(lbl);
    }

    // Family / Auction buttons
    const btnW = 70;
    const famBtn = sketchPanel(btnW, 28, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, btnW) });
    famBtn.x = w - btnW * 2 - 14; famBtn.y = h - HUD_H + 26;
    hud.addChild(famBtn);
    const famLbl = txt(t('world.family'), 12, C.light);
    famLbl.anchor.set(0.5, 0.5);
    famLbl.x = famBtn.x + btnW / 2; famLbl.y = famBtn.y + 14;
    hud.addChild(famLbl);
    this.famBtnRect = { x: famBtn.x, y: famBtn.y, w: btnW, h: 28 };

    const aucBtn = sketchPanel(btnW, 28, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, btnW) });
    aucBtn.x = w - btnW - 6; aucBtn.y = h - HUD_H + 26;
    hud.addChild(aucBtn);
    const aucLbl = txt(t('world.auction'), 12, C.light);
    aucLbl.anchor.set(0.5, 0.5);
    aucLbl.x = aucBtn.x + btnW / 2; aucLbl.y = aucBtn.y + 14;
    hud.addChild(aucLbl);
    this.aucBtnRect = { x: aucBtn.x, y: aucBtn.y, w: btnW, h: 28 };
  }

  // ── Hit rects ──────────────────────────────────────────────────────────────

  private backRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private famBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private aucBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };

  // ── Modal ──────────────────────────────────────────────────────────────────

  private showModal(lines: string[], buttons: { label: string; action: () => void }[]): void {
    const ml = this.modalLayer;
    ml.removeChildren();

    const { w, h } = this;
    const mw = Math.min(300, w - 32);
    const mh = CONFIRM_H;
    const mx = (w - mw) / 2;
    const my = (h - HUD_H - mh) / 2;

    // Dimmer
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    let ly = my + 14;
    for (const line of lines) {
      const lbl = txt(line, 13, C.dark);
      lbl.anchor.set(0.5, 0);
      lbl.x = mx + mw / 2; lbl.y = ly;
      ml.addChild(lbl);
      ly += 20;
    }

    this.modalBtnRects = [];
    const btnW = Math.min(100, (mw - MARGIN * (buttons.length + 1)) / buttons.length);
    let bx = mx + (mw - (btnW + MARGIN) * buttons.length + MARGIN) / 2;
    const by = my + mh - 40;
    for (const btn of buttons) {
      const bp = sketchPanel(btnW, 28, { fill: C.dark, border: C.accent, seed: seedFor(bx, by, btnW) });
      bp.x = bx; bp.y = by;
      ml.addChild(bp);
      const bl = txt(btn.label, 12, C.light);
      bl.anchor.set(0.5, 0.5);
      bl.x = bx + btnW / 2; bl.y = by + 14;
      ml.addChild(bl);
      this.modalBtnRects.push({ rect: { x: bx, y: by, w: btnW, h: 28 }, action: btn.action });
      bx += btnW + MARGIN;
    }

    // Close on dim
    this.modalDimRect = { x: 0, y: 0, w: w, h: h };
  }

  private closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalBtnRects = [];
    this.modalDimRect = null;
    this.selectedTile = null;
    this.renderMap();
  }

  private modalBtnRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  private modalDimRect: { x: number; y: number; w: number; h: number } | null = null;

  // ── Toast ──────────────────────────────────────────────────────────────────

  private showToast(msg: string, color: number = C.dark): void {
    const tl = this.toastLayer;
    tl.removeChildren();
    const { w, h } = this;
    const lbl = txt(msg, 13, color);
    lbl.anchor.set(0.5, 0);
    lbl.x = w / 2; lbl.y = h - HUD_H - 50;
    tl.addChild(lbl);
    this.toastTimer = 2500;
  }

  // ── Tile actions ───────────────────────────────────────────────────────────

  private onTileClick(tx: number, ty: number): void {
    if (tx < 0 || ty < 0 || tx >= MAP_SIZE || ty >= MAP_SIZE) return;
    this.selectedTile = { x: tx, y: ty };
    this.renderMap();

    const tile = this.tileCache.get(`${tx}:${ty}`);
    const me = this.me;

    if (!me?.joined) {
      // Not yet in world — offer to join
      this.showModal(
        [t('world.joinTitle'), t('world.confirmJoin')],
        [
          { label: t('world.confirmJoinBtn'), action: () => this.doJoin(tx, ty) },
          { label: '✕', action: () => this.closeModal() },
        ],
      );
      return;
    }

    if (tile?.mine) {
      // My tile — abandon option
      const [bx, by] = me.mainBaseTile ? this.parseTileId(me.mainBaseTile) : [-1, -1];
      const isBase = bx === tx && by === ty;
      if (isBase) {
        this.showToast(t('world.myBase'));
        return;
      }
      this.showModal(
        [t('world.mine'), `(${tx}, ${ty})`],
        [
          { label: t('world.confirmAbandonBtn'), action: () => this.doAbandon(tx, ty) },
          { label: '✕', action: () => this.closeModal() },
        ],
      );
      return;
    }

    if (tile?.occupied) {
      // Enemy tile — march (attack) — not yet implemented for client
      this.showToast(t('world.err.notImpl'), C.red);
      this.closeModal();
      return;
    }

    if (tile?.type === 'center') {
      this.showToast(t('world.center'));
      return;
    }

    // Empty tile — occupy
    const garrison = tile?.garrison;
    const troops = me.troops ?? 0;
    const msg = garrison
      ? `${t('world.confirmOccupy').replace('{troops}', String(garrison))}`
      : t('world.confirmOccupy').replace('{troops}', '1');
    this.showModal(
      [msg, `(${tx}, ${ty})`],
      [
        { label: t('world.confirmOccupyBtn'), action: () => this.doOccupy(tx, ty) },
        { label: '✕', action: () => this.closeModal() },
      ],
    );
    void troops; // checked server-side
  }

  private async doJoin(tx: number, ty: number): Promise<void> {
    this.closeModal();
    try {
      this.me = await this.cb.worldApi.joinWorld(this.cb.worldId, tx, ty);
      this.showToast(t('world.myBase'));
      await this.loadMapViewport();
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doOccupy(tx: number, ty: number): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.occupyTile(this.cb.worldId, tx, ty);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      await this.loadMapViewport();
      this.showToast(t('world.occupied'));
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doAbandon(tx: number, ty: number): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.abandonTile(this.cb.worldId, tx, ty);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      // Remove from cache so it shows as empty
      this.tileCache.delete(`${tx}:${ty}`);
      await this.loadMapViewport();
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      const map: Record<string, string> = {
        WORLD_FULL:    t('world.err.worldFull'),
        NO_TROOPS:     t('world.err.noTroops'),
        TILE_OCCUPIED: t('world.err.occupied'),
        PROTECTED:     t('world.err.protected'),
        OUT_OF_RANGE:  t('world.err.outOfRange'),
        NOT_OWNER:     t('world.err.notOwner'),
        NOT_IMPLEMENTED: t('world.err.notImpl'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Pan ───────────────────────────────────────────────────────────────────

  private centerAt(tx: number, ty: number): void {
    this.panX = this.w / 2 - tx * TILE_PX - TILE_PX / 2;
    this.panY = (this.h - HUD_H) / 2 - ty * TILE_PX - TILE_PX / 2;
    this.clampPan();
  }

  private clampPan(): void {
    const maxX = TILE_PX * 2;
    const maxY = TILE_PX * 2;
    const minX = this.w - MAP_SIZE * TILE_PX - TILE_PX * 2;
    const minY = (this.h - HUD_H) - MAP_SIZE * TILE_PX - TILE_PX * 2;
    this.panX = Math.min(maxX, Math.max(minX, this.panX));
    this.panY = Math.min(maxY, Math.max(minY, this.panY));
  }

  private screenToTile(sx: number, sy: number): { x: number; y: number } {
    return {
      x: Math.floor((sx - this.panX) / TILE_PX),
      y: Math.floor((sy - this.panY) / TILE_PX),
    };
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  handleDown(x: number, y: number): void {
    // Modal buttons
    if (this.modalDimRect) {
      for (const { rect, action } of this.modalBtnRects) {
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          action();
          return;
        }
      }
      this.closeModal();
      return;
    }

    // Back button
    const b = this.backRect;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      this.cb.onBack();
      return;
    }

    // Family / Auction buttons
    const f = this.famBtnRect;
    if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) {
      this.cb.onOpenFamily();
      return;
    }
    const a = this.aucBtnRect;
    if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) {
      this.cb.onOpenAuction();
      return;
    }

    // Begin drag
    if (y < this.h - HUD_H) {
      this.dragging = true;
      this.dragMoved = false;
      this.dragStartX = x - this.panX;
      this.dragStartY = y - this.panY;
    }
  }

  handleMove(x: number, y: number): void {
    if (!this.dragging) return;
    const dx = x - (this.dragStartX + this.panX);
    const dy = y - (this.dragStartY + this.panY);
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) this.dragMoved = true;
    if (this.dragMoved) {
      this.panX = x - this.dragStartX;
      this.panY = y - this.dragStartY;
      this.clampPan();
      this.renderMap();
    }
  }

  handleUp(x: number, y: number): void {
    if (!this.dragging) return;
    const wasDragging = this.dragMoved;
    this.dragging = false;

    if (!wasDragging && y < this.h - HUD_H) {
      const { x: tx, y: ty } = this.screenToTile(x, y);
      this.onTileClick(tx, ty);
    } else if (wasDragging) {
      // Lazy-load new viewport tiles after pan
      void this.loadMapViewport().then(() => {
        if (!this.destroyed) this.renderMap();
      });
    }
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt * 1000;
      if (this.toastTimer <= 0) this.toastLayer.removeChildren();
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.marchPoll) { clearInterval(this.marchPoll); this.marchPoll = null; }
    this.container.destroy({ children: true });
  }
}
