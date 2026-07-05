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

export class WorldMapInput {
  constructor(private readonly ctx: WorldMapContext) {}

  onTileClick(tx: number, ty: number): void {
    if (tx < 0 || ty < 0 || tx >= this.ctx.mapW || ty >= this.ctx.mapH) return;
    this.ctx.selectedTile = { x: tx, y: ty };
    this.ctx.view.renderMap();

    const tile = this.ctx.tileCache.get(`${tx}:${ty}`);
    const me = this.ctx.me;

    if (!me?.joined) {
      // Not yet placed (normally auto-placed on map entry; this is the manual-retry path for the world-full / no-slot fallback).
      // The system picks the location automatically; the tap coordinate is no longer used for placement.
      this.ctx.panels.showModal(
        [t('world.joinTitle'), t('world.confirmJoin')],
        [
          { label: t('world.confirmJoinBtn'), action: () => void this.ctx.net.doJoin() },
          { label: '✕', action: () => this.ctx.panels.closeModal() },
        ],
      );
      return;
    }

    if (tile?.mine) {
      // My tile — reinforce (march from base) + abandon. Base itself: no actions.
      const [bx, by] = me.mainBaseTile ? this.ctx.parseTileId(me.mainBaseTile) : [-1, -1];
      const isBase = bx === tx && by === ty;
      if (isBase) {
        // Main city — enter desk / defense / teams.
        this.ctx.panels.showModal(
          [t('world.myBase'), `(${tx}, ${ty})`],
          [
            { label: t('world.actEnterCity'), action: () => { this.ctx.panels.closeModal(); this.ctx.cb.onOpenCity(); } },
            { label: t('world.train'), action: () => { this.ctx.panels.closeModal(); this.ctx.panels.openTrainPanel(); } },
            { label: t('world.actDefense'), action: () => { this.ctx.panels.closeModal(); this.ctx.cb.onOpenDefense('base'); } },
            { label: t('world.team.manage'), action: () => { this.ctx.panels.closeModal(); this.ctx.cb.onOpenTeams(); } },
            { label: '✕', action: () => this.ctx.panels.closeModal() },
          ],
        );
        return;
      }
      const tileKey = `${this.ctx.cb.worldId}:${tx}:${ty}`;
      const myButtons: { label: string; action: () => void }[] = [
        { label: t('world.actReinforce'), action: () => this.ctx.panels.showDeployDialog(tx, ty, 'reinforce') },
        { label: t('world.actDefense'), action: () => { this.ctx.panels.closeModal(); this.ctx.cb.onOpenDefense(tileKey); } },
      ];
      // Watchtower (§18 G5 V2): build a long-radius persistent vision source on an owned tile. If a tower already exists, show a status line instead of the build button.
      if (!tile.watchtower) {
        myButtons.push({ label: t('world.actWatchtower'), action: () => this.ctx.net.confirmWatchtower(tx, ty) });
      }
      myButtons.push({ label: t('world.actAbandon'), action: () => this.ctx.net.doAbandon(tx, ty) });
      myButtons.push({ label: '✕', action: () => this.ctx.panels.closeModal() });
      const head = tile.watchtower ? [t('world.mine'), t('world.hasWatchtower'), `(${tx}, ${ty})`] : [t('world.mine'), `(${tx}, ${ty})`];
      this.ctx.panels.showModal(head, myButtons);
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
        buttons.push({ label: t('world.actAttack'), action: () => void this.ctx.net.showAttackTeamPicker(tx, ty) });
      }
      // Scout: no attack, no capture — send a scout to reveal enemy info / defenses then auto-return (scouting is also allowed during a protection window).
      buttons.push({ label: t('world.actScout'), action: () => void this.ctx.net.doScout(tx, ty) });
      buttons.push({ label: '✕', action: () => this.ctx.panels.closeModal() });
      const enemyHead = [t('world.enemyTile'), ownerLine, `(${tx}, ${ty})`];
      if (tile.maxHp && tile.hp != null) enemyHead.push(t('world.buildingHp').replace('{hp}', String(tile.hp)).replace('{max}', String(tile.maxHp)));
      this.ctx.panels.showModal(enemyHead, buttons);
      return;
    }

    if (tile?.type === 'center') {
      this.ctx.panels.showToast(t('world.center'));
      return;
    }

    // Stronghold (G8 §3.1): while unoccupied it is an ultra-strong NPC garrison — cannot be directly occupied or swept, only besieged (march with a team). Once captured it becomes a territory tile handled by the mine/occupied branches above.
    if (tile?.type === 'stronghold') {
      this.ctx.panels.showModal(
        [t('world.stronghold'), t('world.strongholdHint'), `(${tx}, ${ty})`],
        [
          { label: t('world.actAttack'), action: () => void this.ctx.net.showAttackTeamPicker(tx, ty) },
          { label: t('world.actScout'), action: () => void this.ctx.net.doScout(tx, ty) },
          { label: '✕', action: () => this.ctx.panels.closeModal() },
        ],
      );
      return;
    }

