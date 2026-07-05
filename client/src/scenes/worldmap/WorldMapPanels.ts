import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { WorldApiError } from '../../net/WorldApiClient';
import { proceduralTile } from '@nw/shared';
import { loadResAtlas, getResTexture, isResAtlasReady } from '../../render/resAtlasLoader';
import { loadCityAtlas, getCityTexture, isCityAtlasReady } from '../../render/cityAtlasLoader';
import { loadTerrainAtlas, getTerrainTexture, isTerrainAtlasReady } from '../../render/terrainAtlasLoader';
import { loadBuildingAtlas, getBuildingTexture, isBuildingAtlasReady } from '../../render/buildingAtlasLoader';
import { ISO_RATIO, tileToScreen, screenToTile, screenToTileF, diamondPath, diamondVertices, visibleTileBounds } from '../../render/isoGrid';
import { DEFAULT_MAP_SIZE, HUD_H, MARGIN, CONFIRM_H, BASE_SPRITE_TILES, TRAIN_INK_PER, TRAIN_SPEEDUP_PER_COIN, TRAIN_BATCH_MAX, TRAIN_PRESETS, RELOCATE_COST, WATCHTOWER_COST_METAL, WATCHTOWER_COST_PAPER } from './constants';
import { TERRAIN_COLORS, RES_COLORS, MINE_TINT, MINE_BASE_TINT, ENEMY_TINT, ENEMY_BASE_TINT, ALLY_TINT, ALLY_BASE_TINT, FOG_COLOR, CLOUD_COLOR, ALLY_SECT_BORDER, ownerTint, terrainFill, terrainTextureName, tileColor, proceduralTileColor } from './tileStyle';
import { makeZoomCfgs } from './zoom';
import { drawTileL1, drawTileL2, drawResMotif, drawResMotifFallback, drawCityIcon, drawHpBar, placeBuildingSprite, drawStar } from './tileGraphics';
import type { IconKind } from '../../render/icons';
import type { WorldApiClient, WorldTileView, PlayerWorldView, MarchView, NationView, SeasonView, SlgShopItemView } from '../../net/WorldApiClient';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult } from '../../net/proto/transport';
import type { ProceduralTile } from '@nw/shared';
import type { TerrainTextureName } from '../../render/terrainAtlasLoader';
import type { ZoomCfg, PoolSlot } from './zoom';
import type { WorldMapContext, WorldMapCallbacks, DeployKind } from './WorldMapContext';

export class WorldMapPanels {
  constructor(private readonly ctx: WorldMapContext) {}

