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

export class WorldMapNet {
  constructor(private readonly ctx: WorldMapContext) {}

  async loadData(): Promise<void> {
    if (this.ctx.destroyed) return;
    // Map bounds + nations are world-static; fetch once up front (best-effort).
    try {
      const season = await this.ctx.cb.worldApi.getSeason(this.ctx.cb.worldId);
      this.ctx.season = season;
      if (season.mapW > 0) this.ctx.mapW = season.mapW;
      if (season.mapH > 0) this.ctx.mapH = season.mapH;
    } catch { /* offline — keep defaults */ }
    try {
      this.ctx.nations = await this.ctx.cb.worldApi.getNations(this.ctx.cb.worldId);
    } catch { /* offline — no nation overlay */ }
    try {
      this.ctx.me = await this.ctx.cb.worldApi.getMe(this.ctx.cb.worldId);
      // Ensure a valid 3×3 capital exists on entry (ADR-025). joinWorld is the single heal point:
      //   • not joined     → system auto-places the capital (§3.4, prefers proximity to family);
      //   • healthy 3×3    → idempotent no-op, returns current state;
      //   • corrupt/legacy → worldsvc purges the stale data and re-places a fresh 3×3, so the player
      //     re-enters as a brand-new user (fixes a pre-ADR-025 single-tile base rendering no city).
      // Always call it (not only when unjoined) so a corrupt base can't leave the player stuck.
      // World full / no slot / offline → keep whatever getMe returned; do not block map entry.
      const wasJoined = this.ctx.me.joined;
      try {
        this.ctx.me = await this.ctx.cb.worldApi.joinWorld(this.ctx.cb.worldId);
        if (!wasJoined) this.ctx.view.showToast(t('world.myBase'));
      } catch { /* world full / no slot available / offline — keep current state */ }
      if (this.ctx.me.mainBaseTile) {
        const [bx, by] = this.ctx.parseTileId(this.ctx.me.mainBaseTile);
        this.ctx.view.centerAt(bx, by);
      }
      await this.loadMapViewport();
      await this.refreshMarches();
    } catch { /* offline OK */ }
    if (!this.ctx.destroyed) { this.ctx.view.renderMap(); this.ctx.view.renderHud(); }
  }

  async loadMapViewport(): Promise<void> {
    if (this.ctx.destroyed) return;
    const { cx, cy, r } = this.ctx.view.viewportCenter();
    try {
      if (this.ctx.zoom === 1) {
        // Full detail: owner name / garrison / watchtower / visibility gating
        const map = await this.ctx.cb.worldApi.getMap(this.ctx.cb.worldId, cx, cy, r);
        for (const tile of map.tiles) {
          this.ctx.tileCache.set(`${tile.x}:${tile.y}`, tile);
        }
      } else {
        // Sparse occupation layer: only occupied tiles; unoccupied tiles are rendered locally via proceduralTile
        const lod = this.ctx.zoom === 3 ? 'thin' : 'mid';
        const sparse = await this.ctx.cb.worldApi.getMapSparse(this.ctx.cb.worldId, cx, cy, r, lod);
        for (const s of sparse.tiles) {
          // Synthesize a minimal WorldTileView; will be overwritten with full data when zoom 1 loads
          this.ctx.tileCache.set(`${s.x}:${s.y}`, {
            x: s.x,
            y: s.y,
            type: s.type as WorldTileView['type'],
            level: 1,
            occupied: true,
            ...(s.mine ? { mine: true } : {}),
            ...(s.ally ? { ally: true } : {}),
            ...(s.allySect ? { allySect: true } : {}),
          });
        }
      }
    } catch { /* offline */ }
  }

  async refreshMarches(): Promise<void> {
    if (this.ctx.destroyed) return;
    try {
      this.ctx.marches = await this.ctx.cb.worldApi.getMarches(this.ctx.cb.worldId);
      if (!this.ctx.destroyed) { this.ctx.view.renderHud(); this.ctx.view.renderMap(); }
    } catch { /* offline */ }
  }

  async refreshMe(): Promise<void> {
    if (this.ctx.destroyed) return;
    try {
      this.ctx.me = await this.ctx.cb.worldApi.getMe(this.ctx.cb.worldId);
      if (!this.ctx.destroyed) this.ctx.view.renderHud();
    } catch { /* offline */ }
  }

  /** Returns the tile coordinate of the viewport center + a radius to fetch. */

