import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { WorldApiError } from '../../net/WorldApiClient';
import { serverNow } from '../../net/serverClock';
import type { TeamTemplate } from '../../net/WorldApiClient';
import { carriedTroops, teamDisplayName } from '../../game/meta/teamTroops';
import { proceduralTile, ARROW_TOWER_COST, BLOCKER_COST } from '@nw/shared';
import { loadResAtlas, getResTexture, isResAtlasReady } from '../../render/resAtlasLoader';
import { loadCityAtlas, getCityTexture, isCityAtlasReady } from '../../render/cityAtlasLoader';
import { loadTerrainAtlas, getTerrainTexture, isTerrainAtlasReady } from '../../render/terrainAtlasLoader';
import { loadBuildingAtlas, getBuildingTexture, isBuildingAtlasReady } from '../../render/buildingAtlasLoader';
import { ISO_RATIO, tileToScreen, screenToTile, screenToTileF, diamondPath, diamondVertices, visibleTileBounds } from '../../render/isoGrid';
import { DEFAULT_MAP_SIZE, HUD_H, MARGIN, CONFIRM_H, BASE_SPRITE_TILES, RELOCATE_COST, WATCHTOWER_COST_METAL, WATCHTOWER_COST_PAPER } from './constants';
import { TERRAIN_COLORS, RES_COLORS, MINE_TINT, MINE_BASE_TINT, ENEMY_TINT, ENEMY_BASE_TINT, ALLY_TINT, ALLY_BASE_TINT, FOG_COLOR, CLOUD_COLOR, ALLY_SECT_BORDER, ownerTint, terrainFill, terrainTextureName, tileColor, proceduralTileColor } from './tileStyle';
import { makeZoomCfgs } from './zoom';
import { drawTileL1, drawTileL2, drawResMotif, drawResMotifFallback, drawCityIcon, drawHpBar, placeBuildingSprite, drawStar } from './tileGraphics';
import type { IconKind } from '../../render/icons';
import type { WorldApiClient, WorldTileView, PlayerWorldView, MarchView, NationView, SeasonView, SlgShopItemView } from '../../net/WorldApiClient';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult, NationMsg } from '../../net/proto/transport';
import type { ProceduralTile } from '@nw/shared';
import type { TerrainTextureName } from '../../render/terrainAtlasLoader';
import type { ZoomCfg, PoolSlot } from './zoom';
import type { WorldMapContext, WorldMapCallbacks, DeployKind } from './WorldMapContext';

export class WorldMapNet {
  constructor(private readonly ctx: WorldMapContext) {}

  /**
   * Teams with a dispatch in flight (startMarch sent, response not yet applied to ctx.marches).
   * Closes the double-dispatch window: a player could pick a team for tile A, then — before the
   * server response refreshes ctx.marches — open the picker on tile B and pick the same team again,
   * sending it out twice. Held here from the tap until the response lands (or errors) so the picker's
   * idle-team gate treats it as busy in the meantime. Server enforces the same rule authoritatively.
   */
  private pendingTeamIds = new Set<string>();