  renderHud(): void {
    const hud = this.ctx.hudLayer;
    tearDownChildren(hud); // rebuilt every ~5s by the march poll → free resource-count Text textures
    const { w, h } = this.ctx;

    // HUD background
    const panel = sketchPanel(w, HUD_H, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) });
    panel.y = h - HUD_H;
    hud.addChild(panel);

    // Resources row
    if (this.ctx.me?.joined) {
      const troops = this.ctx.me.troops ?? 0;
      const troopCap = this.ctx.me.troopCap ?? 0;
      const territory = this.ctx.me.territoryCount ?? 0;
      const infos = [
        `${t('world.troops')} ${troops}/${troopCap}`,
        `${t('world.territory')} ${territory}`,
      ];
      let ix = 106;
      const resRowY = h - HUD_H + 18;
      for (const info of infos) {
        const lbl = txt(info, 11, C.dark);
        lbl.x = ix; lbl.y = resRowY;
        hud.addChild(lbl);
        ix += lbl.width + 14;
      }

      // Resource counts: hand-drawn motif icon (res_atlas, reused from the map tiles) + count,
      // replacing the earlier emoji glyphs that broke the notebook art style. Falls back to
      // emoji only while the atlas is still decoding (getResTexture null).
      const res = this.ctx.me.resources ?? {};
      const RES_EMOJI: Record<string, string> = { ink: '🖋️', paper: '📄', graphite: '✏️', metal: '🔩', sticker: '⭐' };
      const RES_ICON = 18;
      for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
        if (res[rt] === undefined) continue;
        const tex = getResTexture(rt);
        if (tex) {
          const sp = new PIXI.Sprite(tex);
          sp.width = sp.height = RES_ICON;
          sp.x = ix; sp.y = resRowY - 4;
          hud.addChild(sp);
          ix += RES_ICON + 1;
          const cnt = txt(`${res[rt]}`, 11, C.dark);
          cnt.x = ix; cnt.y = resRowY;
          hud.addChild(cnt);
          ix += cnt.width + 12;
        } else {
          const lbl = txt(`${RES_EMOJI[rt]}${res[rt]}`, 11, C.dark);
          lbl.x = ix; lbl.y = resRowY;
          hud.addChild(lbl);
          ix += lbl.width + 14;
        }
      }
    }

    // Active marches panel — own marches only
    // (G5: this.marches may also hold in-vision enemy marches, which can't be recalled).
    this.ctx.marchRowRects = [];
    const myMarches = this.ctx.marches.filter((m) => m.mine !== false);
    const MARCH_PANEL_X = 8;
    const MARCH_ROW_H = 22;
    const RECALL_W = 50;
    // Section header always visible when player has joined
    if (this.ctx.me?.joined) {
      const headerTxt = myMarches.length > 0
        ? `${t('world.marchList')} (${myMarches.length})`
        : t('world.marchList');
      const marchHeader = txt(headerTxt, 10, C.mid);
      marchHeader.x = MARCH_PANEL_X; marchHeader.y = h - HUD_H + 52;
      hud.addChild(marchHeader);
    }
    if (myMarches.length > 0) {
      const now = Date.now();
      const ROW_Y0 = h - HUD_H + 68;
      for (let i = 0; i < myMarches.length; i++) {
        const m = myMarches[i];
        const [tx, ty] = this.ctx.parseTileId(m.toTile);
        const remaining = Math.max(0, Math.ceil((m.arriveAt - now) / 1000));
        // Hand-drawn march-kind glyph (icons.ts) replacing the earlier emoji, to match the
        // notebook art style. attack→swords, reinforce→shield, scout→scope, return→loop, occupy→flag.
        const MARCH_KIND_ICON: Record<string, IconKind> = {
          attack: 'swords', reinforce: 'armor', scout: 'scope', return: 'replay', occupy: 'flag',
        };
        const rowY = ROW_Y0 + i * MARCH_ROW_H;
        const kindIc = buildIcon(MARCH_KIND_ICON[m.kind] ?? 'flag', 14, C.dark);
        kindIc.x = MARCH_PANEL_X; kindIc.y = rowY + 1;
        hud.addChild(kindIc);
        const rowLbl = txt(`(${tx},${ty})  ${remaining}s`, 11, C.dark);
        rowLbl.x = MARCH_PANEL_X + 17; rowLbl.y = rowY + 2;
        hud.addChild(rowLbl);

        // Recall button (only for non-return marches)
        if (m.kind !== 'return') {
          const recallBtn = sketchPanel(RECALL_W, 18, { fill: C.accent, border: C.red, seed: seedFor(i, 99, RECALL_W) });
          recallBtn.x = MARCH_PANEL_X + 140; recallBtn.y = rowY + 1;
          hud.addChild(recallBtn);
          const recallLbl = txt(t('world.recall'), 10, C.light);
          recallLbl.anchor.set(0.5, 0.5);
          recallLbl.x = recallBtn.x + RECALL_W / 2; recallLbl.y = recallBtn.y + 9;
          hud.addChild(recallLbl);
          this.ctx.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: MARCH_PANEL_X, y: rowY, w: 140, h: MARCH_ROW_H },
            recallRect: { x: recallBtn.x, y: recallBtn.y, w: RECALL_W, h: 18 },
          });
        } else {
          this.ctx.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: MARCH_PANEL_X, y: rowY, w: 140, h: MARCH_ROW_H },
            recallRect: null,
          });
        }
      }
    }

    // Train / Family / Auction buttons (right side)
    const btnW = 70;

    // Action buttons (right side, vertically centred in HUD)
    const btnH = 36;
    const btnY = h - HUD_H + (HUD_H - btnH) / 2;

    // Train button — only meaningful once the player has a base.
    if (this.ctx.me?.joined) {
      const trainBtn = sketchPanel(btnW, btnH, { fill: C.red, border: C.accent, seed: seedFor(2, 0, btnW) });
      trainBtn.x = w - btnW * 3 - 22; trainBtn.y = btnY;
      hud.addChild(trainBtn);
      const inQ = (this.ctx.me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
      const trainLbl = txt(inQ > 0 ? `${t('world.train')} (${inQ})` : t('world.train'), 13, C.light);
      trainLbl.anchor.set(0.5, 0.5);
      trainLbl.x = trainBtn.x + btnW / 2; trainLbl.y = trainBtn.y + btnH / 2;
      hud.addChild(trainLbl);
      this.ctx.trainBtnRect = { x: trainBtn.x, y: trainBtn.y, w: btnW, h: btnH };
    } else {
      this.ctx.trainBtnRect = { x: 0, y: 0, w: 0, h: 0 };
    }

    const famBtn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, btnW) });
    famBtn.x = w - btnW * 2 - 14; famBtn.y = btnY;
    hud.addChild(famBtn);
    const famLbl = txt(t('world.family'), 13, C.light);
    famLbl.anchor.set(0.5, 0.5);
    famLbl.x = famBtn.x + btnW / 2; famLbl.y = famBtn.y + btnH / 2;
    hud.addChild(famLbl);
    this.ctx.famBtnRect = { x: famBtn.x, y: famBtn.y, w: btnW, h: btnH };

    const aucBtn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, btnW) });
    aucBtn.x = w - btnW - 6; aucBtn.y = btnY;
    hud.addChild(aucBtn);
    const aucLbl = txt(t('world.auction'), 13, C.light);
    aucLbl.anchor.set(0.5, 0.5);
    aucLbl.x = aucBtn.x + btnW / 2; aucLbl.y = aucBtn.y + btnH / 2;
    hud.addChild(aucLbl);
    this.ctx.aucBtnRect = { x: aucBtn.x, y: aucBtn.y, w: btnW, h: btnH };

    // World info button — floats top-right over the map (nations / season / shop).
    const infoW = 76, infoH = 34;
    const infoBtn = sketchPanel(infoW, infoH, { fill: C.dark, border: C.accent, seed: seedFor(3, 1, infoW) });
    infoBtn.x = w - infoW - 8; infoBtn.y = 8;
    hud.addChild(infoBtn);
    const infoLbl = txt(t('world.info'), 13, C.light);
    infoLbl.anchor.set(0.5, 0.5);
    infoLbl.x = infoBtn.x + infoW / 2; infoLbl.y = infoBtn.y + infoH / 2;
    hud.addChild(infoLbl);
    this.ctx.infoBtnRect = { x: infoBtn.x, y: infoBtn.y, w: infoW, h: infoH };

    // Zoom cycle button — top-left over the map, cycles L1→L2→L3→L1.
    const zoomLabels: Record<number, string> = { 1: '×1', 2: '×2', 3: '×3' };
    const zoomW = 76, zoomH = 34;
    const zoomBtn = sketchPanel(zoomW, zoomH, { fill: C.dark, border: C.accent, seed: seedFor(4, 2, zoomW) });
    zoomBtn.x = 8; zoomBtn.y = 8;
    hud.addChild(zoomBtn);
    // Hand-drawn magnifier glyph + the ×N label, centred as a group (replaces the 🔍 emoji).
    const zIcon = buildIcon('zoom', 16, C.light);
    const zTxt = txt(zoomLabels[this.ctx.zoom] ?? '', 13, C.light);
    zTxt.anchor.set(0, 0.5);
    const zGrpW = 16 + 4 + zTxt.width;
    const zGx = zoomBtn.x + (zoomW - zGrpW) / 2;
    zIcon.x = zGx; zIcon.y = zoomBtn.y + (zoomH - 16) / 2;
    zTxt.x = zGx + 20; zTxt.y = zoomBtn.y + zoomH / 2;
    hud.addChild(zIcon); hud.addChild(zTxt);
    this.ctx.zoomBtnRect = { x: zoomBtn.x, y: zoomBtn.y, w: zoomW, h: zoomH };
  }

  // ── Hit rects ──────────────────────────────────────────────────────────────

  showModal(lines: string[], buttons: { label: string; action: () => void }[]): void {
    const ml = this.ctx.modalLayer;
    ml.removeChildren();

    const { w, h } = this.ctx;
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

    this.ctx.modalBtnRects = [];
    const btnW = Math.min(100, (mw - MARGIN * (buttons.length + 1)) / buttons.length);
    let bx = mx + (mw - (btnW + MARGIN) * buttons.length + MARGIN) / 2;
    const by = my + mh - 40;
    for (const btn of buttons) {
      const bp = sketchPanel(btnW, 28, { fill: C.dark, border: C.accent, seed: seedFor(bx, by, btnW) });
      bp.x = bx; bp.y = by;
      ml.addChild(bp);
      // '✕' cancel buttons render the hand-drawn close glyph instead of the bare dingbat.
      if (btn.label === '✕') {
        const ic = buildIcon('close', 16, C.light);
        ic.x = bx + btnW / 2 - 8; ic.y = by + 6;
        ml.addChild(ic);
      } else {
        const bl = txt(btn.label, 12, C.light);
        bl.anchor.set(0.5, 0.5);
        bl.x = bx + btnW / 2; bl.y = by + 14;
        ml.addChild(bl);
      }
      this.ctx.modalBtnRects.push({ rect: { x: bx, y: by, w: btnW, h: 28 }, action: btn.action });
      bx += btnW + MARGIN;
    }

    // Close on dim
    this.ctx.modalDimRect = { x: 0, y: 0, w: w, h: h };
  }

  closeModal(): void {
    this.ctx.modalLayer.removeChildren();
    this.ctx.modalBtnRects = [];
    this.ctx.modalDimRect = null;
    this.ctx.selectedTile = null;
    this.ctx.trainPanelOpen = false;
    this.ctx.view.renderMap();
  }

  showToast(msg: string, color: number = C.dark): void {
    const tl = this.ctx.toastLayer;
    tl.removeChildren();
    const { w, h } = this.ctx;
    const lbl = txt(msg, 13, color);
    lbl.anchor.set(0.5, 0);
    lbl.x = w / 2; lbl.y = h - HUD_H - 50;
    tl.addChild(lbl);
    this.ctx.toastTimer = 2500;
  }

  // ── Tile actions ───────────────────────────────────────────────────────────

  showDeployDialog(tx: number, ty: number, kind: DeployKind): void {
    const me = this.ctx.me;
    if (!me?.joined || !me.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    const avail = Math.max(0, Math.floor(me.troops ?? 0));
    const kindLabel = kind === 'attack' ? t('world.actAttack')
      : kind === 'reinforce' ? t('world.actReinforce')
      : kind === 'sweep' ? t('world.actSweep')
      : t('world.actOccupy');
    const send = (qty: number): void => { void this.ctx.net.doMarch(tx, ty, kind, qty); };
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

  // ── Siege team picker (G3-2c §16.2) ────────────────────────────────────────────────
  // A siege march must attach an attack formation template (team) — committed troops = sum of full HP of all units in the team, derived by the server (overrides the troop count). Empty team list → guide the player to manage teams.

  openTrainPanel(): void {
    if (!this.ctx.me?.joined) { this.showToast(t('world.needBase'), C.red); return; }
    this.ctx.trainPanelOpen = true;
    this.ctx.panelRepaint = 0;
    void this.ctx.net.refreshMe().then(() => { if (this.ctx.trainPanelOpen) this.renderTrainPanel(); });
    this.renderTrainPanel();
  }

  /** A small filled button registered in modalBtnRects. */

  panelButton(
    label: string, x: number, y: number, bw: number, bh: number,
    fill: number, action: () => void,
  ): void {
    const ml = this.ctx.modalLayer;
    const bp = sketchPanel(bw, bh, { fill, border: C.accent, seed: seedFor(x, y, bw) });
    bp.x = x; bp.y = y;
    ml.addChild(bp);
    const bl = txt(label, 11, C.light);
    bl.anchor.set(0.5, 0.5);
    bl.x = x + bw / 2; bl.y = y + bh / 2;
    ml.addChild(bl);
    this.ctx.modalBtnRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }

  renderTrainPanel(): void {
    const me = this.ctx.me;
    if (!me?.joined) { this.closeModal(); return; }
    const ml = this.ctx.modalLayer;
    tearDownChildren(ml); // repainted once/sec while open (queue countdowns) → free Text textures
    this.ctx.modalBtnRects = [];

    const { w, h } = this.ctx;
    const pw = Math.min(340, w - 24);
    const ph = 300;
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.ctx.modalDimRect = { x: 0, y: 0, w, h };

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

    // Resources + yield — hand-drawn motif icon (res_atlas, reused from the map tiles) + count,
    // replacing the earlier emoji glyphs. Falls back to emoji while the atlas is still decoding.
    const res = me.resources ?? {};
    const yield_ = me.yieldRate ?? {};
    const RES_EMOJI: Record<string, string> = { ink: '🖋️', paper: '📄', graphite: '✏️', metal: '🔩', sticker: '⭐' };
    const RES_ICON = 16;
    const layoutResRow = (types: string[], rowY: number): void => {
      let rx = px + 14;
      for (const key of types) {
        const amt = Math.floor(res[key] ?? 0);
        const yr = yield_[key];
        const valStr = yr ? `${amt} (+${Math.round(yr)}/${t('world.resYield')})` : `${amt}`;
        const tex = getResTexture(key);
        if (tex) {
          const sp = new PIXI.Sprite(tex);
          sp.width = sp.height = RES_ICON;
          sp.x = rx; sp.y = rowY - 3;
          ml.addChild(sp);
          rx += RES_ICON + 2;
          rx += addText(valStr, rowY, 11, C.dark, rx).width + 14;
        } else {
          rx += addText(`${RES_EMOJI[key]}${valStr}`, rowY, 11, C.dark, rx).width + 14;
        }
      }
    };
    layoutResRow(['ink', 'paper', 'graphite'], ly);
    ly += 18;
    layoutResRow(['metal', 'sticker'], ly);
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
    const ink = Math.floor(res['ink'] ?? 0);
    const capLeft = Math.max(0, cap - troops - inQ);
    const queueFull = (me.trainingQueue ?? []).length >= 2;
    const bw = (pw - 28 - MARGIN * 2) / 3;
    let bx = px + 14;
    for (const n of TRAIN_PRESETS) {
      const cost = n * TRAIN_INK_PER;
      const ok = !queueFull && capLeft >= n && ink >= cost;
      this.panelButton(
        `+${n}`, bx, ly, bw, 30,
        ok ? C.dark : C.mid,
        () => { if (ok) void this.ctx.net.doTrain(n); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < n ? t('world.err.troopCap') : t('world.err.noInk')), C.red); },
      );
      bx += bw + MARGIN;
    }
    // Max preset = min(batch cap, capacity left, ink-affordable)
    const maxQty = Math.min(TRAIN_BATCH_MAX, capLeft, Math.floor(ink / TRAIN_INK_PER));
    const maxOk = !queueFull && maxQty >= 1;
    this.panelButton(
      maxOk ? `${t('world.trainMax')} +${maxQty}` : t('world.trainMax'), bx, ly, bw, 30,
      maxOk ? C.red : C.mid,
      () => { if (maxOk) void this.ctx.net.doTrain(maxQty); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < 1 ? t('world.err.troopCap') : t('world.err.noInk')), C.red); },
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
        () => void this.ctx.net.doSpeedup(coins),
      );
      ly += 34;
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  openInfoPanel(): void {
    this.ctx.trainPanelOpen = false;
    this.renderInfoPanel();
    // Lazy-load shop catalog + fresh nations/season the first time.
    if (this.ctx.shopItems.length === 0) {
      void this.ctx.cb.worldApi.getShopItems()
        .then((items) => { this.ctx.shopItems = items; if (this.ctx.modalDimRect && !this.ctx.trainPanelOpen) this.renderInfoPanel(); })
        .catch(() => { /* offline */ });
    }
    void this.ctx.cb.worldApi.getNations(this.ctx.cb.worldId)
      .then((n) => { this.ctx.nations = n; })
      .catch(() => {});
  }

  /** Localize an SLG shop item by kind + effect (server description is zh-only). */

  shopLabel(it: SlgShopItemView): string {
    const eff = it.effect as Record<string, number>;
    switch (it.kind) {
      case 'troop_speedup': return t('world.shop.speedup').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
      case 'resource_pack': return t('world.shop.resPack').replace('{n}', String(eff.each ?? 0));
      case 'protection':    return t('world.shop.shield').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
      case 'battle_pass':   return t('world.shop.battlePass');
      default:              return it.id;
    }
  }

  renderInfoPanel(): void {
    const ml = this.ctx.modalLayer;
    ml.removeChildren();
    this.ctx.modalBtnRects = [];

    const { w, h } = this.ctx;
    const pw = Math.min(360, w - 20);
    const ph = Math.min(380, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.ctx.modalDimRect = { x: 0, y: 0, w, h };

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
      const active = this.ctx.infoTab === tab.id;
      this.panelButton(tab.label, tx, tabY, tabW, 26, active ? C.red : C.dark, () => {
        this.ctx.infoTab = tab.id; this.renderInfoPanel();
      });
      tx += tabW + MARGIN;
    }

    let ly = tabY + 38;
    const bodyBottom = py + ph - 42;

    if (this.ctx.infoTab === 'nations') {
      if (this.ctx.nations.length === 0) {
        addText(t('world.nationsEmpty'), px + 14, ly, 11, C.mid);
      } else {
        for (const n of this.ctx.nations) {
          if (ly > bodyBottom) break;
          const name = n.nationName || t('world.nationCol').replace('{idx}', String(n.capitalIdx));
          const mine = !!n.ownerId && n.ownerId === this.ctx.cb.accountId;
          const nStar = buildIcon('star', 12, C.gold);
          nStar.x = px + 14; nStar.y = ly - 1;
          ml.addChild(nStar);
          addText(`${name}  (${n.x},${n.y})`, px + 30, ly, 11);
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
    } else if (this.ctx.infoTab === 'season') {
      const s = this.ctx.season;
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
      if (this.ctx.cb.getCoins) {
        addText(t('world.shopBalance').replace('{coins}', String(this.ctx.cb.getCoins())), px + 14, ly, 11, C.accent);
        ly += 22;
      }
      const rowH = 30;
      for (const it of this.ctx.shopItems) {
        if (ly + rowH > bodyBottom) break;
        addText(this.shopLabel(it), px + 14, ly + 4, 11);
        addText(t('world.shopCost').replace('{coins}', String(it.cost)), px + 14, ly + 18, 10, C.mid);
        const bw = 56;
        this.panelButton(t('world.shopBuy'), px + pw - bw - 14, ly + 2, bw, 24, C.accent, () => void this.ctx.net.doBuyShopItem(it.id));
        ly += rowH + 2;
      }
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  /** Open a hidden text input to rename an owned capital, then PATCH via worldsvc. */

  openRenameInput(capitalIdx: number, current: string): void {
    if (this.ctx.hiddenInput) { this.ctx.hiddenInput.remove(); this.ctx.hiddenInput = null; }
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
        if (name && name !== current) void this.ctx.net.doRename(capitalIdx, name);
      }
    });
    inp.addEventListener('blur', () => {
      inp.remove();
      if (this.ctx.hiddenInput === inp) this.ctx.hiddenInput = null;
    });
    this.ctx.hiddenInput = inp;
  }
}