    // Neutral tile. NPC garrison present → offer sweep (march). Always offer
    // direct occupy (S8-1, in-range; server rejects out-of-range).
    const garrison = tile?.garrison ?? 0;
    const buttons: { label: string; action: () => void }[] = [
      { label: t('world.actOccupy'), action: () => this.ctx.net.doOccupy(tx, ty) },
    ];
    if (garrison > 0) {
      buttons.push({ label: t('world.actSweep'), action: () => this.ctx.panels.showDeployDialog(tx, ty, 'sweep') });
    }
    // Scout: send a scout to lift distant fog / reveal an unknown tile, then auto-return (no capture).
    buttons.push({ label: t('world.actScout'), action: () => void this.ctx.net.doScout(tx, ty) });
    // Voluntary relocation (§3.4): if the player already has a capital and the target tile is placeable (not obstacle/gate), spend 500 coins to move the capital here.
    const relocatable = this.ctx.me?.mainBaseTile && tile?.type !== 'obstacle' && tile?.type !== 'gate';
    if (relocatable) {
      buttons.push({ label: t('world.actRelocate'), action: () => this.ctx.net.confirmRelocate(tx, ty) });
    }
    buttons.push({ label: '✕', action: () => this.ctx.panels.closeModal() });
    const head = garrison > 0 ? t('world.garrison').replace('{n}', String(garrison)) : t('world.actOccupy');
    this.ctx.panels.showModal([head, `(${tx}, ${ty})`], buttons);
  }

  // ── Deploy (troop-count dialog) ──────────────────────────────────────────────────
  // Pick how many troops to send for a march action. Presets ¼ / ½ / all of the
  // available pool. March source is the player's main base. Server enforces the
  // per-kind minimums (occupy/attack need OCCUPY_MIN_TROOPS) → toast on reject.

  handleDown(x: number, y: number): void {
    // Modal buttons
    if (this.ctx.modalDimRect) {
      for (const { rect, action } of this.ctx.modalBtnRects) {
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          action();
          return;
        }
      }
      this.ctx.panels.closeModal();
      return;
    }

    // Zoom button (top-left over the map)
    const zb = this.ctx.zoomBtnRect;
    if (zb.w > 0 && x >= zb.x && x <= zb.x + zb.w && y >= zb.y && y <= zb.y + zb.h) {
      this.ctx.view.setZoom(((this.ctx.zoom % 3) + 1) as 1 | 2 | 3);
      return;
    }

    // World info button (floats top-right over the map)
    const ib = this.ctx.infoBtnRect;
    if (ib.w > 0 && x >= ib.x && x <= ib.x + ib.w && y >= ib.y && y <= ib.y + ib.h) {
      this.ctx.panels.openInfoPanel();
      return;
    }

    // Back button (floating top-left chip, drawn on topLayer — see WorldMapRenderer)
    const b = this.ctx.backRect;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      this.ctx.cb.onBack();
      return;
    }

    // Auction button (left column)
    const a = this.ctx.aucBtnRect;
    if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) {
      this.ctx.cb.onOpenAuction();
      return;
    }

    // Marches badge (right column) — toggles the expanded list
    const mb = this.ctx.marchBadgeRect;
    if (mb.w > 0 && x >= mb.x && x <= mb.x + mb.w && y >= mb.y && y <= mb.y + mb.h) {
      this.ctx.marchesExpanded = !this.ctx.marchesExpanded;
      this.ctx.panels.renderHud();
      return;
    }

    // Bottom chat bar — opens the social overlay (also the entry point to family management)
    const cbr = this.ctx.chatBarRect;
    if (cbr.w > 0 && x >= cbr.x && x <= cbr.x + cbr.w && y >= cbr.y && y <= cbr.y + cbr.h) {
      this.ctx.markWorldChatSeen();
      this.ctx.cb.onOpenChat();
      return;
    }

    // March row hit detection (recall button or click-to-center)
    for (const entry of this.ctx.marchRowRects) {
      if (entry.recallRect) {
        const r = entry.recallRect;
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
          void this.ctx.net.doRecall(entry.marchId, entry.worldId);
          return;
        }
      }
      const row = entry.rowRect;
      if (x >= row.x && x <= row.x + row.w && y >= row.y && y <= row.y + row.h) {
        this.ctx.view.centerAt(entry.destX, entry.destY);
        this.ctx.view.renderMap();
        return;
      }
    }

    // Begin drag
    if (y < this.ctx.h - HUD_H) {
      this.ctx.dragging = true;
      this.ctx.dragMoved = false;
      this.ctx.dragStartX = x - this.ctx.panX;
      this.ctx.dragStartY = y - this.ctx.panY;
    }
  }

  handleMove(x: number, y: number): void {
    if (!this.ctx.dragging) return;
    const dx = x - (this.ctx.dragStartX + this.ctx.panX);
    const dy = y - (this.ctx.dragStartY + this.ctx.panY);
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) this.ctx.dragMoved = true;
    if (this.ctx.dragMoved) {
      this.ctx.panX = x - this.ctx.dragStartX;
      this.ctx.panY = y - this.ctx.dragStartY;
      this.ctx.view.clampPan();
      // L1/L2: pool reposition — cheap, no Graphics.clear() needed.
      // L3: just flag dirty; actual redraw happens in update() at most 60fps.
      if (this.ctx.zoom < 3) {
        this.ctx.view.refreshPool();
        this.ctx.view.renderOverlay();
      } else {
        this.ctx.l3Dirty = true;
        this.ctx.view.renderOverlay();
      }
    }
  }

  handleUp(x: number, y: number): void {
    if (!this.ctx.dragging) return;
    const wasDragging = this.ctx.dragMoved;
    this.ctx.dragging = false;

    if (!wasDragging && y < this.ctx.h - HUD_H) {
      const { x: tx, y: ty } = this.ctx.view.screenToTile(x, y);
      this.onTileClick(tx, ty);
    } else if (wasDragging) {
      // Lazy-load new viewport tiles after pan
      void this.ctx.net.loadMapViewport().then(() => {
        if (!this.ctx.destroyed) this.ctx.view.renderMap();
      });
    }
  }
}
