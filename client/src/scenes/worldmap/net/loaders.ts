// WorldMapNet's "fetch and cache" cluster (entry/viewport/marches/chat/me/territories), extracted
// as form① free functions (claudedocs/client-modules.md "单文件 500 行收敛") — every one of these
// already took only `this.ctx` as its dependency, so this is a near-mechanical `this.ctx` -> `ctx`
// port, no host object needed at all.
import { t } from '../../../i18n';
import type { WorldTileView } from '../../../net/WorldApiClient';
import type { WorldMapContext } from '../WorldMapContext';

/**
 * Aggregated SLG-entry fetch (P1-5, comm-audit-2026-07-27): one `POST /world/enter` round-trip
 * replaces what used to be a 9-request waterfall (season, nations, me, join, map/mapSparse,
 * march+occupations+stationed, worldChannel) fired serially/semi-parallel on every world-map entry.
 * The server resolves getMe+joinWorld itself (ADR-025 heal-on-entry semantics unchanged — see
 * worldsvc httpApi.ts's /world/enter handler) and centers the returned map window on the resolved
 * base tile, so the client no longer needs to know the base tile before requesting the map.
 */
export async function loadData(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    // r is purely a function of canvas size (independent of pan/center), so it's safe to read before
    // ctx.me / the camera center are known — see WorldMapRenderer/viewport.ts's viewportCenter().
    const { r } = ctx.view.viewportCenter();
    const entry = await ctx.cb.worldApi.enterWorld(ctx.cb.worldId, r, ctx.zoom);

    // season is null only if this worldId has no provisioned world doc yet (should not happen for a
    // real client-resolved shard) — degrade gracefully and keep the existing mapW/mapH defaults.
    if (entry.season) {
      ctx.season = entry.season;
      if (entry.season.mapW > 0) ctx.mapW = entry.season.mapW;
      if (entry.season.mapH > 0) ctx.mapH = entry.season.mapH;
    }
    ctx.nations = entry.nations;
    // City siege-point nodes for the sprite layer. Server-authoritative on purpose: a designer can drag
    // cities in tools/map-editor and publish, so the seed-derived allCityNodes() the renderer falls back
    // to is only correct for a world with no edited map template behind it.
    ctx.cityNodes = entry.cities;

    // Ensure a valid 3×3 capital exists on entry (ADR-025) — resolved server-side now (see handler
    // comment above); `justJoined` replaces the old local wasJoined-diff to gate the welcome toast.
    ctx.me = entry.me;
    if (entry.me.justJoined) ctx.panels.showToast(t('world.myBase'));
    if (entry.me.mainBaseTile) {
      const [bx, by] = ctx.parseTileId(entry.me.mainBaseTile);
      ctx.view.centerAt(bx, by);
      // SLG opening guide chain (ONBOARDING_DESIGN §4.2) step1 — highlight the newly-known main
      // city until tapped/skipped. Gated on the flag (not `entry.me.justJoined`) so a returning
      // player who joined before this feature shipped still gets it once.
      if (!(ctx.cb.getFlag?.('guide.world.step1') ?? false)) ctx.guideStep = 'step1';
    }

    if (entry.map) {
      for (const tile of entry.map.tiles) {
        ctx.tileCache.set(`${tile.x}:${tile.y}`, tile);
      }
    } else if (entry.mapSparse) {
      for (const s of entry.mapSparse.tiles) {
        // Synthesize a minimal WorldTileView; will be overwritten with full data when zoom 1 loads
        ctx.tileCache.set(`${s.x}:${s.y}`, {
          x: s.x,
          y: s.y,
          type: s.type as WorldTileView['type'],
          level: 1,
          occupied: true,
          ...(s.mine ? { mine: true } : {}),
          ...(s.ally ? { ally: true } : {}),
          ...(s.sectmate ? { sectmate: true } : {}),
          ...(s.allySect ? { allySect: true } : {}),
        });
      }
    }

    ctx.marches = entry.marches;
    ctx.occupations = entry.occupations;
    ctx.stationed = entry.stationed;
    ctx.siegeHolds = entry.siegeHolds;

    ctx.worldChatLatest = entry.worldChannel[0] ?? null; // server returns newest-first
    const seenTs = ctx.getWorldChatSeenTs();
    ctx.worldChatUnread = entry.worldChannel.filter((m) => m.ts > seenTs).length;
  } catch { /* offline OK */ }
  // Deliberately not awaited and deliberately not folded into `/world/enter`: the team panel is the
  // only consumer, and blocking first paint on it would undo the point of the single-round-trip entry.
  void refreshTeams(ctx);
  if (!ctx.destroyed) { ctx.view.renderMap(); ctx.panels.renderHud(); }
}

