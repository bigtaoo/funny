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

    // ── Bottom chat bar (§25): shows the latest world-chat message (sender + truncated
    // body), polled alongside marches — plus an unread badge vs the local "last seen" mark ──
    const chatPanel = sketchPanel(w, HUD_H, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) });
    chatPanel.y = h - HUD_H;
    hud.addChild(chatPanel);
    const latest = this.ctx.worldChatLatest;
    const chatLbl = txt(
      latest ? `${latest.senderName}: ${latest.body.slice(0, 28)}` : t('world.chat'),
      13, latest ? C.dark : C.mid,
    );
    chatLbl.anchor.set(0, 0.5);
    chatLbl.x = 14; chatLbl.y = h - HUD_H / 2;
    hud.addChild(chatLbl);
    if (this.ctx.worldChatUnread > 0) {
      const badgeLabel = this.ctx.worldChatUnread > 9 ? '9+' : String(this.ctx.worldChatUnread);
      const badge = sketchPanel(22, 18, { fill: C.red, border: C.dark, width: 1, seed: seedFor(2, 1, 22) });
      badge.x = 14 + chatLbl.width + 8; badge.y = h - HUD_H / 2 - 9;
      hud.addChild(badge);
      const badgeTxt = txt(badgeLabel, 11, C.light, true);
      badgeTxt.anchor.set(0.5);
      badgeTxt.x = badge.x + 11; badgeTxt.y = badge.y + 9;
      hud.addChild(badgeTxt);
    }
    this.ctx.chatBarRect = { x: 0, y: h - HUD_H, w, h: HUD_H };

    // ── Left column, top-left: Zoom → Auction, stacked directly under the floating
    // Back chip (drawn separately on ctx.topLayer — see WorldMapRenderer). Things that
    // leave the current map view live on the left; passive state lives on the right. ──
    const colW = 88, colH = 34, colGap = 6;
    const colX = this.ctx.backRect.x || 8;
    let ly = this.ctx.backRect.y + this.ctx.backRect.h + colGap || 8;

    const zoomLabels: Record<number, string> = { 1: '×1', 2: '×2', 3: '×3' };
    const zoomBtn = sketchPanel(colW, colH, { fill: C.dark, border: C.accent, seed: seedFor(4, 2, colW) });
    zoomBtn.x = colX; zoomBtn.y = ly;
    hud.addChild(zoomBtn);
    const zIcon = buildIcon('zoom', 16, C.light);
    const zTxt = txt(zoomLabels[this.ctx.zoom] ?? '', 13, C.light);
    zTxt.anchor.set(0, 0.5);
    const zGrpW = 16 + 4 + zTxt.width;
    const zGx = zoomBtn.x + (colW - zGrpW) / 2;
    zIcon.x = zGx; zIcon.y = zoomBtn.y + (colH - 16) / 2;
    zTxt.x = zGx + 20; zTxt.y = zoomBtn.y + colH / 2;
    hud.addChild(zIcon); hud.addChild(zTxt);
    this.ctx.zoomBtnRect = { x: zoomBtn.x, y: zoomBtn.y, w: colW, h: colH };
    ly += colH + colGap;

    const aucBtn = sketchPanel(colW, colH, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, colW) });
    aucBtn.x = colX; aucBtn.y = ly;
    hud.addChild(aucBtn);
    const aIcon = buildIcon('tag', 14, C.light);
    const aTxt = txt(t('world.auction'), 13, C.light);
    aTxt.anchor.set(0, 0.5);
    const aGrpW = 14 + 4 + aTxt.width;
    const aGx = aucBtn.x + (colW - aGrpW) / 2;
    aIcon.x = aGx; aIcon.y = aucBtn.y + (colH - 14) / 2;
    aTxt.x = aGx + 18; aTxt.y = aucBtn.y + colH / 2;
    hud.addChild(aIcon); hud.addChild(aTxt);
    this.ctx.aucBtnRect = { x: aucBtn.x, y: aucBtn.y, w: colW, h: colH };

    // ── Right column, top-right: status card → marches badge → World/info (passive state) ──
    const rightW = 160;
    const rx = w - rightW - 8;
    let ry = this.ctx.topInset + 8;

    if (this.ctx.me?.joined) {
      const cardH = 58;
      const card = sketchPanel(rightW, cardH, { fill: C.paper, border: C.mid, seed: seedFor(2, 5, rightW) });
      card.x = rx; card.y = ry;
      hud.addChild(card);

      const troops = this.ctx.me.troops ?? 0;
      const troopCap = this.ctx.me.troopCap ?? 0;
      const territory = this.ctx.me.territoryCount ?? 0;
      const line1 = `${t('world.troops')} ${troops}/${troopCap}  ${t('world.territory')} ${territory}`;
      const lbl1 = txt(line1, 10, C.dark);
      lbl1.x = rx + 8; lbl1.y = ry + 6;
      hud.addChild(lbl1);

      // Resource counts: hand-drawn motif icon (res_atlas, reused from the map tiles) + count,
      // replacing the earlier emoji glyphs that broke the notebook art style. Falls back to
      // emoji only while the atlas is still decoding (getResTexture null).
      const res = this.ctx.me.resources ?? {};
      const RES_EMOJI: Record<string, string> = { ink: '🖋️', paper: '📄', graphite: '✏️', metal: '🔩', sticker: '⭐' };
      const RES_ICON = 15;
      let ix = rx + 8;
      const resRowY = ry + 32;
      for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
        if (res[rt] === undefined) continue;
        const tex = getResTexture(rt);
        if (tex) {
          const sp = new PIXI.Sprite(tex);
          sp.width = sp.height = RES_ICON;
          sp.x = ix; sp.y = resRowY - 3;
          hud.addChild(sp);
          ix += RES_ICON + 1;
          const cnt = txt(`${res[rt]}`, 10, C.dark);
          cnt.x = ix; cnt.y = resRowY;
          hud.addChild(cnt);
          ix += cnt.width + 8;
        } else {
          const lbl = txt(`${RES_EMOJI[rt]}${res[rt]}`, 10, C.dark);
          lbl.x = ix; lbl.y = resRowY;
          hud.addChild(lbl);
          ix += lbl.width + 8;
        }
      }
      ry += cardH + 6;
    }

    // Marches badge — collapsed by default (flag glyph + count); tap toggles the expanded
    // list (own marches only; G5: this.marches may also hold in-vision enemy marches, which
    // can't be recalled, hence the `mine !== false` filter).
    this.ctx.marchRowRects = [];
    const myMarches = this.ctx.marches.filter((m) => m.mine !== false);
    if (this.ctx.me?.joined) {
      const badgeH = 32;
      const badge = sketchPanel(rightW, badgeH, { fill: C.dark, border: C.accent, seed: seedFor(6, 1, rightW) });
      badge.x = rx; badge.y = ry;
      hud.addChild(badge);
      const bIcon = buildIcon('flag', 14, C.light);
      bIcon.x = rx + 10; bIcon.y = ry + (badgeH - 14) / 2;
      hud.addChild(bIcon);
      const bTxt = txt(myMarches.length > 0 ? `${t('world.marchList')} (${myMarches.length})` : t('world.marchList'), 11, C.light);
      bTxt.anchor.set(0, 0.5);
      bTxt.x = rx + 30; bTxt.y = ry + badgeH / 2;
      hud.addChild(bTxt);
      this.ctx.marchBadgeRect = { x: badge.x, y: badge.y, w: rightW, h: badgeH };
      ry += badgeH + 6;

      if (this.ctx.marchesExpanded && myMarches.length > 0) {
        const MARCH_ROW_H = 22;
        const RECALL_W = 50;
        const MAX_VISIBLE_MARCHES = 5;
        const visibleMarches = myMarches.slice(0, MAX_VISIBLE_MARCHES);
        const overflowCount = myMarches.length - visibleMarches.length;
        const now = Date.now();
        const MARCH_KIND_ICON: Record<string, IconKind> = {
          attack: 'swords', reinforce: 'armor', scout: 'scope', return: 'replay', occupy: 'flag',
        };
        const listH = visibleMarches.length * MARCH_ROW_H + 6 + (overflowCount > 0 ? MARCH_ROW_H : 0);
        const listPanel = sketchPanel(rightW, listH, { fill: C.paper, border: C.mid, seed: seedFor(6, 2, rightW) });
        listPanel.x = rx; listPanel.y = ry;
        hud.addChild(listPanel);
        for (let i = 0; i < visibleMarches.length; i++) {
          const m = visibleMarches[i];
          const [tx, ty] = this.ctx.parseTileId(m.toTile);
          const remaining = Math.max(0, Math.ceil((m.arriveAt - now) / 1000));
          const rowY = listPanel.y + 3 + i * MARCH_ROW_H;
          const kindIc = buildIcon(MARCH_KIND_ICON[m.kind] ?? 'flag', 13, C.dark);
          kindIc.x = rx + 6; kindIc.y = rowY + 1;
          hud.addChild(kindIc);
          const rowLbl = txt(`(${tx},${ty})  ${remaining}s`, 10, C.dark);
          rowLbl.x = rx + 22; rowLbl.y = rowY + 2;
          hud.addChild(rowLbl);

          if (m.kind !== 'return') {
            const recallBtn = sketchPanel(RECALL_W, 18, { fill: C.accent, border: C.red, seed: seedFor(i, 99, RECALL_W) });
            recallBtn.x = rx + rightW - RECALL_W - 4; recallBtn.y = rowY;
            hud.addChild(recallBtn);
            const recallLbl = txt(t('world.recall'), 9, C.light);
            recallLbl.anchor.set(0.5, 0.5);
            recallLbl.x = recallBtn.x + RECALL_W / 2; recallLbl.y = recallBtn.y + 9;
            hud.addChild(recallLbl);
            this.ctx.marchRowRects.push({
              marchId: m.marchId,
              worldId: m.toTile.split(':')[2] ?? '',
              destX: tx, destY: ty,
              rowRect: { x: rx, y: rowY, w: rightW - RECALL_W - 8, h: MARCH_ROW_H },
              recallRect: { x: recallBtn.x, y: recallBtn.y, w: RECALL_W, h: 18 },
            });
          } else {
            this.ctx.marchRowRects.push({
              marchId: m.marchId,
              worldId: m.toTile.split(':')[2] ?? '',
              destX: tx, destY: ty,
              rowRect: { x: rx, y: rowY, w: rightW - 8, h: MARCH_ROW_H },
              recallRect: null,
            });
          }
        }
        if (overflowCount > 0) {
          const overflowY = listPanel.y + 3 + visibleMarches.length * MARCH_ROW_H;
          const overflowLbl = txt(t('world.marchMore', { n: overflowCount }), 10, C.mid);
          overflowLbl.x = rx + 6; overflowLbl.y = overflowY + 2;
          hud.addChild(overflowLbl);
        }
        ry = listPanel.y + listH + 6;
      }
    } else {
      this.ctx.marchBadgeRect = { x: 0, y: 0, w: 0, h: 0 };
    }

    // World info button — nations / season / shop.
    const infoH = 34;
    const infoBtn = sketchPanel(rightW, infoH, { fill: C.dark, border: C.accent, seed: seedFor(3, 1, rightW) });
    infoBtn.x = rx; infoBtn.y = ry;
    hud.addChild(infoBtn);
    const infoLbl = txt(t('world.info'), 13, C.light);
    infoLbl.anchor.set(0.5, 0.5);
    infoLbl.x = infoBtn.x + rightW / 2; infoLbl.y = infoBtn.y + infoH / 2;
    hud.addChild(infoLbl);
    this.ctx.infoBtnRect = { x: infoBtn.x, y: infoBtn.y, w: rightW, h: infoH };
  }

  // ── Hit rects ──────────────────────────────────────────────────────────────

  showModal(lines: string[], buttons: { label: string; action: () => void }[]): void {
    const ml = this.ctx.modalLayer;
    ml.removeChildren();

    const { w, h } = this.ctx;
    // 1.5× the original footprint (600×280 panel, 26/24px text, 56px buttons) — the old fixed
    // size clipped longer confirm copy (e.g. relocate cost text) since lines never wrapped.
    const mw = Math.min(900, w - 32);
    const textPad = 48;
    const textW = mw - textPad * 2;
    const topPad = 42;
    const lineGap = 14;
    const btnH = 84;
    const btnGap = 30;
    const modalMargin = MARGIN * 3;
    const mx = (w - mw) / 2;

    // Pre-measure wrapped label heights so the panel sizes to content instead of clipping/overlapping.
    const labels = lines.map((line) => {
      const lbl = txt(line, 30, C.dark, false, textW);
      lbl.anchor.set(0.5, 0);
      return lbl;
    });
    const textH = labels.reduce((sum, lbl) => sum + lbl.height, 0) + lineGap * Math.max(0, labels.length - 1);
    const mh = Math.max(CONFIRM_H * 1.5, topPad + textH + btnGap + btnH + btnGap);
    const my = (h - HUD_H - mh) / 2;

    // Dimmer
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    let ly = my + topPad;
    for (const lbl of labels) {
      lbl.x = mx + mw / 2; lbl.y = ly;
      ml.addChild(lbl);
      ly += lbl.height + lineGap;
    }

    this.ctx.modalBtnRects = [];
    const btnW = Math.min(300, (mw - modalMargin * (buttons.length + 1)) / buttons.length);
    let bx = mx + (mw - (btnW + modalMargin) * buttons.length + modalMargin) / 2;
    const by = my + mh - btnH - 30;
    for (const btn of buttons) {
      const bp = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(bx, by, btnW) });
      bp.x = bx; bp.y = by;
      ml.addChild(bp);
      // '✕' cancel buttons render the hand-drawn close glyph instead of the bare dingbat.
      if (btn.label === '✕') {
        const ic = buildIcon('close', 48, C.light);
        ic.x = bx + btnW / 2 - 24; ic.y = by + btnH / 2 - 24;
        ml.addChild(ic);
      } else {
        const bl = txt(btn.label, 30, C.light);
        bl.anchor.set(0.5, 0.5);
        bl.x = bx + btnW / 2; bl.y = by + btnH / 2;
        ml.addChild(bl);
      }
      this.ctx.modalBtnRects.push({ rect: { x: bx, y: by, w: btnW, h: btnH }, action: btn.action });
      bx += btnW + modalMargin;
    }

    // Close on dim
    this.ctx.modalDimRect = { x: 0, y: 0, w: w, h: h };
  }

  closeModal(): void {
    this.ctx.modalLayer.removeChildren();
    this.ctx.modalBtnRects = [];
    this.ctx.modalDimRect = null;
    this.ctx.infoScrollRect = null;
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
    fill: number, action: () => void, fontSize = 11,
  ): void {
    const ml = this.ctx.modalLayer;
    const bp = sketchPanel(bw, bh, { fill, border: C.accent, seed: seedFor(x, y, bw) });
    bp.x = x; bp.y = y;
    ml.addChild(bp);
    const bl = txt(label, fontSize, C.light);
    bl.anchor.set(0.5, 0.5);
    bl.x = x + bw / 2; bl.y = y + bh / 2;
    ml.addChild(bl);
    this.ctx.modalBtnRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }

  /**
   * Start a masked, wheel/drag-scrollable list region inside the modal layer (world-info
   * nations/shop tabs — see renderInfoPanel). Registers ctx.infoScrollRect/infoMaxScroll so
   * WorldMapInput can route wheel + drag gestures here, and clamps the current scroll offset
   * to the new content height (list length can change between renders, e.g. shop catalog load).
   * Returns the container rows should be added to (already `.mask`ed to the viewport rect).
   */

  beginScrollList(x: number, y: number, w: number, h: number, contentH: number): PIXI.Container {
    this.ctx.infoScrollRect = { x, y, w, h };
    this.ctx.infoMaxScroll = Math.max(0, contentH - h);
    this.ctx.infoScrollY = Math.max(0, Math.min(this.ctx.infoScrollY, this.ctx.infoMaxScroll));
    const ml = this.ctx.modalLayer;
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(x, y, w, h).endFill();
    ml.addChild(mask);
    const layer = new PIXI.Container();
    layer.mask = mask;
    ml.addChild(layer);
    return layer;
  }

  /** Like {@link panelButton} but adds into a scroll-list's masked layer instead of the modal layer directly. */

  panelButtonIn(
    layer: PIXI.Container, label: string, x: number, y: number, bw: number, bh: number,
    fill: number, action: () => void,
  ): void {
    const bp = sketchPanel(bw, bh, { fill, border: C.accent, seed: seedFor(x, y, bw) });
    bp.x = x; bp.y = y;
    layer.addChild(bp);
    const bl = txt(label, 11, C.light);
    bl.anchor.set(0.5, 0.5);
    bl.x = x + bw / 2; bl.y = y + bh / 2;
    layer.addChild(bl);
    this.ctx.modalBtnRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }

  renderTrainPanel(): void {
    const me = this.ctx.me;
    if (!me?.joined) { this.closeModal(); return; }
    const ml = this.ctx.modalLayer;
    tearDownChildren(ml); // repainted once/sec while open (queue countdowns) → free Text textures
    this.ctx.modalBtnRects = [];

    const { w, h } = this.ctx;
    const S = 2; // train panel is rendered at 2x scale vs other modals
    const pw = Math.min(340 * S, w - 24);
    const ph = Math.min(300 * S, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.ctx.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(7, 7, pw) });
    panel.x = px; panel.y = py;
    ml.addChild(panel);

    const addText = (s: string, ty: number, size = 12 * S, color: number = C.dark, cx = px + 14 * S, anchorX = 0): PIXI.Text => {
      const lbl = txt(s, size, color);
      lbl.anchor.set(anchorX, 0);
      lbl.x = cx; lbl.y = ty;
      ml.addChild(lbl);
      return lbl;
    };

    let ly = py + 12 * S;
    // Title
    const title = txt(t('world.trainTitle'), 14 * S, C.accent);
    title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = ly;
    ml.addChild(title);
    ly += 26 * S;

    // Resources + yield — hand-drawn motif icon (res_atlas, reused from the map tiles) + count,
    // replacing the earlier emoji glyphs. Falls back to emoji while the atlas is still decoding.
    const res = me.resources ?? {};
    const yield_ = me.yieldRate ?? {};
    const RES_EMOJI: Record<string, string> = { ink: '🖋️', paper: '📄', graphite: '✏️', metal: '🔩', sticker: '⭐' };
    const RES_ICON = 16 * S;
    const layoutResRow = (types: string[], rowY: number): void => {
      let rx = px + 14 * S;
      for (const key of types) {
        const amt = Math.floor(res[key] ?? 0);
        const yr = yield_[key];
        const valStr = yr ? `${amt} (+${Math.round(yr)}/${t('world.resYield')})` : `${amt}`;
        const tex = getResTexture(key);
        if (tex) {
          const sp = new PIXI.Sprite(tex);
          sp.width = sp.height = RES_ICON;
          sp.x = rx; sp.y = rowY - 3 * S;
          ml.addChild(sp);
          rx += RES_ICON + 2 * S;
          rx += addText(valStr, rowY, 11 * S, C.dark, rx).width + 14 * S;
        } else {
          rx += addText(`${RES_EMOJI[key]}${valStr}`, rowY, 11 * S, C.dark, rx).width + 14 * S;
        }
      }
    };
    layoutResRow(['ink', 'paper', 'graphite'], ly);
    ly += 18 * S;
    layoutResRow(['metal', 'sticker'], ly);
    ly += 20 * S;

    // Troops
    const inQ = (me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
    const troops = Math.floor(me.troops ?? 0);
    const cap = Math.floor(me.troopCap ?? 0);
    let troopLine = `${t('world.troops')} ${troops}/${cap}`;
    if (inQ > 0) troopLine += `  ·  ${t('world.trainInQueue').replace('{n}', String(inQ))}`;
    addText(troopLine, ly, 12 * S, C.red);
    ly += 24 * S;

    // Recruit row
    addText(t('world.trainNew'), ly, 12 * S);
    ly += 20 * S;
    const ink = Math.floor(res['ink'] ?? 0);
    const capLeft = Math.max(0, cap - troops - inQ);
    const queueFull = (me.trainingQueue ?? []).length >= 2;
    const bw = (pw - 28 * S - MARGIN * S * 2) / 3;
    let bx = px + 14 * S;
    for (const n of TRAIN_PRESETS) {
      const cost = n * TRAIN_INK_PER;
      const ok = !queueFull && capLeft >= n && ink >= cost;
      this.panelButton(
        `+${n}`, bx, ly, bw, 30 * S,
        ok ? C.dark : C.mid,
        () => { if (ok) void this.ctx.net.doTrain(n); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < n ? t('world.err.troopCap') : t('world.err.noInk')), C.red); },
        11 * S,
      );
      bx += bw + MARGIN * S;
    }
    // Max preset = min(batch cap, capacity left, ink-affordable)
    const maxQty = Math.min(TRAIN_BATCH_MAX, capLeft, Math.floor(ink / TRAIN_INK_PER));
    const maxOk = !queueFull && maxQty >= 1;
    this.panelButton(
      maxOk ? `${t('world.trainMax')} +${maxQty}` : t('world.trainMax'), bx, ly, bw, 30 * S,
      maxOk ? C.red : C.mid,
      () => { if (maxOk) void this.ctx.net.doTrain(maxQty); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < 1 ? t('world.err.troopCap') : t('world.err.noInk')), C.red); },
      11 * S,
    );
    ly += 38 * S;

    // Queue
    addText(t('world.trainQueue'), ly, 12 * S);
    ly += 18 * S;
    const queue = me.trainingQueue ?? [];
    if (queue.length === 0) {
      addText(t('world.trainQueueEmpty'), ly, 11 * S, C.mid);
      ly += 18 * S;
    } else {
      const now = Date.now();
      for (const e of queue) {
        const sec = Math.max(0, Math.ceil((e.completeAt - now) / 1000));
        addText(`• ${t('world.trainEntry').replace('{n}', String(e.qty)).replace('{sec}', String(sec))}`, ly, 11 * S, C.dark);
        ly += 18 * S;
      }
      // One-tap coin speedup: enough coins to clear the whole queue.
      const lastDone = queue[queue.length - 1]!.completeAt;
      const remainSec = Math.max(0, Math.ceil((lastDone - now) / 1000));
      const coins = Math.max(1, Math.ceil(remainSec / TRAIN_SPEEDUP_PER_COIN));
      ly += 4 * S;
      this.panelButton(
        t('world.speedup').replace('{coins}', String(coins)),
        px + 14 * S, ly, pw - 28 * S, 28 * S, C.accent,
        () => void this.ctx.net.doSpeedup(coins),
        12 * S,
      );
      ly += 34 * S;
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50 * S, py + ph - 34 * S, 100 * S, 28 * S, C.dark, () => this.closeModal(), 12 * S);
  }

  openInfoPanel(): void {
    this.ctx.trainPanelOpen = false;
    this.ctx.infoScrollY = 0;
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
        this.ctx.infoTab = tab.id; this.ctx.infoScrollY = 0; this.renderInfoPanel();
      });
      tx += tabW + MARGIN;
    }

    let ly = tabY + 38;
    const bodyBottom = py + ph - 42;
    this.ctx.infoScrollRect = null;

    if (this.ctx.infoTab === 'nations') {
      if (this.ctx.nations.length === 0) {
        addText(t('world.nationsEmpty'), px + 14, ly, 11, C.mid);
      } else {
        const rowH = 24;
        const listLayer = this.beginScrollList(px, ly, pw, bodyBottom - ly, this.ctx.nations.length * rowH);
        let ry = ly - this.ctx.infoScrollY;
        for (const n of this.ctx.nations) {
          if (ry + rowH >= ly && ry <= bodyBottom) {
            const name = n.nationName || t('world.nationCol').replace('{idx}', String(n.capitalIdx));
            const mine = !!n.ownerId && n.ownerId === this.ctx.cb.accountId;
            const nStar = buildIcon('star', 12, C.gold);
            nStar.x = px + 14; nStar.y = ry - 1;
            listLayer.addChild(nStar);
            const nameLbl = txt(`${name}  (${n.x},${n.y})`, 11, C.dark);
            nameLbl.x = px + 30; nameLbl.y = ry;
            listLayer.addChild(nameLbl);
            if (mine) {
              // Owner may rename their capital (server re-checks ownerId).
              const bw = 54;
              this.panelButtonIn(listLayer, t('world.nationRename'), px + pw - bw - 14, ry - 4, bw, 22, C.accent, () => this.openRenameInput(n.capitalIdx, name));
            } else {
              const status = n.ownerId ? t('world.nationOwned') : t('world.nationFree');
              const statusLbl = txt(status, 11, n.ownerId ? C.red : C.mid);
              statusLbl.anchor.set(1, 0); statusLbl.x = px + pw - 14; statusLbl.y = ry;
              listLayer.addChild(statusLbl);
            }
          }
          ry += rowH;
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
      const rowH = 32;
      const listLayer = this.beginScrollList(px, ly, pw, bodyBottom - ly, this.ctx.shopItems.length * rowH);
      let ry = ly - this.ctx.infoScrollY;
      for (const it of this.ctx.shopItems) {
        if (ry + rowH >= ly && ry <= bodyBottom) {
          const nameLbl = txt(this.shopLabel(it), 11, C.dark);
          nameLbl.x = px + 14; nameLbl.y = ry + 4;
          listLayer.addChild(nameLbl);
          const costLbl = txt(t('world.shopCost').replace('{coins}', String(it.cost)), 10, C.mid);
          costLbl.x = px + 14; costLbl.y = ry + 18;
          listLayer.addChild(costLbl);
          const bw = 56;
          this.panelButtonIn(listLayer, t('world.shopBuy'), px + pw - bw - 14, ry + 2, bw, 24, C.accent, () => void this.ctx.net.doBuyShopItem(it.id));
        }
        ry += rowH;
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
