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
import type { WorldApiClient, WorldTileView, PlayerWorldView, MarchView, NationView, SeasonView, SlgShopItemView } from '../net/WorldApiClient';
import { WorldApiError } from '../net/WorldApiClient';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult } from '../net/proto/transport';

// ── Public callbacks ────────────────────────────────────────────────────────

export interface WorldMapCallbacks {
  onBack(): void;
  onOpenFamily(): void;
  onOpenAuction(): void;
  /**
   * Spectate a finished siege (G3-2c): app fetches the replay (seed + both armies)
   * and runs it headless in spectator mode — pure play-back, non-authoritative
   * (worldsvc already ran the authoritative engine battle). Either combatant can watch.
   */
  onReplaySiege(siegeId: string): void;
  /**
   * Open the simplified defense editor (C3) for a tile. `tileKey` is 'base' for the
   * main city or the full tileId `{worldId}:{x}:{y}` for an owned territory.
   */
  onOpenDefense(tileKey: string): void;
  /** Open the attack-team manager (G3-2c) — 5 formation templates used when sieging. */
  onOpenTeams(): void;
  worldApi: WorldApiClient;
  worldId: string;
  playerName: string;
  /** current player's accountId — gates capital rename (must own the capital). */
  accountId: string;
  /** live coin balance getter (SaveData.wallet mirror) — shown in the SLG shop. */
  getCoins?: () => number;
}

/** March kinds the deploy dialog can dispatch (occupy/reinforce/attack/sweep). */
type DeployKind = 'occupy' | 'reinforce' | 'attack' | 'sweep';

/** Live-push handle returned by showWorldMap — app forwards NetSession pushes here. */
export interface WorldMapView {
  applyMarchUpdate(m: MarchUpdate): void;
  applyTileUpdate(t: TileUpdate): void;
  applyUnderAttack(u: UnderAttack): void;
  applySiegeResult(s: SiegeResult): void;
}

// ── Tile styling ─────────────────────────────────────────────────────────────
// 配色对齐服务端 TileType（neutral/resource/territory/familyKeep/center/base/
// obstacle/gate）。敌我色遵循「敌蓝我红」（project_art_direction）：
// 我方领地/主城 = 红墨，敌方 = 蓝墨。首府由 getNations() 叠加星标渲染（非瓦片类型）。

// 地形底色（未被占领时）。
const TERRAIN_COLORS: Record<string, number> = {
  neutral:    0xf5f0e8, // 纸底空地
  resource:   0xd4e8a0, // 资源格（resType 进一步细分）
  familyKeep: 0xffd060, // 战略要点 / 险地
  center:     0xffe88a, // 世界中心
  obstacle:   0x9a9488, // 阻挡地形（山脉/河流，不可通行）
  gate:       0xc8a878, // 关隘/桥（通道）
  territory:  0xf5f0e8, // 兜底（territory 一定被 own/enemy 覆盖）
  base:       0xf5f0e8,
};

const RES_COLORS: Record<string, number> = {
  food:  0xa8d870,
  wood:  0x90b860,
  iron:  0xa0b8c8,
};

const MINE_TINT      = 0xe69090; // 我方领地（红墨淡）
const MINE_BASE_TINT = 0xcc3333; // 我方主城（红墨浓）
const ENEMY_TINT     = 0x90a8e6; // 敌方领地（蓝墨淡）
const ENEMY_BASE_TINT= 0x4477cc; // 敌方主城（蓝墨浓）

