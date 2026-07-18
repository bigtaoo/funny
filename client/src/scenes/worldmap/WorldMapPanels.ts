import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchButton, seedFor, tearDownChildren } from '../../render/sketchUi';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { buildIcon } from '../../render/icons';
import { FS, snapFont } from '../../render/fontScale';
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
import { formatDuration } from './formatDuration';

export class WorldMapPanels {
  constructor(private readonly ctx: WorldMapContext) {}

  /**
   * Header-bar content (drawn into ctx.headerHudLayer, above the static topLayer chrome):
   * per-resource production rate centered in the bar, and the auction button pinned to its
   * far right. Rebuilt alongside hudLayer on every ~5s march poll so production stays live.
   */
  private renderHeaderHud(): void {
    const layer = this.ctx.headerHudLayer;
    tearDownChildren(layer);
    const { w } = this.ctx;
    const headerH = this.ctx.topInset;

    // Auction button — far right of the header bar. Width auto-fits the icon+label so the
    // text never clips, and the larger right margin (56) pulls it clear of the screen edge.
    const aucH = Math.round(headerH * 0.7);
    const aIconSize = Math.round(aucH * 0.4);
    const aIcon = buildIcon('tag', aIconSize, C.light);
    const aTxt = txt(t('world.auction'), snapFont(Math.round(aucH * 0.34)), C.light);
    aTxt.anchor.set(0, 0.5);
    const aGrpW = aIconSize + 4 + aTxt.width;
    const aucW = Math.ceil(aGrpW) + 24; // horizontal padding around the content group
    const aucBtn = sketchButton(aucW, aucH, seedFor(1, 0, aucW));
    aucBtn.x = w - aucW - 56; aucBtn.y = (headerH - aucH) / 2;
    layer.addChild(aucBtn);
    const aGx = aucBtn.x + (aucW - aGrpW) / 2;
    aIcon.x = aGx; aIcon.y = aucBtn.y + (aucH - aIconSize) / 2;
    aTxt.x = aGx + aIconSize + 4; aTxt.y = aucBtn.y + aucH / 2;
    layer.addChild(aIcon); layer.addChild(aTxt);
    this.ctx.aucBtnRect = { x: aucBtn.x, y: aucBtn.y, w: aucW, h: aucH };

    // Per-resource production readout — centered between the back button and the auction
    // button, replacing the old "World" title text.
    const yieldRate = this.ctx.me?.yieldRate ?? {};
    const iconSize = Math.round(headerH * 0.34);
    const fontSize = snapFont(Math.round(headerH * 0.26));
    const gap = Math.round(headerH * 0.3);
    const cluster = new PIXI.Container();
    let cx = 0;
    for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
      const rate = Math.round(yieldRate[rt] ?? 0);
      const tex = getResTexture(rt);
      if (tex) {
        const sp = new PIXI.Sprite(tex);
        sp.width = sp.height = iconSize;
        sp.x = cx; sp.y = -iconSize / 2;
        cluster.addChild(sp);
        cx += iconSize + 3;
      }
      const lbl = txt(`+${rate}`, fontSize, C.dark);
      lbl.anchor.set(0, 0.5); lbl.x = cx; lbl.y = 0;
      cluster.addChild(lbl);
      cx += lbl.width + gap;
    }
    cx -= gap;
    const leftBound = this.ctx.backRect.x + this.ctx.backRect.w + 8;
    const rightBound = aucBtn.x - 8;
    cluster.x = leftBound + Math.max(0, (rightBound - leftBound - cx) / 2);
    cluster.y = headerH / 2;