  async showAttackTeamPicker(tx: number, ty: number): Promise<void> {
    const me = this.ctx.me;
    if (!me?.joined || !me.mainBaseTile) { this.ctx.view.showToast(t('world.needBase'), C.red); return; }
    let teams: { id: string; name: string; army: { initialHp?: number }[] }[] = [];
    try {
      teams = await this.ctx.cb.worldApi.getTeams(this.ctx.cb.worldId);
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
    buttons.push({ label: t('world.team.manage'), action: () => this.ctx.cb.onOpenTeams() });
    buttons.push({ label: '✕', action: () => this.ctx.view.closeModal() });
    const head = usable.length > 0 ? t('world.team.pickTitle') : t('world.team.noTeams');
    this.ctx.view.showModal([head, `(${tx}, ${ty})`], buttons);
  }

  async doMarchTeam(tx: number, ty: number, teamId: string): Promise<void> {
    this.ctx.view.closeModal();
    const me = this.ctx.me;
    if (!me?.mainBaseTile) { this.ctx.view.showToast(t('world.needBase'), C.red); return; }
    const [fx, fy] = this.ctx.parseTileId(me.mainBaseTile);
    try {
      // troops=1 is a placeholder; the server overwrites it with the team's committed troop count (§16.2).
      const march = await this.ctx.cb.worldApi.startMarch(this.ctx.cb.worldId, fx, fy, tx, ty, 'attack', 1, teamId);
      this.ctx.myAttackTiles.add(march.toTile);
      this.ctx.marches = await this.ctx.cb.worldApi.getMarches(this.ctx.cb.worldId);
      this.ctx.me = await this.ctx.cb.worldApi.getMe(this.ctx.cb.worldId);
      this.ctx.view.showToast(t('world.dispatched'));
      this.ctx.view.renderMap(); this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  async doMarch(tx: number, ty: number, kind: DeployKind, troops: number): Promise<void> {
    this.ctx.view.closeModal();
    const me = this.ctx.me;
    if (!me?.mainBaseTile) { this.ctx.view.showToast(t('world.needBase'), C.red); return; }
    if (troops < 1) { this.ctx.view.showToast(t('world.err.noTroops'), C.red); return; }
    const [fx, fy] = this.ctx.parseTileId(me.mainBaseTile);
    try {
      const march = await this.ctx.cb.worldApi.startMarch(this.ctx.cb.worldId, fx, fy, tx, ty, kind, troops);
      if (kind === 'attack') this.ctx.myAttackTiles.add(march.toTile);
      this.ctx.marches = await this.ctx.cb.worldApi.getMarches(this.ctx.cb.worldId);
      this.ctx.me = await this.ctx.cb.worldApi.getMe(this.ctx.cb.worldId);
      this.ctx.view.showToast(t('world.dispatched'));
      this.ctx.view.renderMap(); this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  /**
   * Scout march: send 1 scout (minimum troops, does not lock the main army) to the target tile,
   * revealing a wider vision radius along the route and at the destination (VISION_SCOUT_RADIUS),
   * then auto-return. No attack, no capture — dispatched directly without the troop-count dialog
   * (scouting is meant to be lightweight).
   */

  async doScout(tx: number, ty: number): Promise<void> {
    this.ctx.view.closeModal();
    const me = this.ctx.me;
    if (!me?.mainBaseTile) { this.ctx.view.showToast(t('world.needBase'), C.red); return; }
    if ((me.troops ?? 0) < 1) { this.ctx.view.showToast(t('world.err.noTroops'), C.red); return; }
    const [fx, fy] = this.ctx.parseTileId(me.mainBaseTile);
    try {
      await this.ctx.cb.worldApi.startMarch(this.ctx.cb.worldId, fx, fy, tx, ty, 'scout', 1);
      this.ctx.marches = await this.ctx.cb.worldApi.getMarches(this.ctx.cb.worldId);
      this.ctx.me = await this.ctx.cb.worldApi.getMe(this.ctx.cb.worldId);
      this.ctx.view.showToast(t('world.scoutSent'));
      this.ctx.view.renderMap(); this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Join the world: the system automatically places the capital (§3.4, preferring proximity to the family); the position is determined by the server. After placement, pan the camera to the new capital. */

  async doJoin(): Promise<void> {
    this.ctx.view.closeModal();
    try {
      this.ctx.me = await this.ctx.cb.worldApi.joinWorld(this.ctx.cb.worldId);
      this.ctx.view.showToast(t('world.myBase'));
      if (this.ctx.me.mainBaseTile) {
        const [bx, by] = this.ctx.parseTileId(this.ctx.me.mainBaseTile);
        this.ctx.view.centerAt(bx, by);
      }
      await this.loadMapViewport();
      this.ctx.view.renderMap(); this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  async doOccupy(tx: number, ty: number): Promise<void> {
    this.ctx.view.closeModal();
    try {
      await this.ctx.cb.worldApi.occupyTile(this.ctx.cb.worldId, tx, ty);
      this.ctx.me = await this.ctx.cb.worldApi.getMe(this.ctx.cb.worldId);
      await this.loadMapViewport();
      this.ctx.view.showToast(t('world.occupied'));
      this.ctx.view.renderMap(); this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  async doRecall(marchId: string, worldId: string): Promise<void> {
    try {
      await this.ctx.cb.worldApi.recallMarch(marchId, worldId);
      this.ctx.marches = await this.ctx.cb.worldApi.getMarches(this.ctx.cb.worldId);
      this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Second confirmation before relocation (shows cost); confirm → doRelocate. */

  confirmRelocate(tx: number, ty: number): void {
    this.ctx.view.showModal(
      [t('world.relocateTitle'), t('world.relocateConfirm').replace('{n}', String(RELOCATE_COST))],
      [
        { label: t('world.relocateBtn'), action: () => this.doRelocate(tx, ty) },
        { label: '✕', action: () => this.ctx.view.closeModal() },
      ],
    );
  }

  async doRelocate(tx: number, ty: number): Promise<void> {
    this.ctx.view.closeModal();
    try {
      this.ctx.me = await this.ctx.cb.worldApi.relocateBase(this.ctx.cb.worldId, tx, ty);
      this.ctx.tileCache.clear(); // capital position changed + old location reverts to neutral — re-fetch the entire viewport
      if (this.ctx.me.mainBaseTile) {
        const [bx, by] = this.ctx.parseTileId(this.ctx.me.mainBaseTile);
        this.ctx.view.centerAt(bx, by);
      }
      await this.loadMapViewport();
      this.ctx.view.showToast(t('world.relocated'));
      this.ctx.view.renderMap(); this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Second confirmation before building a watchtower (shows resource cost); confirm → doWatchtower. */

  confirmWatchtower(tx: number, ty: number): void {
    this.ctx.view.showModal(
      [
        t('world.watchtowerTitle'),
        t('world.watchtowerConfirm')
          .replace('{paper}', String(WATCHTOWER_COST_PAPER))
          .replace('{metal}', String(WATCHTOWER_COST_METAL)),
      ],
      [
        { label: t('world.watchtowerBtn'), action: () => void this.doWatchtower(tx, ty) },
        { label: '✕', action: () => this.ctx.view.closeModal() },
      ],
    );
  }

  async doWatchtower(tx: number, ty: number): Promise<void> {
    this.ctx.view.closeModal();
    try {
      await this.ctx.cb.worldApi.buildWatchtower(this.ctx.cb.worldId, tx, ty);
      this.ctx.me = await this.ctx.cb.worldApi.getMe(this.ctx.cb.worldId); // resources deducted — refresh local state
      this.ctx.tileCache.clear();                                  // new tower expands vision → re-fetch entire viewport to reveal tiles
      await this.loadMapViewport();
      this.ctx.view.showToast(t('world.watchtowerBuilt'));
      this.ctx.view.renderMap(); this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  async doAbandon(tx: number, ty: number): Promise<void> {
    this.ctx.view.closeModal();
    try {
      await this.ctx.cb.worldApi.abandonTile(this.ctx.cb.worldId, tx, ty);
      this.ctx.me = await this.ctx.cb.worldApi.getMe(this.ctx.cb.worldId);
      // Remove from cache so it shows as empty
      this.ctx.tileCache.delete(`${tx}:${ty}`);
      await this.loadMapViewport();
      this.ctx.view.renderMap(); this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── Train / resource panel (C4) ─────────────────────────────────────────────
  // A richer modal than showModal: full resources + yield, recruit presets, the
  // live training queue (countdown), and a one-tap coin speedup. Rendered into
  // modalLayer (reusing modalBtnRects for hit detection + dim-to-close), and
  // re-painted ~1s by update() so the queue countdowns tick.

  async doTrain(qty: number): Promise<void> {
    try {
      this.ctx.me = await this.ctx.cb.worldApi.trainTroops(this.ctx.cb.worldId, qty);
      this.ctx.view.showToast(t('world.trained'));
      if (this.ctx.trainPanelOpen) this.ctx.view.renderTrainPanel();
      this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  async doSpeedup(coins: number): Promise<void> {
    try {
      this.ctx.me = await this.ctx.cb.worldApi.speedupTraining(this.ctx.cb.worldId, coins);
      this.ctx.view.showToast(t('world.spedup'));
      if (this.ctx.trainPanelOpen) this.ctx.view.renderTrainPanel();
      this.ctx.view.renderHud();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── World info panel (C5): nations / season / SLG shop ───────────────────────
  // Tabbed modal rendered into modalLayer. Season is read-only; nations lets the
  // capital owner rename theirs (setNationName, server re-checks ownerId). The shop
  // buys via worldApi.buyShopItem → commercial.spend (server-authoritative, toast on
  // INSUFFICIENT_FUNDS) and shows the SaveData coin balance via the getCoins callback.

  async doBuyShopItem(itemId: string): Promise<void> {
    try {
      await this.ctx.cb.worldApi.buyShopItem(this.ctx.cb.worldId, itemId);
      this.ctx.view.showToast(t('world.shopBought'));
      await this.refreshMe();
      if (this.ctx.modalDimRect && !this.ctx.trainPanelOpen) this.ctx.view.renderInfoPanel();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── Live push (worldsvc → gateway → NetSession → here, §14.5) ────────────────
  // Wired by createAppCore: it points session.handlers at these while the world
  // map is on-screen. Each one does a targeted authoritative refetch then redraws
  // — cheaper than hand-merging the push payload into the cached views.

  async doRename(capitalIdx: number, name: string): Promise<void> {
    try {
      await this.ctx.cb.worldApi.setNationName(this.ctx.cb.worldId, capitalIdx, name);
      const n = this.ctx.nations.find(x => x.capitalIdx === capitalIdx);
      if (n) n.nationName = name;
      if (this.ctx.modalDimRect && !this.ctx.trainPanelOpen) this.ctx.view.renderInfoPanel();
    } catch (e) {
      this.ctx.view.showToast(this.errorMsg(e), C.red);
    }
  }

  applyMarchUpdate(_m: MarchUpdate): void {
    if (this.ctx.destroyed) return;
    void this.refreshMarches();
  }

  applyTileUpdate(_tu: TileUpdate): void {
    if (this.ctx.destroyed) return;
    void this.loadMapViewport().then(() => { if (!this.ctx.destroyed) this.ctx.view.renderMap(); });
  }

  applyUnderAttack(u: UnderAttack): void {
    if (this.ctx.destroyed) return;
    const [tx, ty] = this.ctx.parseTileId(u.tile);
    const sec = Math.max(0, Math.ceil((u.arriveAt - Date.now()) / 1000));
    const name = u.attackerName || ('#' + (u.attackerPublicId || '?'));
    this.ctx.view.showToast(
      `${t('world.underAttack')} ${t('world.underAttackMsg')
        .replace('{name}', name)
        .replace('{tile}', `(${tx},${ty})`)
        .replace('{sec}', String(sec))}`,
      C.red,
    );
  }

  applySiegeResult(s: SiegeResult): void {
    if (this.ctx.destroyed) return;
    // Ownership / resources / troops may all have shifted — refetch the lot.
    void this.loadMapViewport().then(() => { if (!this.ctx.destroyed) this.ctx.view.renderMap(); });
    void this.refreshMe();
    void this.refreshMarches();

    if (this.ctx.myAttackTiles.has(s.tile)) {
      // We attacked — show the outcome + offer replay & verify (anti-cheat, C2).
      const loot = s.lootSummary ?? '';
      const line = s.outcome === 'attacker_win' ? t('world.siegeWin').replace('{loot}', loot)
        : s.outcome === 'defender_win' ? t('world.siegeLoss')
        : t('world.siegeDraw');
      this.ctx.view.showModal(
        [line],
        [
          { label: t('world.replaySiege'), action: () => { this.ctx.view.closeModal(); this.ctx.cb.onReplaySiege(s.siegeId); } },
          { label: '✕', action: () => this.ctx.view.closeModal() },
        ],
      );
    } else {
      // We were the defender (or a bystander) — toast only.
      const line = s.outcome === 'attacker_win' ? t('world.defendLost') : t('world.defendHeld');
      this.ctx.view.showToast(line, s.outcome === 'attacker_win' ? C.red : C.dark);
    }
  }

  errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      const map: Record<string, string> = {
        WORLD_FULL:    t('world.err.worldFull'),
        NO_TROOPS:     t('world.err.noTroops'),
        TILE_OCCUPIED: t('world.err.occupied'),
        PROTECTED:     t('world.err.protected'),
        ALLY_TILE:     t('world.err.allyTile'),
        OUT_OF_RANGE:  t('world.err.outOfRange'),
        NOT_OWNER:     t('world.err.notOwner'),
        NOT_IMPLEMENTED: t('world.err.notImpl'),
        TROOP_CAP_REACHED:      t('world.err.troopCap'),
        INSUFFICIENT_RESOURCES: t('world.err.noInk'),
        PATH_BLOCKED:  t('world.err.pathBlocked'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Pan ───────────────────────────────────────────────────────────────────

  // ── Lifecycle: march poll, split out of the original WorldMapScene ctor+destroy ──

  start(): void {
    this.ctx.marchPoll = setInterval(() => { if (!this.ctx.destroyed) this.refreshMarches(); }, 5000);
  }

  destroy(): void {
    if (this.ctx.marchPoll) { clearInterval(this.ctx.marchPoll); this.ctx.marchPoll = null; }
  }
}