function tileColor(tile: WorldTileView): number {
  if (tile.mine)     return tile.type === 'base' ? MINE_BASE_TINT : MINE_TINT;
  if (tile.occupied) return tile.type === 'base' ? ENEMY_BASE_TINT : ENEMY_TINT;
  if (tile.type === 'resource' && tile.resType) {
    return RES_COLORS[tile.resType] ?? TERRAIN_COLORS.resource!;
  }
  return TERRAIN_COLORS[tile.type] ?? TERRAIN_COLORS.neutral!;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAP_SIZE = 1500; // 服务端默认 1500×1500；实际从 getSeason 取
const TILE_PX  = 20;   // logical pixels per tile when fully zoomed out
const HUD_H    = 80;   // bottom HUD bar height
const MARGIN   = 4;    // margin inside modal
const CONFIRM_H = 140;

// Train economy mirrors (DRAFT; server @nw/shared is authoritative — these only
// size the client's preview/cost estimates for the C4 panel). Keep in sync with
// shared/slg.ts TROOP_TRAIN_FOOD_COST / TROOP_SPEEDUP_SECS_PER_COIN / *_BATCH_MAX.
const TRAIN_FOOD_PER        = 10;
const TRAIN_SPEEDUP_PER_COIN = 60; // seconds shortened per coin
const TRAIN_BATCH_MAX       = 500;
const TRAIN_PRESETS         = [10, 50];
/** 主动迁城金币花费（display only；server @nw/shared RELOCATE_COST 权威）。 */
const RELOCATE_COST = 500;

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

  // Map bounds (from getSeason; default to server's 1500×1500)
  private mapW = DEFAULT_MAP_SIZE;
  private mapH = DEFAULT_MAP_SIZE;

  // Tile data cache
  private tileCache: Map<string, WorldTileView> = new Map();
  private me: PlayerWorldView | null = null;
  private marches: MarchView[] = [];
  // Nations (10 capitals) — overlaid as star markers + Voronoi-nearest tint hint.
  private nations: NationView[] = [];
  // Season + SLG shop catalog (C5; season also gives map bounds, shop fetched lazily).
  private season: SeasonView | null = null;
  private shopItems: SlgShopItemView[] = [];
  private infoTab: 'nations' | 'season' | 'shop' = 'nations';
  private hiddenInput: HTMLInputElement | null = null;

  // Graphics layers
  private mapGfx!: PIXI.Graphics;
  private overlayGfx!: PIXI.Graphics;
  private hudLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;

  // Selected tile
  private selectedTile: { x: number; y: number } | null = null;

  // Tiles this player launched an attack against this session — used to tell
  // whether an incoming siege_result is ours (attacker → offer replay) or the
  // defender's (just a toast). Keyed by full tileId "x:y:world".
  private myAttackTiles: Set<string> = new Set();

  // Toast
  private toastTimer = 0;
  private destroyed = false;

  // Train/resource panel (C4): when open, re-rendered ~1s for live countdowns.
  private trainPanelOpen = false;
  private panelRepaint = 0;

  // March poll interval
  private marchPoll: ReturnType<typeof setInterval> | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: WorldMapCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.container = new PIXI.Container();
    this.build();
    this.loadData();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));

    // Center map on join initially; will be overridden once we know base location
    this.centerAt(Math.floor(this.mapW / 2), Math.floor(this.mapH / 2));

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
    // Map bounds + nations are world-static; fetch once up front (best-effort).
    try {
      const season = await this.cb.worldApi.getSeason(this.cb.worldId);
      this.season = season;
      if (season.mapW > 0) this.mapW = season.mapW;
      if (season.mapH > 0) this.mapH = season.mapH;
    } catch { /* offline — keep defaults */ }
    try {
      this.nations = await this.cb.worldApi.getNations(this.cb.worldId);
    } catch { /* offline — no nation overlay */ }
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
      if (!this.destroyed) { this.renderHud(); this.renderMap(); }
    } catch { /* offline */ }
  }

  private async refreshMe(): Promise<void> {
    if (this.destroyed) return;
    try {
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      if (!this.destroyed) this.renderHud();
    } catch { /* offline */ }
  }

  /** Returns the tile coordinate of the viewport center + a radius to fetch. */
  private viewportCenter(): { cx: number; cy: number; r: number } {
    const cx = Math.floor(-this.panX / TILE_PX + this.w / 2 / TILE_PX);
    const cy = Math.floor(-this.panY / TILE_PX + (this.h - HUD_H) / 2 / TILE_PX);
    const r  = Math.ceil(Math.max(this.w, this.h - HUD_H) / TILE_PX / 2) + 4;
    return { cx: Math.max(0, Math.min(this.mapW - 1, cx)), cy: Math.max(0, Math.min(this.mapH - 1, cy)), r };
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

    for (let ty = Math.max(0, y0); ty <= Math.min(this.mapH - 1, y1); ty++) {
      for (let tx = Math.max(0, x0); tx <= Math.min(this.mapW - 1, x1); tx++) {
        const tile = this.tileCache.get(`${tx}:${ty}`);
        const px = this.panX + tx * TILE_PX;
        const py = this.panY + ty * TILE_PX;

        const color = tile ? tileColor(tile) : TERRAIN_COLORS.neutral!;

        g.beginFill(color, 0.85);
        g.lineStyle(0.5, 0xccbbaa, 0.5);
        g.drawRect(px, py, TILE_PX - 1, TILE_PX - 1);
        g.endFill();

        // Level label for resource tiles
        if (tile && tile.level > 1) {
          // Draw a small level indicator using a dot
          const dotColor = tile.mine ? 0xcc2222 : (tile.occupied ? 0x2266cc : 0x888888);
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

    // Capital star markers (10 nations) — drawn above tiles so they stay visible.
    for (const n of this.nations) {
      const cx = this.panX + n.x * TILE_PX + TILE_PX / 2;
      const cy = this.panY + n.y * TILE_PX + TILE_PX / 2;
      if (cx < -TILE_PX || cy < -TILE_PX || cx > this.w + TILE_PX || cy > this.h - HUD_H + TILE_PX) continue;
      this.drawStar(g, cx, cy, TILE_PX * 0.7, n.ownerId ? 0xffcc00 : 0xccb890, !!n.ownerId);
    }

    // March arrows (line from→to + dot at destination)
    for (const march of this.marches) {
      const [fx, fy] = this.parseTileId(march.fromTile);
      const [tx2, ty2] = this.parseTileId(march.toTile);
      const fpx = this.panX + fx * TILE_PX + TILE_PX / 2;
      const fpy = this.panY + fy * TILE_PX + TILE_PX / 2;
      const px = this.panX + tx2 * TILE_PX + TILE_PX / 2;
      const py = this.panY + ty2 * TILE_PX + TILE_PX / 2;
      const col = march.kind === 'return' ? 0x44cc88
        : march.kind === 'attack' ? 0xcc3333
        : march.kind === 'reinforce' ? 0x44aacc
        : 0xcc8844;
      g.lineStyle(1.5, col, 0.55);
      g.moveTo(fpx, fpy);
      g.lineTo(px, py);
      g.lineStyle(0);
      g.beginFill(col, 0.9);
      g.drawCircle(px, py, 4);
      g.endFill();
    }
  }

  /** Draw a 5-point star (capital marker). Filled when the nation is owned. */
  private drawStar(g: PIXI.Graphics, cx: number, cy: number, r: number, color: number, filled: boolean): void {
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.45;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    }
    g.lineStyle(1.5, 0x6a5a20, 0.9);
    if (filled) g.beginFill(color, 0.95);
    g.drawPolygon(pts);
    if (filled) g.endFill();
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

    // Active marches list (one row per march, recall button)
    this.marchRowRects = [];
    if (this.marches.length > 0) {
      const now = Date.now();
      const MARCH_ROW_H = 22;
      const ROW_Y0 = h - HUD_H + 40;
      const RECALL_W = 46;
      for (let i = 0; i < this.marches.length; i++) {
        const m = this.marches[i];
        const [tx, ty] = this.parseTileId(m.toTile);
        const remaining = Math.max(0, Math.ceil((m.arriveAt - now) / 1000));
        const kindIcon = m.kind === 'attack' ? '⚔' : m.kind === 'reinforce' ? '🛡' : m.kind === 'return' ? '↩' : '→';
        const rowY = ROW_Y0 + i * MARCH_ROW_H;
        const rowLbl = txt(`${kindIcon}(${tx},${ty}) ${remaining}s`, 10, C.dark);
        rowLbl.x = 10; rowLbl.y = rowY + 3;
        hud.addChild(rowLbl);

        // Recall button (only for non-return marches)
        if (m.kind !== 'return') {
          const recallBtn = sketchPanel(RECALL_W, 18, { fill: C.accent, border: C.red, seed: seedFor(i, 99, RECALL_W) });
          recallBtn.x = 10 + 120; recallBtn.y = rowY + 1;
          hud.addChild(recallBtn);
          const recallLbl = txt(t('world.recall'), 9, C.light);
          recallLbl.anchor.set(0.5, 0.5);
          recallLbl.x = recallBtn.x + RECALL_W / 2; recallLbl.y = recallBtn.y + 9;
          hud.addChild(recallLbl);
          this.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: 10, y: rowY, w: 120, h: MARCH_ROW_H },
            recallRect: { x: recallBtn.x, y: recallBtn.y, w: RECALL_W, h: 18 },
          });
        } else {
          this.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: 10, y: rowY, w: 120, h: MARCH_ROW_H },
            recallRect: null,
          });
        }
      }
    }

    // Train / Family / Auction buttons (right side)
    const btnW = 70;

    // Train button — only meaningful once the player has a base.
    if (this.me?.joined) {
      const trainBtn = sketchPanel(btnW, 28, { fill: C.red, border: C.accent, seed: seedFor(2, 0, btnW) });
      trainBtn.x = w - btnW * 3 - 22; trainBtn.y = h - HUD_H + 26;
      hud.addChild(trainBtn);
      const inQ = (this.me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
      const trainLbl = txt(inQ > 0 ? `${t('world.train')} (${inQ})` : t('world.train'), 12, C.light);
      trainLbl.anchor.set(0.5, 0.5);
      trainLbl.x = trainBtn.x + btnW / 2; trainLbl.y = trainBtn.y + 14;
      hud.addChild(trainLbl);
      this.trainBtnRect = { x: trainBtn.x, y: trainBtn.y, w: btnW, h: 28 };
    } else {
      this.trainBtnRect = { x: 0, y: 0, w: 0, h: 0 };
    }

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

    // World info button — floats top-right over the map (nations / season / shop).
    const infoW = 56, infoH = 26;
    const infoBtn = sketchPanel(infoW, infoH, { fill: C.dark, border: C.accent, seed: seedFor(3, 1, infoW) });
    infoBtn.x = w - infoW - 8; infoBtn.y = 8;
    hud.addChild(infoBtn);
    const infoLbl = txt(t('world.info'), 12, C.light);
    infoLbl.anchor.set(0.5, 0.5);
    infoLbl.x = infoBtn.x + infoW / 2; infoLbl.y = infoBtn.y + infoH / 2;
    hud.addChild(infoLbl);
    this.infoBtnRect = { x: infoBtn.x, y: infoBtn.y, w: infoW, h: infoH };
  }

  // ── Hit rects ──────────────────────────────────────────────────────────────

  private backRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private trainBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private famBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private aucBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private infoBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private marchRowRects: {
    marchId: string; worldId: string; destX: number; destY: number;
    rowRect: { x: number; y: number; w: number; h: number };
    recallRect: { x: number; y: number; w: number; h: number } | null;
  }[] = [];

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
    this.trainPanelOpen = false;
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
    if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) return;
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
      // My tile — reinforce (march from base) + abandon. Base itself: no actions.
      const [bx, by] = me.mainBaseTile ? this.parseTileId(me.mainBaseTile) : [-1, -1];
      const isBase = bx === tx && by === ty;
      if (isBase) {
        // Main city — edit base defense config (C3).
        this.showModal(
          [t('world.myBase'), `(${tx}, ${ty})`],
          [
            { label: t('world.actDefense'), action: () => { this.closeModal(); this.cb.onOpenDefense('base'); } },
            { label: t('world.team.manage'), action: () => { this.closeModal(); this.cb.onOpenTeams(); } },
            { label: '✕', action: () => this.closeModal() },
          ],
        );
        return;
      }
      const tileKey = `${this.cb.worldId}:${tx}:${ty}`;
      this.showModal(
        [t('world.mine'), `(${tx}, ${ty})`],
        [
          { label: t('world.actReinforce'), action: () => this.showDeployDialog(tx, ty, 'reinforce') },
          { label: t('world.actDefense'), action: () => { this.closeModal(); this.cb.onOpenDefense(tileKey); } },
          { label: t('world.actAbandon'), action: () => this.doAbandon(tx, ty) },
          { label: '✕', action: () => this.closeModal() },
        ],
      );
      return;
    }

    if (tile?.occupied) {
      // Enemy tile — siege (attack march from base). Protected tiles can't be hit.
      const ownerLine = tile.ownerName
        ? `${tile.ownerName}${tile.ownerPublicId ? ' #' + tile.ownerPublicId : ''}`
        : (tile.ownerPublicId ? '#' + tile.ownerPublicId : t('world.unknownOwner'));
      const buttons: { label: string; action: () => void }[] = [];
      const protectedNow = (tile.protectedUntil ?? 0) > Date.now();
      if (!protectedNow) {
        buttons.push({ label: t('world.actAttack'), action: () => void this.showAttackTeamPicker(tx, ty) });
      }
      buttons.push({ label: '✕', action: () => this.closeModal() });
      this.showModal([t('world.enemyTile'), ownerLine, `(${tx}, ${ty})`], buttons);
      return;
    }

    if (tile?.type === 'center') {
      this.showToast(t('world.center'));
      return;
    }

    // Neutral tile. NPC garrison present → offer sweep (march). Always offer
    // direct occupy (S8-1, in-range; server rejects out-of-range).
    const garrison = tile?.garrison ?? 0;
    const buttons: { label: string; action: () => void }[] = [
      { label: t('world.actOccupy'), action: () => this.doOccupy(tx, ty) },
    ];
    if (garrison > 0) {
      buttons.push({ label: t('world.actSweep'), action: () => this.showDeployDialog(tx, ty, 'sweep') });
    }
    // 主动迁城（§3.4）：已有主城且目标可落城（非障碍/关隘）→ 花 500 金币把主城迁到此格。
    const relocatable = this.me?.mainBaseTile && tile?.type !== 'obstacle' && tile?.type !== 'gate';
    if (relocatable) {
      buttons.push({ label: t('world.actRelocate'), action: () => this.confirmRelocate(tx, ty) });
    }
    buttons.push({ label: '✕', action: () => this.closeModal() });
    const head = garrison > 0 ? t('world.garrison').replace('{n}', String(garrison)) : t('world.actOccupy');
    this.showModal([head, `(${tx}, ${ty})`], buttons);
  }

  // ── Deploy (派兵数对话框) ──────────────────────────────────────────────────
  // Pick how many troops to send for a march action. Presets ¼ / ½ / all of the
  // available pool. March source is the player's main base. Server enforces the
  // per-kind minimums (occupy/attack need OCCUPY_MIN_TROOPS) → toast on reject.

  private showDeployDialog(tx: number, ty: number, kind: DeployKind): void {
    const me = this.me;
    if (!me?.joined || !me.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    const avail = Math.max(0, Math.floor(me.troops ?? 0));
    const kindLabel = kind === 'attack' ? t('world.actAttack')
      : kind === 'reinforce' ? t('world.actReinforce')
      : kind === 'sweep' ? t('world.actSweep')
      : t('world.actOccupy');
    const send = (qty: number): void => { void this.doMarch(tx, ty, kind, qty); };
    this.showModal(
      [t('world.deployTitle').replace('{avail}', String(avail)), `${kindLabel} → (${tx}, ${ty})`],
      [
        { label: t('world.deployQuarter'), action: () => send(Math.floor(avail / 4)) },
        { label: t('world.deployHalf'), action: () => send(Math.floor(avail / 2)) },
        { label: t('world.deployAll'), action: () => send(avail) },
        { label: '✕', action: () => this.closeModal() },
      ],
    );
  }

  // ── 围攻选队（G3-2c §16.2）────────────────────────────────────────────────
  // 围攻必须挂一支进攻布阵模板（队伍）出征——committed 兵力 = 队伍各单位满血之和，由服务端
  // 推导（覆盖派兵数）。空队伍列表 → 引导去管理队伍。

  private async showAttackTeamPicker(tx: number, ty: number): Promise<void> {
    const me = this.me;
    if (!me?.joined || !me.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    let teams: { id: string; name: string; army: { initialHp?: number }[] }[] = [];
    try {
      teams = await this.cb.worldApi.getTeams(this.cb.worldId);
    } catch { /* offline — treat as empty */ }
    const usable = teams.filter((tm) => tm.army.length > 0);
    const buttons: { label: string; action: () => void }[] = [];
    for (const tm of usable) {
      const committed = tm.army.reduce((s, e) => s + Math.max(0, Math.floor(e.initialHp ?? 0)), 0);
      buttons.push({
        label: `${tm.name} · ${t('world.team.committed').replace('{n}', String(committed))}`,
        action: () => void this.doMarchTeam(tx, ty, tm.id),
      });
    }
    buttons.push({ label: t('world.team.manage'), action: () => this.cb.onOpenTeams() });
    buttons.push({ label: '✕', action: () => this.closeModal() });
    const head = usable.length > 0 ? t('world.team.pickTitle') : t('world.team.noTeams');
    this.showModal([head, `(${tx}, ${ty})`], buttons);
  }

  private async doMarchTeam(tx: number, ty: number, teamId: string): Promise<void> {
    this.closeModal();
    const me = this.me;
    if (!me?.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    const [fx, fy] = this.parseTileId(me.mainBaseTile);
    try {
      // troops=1 占位，服务端按队伍 committed 兵力覆盖（§16.2）。
      const march = await this.cb.worldApi.startMarch(this.cb.worldId, fx, fy, tx, ty, 'attack', 1, teamId);
      this.myAttackTiles.add(march.toTile);
      this.marches = await this.cb.worldApi.getMarches(this.cb.worldId);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      this.showToast(t('world.dispatched'));
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doMarch(tx: number, ty: number, kind: DeployKind, troops: number): Promise<void> {
    this.closeModal();
    const me = this.me;
    if (!me?.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    if (troops < 1) { this.showToast(t('world.err.noTroops'), C.red); return; }
    const [fx, fy] = this.parseTileId(me.mainBaseTile);
    try {
      const march = await this.cb.worldApi.startMarch(this.cb.worldId, fx, fy, tx, ty, kind, troops);
      if (kind === 'attack') this.myAttackTiles.add(march.toTile);
      this.marches = await this.cb.worldApi.getMarches(this.cb.worldId);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      this.showToast(t('world.dispatched'));
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
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

  private async doRecall(marchId: string, worldId: string): Promise<void> {
    try {
      await this.cb.worldApi.recallMarch(marchId, worldId);
      this.marches = await this.cb.worldApi.getMarches(this.cb.worldId);
      this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  /** 迁城前的二次确认（展示花费）；确认 → doRelocate。 */
  private confirmRelocate(tx: number, ty: number): void {
    this.showModal(
      [t('world.relocateTitle'), t('world.relocateConfirm').replace('{n}', String(RELOCATE_COST))],
      [
        { label: t('world.relocateBtn'), action: () => this.doRelocate(tx, ty) },
        { label: '✕', action: () => this.closeModal() },
      ],
    );
  }

  private async doRelocate(tx: number, ty: number): Promise<void> {
    this.closeModal();
    try {
      this.me = await this.cb.worldApi.relocateBase(this.cb.worldId, tx, ty);
      this.tileCache.clear(); // 主城位置变了 + 旧址回归中立，整块视区重拉
      if (this.me.mainBaseTile) {
        const [bx, by] = this.parseTileId(this.me.mainBaseTile);
        this.centerAt(bx, by);
      }
      await this.loadMapViewport();
      this.showToast(t('world.relocated'));
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

  // ── Train / resource panel (C4) ─────────────────────────────────────────────
  // A richer modal than showModal: full resources + yield, recruit presets, the
  // live training queue (countdown), and a one-tap coin speedup. Rendered into
  // modalLayer (reusing modalBtnRects for hit detection + dim-to-close), and
  // re-painted ~1s by update() so the queue countdowns tick.

  private openTrainPanel(): void {
    if (!this.me?.joined) { this.showToast(t('world.needBase'), C.red); return; }
    this.trainPanelOpen = true;
    this.panelRepaint = 0;
    void this.refreshMe().then(() => { if (this.trainPanelOpen) this.renderTrainPanel(); });
    this.renderTrainPanel();
  }

  /** A small filled button registered in modalBtnRects. */
  private panelButton(
    label: string, x: number, y: number, bw: number, bh: number,
    fill: number, action: () => void,
  ): void {
    const ml = this.modalLayer;
    const bp = sketchPanel(bw, bh, { fill, border: C.accent, seed: seedFor(x, y, bw) });
    bp.x = x; bp.y = y;
    ml.addChild(bp);
    const bl = txt(label, 11, C.light);
    bl.anchor.set(0.5, 0.5);
    bl.x = x + bw / 2; bl.y = y + bh / 2;
    ml.addChild(bl);
    this.modalBtnRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }

  private renderTrainPanel(): void {
    const me = this.me;
    if (!me?.joined) { this.closeModal(); return; }
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalBtnRects = [];

    const { w, h } = this;
    const pw = Math.min(340, w - 24);
    const ph = 300;
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(7, 7, pw) });
    panel.x = px; panel.y = py;
    ml.addChild(panel);

    const addText = (s: string, ty: number, size = 12, color: number = C.dark, cx = px + 14, anchorX = 0): PIXI.Text => {
      const lbl = txt(s, size, color);
      lbl.anchor.set(anchorX, 0);
      lbl.x = cx; lbl.y = ty;
      ml.addChild(lbl);
      return lbl;
    };

    let ly = py + 12;
    // Title
    const title = txt(t('world.trainTitle'), 14, C.accent);
    title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = ly;
    ml.addChild(title);
    ly += 26;

    // Resources + yield
    const res = me.resources ?? {};
    const yield_ = me.yieldRate ?? {};
    const fmt = (icon: string, key: string): string => {
      const amt = Math.floor(res[key] ?? 0);
      const yr = yield_[key];
      return yr ? `${icon}${amt} (+${Math.round(yr)}/${t('world.resYield')})` : `${icon}${amt}`;
    };
    addText(`${fmt('🌾', 'food')}   ${fmt('🪵', 'wood')}   ${fmt('⛏️', 'iron')}`, ly, 11);
    ly += 20;

    // Troops
    const inQ = (me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
    const troops = Math.floor(me.troops ?? 0);
    const cap = Math.floor(me.troopCap ?? 0);
    let troopLine = `${t('world.troops')} ${troops}/${cap}`;
    if (inQ > 0) troopLine += `  ·  ${t('world.trainInQueue').replace('{n}', String(inQ))}`;
    addText(troopLine, ly, 12, C.red);
    ly += 24;

    // Recruit row
    addText(t('world.trainNew'), ly, 12);
    ly += 20;
    const food = Math.floor(res['food'] ?? 0);
    const capLeft = Math.max(0, cap - troops - inQ);
    const queueFull = (me.trainingQueue ?? []).length >= 2;
    const bw = (pw - 28 - MARGIN * 2) / 3;
    let bx = px + 14;
    for (const n of TRAIN_PRESETS) {
      const cost = n * TRAIN_FOOD_PER;
      const ok = !queueFull && capLeft >= n && food >= cost;
      this.panelButton(
        `+${n}`, bx, ly, bw, 30,
        ok ? C.dark : C.mid,
        () => { if (ok) void this.doTrain(n); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < n ? t('world.err.troopCap') : t('world.err.noFood')), C.red); },
      );
      bx += bw + MARGIN;
    }
    // Max preset = min(batch cap, capacity left, food-affordable)
    const maxQty = Math.min(TRAIN_BATCH_MAX, capLeft, Math.floor(food / TRAIN_FOOD_PER));
    const maxOk = !queueFull && maxQty >= 1;
    this.panelButton(
      maxOk ? `${t('world.trainMax')} +${maxQty}` : t('world.trainMax'), bx, ly, bw, 30,
      maxOk ? C.red : C.mid,
      () => { if (maxOk) void this.doTrain(maxQty); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < 1 ? t('world.err.troopCap') : t('world.err.noFood')), C.red); },
    );
    ly += 38;

    // Queue
    addText(t('world.trainQueue'), ly, 12);
    ly += 18;
    const queue = me.trainingQueue ?? [];
    if (queue.length === 0) {
      addText(t('world.trainQueueEmpty'), ly, 11, C.mid);
      ly += 18;
    } else {
      const now = Date.now();
      for (const e of queue) {
        const sec = Math.max(0, Math.ceil((e.completeAt - now) / 1000));
        addText(`• ${t('world.trainEntry').replace('{n}', String(e.qty)).replace('{sec}', String(sec))}`, ly, 11, C.dark);
        ly += 18;
      }
      // One-tap coin speedup: enough coins to clear the whole queue.
      const lastDone = queue[queue.length - 1]!.completeAt;
      const remainSec = Math.max(0, Math.ceil((lastDone - now) / 1000));
      const coins = Math.max(1, Math.ceil(remainSec / TRAIN_SPEEDUP_PER_COIN));
      ly += 4;
      this.panelButton(
        t('world.speedup').replace('{coins}', String(coins)),
        px + 14, ly, pw - 28, 28, C.accent,
        () => void this.doSpeedup(coins),
      );
      ly += 34;
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  private async doTrain(qty: number): Promise<void> {
    try {
      this.me = await this.cb.worldApi.trainTroops(this.cb.worldId, qty);
      this.showToast(t('world.trained'));
      if (this.trainPanelOpen) this.renderTrainPanel();
      this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doSpeedup(coins: number): Promise<void> {
    try {
      this.me = await this.cb.worldApi.speedupTraining(this.cb.worldId, coins);
      this.showToast(t('world.spedup'));
      if (this.trainPanelOpen) this.renderTrainPanel();
      this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── World info panel (C5): nations / season / SLG shop ───────────────────────
  // Tabbed modal rendered into modalLayer. Season is read-only; nations lets the
  // capital owner rename theirs (setNationName, server re-checks ownerId). The shop
  // buys via worldApi.buyShopItem → commercial.spend (server-authoritative, toast on
  // INSUFFICIENT_FUNDS) and shows the SaveData coin balance via the getCoins callback.

  private openInfoPanel(): void {
    this.trainPanelOpen = false;
    this.renderInfoPanel();
    // Lazy-load shop catalog + fresh nations/season the first time.
    if (this.shopItems.length === 0) {
      void this.cb.worldApi.getShopItems()
        .then((items) => { this.shopItems = items; if (this.modalDimRect && !this.trainPanelOpen) this.renderInfoPanel(); })
        .catch(() => { /* offline */ });
    }
    void this.cb.worldApi.getNations(this.cb.worldId)
      .then((n) => { this.nations = n; })
      .catch(() => {});
  }

  /** Localize an SLG shop item by kind + effect (server description is zh-only). */
  private shopLabel(it: SlgShopItemView): string {
    const eff = it.effect as Record<string, number>;
    switch (it.kind) {
      case 'troop_speedup': return t('world.shop.speedup').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
      case 'resource_pack': return t('world.shop.resPack').replace('{n}', String(eff.each ?? 0));
      case 'protection':    return t('world.shop.shield').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
      case 'battle_pass':   return t('world.shop.battlePass');
      default:              return it.id;
    }
  }

  private renderInfoPanel(): void {
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalBtnRects = [];

    const { w, h } = this;
    const pw = Math.min(360, w - 20);
    const ph = Math.min(380, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(9, 9, pw) });
    panel.x = px; panel.y = py;
    ml.addChild(panel);

    const addText = (s: string, tx2: number, ty: number, size = 12, color: number = C.dark, anchorX = 0): void => {
      const lbl = txt(s, size, color);
      lbl.anchor.set(anchorX, 0);
      lbl.x = tx2; lbl.y = ty;
      ml.addChild(lbl);
    };

    // Title
    const title = txt(t('world.infoTitle'), 14, C.accent);
    title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = py + 10;
    ml.addChild(title);

    // Tabs
    const tabs: { id: 'nations' | 'season' | 'shop'; label: string }[] = [
      { id: 'nations', label: t('world.tabNations') },
      { id: 'season',  label: t('world.tabSeason') },
      { id: 'shop',    label: t('world.tabShop') },
    ];
    const tabW = (pw - 28 - MARGIN * 2) / 3;
    let tx = px + 14;
    const tabY = py + 34;
    for (const tab of tabs) {
      const active = this.infoTab === tab.id;
      this.panelButton(tab.label, tx, tabY, tabW, 26, active ? C.red : C.dark, () => {
        this.infoTab = tab.id; this.renderInfoPanel();
      });
      tx += tabW + MARGIN;
    }

    let ly = tabY + 38;
    const bodyBottom = py + ph - 42;

    if (this.infoTab === 'nations') {
      if (this.nations.length === 0) {
        addText(t('world.nationsEmpty'), px + 14, ly, 11, C.mid);
      } else {
        for (const n of this.nations) {
          if (ly > bodyBottom) break;
          const name = n.nationName || t('world.nationCol').replace('{idx}', String(n.capitalIdx));
          const mine = !!n.ownerId && n.ownerId === this.cb.accountId;
          addText(`★ ${name}  (${n.x},${n.y})`, px + 14, ly, 11);
          if (mine) {
            // Owner may rename their capital (server re-checks ownerId).
            const bw = 54;
            this.panelButton(t('world.nationRename'), px + pw - bw - 14, ly - 4, bw, 22, C.accent, () => this.openRenameInput(n.capitalIdx, name));
          } else {
            const status = n.ownerId ? t('world.nationOwned') : t('world.nationFree');
            addText(status, px + pw - 14, ly, 11, n.ownerId ? C.red : C.mid, 1);
          }
          ly += 24;
        }
      }
    } else if (this.infoTab === 'season') {
      const s = this.season;
      if (!s) {
        addText('—', px + 14, ly, 11, C.mid);
      } else {
        addText(t('world.seasonNo').replace('{n}', String(s.season)), px + 14, ly, 13, C.red); ly += 22;
        const statusKey = `world.season.${s.status}`;
        addText(t(statusKey as Parameters<typeof t>[0]), px + 14, ly, 11); ly += 18;
        addText(t('world.seasonPop').replace('{pop}', String(s.population)).replace('{cap}', String(s.capacity)), px + 14, ly, 11); ly += 18;
        if (s.resetAt) {
          const days = Math.max(0, Math.ceil((s.resetAt - Date.now()) / 86400000));
          addText(t('world.seasonReset').replace('{d}', String(days)), px + 14, ly, 11); ly += 18;
        }
      }
    } else {
      // Shop — show current coin balance (SaveData mirror) above the catalog.
      if (this.cb.getCoins) {
        addText(t('world.shopBalance').replace('{coins}', String(this.cb.getCoins())), px + 14, ly, 11, C.accent);
        ly += 22;
      }
      const rowH = 30;
      for (const it of this.shopItems) {
        if (ly + rowH > bodyBottom) break;
        addText(this.shopLabel(it), px + 14, ly + 4, 11);
        addText(t('world.shopCost').replace('{coins}', String(it.cost)), px + 14, ly + 18, 10, C.mid);
        const bw = 56;
        this.panelButton(t('world.shopBuy'), px + pw - bw - 14, ly + 2, bw, 24, C.accent, () => void this.doBuyShopItem(it.id));
        ly += rowH + 2;
      }
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  /** Open a hidden text input to rename an owned capital, then PATCH via worldsvc. */
  private openRenameInput(capitalIdx: number, current: string): void {
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = current;
    inp.maxLength = 24;
    inp.placeholder = t('world.nationNamePrompt');
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const name = inp.value.trim();
        inp.remove();
        if (name && name !== current) void this.doRename(capitalIdx, name);
      }
    });
    inp.addEventListener('blur', () => {
      inp.remove();
      if (this.hiddenInput === inp) this.hiddenInput = null;
    });
    this.hiddenInput = inp;
  }

  private async doRename(capitalIdx: number, name: string): Promise<void> {
    try {
      await this.cb.worldApi.setNationName(this.cb.worldId, capitalIdx, name);
      const n = this.nations.find(x => x.capitalIdx === capitalIdx);
      if (n) n.nationName = name;
      if (this.modalDimRect && !this.trainPanelOpen) this.renderInfoPanel();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doBuyShopItem(itemId: string): Promise<void> {
    try {
      await this.cb.worldApi.buyShopItem(this.cb.worldId, itemId);
      this.showToast(t('world.shopBought'));
      await this.refreshMe();
      if (this.modalDimRect && !this.trainPanelOpen) this.renderInfoPanel();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── Live push (worldsvc → gateway → NetSession → here, §14.5) ────────────────
  // Wired by createAppCore: it points session.handlers at these while the world
  // map is on-screen. Each one does a targeted authoritative refetch then redraws
  // — cheaper than hand-merging the push payload into the cached views.

  applyMarchUpdate(_m: MarchUpdate): void {
    if (this.destroyed) return;
    void this.refreshMarches();
  }

  applyTileUpdate(_tu: TileUpdate): void {
    if (this.destroyed) return;
    void this.loadMapViewport().then(() => { if (!this.destroyed) this.renderMap(); });
  }

  applyUnderAttack(u: UnderAttack): void {
    if (this.destroyed) return;
    const [tx, ty] = this.parseTileId(u.tile);
    const sec = Math.max(0, Math.ceil((u.arriveAt - Date.now()) / 1000));
    const name = u.attackerName || ('#' + (u.attackerPublicId || '?'));
    this.showToast(
      `${t('world.underAttack')} ${t('world.underAttackMsg')
        .replace('{name}', name)
        .replace('{tile}', `(${tx},${ty})`)
        .replace('{sec}', String(sec))}`,
      C.red,
    );
  }

  applySiegeResult(s: SiegeResult): void {
    if (this.destroyed) return;
    // Ownership / resources / troops may all have shifted — refetch the lot.
    void this.loadMapViewport().then(() => { if (!this.destroyed) this.renderMap(); });
    void this.refreshMe();
    void this.refreshMarches();

    if (this.myAttackTiles.has(s.tile)) {
      // We attacked — show the outcome + offer replay & verify (anti-cheat, C2).
      const loot = s.lootSummary ?? '';
      const line = s.outcome === 'attacker_win' ? t('world.siegeWin').replace('{loot}', loot)
        : s.outcome === 'defender_win' ? t('world.siegeLoss')
        : t('world.siegeDraw');
      this.showModal(
        [line],
        [
          { label: t('world.replaySiege'), action: () => { this.closeModal(); this.cb.onReplaySiege(s.siegeId); } },
          { label: '✕', action: () => this.closeModal() },
        ],
      );
    } else {
      // We were the defender (or a bystander) — toast only.
      const line = s.outcome === 'attacker_win' ? t('world.defendLost') : t('world.defendHeld');
      this.showToast(line, s.outcome === 'attacker_win' ? C.red : C.dark);
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
        TROOP_CAP_REACHED:      t('world.err.troopCap'),
        INSUFFICIENT_RESOURCES: t('world.err.noFood'),
        PATH_BLOCKED:  t('world.err.pathBlocked'),
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
    const minX = this.w - this.mapW * TILE_PX - TILE_PX * 2;
    const minY = (this.h - HUD_H) - this.mapH * TILE_PX - TILE_PX * 2;
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

    // World info button (floats top-right over the map)
    const ib = this.infoBtnRect;
    if (ib.w > 0 && x >= ib.x && x <= ib.x + ib.w && y >= ib.y && y <= ib.y + ib.h) {
      this.openInfoPanel();
      return;
    }

    // Back button
    const b = this.backRect;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      this.cb.onBack();
      return;
    }

    // Train / Family / Auction buttons
    const tr = this.trainBtnRect;
    if (tr.w > 0 && x >= tr.x && x <= tr.x + tr.w && y >= tr.y && y <= tr.y + tr.h) {
      this.openTrainPanel();
      return;
    }
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

    // March row hit detection (recall button or click-to-center)
    for (const entry of this.marchRowRects) {
      if (entry.recallRect) {
        const r = entry.recallRect;
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
          void this.doRecall(entry.marchId, entry.worldId);
          return;
        }
      }
      const row = entry.rowRect;
      if (x >= row.x && x <= row.x + row.w && y >= row.y && y <= row.y + row.h) {
        this.centerAt(entry.destX, entry.destY);
        this.renderMap();
        return;
      }
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
    // Tick the train panel's queue countdowns once per second while open.
    if (this.trainPanelOpen) {
      this.panelRepaint += dt;
      if (this.panelRepaint >= 1) {
        this.panelRepaint = 0;
        this.renderTrainPanel();
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.marchPoll) { clearInterval(this.marchPoll); this.marchPoll = null; }
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.container.destroy({ children: true });
  }
}
