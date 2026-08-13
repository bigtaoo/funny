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

    ctx.worldChatLatest = entry.worldChannel[0] ?? null; // server returns newest-first
    const seenTs = ctx.getWorldChatSeenTs();
    ctx.worldChatUnread = entry.worldChannel.filter((m) => m.ts > seenTs).length;
  } catch { /* offline OK */ }
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

export async function refreshMarches(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    const [marches, occupations, stationed] = await Promise.all([
      ctx.cb.worldApi.getMarches(ctx.cb.worldId),
      ctx.cb.worldApi.getOccupations(ctx.cb.worldId),
      ctx.cb.worldApi.getStationed(ctx.cb.worldId),
    ]);
    ctx.marches = marches;
    ctx.occupations = occupations;
    ctx.stationed = stationed;
    if (!ctx.destroyed) { ctx.panels.renderHud(); ctx.view.renderMap(); }
  } catch { /* offline */ }
}

export async function refreshWorldChat(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    const msgs = await ctx.cb.worldApi.getWorldChannel(ctx.cb.worldId, { limit: 20 });
    ctx.worldChatLatest = msgs[0] ?? null; // server returns newest-first
    const seenTs = ctx.getWorldChatSeenTs();
    ctx.worldChatUnread = msgs.filter((m) => m.ts > seenTs).length;
    if (!ctx.destroyed) ctx.panels.renderHud();
  } catch { /* offline */ }
}

export async function refreshMe(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    ctx.me = await ctx.cb.worldApi.getMe(ctx.cb.worldId);
    if (!ctx.destroyed) ctx.panels.renderHud();
  } catch { /* offline */ }
}

/** Full list of owned tiles (Territory Overview panel, SLG_DESIGN_LOG.md §26). Fetched on demand
 * (list tab opened), not on the ~5s poll — can be 200-300 rows. */
export async function refreshTerritories(ctx: WorldMapContext): Promise<void> {
  if (ctx.destroyed) return;
  try {
    ctx.territories = await ctx.cb.worldApi.getTerritories(ctx.cb.worldId);
  } catch { /* offline */ }
}
