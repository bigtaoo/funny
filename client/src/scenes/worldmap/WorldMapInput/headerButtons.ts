// WorldMapInput.handleDown's header/HUD button hit-tests: zoom, resource cluster, back, shop,
// home, auction, marches badge, replay badge, bottom chat bar. Pulled out of handleDown
// (2026-08-12, claudedocs/client-modules.md "单文件 500 行收敛") — independent-function-module
// extraction (form①): this block only ever reads ctx's rects/state and calls through to
// ctx.panels/ctx.cb/ctx.view/ctx.net, so it's a pure function taking `ctx` + the tap coordinates,
// returning whether it consumed the tap (handleDown returns immediately when it did).
//
// 2026-08-31: the nine hand-written containment tests became one `Hit[]` + `dispatchHit`
// (ui/hits.ts), which is also what gives these buttons their tap cue — the map's HUD is the one
// place in the world map that is unambiguously UI rather than terrain. A zero-width rect means
// "this button isn't drawn right now" (no main base yet, no replays), so those entries are simply
// not pushed instead of being guarded at test time.
import type { WorldMapContext } from '../WorldMapContext';
import { dispatchHit, type Hit } from '../../../ui/hits';

export function hitTestHeaderButtons(ctx: WorldMapContext, x: number, y: number): boolean {
  const hits: Hit[] = [];
  /** `optional` mirrors the old `w > 0` guards: a rect the renderer left empty is not a button. */
  const add = (rect: Hit['rect'], fn: () => void, opts?: { optional?: boolean; sound?: Hit['sound'] }): void => {
    if (opts?.optional && rect.w <= 0) return;
    hits.push({ rect, fn, sound: opts?.sound });
  };

  // Zoom button (top-left over the map)
  add(ctx.zoomBtnRect, () => ctx.view.setZoom(((ctx.zoom % 3) + 1) as 1 | 2 | 3), { optional: true });

  // Header resource cluster — opens the Territory Overview panel (SLG_DESIGN_LOG.md §26)
  add(ctx.resClusterRect, () => ctx.panels.openTerritoryPanel(), { optional: true });

  // Back button (floating top-left chip, drawn on topLayer — see WorldMapRenderer)
  add(ctx.backRect, () => ctx.cb.onBack(), { sound: 'sfx.ui.back' });

  // Shop button (header bar, immediately left of the home/auction buttons)
  add(ctx.shopBtnRect, () => ctx.panels.openShopPanel());

  // Home button (header bar, immediately left of the shop button) — recenters the camera on the
  // player's own base without leaving the world map. Omitted (zero rect) before mainBaseTile exists.
  add(ctx.homeBtnRect, () => {
    if (!ctx.me?.mainBaseTile) return;
    const [bx, by] = ctx.parseTileId(ctx.me.mainBaseTile);
    ctx.view.centerAt(bx, by);
    ctx.view.renderMap();
  }, { optional: true });

  // Auction button (left column)
  add(ctx.aucBtnRect, () => ctx.cb.onOpenAuction());

  // Team badge (right column) — toggles the expanded team panel. Opening it re-fetches the formation
  // templates: unlike the march/station state (kept live by the gateway push channel) a team's ROSTER
  // only changes in the city/formation editor, which the map never hears about, so the panel would
  // otherwise show a stale set of teams until the next world entry.
  add(ctx.teamBadgeRect, () => {
    ctx.teamPanelExpanded = !ctx.teamPanelExpanded;
    if (ctx.teamPanelExpanded) void ctx.net.refreshTeams();
    ctx.panels.renderHud();
  }, { optional: true });

  // Battle-replays badge (right column, below marches) — opens the last-100 replay browser
  add(ctx.replayBadgeRect, () => ctx.panels.openReplayPanel(), { optional: true });

  // Bottom chat bar — opens the social overlay (also the entry point to family management)
  add(ctx.chatBarRect, () => {
    ctx.markWorldChatSeen();
    ctx.cb.onOpenChat();
  }, { optional: true });

  return dispatchHit(hits, x, y);
}