export async function loadMapViewport(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  const { cx, cy, r } = ctx.view.viewportCenter();
  try {
    if (ctx.zoom === 1) {
      // Full detail: owner name / garrison / watchtower / visibility gating
      const map = await ctx.cb.worldApi.getMap(ctx.cb.worldId, cx, cy, r);
      for (const tile of map.tiles) {
        ctx.tileCache.set(`${tile.x}:${tile.y}`, tile);
      }
    } else {
      // Sparse occupation layer: only occupied tiles; unoccupied tiles are rendered locally via proceduralTile
      const lod = ctx.zoom === 3 ? 'thin' : 'mid';
      const sparse = await ctx.cb.worldApi.getMapSparse(ctx.cb.worldId, cx, cy, r, lod);
      for (const s of sparse.tiles) {
        // Synthesize a minimal WorldTileView; will be overwritten with full data when zoom 1 loads
        ctx.tileCache.set(`${s.x}:${s.y}`, {
          x: s.x,
          y: s.y,
          type: s.type as WorldTileView['type'],
          level: 1,
          occupied: true,
          ...(s.mine ? { mine: true } : {}),
          ...(s.ally ? { ally: true } : {}),
          ...(s.sectmate ? { sectmate: true } : {}),
          ...(s.allySect ? { allySect: true } : {}),
        });
      }
    }
  } catch { /* offline */ }
}

/**
 * One in-flight order re-read per scene, with a trailing re-run (2026-09-26).
 *
 * Callers fire this freely — every `march_update` push, the team picker, stop-hold, recall — and each
 * used to issue its own four requests. During a five-team dispatch those piled up behind the client's
 * 5 req/s rate gate and held the player's next order back by seconds. Now a call that lands while a
 * read is in flight only marks it dirty: the loop runs once more after the current read, and every
 * caller's promise resolves after a read that STARTED after that caller asked. So "await this, then
 * read ctx" still means "fresh as of my call", which the team picker depends on.
 */
const orderRefreshes = new WeakMap<WorldMapContext, { dirty: boolean; done: Promise<void> }>();

export function refreshMarches(ctx: WorldMapContext): Promise<void> {
  const running = orderRefreshes.get(ctx);
  if (running) {
    running.dirty = true;
    return running.done;
  }
  const slot = { dirty: false, done: Promise.resolve() };
  orderRefreshes.set(ctx, slot);
  slot.done = (async () => {
    try {
      do {
        slot.dirty = false;
        await fetchOrders(ctx);
      } while (slot.dirty && !ctx.destroyed);
    } finally {
      orderRefreshes.delete(ctx);
    }
  })();
  return slot.done;
}

async function fetchOrders(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    // All four slices in one request: marches, occupations, stationed, and 围攻驻留 siege holds (a team
    // pinned to a won base/city assault is in none of the other three, so without it it read as idle).
    const orders = await ctx.cb.worldApi.getOrders(ctx.cb.worldId);
    ctx.marches = orders.marches;
    ctx.occupations = orders.occupations;
    ctx.stationed = orders.stationed;
    ctx.siegeHolds = orders.siegeHolds;
    if (!ctx.destroyed) { ctx.panels.renderHud(); ctx.view.renderMap(); }
  } catch { /* offline */ }
}

export async function refreshMe(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    ctx.me = await ctx.cb.worldApi.getMe(ctx.cb.worldId);
    if (!ctx.destroyed) ctx.panels.renderHud();
    // The overlays that make refreshMe worth calling (city, formation editor, defense editor) are the
    // same ones that can have re-armed or re-crewed a team, so pick the new rosters up here too.
    void refreshTeams(ctx);
  } catch { /* offline */ }
}

/** Full list of owned tiles (Territory Overview panel, SLG_DESIGN_LOG.md §26). Fetched on demand
 * (list tab opened), not on every viewport refetch — can be 200-300 rows. */
/**
 * ADR-074 P1: re-fetch the wild-city siege state. Called when the city info panel opens (durability
 * regenerates continuously and rival sects are hitting the same walls, so the entry-payload snapshot goes
 * stale within minutes), NOT on every map viewport refetch — 64 rows per fetch for a panel almost nobody has open is
 * not worth the bandwidth, and the durability BAR on the map only needs to be roughly right.
 */
export async function refreshCities(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    ctx.cityNodes = await ctx.cb.worldApi.getCities(ctx.cb.worldId);
  } catch { /* offline — keep the entry-payload snapshot */ }
}

/**
 * Attack-formation templates for the team panel (WorldMapPanels/hud.ts). Separate from the entry
 * payload on purpose: the map itself never needs a team's ROSTER — only the marches/occupations/
 * stationed rows, which `/world/enter` already carries — so this is fetched once right after entry
 * (so the collapsed badge can show an honest away/total from the first frame) and again whenever the
 * panel is opened or the player comes back from a screen that can have re-armed a team.
 *
 * `teamsLoaded` latches on the first success and is never cleared: an offline blip must not make the
 * panel claim the player has no teams, it should keep showing the last set it knows about.
 */
export async function refreshTeams(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    ctx.teams = await ctx.cb.worldApi.getTeams(ctx.cb.worldId);
    ctx.teamsLoaded = true;
    if (!ctx.destroyed) ctx.panels.renderHud();
  } catch { /* offline — keep whatever we already had */ }
}

export async function refreshTerritories(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    ctx.territories = await ctx.cb.worldApi.getTerritories(ctx.cb.worldId);
  } catch { /* offline */ }
}