    // Independent background panel behind the resource cluster, distinguishing it from the
    // shared header-bar chrome instead of floating directly on it.
    const padX = 10, padY = Math.round(headerH * 0.14);
    const bgPanel = sketchPanel(cx + padX * 2, headerH - padY * 2, { fill: C.paper, border: C.mid, seed: seedFor(2, 0, cx) });
    bgPanel.x = cluster.x - padX; bgPanel.y = padY;
    layer.addChild(bgPanel);
    layer.addChild(cluster);
    // Tappable: opens the Territory Overview panel (SLG_DESIGN_LOG.md §26).
    this.ctx.resClusterRect = { x: bgPanel.x, y: bgPanel.y, w: cx + padX * 2, h: headerH - padY * 2 };
  }

  renderHud(): void {
    const hud = this.ctx.hudLayer;
    tearDownChildren(hud); // rebuilt every ~5s by the march poll → free resource-count Text textures
    const { w, h } = this.ctx;
    this.renderHeaderHud();

    // ── Bottom chat bar (§25): shows the latest world-chat message (sender + truncated
    // body), polled alongside marches — plus an unread badge vs the local "last seen" mark ──
    const chatPanel = sketchPanel(w, HUD_H, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) });
    chatPanel.y = h - HUD_H;
    hud.addChild(chatPanel);
    const latest = this.ctx.worldChatLatest;
    const chatLbl = txt(
      latest ? `${latest.senderName}: ${latest.body.slice(0, 28)}` : t('world.chat'),
      FS.tiny, latest ? C.dark : C.mid,
    );
    chatLbl.anchor.set(0, 0.5);
    chatLbl.x = 14; chatLbl.y = h - HUD_H / 2;
    hud.addChild(chatLbl);
    if (this.ctx.worldChatUnread > 0) {
      const badgeLabel = this.ctx.worldChatUnread > 9 ? '9+' : String(this.ctx.worldChatUnread);
      const badge = sketchPanel(22, 18, { fill: C.red, border: C.dark, width: 1, seed: seedFor(2, 1, 22) });
      badge.x = 14 + chatLbl.width + 8; badge.y = h - HUD_H / 2 - 9;
      hud.addChild(badge);
      const badgeTxt = txt(badgeLabel, FS.micro, C.light, true);
      badgeTxt.anchor.set(0.5);
      badgeTxt.x = badge.x + 11; badgeTxt.y = badge.y + 9;
      hud.addChild(badgeTxt);
    }
    this.ctx.chatBarRect = { x: 0, y: h - HUD_H, w, h: HUD_H };

    // ── Left column, top-left: Zoom, stacked directly under the floating Back chip
    // (drawn separately on ctx.topLayer — see WorldMapRenderer). The auction button now
    // lives in the header bar itself (renderHeaderHud), far right. ──
    const colW = 176, colH = 68, colGap = 6; // 2x the original 88x34 footprint
    const colX = this.ctx.backRect.x || 8;
    const ly = this.ctx.backRect.y + this.ctx.backRect.h + colGap || 8;

    const zoomLabels: Record<number, string> = { 1: '×1', 2: '×2', 3: '×3' };
    const zoomBtn = sketchButton(colW, colH, seedFor(4, 2, colW));
    zoomBtn.x = colX; zoomBtn.y = ly;
    hud.addChild(zoomBtn);
    const zIcon = buildIcon('zoom', 32, C.light);
    const zTxt = txt(zoomLabels[this.ctx.zoom] ?? '', FS.heading, C.light);
    zTxt.anchor.set(0, 0.5);
    const zGrpW = 32 + 8 + zTxt.width;
    const zGx = zoomBtn.x + (colW - zGrpW) / 2;
    zIcon.x = zGx; zIcon.y = zoomBtn.y + (colH - 32) / 2;
    zTxt.x = zGx + 40; zTxt.y = zoomBtn.y + colH / 2;
    hud.addChild(zIcon); hud.addChild(zTxt);
    this.ctx.zoomBtnRect = { x: zoomBtn.x, y: zoomBtn.y, w: colW, h: colH };

    // ── Right column, top-right: status card → marches badge → World/info (passive state) ──
    // 2x the original 160-wide footprint (status card, marches badge/list, info button).
    const rightW = 320;
    const rx = w - rightW - 16;
    let ry = this.ctx.topInset + 16;

    if (this.ctx.me?.joined) {
      const cardH = 116;
      const card = sketchPanel(rightW, cardH, { fill: C.paper, border: C.mid, seed: seedFor(2, 5, rightW) });
      card.x = rx; card.y = ry;
      hud.addChild(card);

      const troops = this.ctx.me.troops ?? 0;
      const troopCap = this.ctx.me.troopCap ?? 0;
      const territory = this.ctx.me.territoryCount ?? 0;
      const line1 = `${t('world.troops')} ${troops}/${troopCap}  ${t('world.territory')} ${territory}`;
      const lbl1 = txt(line1, FS.bodyLg, C.dark);
      lbl1.x = rx + 16; lbl1.y = ry + 12;
      hud.addChild(lbl1);

      // Resource counts: hand-drawn motif icon (res_atlas, reused from the map tiles) + count,
      // replacing the earlier emoji glyphs that broke the notebook art style. Falls back to
      // emoji only while the atlas is still decoding (getResTexture null).
      const res = this.ctx.me.resources ?? {};
      const RES_EMOJI: Record<string, string> = { ink: '🖋️', paper: '📄', graphite: '✏️', metal: '🔩', sticker: '⭐' };
      const RES_ICON = 30;
      let ix = rx + 16;
      const resRowY = ry + 64;
      for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
        if (res[rt] === undefined) continue;
        const tex = getResTexture(rt);
        if (tex) {
          const sp = new PIXI.Sprite(tex);
          sp.width = sp.height = RES_ICON;
          sp.x = ix; sp.y = resRowY - 6;
          hud.addChild(sp);
          ix += RES_ICON + 2;
          const cnt = txt(`${res[rt]}`, FS.bodyLg, C.dark);
          cnt.x = ix; cnt.y = resRowY;
          hud.addChild(cnt);
          ix += cnt.width + 16;
        } else {
          const lbl = txt(`${RES_EMOJI[rt]}${res[rt]}`, FS.bodyLg, C.dark);
          lbl.x = ix; lbl.y = resRowY;
          hud.addChild(lbl);
          ix += lbl.width + 16;
        }
      }
      ry += cardH + 12;
    }

    // Marches badge — collapsed by default (flag glyph + count); tap toggles the expanded
    // list (own marches only; G5: this.marches may also hold in-vision enemy marches, which
    // can't be recalled, hence the `mine !== false` filter).
    this.ctx.marchRowRects = [];
    const myMarches = this.ctx.marches.filter((m) => m.mine !== false);
    if (this.ctx.me?.joined) {
      const badgeH = 64;
      const badge = sketchButton(rightW, badgeH, seedFor(6, 1, rightW));
      badge.x = rx; badge.y = ry;
      hud.addChild(badge);
      const bIcon = buildIcon('flag', 28, C.light);
      bIcon.x = rx + 20; bIcon.y = ry + (badgeH - 28) / 2;
      hud.addChild(bIcon);
      const bTxt = txt(myMarches.length > 0 ? `${t('world.marchList')} (${myMarches.length})` : t('world.marchList'), FS.label, C.light);
      bTxt.anchor.set(0, 0.5);
      bTxt.x = rx + 60; bTxt.y = ry + badgeH / 2;
      hud.addChild(bTxt);
      this.ctx.marchBadgeRect = { x: badge.x, y: badge.y, w: rightW, h: badgeH };
      ry += badgeH + 12;

      if (this.ctx.marchesExpanded && myMarches.length > 0) {
        const MARCH_ROW_H = 44;
        const RECALL_W = 100;
        const MAX_VISIBLE_MARCHES = 5;
        const visibleMarches = myMarches.slice(0, MAX_VISIBLE_MARCHES);
        const overflowCount = myMarches.length - visibleMarches.length;
        const now = Date.now();
        const MARCH_KIND_ICON: Record<string, IconKind> = {
          attack: 'swords', reinforce: 'armor', scout: 'scope', return: 'replay', occupy: 'flag',
        };
        const listH = visibleMarches.length * MARCH_ROW_H + 12 + (overflowCount > 0 ? MARCH_ROW_H : 0);
        const listPanel = sketchPanel(rightW, listH, { fill: C.paper, border: C.mid, seed: seedFor(6, 2, rightW) });
        listPanel.x = rx; listPanel.y = ry;
        hud.addChild(listPanel);
        for (let i = 0; i < visibleMarches.length; i++) {
          const m = visibleMarches[i];
          const [tx, ty] = this.ctx.parseTileId(m.toTile);
          const remaining = Math.max(0, Math.ceil((m.arriveAt - now) / 1000));
          const rowY = listPanel.y + 6 + i * MARCH_ROW_H;
          const kindIc = buildIcon(MARCH_KIND_ICON[m.kind] ?? 'flag', 26, C.dark);
          kindIc.x = rx + 12; kindIc.y = rowY + 2;
          hud.addChild(kindIc);
          const rowLbl = txt(`(${tx},${ty})  ${remaining}s`, FS.bodyLg, C.dark);
          rowLbl.x = rx + 44; rowLbl.y = rowY + 4;
          hud.addChild(rowLbl);

          if (m.kind !== 'return') {
            const recallBtn = sketchPanel(RECALL_W, 36, { fill: C.accent, border: C.red, seed: seedFor(i, 99, RECALL_W) });
            recallBtn.x = rx + rightW - RECALL_W - 8; recallBtn.y = rowY;
            hud.addChild(recallBtn);
            const recallLbl = txt(t('world.recall'), FS.body, C.light);
            recallLbl.anchor.set(0.5, 0.5);
            recallLbl.x = recallBtn.x + RECALL_W / 2; recallLbl.y = recallBtn.y + 18;
            hud.addChild(recallLbl);
            this.ctx.marchRowRects.push({
              marchId: m.marchId,
              worldId: m.toTile.split(':')[2] ?? '',
              destX: tx, destY: ty,
              rowRect: { x: rx, y: rowY, w: rightW - RECALL_W - 16, h: MARCH_ROW_H },
              recallRect: { x: recallBtn.x, y: recallBtn.y, w: RECALL_W, h: 36 },
            });
          } else {
            this.ctx.marchRowRects.push({
              marchId: m.marchId,
              worldId: m.toTile.split(':')[2] ?? '',
              destX: tx, destY: ty,
              rowRect: { x: rx, y: rowY, w: rightW - 16, h: MARCH_ROW_H },
              recallRect: null,
            });
          }
        }
        if (overflowCount > 0) {
          const overflowY = listPanel.y + 6 + visibleMarches.length * MARCH_ROW_H;
          const overflowLbl = txt(t('world.marchMore', { n: overflowCount }), FS.bodyLg, C.mid);
          overflowLbl.x = rx + 12; overflowLbl.y = overflowY + 4;
          hud.addChild(overflowLbl);
        }
        ry = listPanel.y + listH + 12;
      }

      // Battle-replays badge — sits directly below the marches badge; tapping opens the last-100 replay browser.
      const repH = 64;
      const repBadge = sketchPanel(rightW, repH, { fill: C.paper, border: C.mid, seed: seedFor(6, 3, rightW) });
      repBadge.x = rx; repBadge.y = ry;
      hud.addChild(repBadge);
      const repIcon = buildIcon('replay', 28, C.dark);
      repIcon.x = rx + 20; repIcon.y = ry + (repH - 28) / 2;
      hud.addChild(repIcon);
      const repTxt = txt(t('world.replays'), FS.label, C.dark);
      repTxt.anchor.set(0, 0.5);
      repTxt.x = rx + 60; repTxt.y = ry + repH / 2;
      hud.addChild(repTxt);
      this.ctx.replayBadgeRect = { x: repBadge.x, y: repBadge.y, w: rightW, h: repH };
      ry += repH + 12;
    } else {
      this.ctx.marchBadgeRect = { x: 0, y: 0, w: 0, h: 0 };
      this.ctx.replayBadgeRect = { x: 0, y: 0, w: 0, h: 0 };
    }
  }

  // ── Hit rects ──────────────────────────────────────────────────────────────

  showModal(lines: string[], buttons: { label: string; action: () => void; disabled?: boolean }[]): void {
    const ml = this.ctx.modalLayer;
    tearDownChildren(ml);

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
      const lbl = txt(line, FS.title, C.dark, false, textW);
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
      // Disabled buttons (e.g. Occupy on a tile not connected to the player's territory, ADR-039) use the
      // shared pale-grey disabled styling; the action is still registered so tapping it surfaces a toast
      // explaining why, rather than reading as a dead click.
      const disabled = !!btn.disabled;
      const bp = sketchPanel(btnW, btnH, { fill: disabled ? C.btnDis : C.dark, border: disabled ? C.btnOff : C.accent, seed: seedFor(bx, by, btnW) });
      bp.x = bx; bp.y = by;
      ml.addChild(bp);
      // '✕' cancel buttons render the hand-drawn close glyph instead of the bare dingbat.
      if (btn.label === '✕') {
        const ic = buildIcon('close', 48, C.light);
        ic.x = bx + btnW / 2 - 24; ic.y = by + btnH / 2 - 24;
        ml.addChild(ic);
      } else {
        const bl = txt(btn.label, FS.title, disabled ? C.mid : C.light);
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
    tearDownChildren(this.ctx.modalLayer);
    this.ctx.modalBtnRects = [];
    this.ctx.modalDimRect = null;
    this.ctx.infoScrollRect = null;
    this.ctx.infoScrollRerender = null;
    this.ctx.infoScrollPendingTap = null;
    this.ctx.selectedTile = null;
    this.ctx.trainPanelOpen = false;
    this.ctx.territoryPanelOpen = false;
    this.ctx.replayPanelOpen = false;
    this.ctx.view.renderMap();
  }

  showToast(msg: string, color: number = C.dark): void {
    const tl = this.ctx.toastLayer;
    tearDownChildren(tl);
    const { w, h } = this.ctx;
    // Unified toast box: dark panel + colored border, centered at h*2/3 — matches CityScene.showToast
    // and the global fallback GlobalToast so world-map notices read the same as the rest of the game.
    const tw = Math.min(w - 40, 720);
    const th = 84;
    const box = sketchPanel(tw, th, { fill: C.dark, fillAlpha: 0.88, border: color, width: 1, seed: 7 });
    box.x = (w - tw) / 2;
    box.y = Math.round(h * 2 / 3 - th / 2);
    tl.addChild(box);
    const lbl = txt(msg, FS.headline, 0xffffff, false, tw - 48);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = box.x + tw / 2;
    lbl.y = box.y + th / 2;
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
    const bl = txt(label, snapFont(fontSize), C.light);
    bl.anchor.set(0.5, 0.5);
    bl.x = x + bw / 2; bl.y = y + bh / 2;
    ml.addChild(bl);
    this.ctx.modalBtnRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }

  /**
   * Start a masked, wheel/drag-scrollable list region inside the modal layer (Territory
   * Overview's list/world tabs — see renderTerritoryPanel/renderWorldTabBody). Registers
   * ctx.infoScrollRect/infoMaxScroll so WorldMapInput can route wheel + drag gestures here, and
   * clamps the current scroll offset to the new content height (list length can change between
   * renders, e.g. shop catalog load). Returns the container rows should be added to (already
   * `.mask`ed to the viewport rect).
   */

  beginScrollList(x: number, y: number, w: number, h: number, contentH: number, rerender: () => void = () => this.renderTerritoryPanel()): PIXI.Container {
    this.ctx.infoScrollRect = { x, y, w, h };
    this.ctx.infoMaxScroll = Math.max(0, contentH - h);
    this.ctx.infoScrollY = Math.max(0, Math.min(this.ctx.infoScrollY, this.ctx.infoMaxScroll));
    this.ctx.infoScrollRerender = rerender;
    const ml = this.ctx.modalLayer;
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(x, y, w, h).endFill();
    ml.addChild(mask);
    const layer = new PIXI.Container();
    layer.mask = mask;
    ml.addChild(layer);
    // Position indicator on the list's right edge. Drawn into the modal layer above `layer`
    // so it's never clipped by the mask; renderTerritoryPanel adds the close button after, on top.
    drawScrollIndicator(ml, { x, y, w, h }, this.ctx.infoScrollY, this.ctx.infoMaxScroll);
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
    const bl = txt(label, FS.micro, C.light);
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
      const lbl = txt(s, snapFont(size), color);
      lbl.anchor.set(anchorX, 0);
      lbl.x = cx; lbl.y = ty;
      ml.addChild(lbl);
      return lbl;
    };

    let ly = py + 12 * S;
    // Title
    const title = txt(t('world.trainTitle'), snapFont(14 * S), C.accent);
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
        addText(`• ${t('world.trainEntry').replace('{n}', String(e.qty)).replace('{time}', formatDuration(sec))}`, ly, 11 * S, C.dark);
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

  /** Lazy-load the world-info data (nations/shop catalog) the first time the 'world' tab of
   * the Territory Overview panel is opened — mirrors the old standalone world-info button. */

  loadWorldTabData(): void {
    if (this.ctx.shopItems.length === 0) {
      void this.ctx.cb.worldApi.getShopItems()
        .then((items) => {
          this.ctx.shopItems = items;
          if (this.ctx.territoryPanelOpen && this.ctx.territoryTab === 'world' && !this.ctx.trainPanelOpen) this.renderTerritoryPanel();
        })
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

  /** Nations / season / shop sub-tabs — the 'world' tab body of the Territory Overview panel
   * (folded in from the old standalone world-info button/modal). Draws into the panel region
   * already set up by renderTerritoryPanel (px/pw for the panel, ly the current cursor y, and
   * bodyBottom the panel's content-area bottom). */

  private renderWorldTabBody(px: number, pw: number, ly: number, bodyBottom: number): void {
    const ml = this.ctx.modalLayer;
    const addText = (s: string, tx2: number, ty: number, size = 12, color: number = C.dark, anchorX = 0): void => {
      const lbl = txt(s, snapFont(size), color);
      lbl.anchor.set(anchorX, 0);
      lbl.x = tx2; lbl.y = ty;
      ml.addChild(lbl);
    };

    // Sub-tabs
    const tabs: { id: 'nations' | 'season' | 'shop'; label: string }[] = [
      { id: 'nations', label: t('world.tabNations') },
      { id: 'season',  label: t('world.tabSeason') },
      { id: 'shop',    label: t('world.tabShop') },
    ];
    const tabW = (pw - 28 - MARGIN * 2) / 3;
    let tx = px + 14;
    for (const tab of tabs) {
      const active = this.ctx.infoTab === tab.id;
      this.panelButton(tab.label, tx, ly, tabW, 26, active ? C.red : C.dark, () => {
        this.ctx.infoTab = tab.id; this.ctx.infoScrollY = 0; this.renderTerritoryPanel();
      });
      tx += tabW + MARGIN;
    }

    let cy = ly + 34;
    this.ctx.infoScrollRect = null;

    if (this.ctx.infoTab === 'nations') {
      if (this.ctx.nations.length === 0) {
        addText(t('world.nationsEmpty'), px + 14, cy, 11, C.mid);
      } else {
        const rowH = 24;
        const listLayer = this.beginScrollList(px, cy, pw, bodyBottom - cy, this.ctx.nations.length * rowH, () => this.renderTerritoryPanel());
        let ry = cy - this.ctx.infoScrollY;
        for (const n of this.ctx.nations) {
          if (ry + rowH >= cy && ry <= bodyBottom) {
            const name = n.nationName || t('world.nationCol').replace('{idx}', String(n.capitalIdx));
            const mine = !!n.ownerId && n.ownerId === this.ctx.cb.accountId;
            const nStar = buildIcon('star', 12, C.gold);
            nStar.x = px + 14; nStar.y = ry - 1;
            listLayer.addChild(nStar);
            const nameLbl = txt(`${name}  (${n.x},${n.y})`, FS.micro, C.dark);
            nameLbl.x = px + 30; nameLbl.y = ry;
            listLayer.addChild(nameLbl);
            if (mine) {
              // Owner may rename their capital (server re-checks ownerId).
              const bw = 54;
              this.panelButtonIn(listLayer, t('world.nationRename'), px + pw - bw - 14, ry - 4, bw, 22, C.accent, () => this.openRenameInput(n.capitalIdx, name));
            } else {
              const status = n.ownerId ? t('world.nationOwned') : t('world.nationFree');
              const statusLbl = txt(status, FS.micro, n.ownerId ? C.red : C.mid);
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
        addText('—', px + 14, cy, 11, C.mid);
      } else {
        addText(t('world.seasonNo').replace('{n}', String(s.season)), px + 14, cy, 13, C.red); cy += 22;
        const statusKey = `world.season.${s.status}`;
        addText(t(statusKey as Parameters<typeof t>[0]), px + 14, cy, 11); cy += 18;
        addText(t('world.seasonPop').replace('{pop}', String(s.population)).replace('{cap}', String(s.capacity)), px + 14, cy, 11); cy += 18;
        if (s.resetAt) {
          const days = Math.max(0, Math.ceil((s.resetAt - Date.now()) / 86400000));
          addText(t('world.seasonReset').replace('{d}', String(days)), px + 14, cy, 11); cy += 18;
        }
      }
    } else {
      // Shop — show current coin balance (SaveData mirror) above the catalog.
      if (this.ctx.cb.getCoins) {
        addText(t('world.shopBalance').replace('{coins}', String(this.ctx.cb.getCoins())), px + 14, cy, 11, C.accent);
        cy += 22;
      }
      const rowH = 32;
      const listLayer = this.beginScrollList(px, cy, pw, bodyBottom - cy, this.ctx.shopItems.length * rowH, () => this.renderTerritoryPanel());
      let ry = cy - this.ctx.infoScrollY;
      for (const it of this.ctx.shopItems) {
        if (ry + rowH >= cy && ry <= bodyBottom) {
          const nameLbl = txt(this.shopLabel(it), FS.micro, C.dark);
          nameLbl.x = px + 14; nameLbl.y = ry + 4;
          listLayer.addChild(nameLbl);
          const costLbl = txt(t('world.shopCost').replace('{coins}', String(it.cost)), FS.micro, C.mid);
          costLbl.x = px + 14; costLbl.y = ry + 18;
          listLayer.addChild(costLbl);
          const bw = 56;
          this.panelButtonIn(listLayer, t('world.shopBuy'), px + pw - bw - 14, ry + 2, bw, 24, C.accent, () => void this.ctx.net.doBuyShopItem(it.id));
        }
        ry += rowH;
      }
    }
  }

  // ── Territory Overview panel (SLG_DESIGN_LOG.md §26) ────────────────────────────
  // Opened by tapping the header resource cluster. Overview tab: production/storage +
  // troops + territory count (all already in ctx.me, no extra fetch). List tab: every
  // owned tile (can be 200-300) with a level-filter checkbox grid + jump/abandon per row —
  // fetched lazily (WorldMapNet.refreshTerritories) only when this tab is opened.

  openTerritoryPanel(): void {
    if (!this.ctx.me?.joined) { this.showToast(t('world.needBase'), C.red); return; }
    this.ctx.territoryPanelOpen = true;
    this.ctx.territoryTab = 'overview';
    this.ctx.infoScrollY = 0;
    this.renderTerritoryPanel();
  }

  private switchTerritoryTab(tab: 'overview' | 'list' | 'world'): void {
    this.ctx.territoryTab = tab;
    this.ctx.infoScrollY = 0;
    this.renderTerritoryPanel();
    if (tab === 'list') {
      void this.ctx.net.refreshTerritories().then(() => {
        if (this.ctx.territoryPanelOpen && this.ctx.territoryTab === 'list') this.renderTerritoryPanel();
      });
    } else if (tab === 'world') {
      this.loadWorldTabData();
    }
  }

  renderTerritoryPanel(): void {
    const me = this.ctx.me;
    if (!me?.joined) { this.closeModal(); return; }
    const ml = this.ctx.modalLayer;
    tearDownChildren(ml);
    this.ctx.modalBtnRects = [];

    const { w, h } = this.ctx;
    // Width doubled (420→840, still clamped to the viewport) so the enlarged
    // overview text has room to breathe.
    const pw = Math.min(840, w - 20);
    // Panel height is 80% of the page height (capped so it never overlaps the HUD).
    const ph = Math.min(h * 0.8, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.ctx.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(11, 11, pw) });
    panel.x = px; panel.y = py;
    ml.addChild(panel);

    const addText = (s: string, tx2: number, ty: number, size = 12, color: number = C.dark): void => {
      const lbl = txt(s, snapFont(size), color);
      lbl.x = tx2; lbl.y = ty;
      ml.addChild(lbl);
    };

    const title = txt(t('world.territoryTitle'), FS.tiny, C.accent);
    title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = py + 10;
    ml.addChild(title);

    // Tabs
    const tabs: { id: 'overview' | 'list' | 'world'; label: string }[] = [
      { id: 'overview', label: t('world.territoryTabOverview') },
      { id: 'list', label: t('world.territoryTabList') },
      { id: 'world', label: t('world.info') },
    ];
    const tabW = (pw - 28 - MARGIN * 2) / 3;
    let tabX = px + 14;
    const tabY = py + 34;
    for (const tab of tabs) {
      const active = this.ctx.territoryTab === tab.id;
      this.panelButton(tab.label, tabX, tabY, tabW, 26, active ? C.red : C.dark, () => this.switchTerritoryTab(tab.id));
      tabX += tabW + MARGIN;
    }

    let ly = tabY + 38;
    const bodyBottom = py + ph - 42;
    this.ctx.infoScrollRect = null;

    if (this.ctx.territoryTab === 'overview') {
      const res = me.resources ?? {};
      const yieldRate = me.yieldRate ?? {};
      const RES_LABEL: Record<string, string> = { ink: t('world.ink'), paper: t('world.paper'), graphite: t('world.graphite'), metal: t('world.metal'), sticker: t('world.sticker') };
      // Overview text enlarged ~2x per request: resource/season rows at FS.label,
      // the emphasized troops/territory lines at FS.heading; line spacing doubled to match.
      for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
        const amt = Math.floor(res[rt] ?? 0);
        const yr = Math.round(yieldRate[rt] ?? 0);
        addText(`${RES_LABEL[rt]}  ${amt}  (+${yr}/${t('world.resYield')})`, px + 14, ly, FS.label, C.dark);
        ly += 40;
      }
      ly += 16;
      addText(`${t('world.troops')} ${Math.floor(me.troops ?? 0)}/${Math.floor(me.troopCap ?? 0)}`, px + 14, ly, FS.heading, C.red);
      ly += 44;
      addText(`${t('world.territory')} ${me.territoryCount ?? 0}`, px + 14, ly, FS.heading, C.red);
      ly += 52;
      const s = this.ctx.season;
      if (s) {
        addText(t('world.seasonNo').replace('{n}', String(s.season)), px + 14, ly, FS.label, C.mid); ly += 36;
        addText(t('world.seasonPop').replace('{pop}', String(s.population)).replace('{cap}', String(s.capacity)), px + 14, ly, FS.label, C.mid); ly += 36;
      }
    } else if (this.ctx.territoryTab === 'world') {
      this.renderWorldTabBody(px, pw, ly, bodyBottom);
    } else {
      // Level-filter checkbox grid, two rows — split evenly across the levels actually present.
      const levels = Array.from(new Set(this.ctx.territories.map((tv) => tv.level))).sort((a, b) => a - b);
      if (levels.length > 0) {
        const perRow = Math.ceil(levels.length / 2);
        const chkW = (pw - 28 - MARGIN * (perRow - 1)) / perRow;
        for (let i = 0; i < levels.length; i++) {
          const lvl = levels[i]!;
          const row = i < perRow ? 0 : 1;
          const col = i < perRow ? i : i - perRow;
          const hidden = this.ctx.territoryHiddenLevels.has(lvl);
          const cx3 = px + 14 + col * (chkW + MARGIN);
          const cy3 = ly + row * 28;
          this.panelButton(`Lv.${lvl}`, cx3, cy3, chkW, 24, hidden ? C.mid : C.red, () => {
            if (hidden) this.ctx.territoryHiddenLevels.delete(lvl); else this.ctx.territoryHiddenLevels.add(lvl);
            this.renderTerritoryPanel();
          }, 10);
        }
        ly += 2 * 28 + 8;
      }

      const filtered = this.ctx.territories.filter((tv) => !this.ctx.territoryHiddenLevels.has(tv.level));
      if (filtered.length === 0) {
        addText(t('world.territoryEmpty'), px + 14, ly, 11, C.mid);
      } else {
        const rowH = 34;
        const listLayer = this.beginScrollList(px, ly, pw, bodyBottom - ly, filtered.length * rowH, () => this.renderTerritoryPanel());
        let ry = ly - this.ctx.infoScrollY;
        for (const tv of filtered) {
          if (ry + rowH >= ly && ry <= bodyBottom) {
            const label = `(${tv.x},${tv.y})  Lv.${tv.level}  ${t('world.garrison').replace('{n}', String(tv.garrison ?? 0))}`;
            const nameLbl = txt(label, FS.micro, C.dark);
            nameLbl.x = px + 14; nameLbl.y = ry + 8;
            listLayer.addChild(nameLbl);
            const btnW = 56;
            this.panelButtonIn(listLayer, t('world.territoryJump'), px + pw - btnW * 2 - 22, ry + 2, btnW, 26,
              C.accent, () => { this.ctx.view.centerAt(tv.x, tv.y); this.ctx.view.renderMap(); this.closeModal(); });
            this.panelButtonIn(listLayer, t('world.actAbandon'), px + pw - btnW - 14, ry + 2, btnW, 26,
              C.red, () => void this.ctx.net.doAbandonFromList(tv.x, tv.y));
          }
          ry += rowH;
        }
      }
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  // ── Battle replay browser (last-100 sieges) ─────────────────────────────────────

  /** Open the replay browser: fetch the recent sieges, then render the list (repaints once the fetch lands). */
  openReplayPanel(): void {
    if (!this.ctx.me?.joined) { this.showToast(t('world.needBase'), C.red); return; }
    this.ctx.replayPanelOpen = true;
    this.ctx.infoScrollY = 0;
    this.renderReplayPanel();
    void this.ctx.cb.worldApi.listSieges(this.ctx.cb.worldId)
      .then((rows) => { this.ctx.sieges = rows; if (this.ctx.replayPanelOpen) this.renderReplayPanel(); })
      .catch(() => { /* offline — keep whatever is cached */ });
  }

  /** Render the recent-sieges list as a scrollable modal; each replayable row opens the existing siege replay. */
  renderReplayPanel(): void {
    if (!this.ctx.me?.joined) { this.closeModal(); return; }
    const ml = this.ctx.modalLayer;
    tearDownChildren(ml);
    this.ctx.modalBtnRects = [];

    const { w, h } = this.ctx;
    const pw = Math.min(440, w - 20);
    const ph = Math.min(h * 0.8, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.ctx.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(12, 12, pw) });
    panel.x = px; panel.y = py;
    ml.addChild(panel);

    const title = txt(t('world.replaysTitle'), FS.tiny, C.accent);
    title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = py + 10;
    ml.addChild(title);

    const ly = py + 44;
    const bodyBottom = py + ph - 42;
    this.ctx.infoScrollRect = null;

    const rows = this.ctx.sieges;
    if (rows.length === 0) {
      const empty = txt(t('world.replaysEmpty'), FS.tiny, C.mid);
      empty.x = px + 16; empty.y = ly;
      ml.addChild(empty);
    } else {
      const rowH = 40;
      const now = Date.now();
      const listLayer = this.beginScrollList(px, ly, pw, bodyBottom - ly, rows.length * rowH, () => this.renderReplayPanel());
      let ry = ly - this.ctx.infoScrollY;
      for (const s of rows) {
        if (ry + rowH >= ly && ry <= bodyBottom) {
          const [, sx, sy] = s.tile.split(':');
          const roleTxt = s.role === 'attacker' ? t('world.replay.atk') : t('world.replay.def');
          const outTxt = s.outcome === 'attacker_win' ? t('world.replay.win')
            : s.outcome === 'defender_win' ? t('world.replay.loss') : t('world.replay.draw');
          // Win/loss is relative to the requester's role: attacker_win is a win for the attacker but a loss for the defender.
          const won = (s.role === 'attacker') === (s.outcome === 'attacker_win');
          const lvlTxt = s.tileLevel ? `Lv.${s.tileLevel}` : '';
          const label = `(${sx},${sy}) ${lvlTxt}  ${roleTxt}·${outTxt}  ${this.agoText(now - s.ts)}`;
          const rowLbl = txt(label, FS.tiny, won ? C.dark : C.red);
          rowLbl.x = px + 14; rowLbl.y = ry + 6;
          listLayer.addChild(rowLbl);
          const btnW = 72;
          if (s.hasReplay) {
            this.panelButtonIn(listLayer, t('world.replaySiege'), px + pw - btnW - 14, ry + 2, btnW, 28,
              C.accent, () => { this.closeModal(); this.ctx.cb.onReplaySiege(s.siegeId); });
          } else {
            const noRep = txt(t('world.replay.none'), FS.micro, C.mid);
            noRep.x = px + pw - btnW - 8; noRep.y = ry + 8;
            listLayer.addChild(noRep);
          }
        }
        ry += rowH;
      }
    }

    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  /** Compact "how long ago" label from a millisecond delta (m/h/d), for battle-report rows. */
  private agoText(deltaMs: number): string {
    const min = Math.max(0, Math.floor(deltaMs / 60000));
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
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
