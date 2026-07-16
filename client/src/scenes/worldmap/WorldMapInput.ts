import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { WorldApiError } from '../../net/WorldApiClient';
import { baseFootprintCells, baseFootprintInBounds } from '@nw/shared';
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

  /**
   * Mirrors worldsvc's footprintOwnedBy (§3.4): true iff the whole 3×3 block anchored at (ax,ay) is owned by
   * the player right now — in bounds and every cell cached as `mine`. This is the relocate gate: the capital
   * may only move onto a 3×3 the player already fully holds, so a cell that is neutral, enemy, or not yet
   * revealed (uncached → not provably mine) disqualifies the block. The server re-validates on relocate.
   */
  private footprintAllMine(ax: number, ay: number): boolean {
    if (!baseFootprintInBounds(ax, ay, this.ctx.mapW, this.ctx.mapH)) return false;
    for (const { x, y } of baseFootprintCells(ax, ay)) {
      if (!this.ctx.tileCache.get(`${x}:${y}`)?.mine) return false;
    }
    return true;
  }

  /**
   * Client-side pre-check mirroring worldsvc's isConnectedToSectTerritory (ADR-039 "连地") for a single
   * occupy target: an occupy is only accepted if the target 4-neighbours land the player's sect already
   * holds — the player's own 3×3 capital footprint counts as guaranteed initial territory even before any
   * expansion (SLG_DESIGN §4.1). Used only to grey out the Occupy button so it's not a click-then-reject.
   *
   * Restricted to SOLO players (no familyId) on purpose: the server counts own family ∪ sibling families
   * in the same sect, but the client only tags its own family's tiles (`mine`; `ally` = same family) — a
   * sibling family's territory carries no client flag, so for anyone in a family we cannot prove the
   * target is unconnected and must NOT pre-disable (the server still validates on departure). A solo
   * player's friendly set is exactly {self}, fully known here, so the check is safe. Returns true (=allow)
   * whenever connectivity cannot be confidently disproven.
   */
  private occupyConnected(tx: number, ty: number): boolean {
    const me = this.ctx.me;
    if (me?.familyId) return true; // in a family / possibly a sect → sibling-family tiles are invisible to us; defer to the server
    const baseCells = new Set<string>();
    if (me?.mainBaseTile) {
      const [bx, by] = this.ctx.parseTileId(me.mainBaseTile);
      for (const c of baseFootprintCells(bx, by)) baseCells.add(`${c.x}:${c.y}`);
    }
    const neighbors = [{ x: tx - 1, y: ty }, { x: tx + 1, y: ty }, { x: tx, y: ty - 1 }, { x: tx, y: ty + 1 }];
    for (const n of neighbors) {
      if (n.x < 0 || n.y < 0 || n.x >= this.ctx.mapW || n.y >= this.ctx.mapH) continue;
      if (baseCells.has(`${n.x}:${n.y}`)) return true;      // borders own capital footprint (initial territory)
      if (this.ctx.tileCache.get(`${n.x}:${n.y}`)?.mine) return true; // borders own captured territory
    }
    return false;
  }

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
      // The base is an indivisible 3×3 block (ADR-025) — any cell inside its footprint counts as
      // "the city", not just the exact center anchor tile, otherwise 8 of the 9 tiles fell through
      // to the generic mine-tile menu (no Enter City / Train option) and looked like a dead click.
      const isBase = me.mainBaseTile != null && baseFootprintCells(bx, by).some((c) => c.x === tx && c.y === ty);
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
      const myButtons: { label: string; action: () => void; disabled?: boolean }[] = [
        { label: t('world.actReinforce'), action: () => this.ctx.panels.showDeployDialog(tx, ty, 'reinforce') },
        { label: t('world.actDefense'), action: () => { this.ctx.panels.closeModal(); this.ctx.cb.onOpenDefense(tileKey); } },
      ];
      // Watchtower (§18 G5 V2): build a long-radius persistent vision source on an owned tile. If a tower already exists, show a status line instead of the build button.
      if (!tile.watchtower) {
        myButtons.push({ label: t('world.actWatchtower'), action: () => this.ctx.net.confirmWatchtower(tx, ty) });
      }
      // Relocate here (§3.4): the capital may only move onto a 3×3 block the player already fully owns —
      // this clicked cell as centre plus all 8 neighbours. Offered on every owned tile so the intent is
      // discoverable; when the surrounding ring isn't all mine the button is disabled and taps explain why
      // ("occupy the surrounding tiles first"), mirroring the Occupy-connectivity gate below.
      if (me.mainBaseTile) {
        const canRelocate = this.footprintAllMine(tx, ty);
        myButtons.push({
          label: t('world.actRelocate'),
          disabled: !canRelocate,
          action: canRelocate
            ? () => this.ctx.net.confirmRelocate(tx, ty)
            : () => this.ctx.panels.showToast(t('world.err.relocateNeedSurround'), C.red),
        });
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

    // Neutral tile, mid occupation-hold (ADR-037 §5.4): the tile has no owner yet, but a pending occupier has
    // already won the PvE battle and is waiting out the hold countdown before ownership lands.
    if (tile?.contestedUntil) {
      const secLeft = Math.max(0, Math.ceil((tile.contestedUntil - Date.now()) / 1000));
      if (tile.contestedByMe) {
        // My own pending hold — nothing to do but watch the countdown (no reinforcement in v1).
        this.ctx.panels.showModal([t('world.occupyingMine').replace('{sec}', String(secLeft)), `(${tx}, ${ty})`], [
          { label: '✕', action: () => this.ctx.panels.closeModal() },
        ]);
        return;
      }
      // Someone else is holding it — offer an expelling attack instead of occupy/sweep (occupying it directly
      // would just bounce off the pending holder's contestedBy at arrival; use attack to fight their held garrison).
      const holdButtons: { label: string; action: () => void }[] = [
        { label: t('world.actAttack'), action: () => void this.ctx.net.showAttackTeamPicker(tx, ty) },
        { label: t('world.actScout'), action: () => void this.ctx.net.doScout(tx, ty) },
        { label: '✕', action: () => this.ctx.panels.closeModal() },
      ];
      this.ctx.panels.showModal([t('world.occupying').replace('{sec}', String(secLeft)), `(${tx}, ${ty})`], holdButtons);
      return;
    }

    // Neutral tile. NPC garrison present → offer sweep (march). Occupy is now a march (ADR-037 §5.4: fights the
    // tile's system garrison via the deterministic engine, then holds it for a countdown before ownership lands)
    // — same troop-count dialog as sweep/reinforce, not an instant grab.
    const garrison = tile?.garrison ?? 0;
    // ADR-039 连地: grey out Occupy when the target doesn't border the player's territory (occupy would be
    // rejected server-side with TERRITORY_NOT_CONNECTED). Tapping the disabled button explains why. Sweep is
    // not gated — it has no connectivity requirement server-side.
    const occupyConnected = this.occupyConnected(tx, ty);
    const buttons: { label: string; action: () => void; disabled?: boolean }[] = [
      {
        label: t('world.actOccupy'),
        disabled: !occupyConnected,
        action: occupyConnected
          ? () => this.ctx.panels.showDeployDialog(tx, ty, 'occupy')
          : () => this.ctx.panels.showToast(t('world.err.notConnected'), C.red),
      },
    ];
    if (garrison > 0) {
      buttons.push({ label: t('world.actSweep'), action: () => this.ctx.panels.showDeployDialog(tx, ty, 'sweep') });
    }
    // Scout: send a scout to lift distant fog / reveal an unknown tile, then auto-return (no capture).
    buttons.push({ label: t('world.actScout'), action: () => void this.ctx.net.doScout(tx, ty) });
    // (Relocate moved to the owned-tile branch: §3.4 now requires the target 3×3 to be already fully owned,
    // so relocation is initiated by clicking your own centre tile, not a neutral one.)
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
      // Scrollable list body (world-info nations/shop tabs) — begin a drag-to-scroll
      // gesture instead of closing the modal on a tap inside the list.
      const sr = this.ctx.infoScrollRect;
      if (sr && x >= sr.x && x <= sr.x + sr.w && y >= sr.y && y <= sr.y + sr.h) {
        this.ctx.infoScrollDragging = true;
        this.ctx.infoScrollDragMoved = false;
        this.ctx.infoScrollDragStartY = y;
        this.ctx.infoScrollDragStartScroll = this.ctx.infoScrollY;
        return;
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

    // Begin drag (only inside the map band — below the header bar, above the chat HUD)
    if (y > this.ctx.topInset && y < this.ctx.h - HUD_H) {
      this.ctx.dragging = true;
      this.ctx.dragMoved = false;
      this.ctx.dragStartX = x - this.ctx.panX;
      this.ctx.dragStartY = y - this.ctx.panY;
    }
  }

  handleMove(x: number, y: number): void {
    if (this.ctx.infoScrollDragging) {
      const dy = y - this.ctx.infoScrollDragStartY;
      if (Math.abs(dy) > 6) this.ctx.infoScrollDragMoved = true;
      if (this.ctx.infoScrollDragMoved) {
        const next = Math.max(0, Math.min(this.ctx.infoMaxScroll, this.ctx.infoScrollDragStartScroll - dy));
        if (next !== this.ctx.infoScrollY) {
          this.ctx.infoScrollY = next;
          this.ctx.panels.renderInfoPanel();
        }
      }
      return;
    }
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
        // refreshPool() short-circuits the tile pool at L3 but still repositions city
        // sprites (refreshCityLayer) — without this, city sprites keep whatever screen
        // position they were last drawn at and appear to drift with the camera instead
        // of tracking the map while panning at L3.
        this.ctx.view.refreshCityLayer();
        this.ctx.view.renderOverlay();
      }
    }
  }

  handleUp(x: number, y: number): void {
    if (this.ctx.infoScrollDragging) {
      this.ctx.infoScrollDragging = false;
      return;
    }
    if (!this.ctx.dragging) return;
    const wasDragging = this.ctx.dragMoved;
    this.ctx.dragging = false;

    if (!wasDragging && y > this.ctx.topInset && y < this.ctx.h - HUD_H) {
      const { x: tx, y: ty } = this.ctx.view.screenToTile(x, y);
      this.onTileClick(tx, ty);
    } else if (wasDragging) {
      // Lazy-load new viewport tiles after pan
      void this.ctx.net.loadMapViewport().then(() => {
        if (!this.ctx.destroyed) this.ctx.view.renderMap();
      });
    }
  }

  /** Mouse-wheel scroll over the world-info panel's scrollable list (browser only). */
  handleWheel(x: number, y: number, deltaY: number): void {
    const sr = this.ctx.infoScrollRect;
    if (!sr || x < sr.x || x > sr.x + sr.w || y < sr.y || y > sr.y + sr.h) return;
    const next = Math.max(0, Math.min(this.ctx.infoMaxScroll, this.ctx.infoScrollY + deltaY));
    if (next !== this.ctx.infoScrollY) {
      this.ctx.infoScrollY = next;
      this.ctx.panels.renderInfoPanel();
    }
  }
}