  /**
   * Aggregated SLG-entry fetch (P1-5, comm-audit-2026-07-27): one `POST /world/enter` round-trip
   * replaces what used to be a 9-request waterfall (season, nations, me, join, map/mapSparse,
   * march+occupations+stationed, worldChannel) fired serially/semi-parallel on every world-map entry.
   * The server resolves getMe+joinWorld itself (ADR-025 heal-on-entry semantics unchanged — see
   * worldsvc httpApi.ts's /world/enter handler) and centers the returned map window on the resolved
   * base tile, so the client no longer needs to know the base tile before requesting the map.
   */
  async loadData(): Promise<void> {
    if (this.ctx.destroyed) return;
    try {
      // r is purely a function of canvas size (independent of pan/center), so it's safe to read before
      // this.ctx.me / the camera center are known — see WorldMapRenderer/viewport.ts's viewportCenter().
      const { r } = this.ctx.view.viewportCenter();
      const entry = await this.ctx.cb.worldApi.enterWorld(this.ctx.cb.worldId, r, this.ctx.zoom);

      // season is null only if this worldId has no provisioned world doc yet (should not happen for a
      // real client-resolved shard) — degrade gracefully and keep the existing mapW/mapH defaults.
      if (entry.season) {
        this.ctx.season = entry.season;
        if (entry.season.mapW > 0) this.ctx.mapW = entry.season.mapW;
        if (entry.season.mapH > 0) this.ctx.mapH = entry.season.mapH;
      }
      this.ctx.nations = entry.nations;

      // Ensure a valid 3×3 capital exists on entry (ADR-025) — resolved server-side now (see handler
      // comment above); `justJoined` replaces the old local wasJoined-diff to gate the welcome toast.
      this.ctx.me = entry.me;
      if (entry.me.justJoined) this.ctx.panels.showToast(t('world.myBase'));
      if (entry.me.mainBaseTile) {
        const [bx, by] = this.ctx.parseTileId(entry.me.mainBaseTile);
        this.ctx.view.centerAt(bx, by);
      }

      if (entry.map) {
        for (const tile of entry.map.tiles) {
          this.ctx.tileCache.set(`${tile.x}:${tile.y}`, tile);
        }
      } else if (entry.mapSparse) {
        for (const s of entry.mapSparse.tiles) {
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

      this.ctx.marches = entry.marches;
      this.ctx.occupations = entry.occupations;
      this.ctx.stationed = entry.stationed;

      this.ctx.worldChatLatest = entry.worldChannel[0] ?? null; // server returns newest-first
      const seenTs = this.ctx.getWorldChatSeenTs();
      this.ctx.worldChatUnread = entry.worldChannel.filter((m) => m.ts > seenTs).length;
    } catch { /* offline OK */ }
    if (!this.ctx.destroyed) { this.ctx.view.renderMap(); this.ctx.panels.renderHud(); }
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
      const [marches, occupations, stationed] = await Promise.all([
        this.ctx.cb.worldApi.getMarches(this.ctx.cb.worldId),
        this.ctx.cb.worldApi.getOccupations(this.ctx.cb.worldId),
        this.ctx.cb.worldApi.getStationed(this.ctx.cb.worldId),
      ]);
      this.ctx.marches = marches;
      this.ctx.occupations = occupations;
      this.ctx.stationed = stationed;
      if (!this.ctx.destroyed) { this.ctx.panels.renderHud(); this.ctx.view.renderMap(); }
    } catch { /* offline */ }
  }

  async refreshWorldChat(): Promise<void> {
    if (this.ctx.destroyed) return;
    try {
      const msgs = await this.ctx.cb.worldApi.getWorldChannel(this.ctx.cb.worldId, { limit: 20 });
      this.ctx.worldChatLatest = msgs[0] ?? null; // server returns newest-first
      const seenTs = this.ctx.getWorldChatSeenTs();
      this.ctx.worldChatUnread = msgs.filter((m) => m.ts > seenTs).length;
      if (!this.ctx.destroyed) this.ctx.panels.renderHud();
    } catch { /* offline */ }
  }

  async refreshMe(): Promise<void> {
    if (this.ctx.destroyed) return;
    try {
      this.ctx.me = await this.ctx.cb.worldApi.getMe(this.ctx.cb.worldId);
      if (!this.ctx.destroyed) this.ctx.panels.renderHud();
    } catch { /* offline */ }
  }

  /** Returns the tile coordinate of the viewport center + a radius to fetch. */

  /**
   * Team picker for a team-based march. kind='attack' (siege a real player / stronghold) or 'occupy'
   * (grab neutral land, §4.2): both attach an attack-formation team so the committed troops belong to the
   * team's cards (cardState.currentTroops), not the flat pool — survivors are retained on the cards and the
   * team can march on after its occupation hold, instead of the pool troops being consumed as garrison.
   * For occupy we also keep the legacy "散兵占领" flat-pool option, so early players with no card team can
   * still grab land the old way.
   */
  async showTeamPicker(tx: number, ty: number, kind: 'attack' | 'occupy' | 'move' = 'attack', stationMode?: 'idle' | 'garrison'): Promise<void> {
    const me = this.ctx.me;
    if (!me?.joined || !me.mainBaseTile) { this.ctx.panels.showToast(t('world.needBase'), C.red); return; }
    let teams: TeamTemplate[] = [];
    try {
      teams = await this.ctx.cb.worldApi.getTeams(this.ctx.cb.worldId);
    } catch { /* offline — treat as empty */ }
    // Idle-team gate (2026-07-15): a team already committed to an active (non-recalled) march — marching or
    // holding a captured tile — must not accept a new order (mirrors the server-side TEAM_BUSY check in
    // combatMarch.ts, which checks both `marches` and `occupations`).
    // ADR-051 (P3c): a 停留 idle field team is NOT busy — it can be re-commanded (move / 就地占领) straight from
    // where it stands, so only 驻扎 garrison stationed teams count as busy here (mirrors the relaxed server gate).
    const busyTeamIds = new Set([
      ...this.ctx.marches.filter((m) => m.mine && m.teamId).map((m) => m.teamId),
      ...this.ctx.occupations.filter((o) => o.teamId).map((o) => o.teamId),
      ...this.ctx.stationed.filter((s) => s.mine !== false && s.mode === 'garrison').map((s) => s.teamId), // own 驻扎 = locked; own 停留 idle = free; enemy stationed ignored (teamId blanked anyway)
      ...this.pendingTeamIds, // in-flight dispatch not yet reflected in ctx.marches
    ]);
    // Committed troops = the strength the team actually CARRIES, from each card's cardState.currentTroops
    // ledger (§6.1). Legacy pre-migration teams (unit entries, no cardInstanceId) carry 0 — they can't be
    // dispatched, so they read 0 here and drop out of `usable` below (see teamTroops.ts). Mirrors
    // CityScene.committedTroops / TeamsScene so the picker shows the same number as those screens.
    const cardState = me.cardState ?? {};
    const committedOf = (tm: TeamTemplate): number => carriedTroops(tm.army, cardState);
    // Only offer teams that can actually go into battle right now: non-empty army, not already
    // out on a march/hold, and carrying troops > 0 (a wiped-out or legacy team can't fight).
    const usable = teams.filter((tm) => tm.army.length > 0 && !busyTeamIds.has(tm.id) && committedOf(tm) > 0);
    const buttons: { label: string; action: () => void }[] = [];
    for (const tm of usable) {
      const committed = committedOf(tm);
      buttons.push({
        label: `${teamDisplayName(tm)} · ${t('world.team.committed').replace('{n}', String(committed))}`,
        action: () => void this.doMarchTeam(tx, ty, tm.id, kind, stationMode),
      });
    }
    buttons.push({ label: '✕', action: () => this.ctx.panels.closeModal() });
    // 移动并驻扎 (stationMode==='garrison') gets its own picker title so the intent is unmistakable at team-select time.
    const moveTitle = stationMode === 'garrison' ? t('world.team.pickTitleGarrison') : t('world.team.pickTitleMove');
    const head = usable.length > 0
      ? (kind === 'occupy' ? t('world.team.pickTitleOccupy') : kind === 'move' ? moveTitle : t('world.team.pickTitle'))
      : (kind === 'occupy' ? t('world.team.noTeamsOccupy') : kind === 'move' ? t('world.team.noTeamsMove') : t('world.team.noTeams'));
    this.ctx.panels.showModal([head, `(${tx}, ${ty})`], buttons);
  }

  async doMarchTeam(tx: number, ty: number, teamId: string, kind: 'attack' | 'occupy' | 'move' = 'attack', stationMode?: 'idle' | 'garrison'): Promise<void> {
    this.ctx.panels.closeModal();
    const me = this.ctx.me;
    if (!me?.mainBaseTile) { this.ctx.panels.showToast(t('world.needBase'), C.red); return; }
    // Guard against a second dispatch of the same team while the first is still in flight (see pendingTeamIds).
    if (this.pendingTeamIds.has(teamId)) { this.ctx.panels.showToast(t('world.team.busy'), C.red); return; }
    this.pendingTeamIds.add(teamId);
    // Origin is always the main base for a fresh dispatch. ADR-051 (P3c): if the picked team is actually a 停留
    // idle field team being re-commanded, worldsvc overrides fromX/fromY to its stationed cell server-side, so
    // passing the base coords here is harmless (the client can't send a wrong origin that matters).
    const [fx, fy] = this.ctx.parseTileId(me.mainBaseTile);
    try {
      // troops=1 is a placeholder; the server overwrites it with the team's committed troop count (§16.2).
      // P1-3 (comm-audit-2026-07-27): startMarch's response already carries the created march + updated
      // `me` (troops/resources committed) — locally append/adopt both instead of following up with
      // GET /world/march + GET /world/me. `mine` isn't set on the raw march object (only getMarches'
      // list-assembly stamps it, since only it knows who's asking) — a march THIS call just dispatched
      // is unconditionally the caller's own, so it's safe to stamp true here directly.
      const { me, ...march } = await this.ctx.cb.worldApi.startMarch(this.ctx.cb.worldId, fx, fy, tx, ty, kind, 1, teamId, stationMode);
      if (kind === 'attack') this.ctx.myAttackTiles.add(march.toTile);
      else if (kind === 'occupy') this.ctx.myOccupyTiles.add(march.toTile);
      this.ctx.marches = [...this.ctx.marches, { ...march, mine: true }];
      if (me) this.ctx.me = me; // defensive: never null out the cached state if a response omits it
      this.ctx.panels.showToast(t('world.dispatched'));
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    } finally {
      this.pendingTeamIds.delete(teamId);
    }
  }

  /**
   * ADR-051 (P4 §4.3): 就地占领 — an idle 停留 team standing on a neutral tile occupies that very tile without
   * marching. Dispatched as a normal team `occupy` on the tile the team already stands on: worldsvc's P3c
   * idle-redispatch forces the origin to the team's stationed cell (= this tile), so origin === destination →
   * a zero-distance occupy that fights the tile's NPC garrison and, on winning the hold, flips it to owned with
   * the team left standing there (idle). Reuses doMarchTeam verbatim (pendingTeamIds guard, occupy toast/refresh).
   */
  async doInPlaceOccupy(tx: number, ty: number, teamId: string): Promise<void> {
    await this.doMarchTeam(tx, ty, teamId, 'occupy');
  }

  async doMarch(tx: number, ty: number, kind: DeployKind, troops: number): Promise<void> {
    this.ctx.panels.closeModal();
    const me = this.ctx.me;
    if (!me?.mainBaseTile) { this.ctx.panels.showToast(t('world.needBase'), C.red); return; }
    if (troops < 1) { this.ctx.panels.showToast(t('world.err.noTroops'), C.red); return; }
    const [fx, fy] = this.ctx.parseTileId(me.mainBaseTile);
    try {
      // P1-3: see doMarchTeam's comment above — adopt march + me from the response directly.
      const { me, ...march } = await this.ctx.cb.worldApi.startMarch(this.ctx.cb.worldId, fx, fy, tx, ty, kind, troops);
      if (kind === 'attack') this.ctx.myAttackTiles.add(march.toTile);
      else if (kind === 'occupy') this.ctx.myOccupyTiles.add(march.toTile);
      this.ctx.marches = [...this.ctx.marches, { ...march, mine: true }];
      if (me) this.ctx.me = me; // defensive: never null out the cached state if a response omits it
      this.ctx.panels.showToast(t('world.dispatched'));
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Join the world: the system automatically places the capital (§3.4, preferring proximity to the family); the position is determined by the server. After placement, pan the camera to the new capital. */

  async doJoin(): Promise<void> {
    this.ctx.panels.closeModal();
    try {
      this.ctx.me = await this.ctx.cb.worldApi.joinWorld(this.ctx.cb.worldId);
      this.ctx.panels.showToast(t('world.myBase'));
      if (this.ctx.me.mainBaseTile) {
        const [bx, by] = this.ctx.parseTileId(this.ctx.me.mainBaseTile);
        this.ctx.view.centerAt(bx, by);
      }
      await this.loadMapViewport();
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  async doRecall(marchId: string, worldId: string): Promise<void> {
    try {
      await this.ctx.cb.worldApi.recallMarch(marchId, worldId);
      this.ctx.marches = await this.ctx.cb.worldApi.getMarches(this.ctx.cb.worldId);
      this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Pay coins to instantly complete an in-transit 'return' march (2026-08-01, SLG_DESIGN_LOG §46). */
  async doInstantReturn(marchId: string, worldId: string): Promise<void> {
    try {
      this.ctx.me = await this.ctx.cb.worldApi.instantReturnMarch(marchId, worldId);
      this.ctx.marches = await this.ctx.cb.worldApi.getMarches(this.ctx.cb.worldId);
      this.ctx.panels.showToast(t('world.instantReturnDone'));
      this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Recall a team stationed on a tile back home (2026-07-23): dispatches a return leg, then refreshes the map. */
  async doRecallStationed(teamId: string): Promise<void> {
    this.ctx.panels.closeModal();
    try {
      await this.ctx.cb.worldApi.recallStationed(teamId, this.ctx.cb.worldId);
      const [marches, stationed] = await Promise.all([
        this.ctx.cb.worldApi.getMarches(this.ctx.cb.worldId),
        this.ctx.cb.worldApi.getStationed(this.ctx.cb.worldId),
      ]);
      this.ctx.marches = marches;
      this.ctx.stationed = stationed;
      this.ctx.panels.showToast(t('world.stationRecalled'));
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Second confirmation before relocation (shows cost); confirm → doRelocate. */

  confirmRelocate(tx: number, ty: number): void {
    this.ctx.panels.showModal(
      [t('world.relocateTitle'), t('world.relocateConfirm').replace('{n}', String(RELOCATE_COST))],
      [
        { label: t('world.relocateBtn'), action: () => this.doRelocate(tx, ty) },
        { label: '✕', action: () => this.ctx.panels.closeModal() },
      ],
    );
  }

  async doRelocate(tx: number, ty: number): Promise<void> {
    this.ctx.panels.closeModal();
    try {
      this.ctx.me = await this.ctx.cb.worldApi.relocateBase(this.ctx.cb.worldId, tx, ty);
      this.ctx.tileCache.clear(); // capital position changed + old location reverts to neutral — re-fetch the entire viewport
      if (this.ctx.me.mainBaseTile) {
        const [bx, by] = this.ctx.parseTileId(this.ctx.me.mainBaseTile);
        this.ctx.view.centerAt(bx, by);
      }
      await this.loadMapViewport();
      this.ctx.panels.showToast(t('world.relocated'));
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Second confirmation before building a watchtower (shows resource cost); confirm → doWatchtower. */

  confirmWatchtower(tx: number, ty: number): void {
    this.ctx.panels.showModal(
      [
        t('world.watchtowerTitle'),
        t('world.watchtowerConfirm')
          .replace('{paper}', String(WATCHTOWER_COST_PAPER))
          .replace('{metal}', String(WATCHTOWER_COST_METAL)),
      ],
      [
        { label: t('world.watchtowerBtn'), action: () => void this.doWatchtower(tx, ty) },
        { label: '✕', action: () => this.ctx.panels.closeModal() },
      ],
    );
  }

  async doWatchtower(tx: number, ty: number): Promise<void> {
    this.ctx.panels.closeModal();
    try {
      // P1-3: buildWatchtower's response now carries `me` (resources deducted) directly — adopt it
      // instead of a separate GET /world/me.
      const { me } = await this.ctx.cb.worldApi.buildWatchtower(this.ctx.cb.worldId, tx, ty);
      if (me) this.ctx.me = me; // defensive: never null out the cached state if a response omits it
      this.ctx.tileCache.clear();                                  // new tower expands vision → re-fetch entire viewport to reveal tiles
      await this.loadMapViewport();
      this.ctx.panels.showToast(t('world.watchtowerBuilt'));
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  /** ADR-051 (P5): confirm dialog (shows resource cost) before building a structure; confirm → doBuildStructure. */
  confirmBuildStructure(tx: number, ty: number, kind: 'arrowTower' | 'blocker'): void {
    const cost = kind === 'arrowTower' ? ARROW_TOWER_COST : BLOCKER_COST;
    this.ctx.panels.showModal(
      [
        t(kind === 'arrowTower' ? 'world.arrowTowerTitle' : 'world.blockerTitle'),
        t('world.structureConfirm')
          .replace('{paper}', String(cost.paper ?? 0))
          .replace('{metal}', String(cost.metal ?? 0)),
      ],
      [
        { label: t('world.buildBtn'), action: () => void this.doBuildStructure(tx, ty, kind) },
        { label: '✕', action: () => this.ctx.panels.closeModal() },
      ],
    );
  }

  async doBuildStructure(tx: number, ty: number, kind: 'arrowTower' | 'blocker'): Promise<void> {
    this.ctx.panels.closeModal();
    try {
      // P1-3: buildStructure's response now carries `me` (resources deducted) directly — adopt it
      // instead of a separate GET /world/me.
      const { me } = await this.ctx.cb.worldApi.buildStructure(this.ctx.cb.worldId, tx, ty, kind);
      if (me) this.ctx.me = me; // defensive: never null out the cached state if a response omits it
      this.ctx.tileCache.delete(`${tx}:${ty}`);
      await this.loadMapViewport();
      this.ctx.panels.showToast(t('world.structureBuilt'));
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  async doDemolishStructure(tx: number, ty: number): Promise<void> {
    this.ctx.panels.closeModal();
    try {
      await this.ctx.cb.worldApi.demolishStructure(this.ctx.cb.worldId, tx, ty);
      this.ctx.tileCache.delete(`${tx}:${ty}`);
      await this.loadMapViewport();
      this.ctx.panels.showToast(t('world.structureDemolished'));
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  async doAbandon(tx: number, ty: number): Promise<void> {
    this.ctx.panels.closeModal();
    try {
      // P1-3: abandonTile already returns the full updated player world state — adopt it directly
      // instead of a separate GET /world/me (was previously discarded and re-fetched, see finding B).
      this.ctx.me = await this.ctx.cb.worldApi.abandonTile(this.ctx.cb.worldId, tx, ty);
      // Remove from cache so it shows as empty
      this.ctx.tileCache.delete(`${tx}:${ty}`);
      await this.loadMapViewport();
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Full list of owned tiles (Territory Overview panel, SLG_DESIGN_LOG.md §26). Fetched on demand
   * (list tab opened), not on the ~5s poll — can be 200-300 rows. */
  async refreshTerritories(): Promise<void> {
    if (this.ctx.destroyed) return;
    try {
      this.ctx.territories = await this.ctx.cb.worldApi.getTerritories(this.ctx.cb.worldId);
    } catch { /* offline */ }
  }

  /** Same as doAbandon but for a row in the Territory Overview list: keeps the panel open and
   * refreshes the list in place instead of closing the modal. */
  async doAbandonFromList(tx: number, ty: number): Promise<void> {
    try {
      // P1-3: same as doAbandon above — adopt `me` from the response directly.
      this.ctx.me = await this.ctx.cb.worldApi.abandonTile(this.ctx.cb.worldId, tx, ty);
      this.ctx.tileCache.delete(`${tx}:${ty}`);
      await Promise.all([this.loadMapViewport(), this.refreshTerritories()]);
      this.ctx.view.renderMap(); this.ctx.panels.renderHud();
      if (this.ctx.territoryPanelOpen) this.ctx.panels.renderTerritoryPanel();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── World info panel (C5): nations / season / SLG shop ───────────────────────
  // Tabbed modal rendered into modalLayer. Season is read-only; nations lets the
  // capital owner rename theirs (setNationName, server re-checks ownerId). The shop
  // buys via worldApi.buyShopItem → commercial.spend (server-authoritative, toast on
  // INSUFFICIENT_FUNDS) and shows the SaveData coin balance via the getCoins callback.

  async doBuyShopItem(itemId: string): Promise<void> {
    try {
      // P1-3: buyShopItem already returns the full updated player world state — adopt it directly
      // instead of a separate refreshMe() round-trip.
      this.ctx.me = await this.ctx.cb.worldApi.buyShopItem(this.ctx.cb.worldId, itemId);
      this.ctx.panels.showToast(t('world.shopBought'));
      if (this.ctx.territoryPanelOpen && this.ctx.territoryTab === 'world') this.ctx.panels.renderTerritoryPanel();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
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
      if (this.ctx.territoryPanelOpen && this.ctx.territoryTab === 'world') this.ctx.panels.renderTerritoryPanel();
    } catch (e) {
      this.ctx.panels.showToast(this.errorMsg(e), C.red);
    }
  }

  applyMarchUpdate(_m: MarchUpdate): void {
    if (this.ctx.destroyed) return;
    void this.refreshMarches();
  }

  /**
   * Real-time world/nation channel message (gateway push, worldsvc → gateway). Previously dropped
   * entirely (client had no onNationMsg handler) while a 5s poll (refreshWorldChat) re-fetched the
   * same data — this updates the HUD's latest-message + unread count immediately from the push
   * payload instead of waiting on the next poll tick.
   */
  applyNationMsg(n: NationMsg): void {
    if (this.ctx.destroyed) return;
    this.ctx.worldChatLatest = { id: `push:${n.ts}:${n.fromPublicId}`, senderId: n.fromPublicId, senderPublicId: n.fromPublicId, senderName: n.fromName, body: n.text, ts: n.ts };
    if (n.ts > this.ctx.getWorldChatSeenTs()) this.ctx.worldChatUnread += 1;
    if (!this.ctx.destroyed) this.ctx.panels.renderHud();
  }

  applyTileUpdate(tu: TileUpdate): void {
    if (this.ctx.destroyed) return;
    // D-CITY-8: flag whether this push is our own main base losing durability, so the full-screen
    // vignette flash (WorldMapRenderer/vignette.ts) can fire once the fresh hp value is in cache.
    // TileUpdate itself carries no hp field (see transport.proto), so we diff the cached view before/after.
    const isOwnBase = !!this.ctx.me?.mainBaseTile && tu.tileId === this.ctx.me.mainBaseTile;
    const [bx, by] = isOwnBase ? this.ctx.parseTileId(tu.tileId) : [0, 0];
    const prevHp = isOwnBase ? this.ctx.tileCache.get(`${bx}:${by}`)?.hp : undefined;
    void this.loadMapViewport().then(() => {
      if (this.ctx.destroyed) return;
      if (isOwnBase) {
        const nowHp = this.ctx.tileCache.get(`${bx}:${by}`)?.hp;
        if (prevHp != null && nowHp != null && nowHp < prevHp) this.ctx.view.flashDamageVignette();
      }
      this.ctx.view.renderMap();
    });
  }

  applyUnderAttack(u: UnderAttack): void {
    if (this.ctx.destroyed) return;
    const [tx, ty] = this.ctx.parseTileId(u.tile);
    const sec = Math.max(0, Math.ceil((u.arriveAt - serverNow()) / 1000));
    const name = u.attackerName || ('#' + (u.attackerPublicId || '?'));
    this.ctx.panels.showToast(
      `${t('world.underAttack')} ${t('world.underAttackMsg')
        .replace('{name}', name)
        .replace('{tile}', `(${tx},${ty})`)
        .replace('{sec}', String(sec))}`,
      C.red,
    );
  }

  applySiegeResult(s: SiegeResult): void {
    if (this.ctx.destroyed) return;
    // The attacking march is about to drop off `ctx.marches` (refreshMarches below) and get torn
    // down by fog.ts syncMarchTokens — mark it to keep playing 'attacking' a beat longer instead
    // of vanishing instantly. Default duration covers the case the .tao asset hasn't loaded yet.
    if (s.marchId) {
      const entry = this.ctx.marchTokenRuntimes.get(s.marchId);
      if (entry) {
        // A 'dot' LOD token has no clip/duration concept — it's a static sprite, so the default
        // beat below covers it (its container is torn down the same as a stickman's either way).
        const durSec = (entry.mode === 'stickman' && entry.runtime?.currentDuration) || 0.6;
        this.ctx.marchAttackUntil.set(s.marchId, Date.now() + durSec * 1000);
      }
    }
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
      this.ctx.panels.showModal(
        [line],
        [
          { label: t('world.replaySiege'), action: () => { this.ctx.panels.closeModal(); this.ctx.cb.onReplaySiege(s.siegeId); } },
          { label: '✕', action: () => this.ctx.panels.closeModal() },
        ],
      );
    } else if (this.ctx.myOccupyTiles.has(s.tile)) {
      // We launched an occupy (PvE land-grab, ADR-037). It reports back as a SiegeResult but is our own action —
      // a win begins the occupation hold, a non-win means the NPC garrison held. Lightweight toast (no replay
      // modal): occupy is high-frequency expansion, unlike a deliberate PvP siege.
      this.ctx.myOccupyTiles.delete(s.tile);
      const line = s.outcome === 'attacker_win' ? t('world.occupyWin') : t('world.occupyLoss');
      this.ctx.panels.showToast(line, s.outcome === 'attacker_win' ? C.dark : C.red);
    } else {
      // We were the defender (or a bystander) — toast only.
      const line = s.outcome === 'attacker_win' ? t('world.defendLost') : t('world.defendHeld');
      this.ctx.panels.showToast(line, s.outcome === 'attacker_win' ? C.red : C.dark);
    }
  }

  errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      // worldsvc reuses TILE_OCCUPIED for both "someone else already owns this exact tile" and "the 3×3
      // capital footprint doesn't fit/fully fit here" (ADR-025) — the generic "tile occupied" copy is
      // misleading for the latter (client cache can go stale between the pre-check and this round trip),
      // so match on the server's distinguishing message text before falling back to the generic mapping.
      if (e.code === 'TILE_OCCUPIED' && /3.3/.test(e.message)) return t('world.err.footprintBlocked');
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
        TERRITORY_NOT_CONNECTED: t('world.err.notConnected'),
        TEAM_BUSY:     t('world.team.busy'),
        SATCHEL_CAP_EXCEEDED: t('world.err.satchelCap'),
        // battle_pass single-slot gate (2026-08-01 fix) — same copy as the pre-emptively greyed-out shop row.
        ALREADY_ACTIVE: t('world.shopAlreadyActive'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Pan ───────────────────────────────────────────────────────────────────

  // ── Lifecycle: split out of the original WorldMapScene ctor+destroy ──

  /**
   * P1-2 (comm-audit-2026-07-27): this used to run a 5s setInterval re-fetching
   * marches/occupations/stationed/worldChannel unconditionally — 100% redundant with the gateway
   * push channel, which already fires on every actual state change:
   *   - march dispatch/recall/arrival  → march_update  → applyMarchUpdate()   → refreshMarches()
   *   - siege settlement               → siege_result  → applySiegeResult()  → refreshMarches() (+ me/map)
   *   - world/nation chat message      → nation_msg    → applyNationMsg()    (P0-5, local update, no refetch)
   * Push delivery latency (worldsvc's 2s scheduler tick) was already *lower* than the poll interval,
   * so the timer was pure background tax, not a reliability backstop. What replaced it as the
   * "nothing periodically refreshes anymore" concern is the per-second HUD tick (P1-1,
   * WorldMapRenderer/lifecycle.ts) — that keeps countdown text moving between events using the
   * already-cached state, so removing this timer doesn't freeze the display, only the extra requests.
   * start()/destroy() are kept as the lifecycle hook pair WorldMapScene already calls; both are now
   * no-ops rather than removing the pairing from every call site.
   */
  start(): void { /* intentionally no-op — see doc comment above */ }

  destroy(): void { /* intentionally no-op — nothing left to tear down (see start()) */ }
}
