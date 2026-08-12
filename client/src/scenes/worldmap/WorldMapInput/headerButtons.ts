// WorldMapInput.handleDown's header/HUD button hit-tests: zoom, resource cluster, back, shop,
// home, auction, marches badge, replay badge, bottom chat bar. Pulled out of handleDown
// (2026-08-12, claudedocs/client-modules.md "单文件 500 行收敛") — independent-function-module
// extraction (form①): this block only ever reads ctx's rects/state and calls through to
// ctx.panels/ctx.cb/ctx.view/ctx.net, so it's a pure function taking `ctx` + the tap coordinates,
// returning whether it consumed the tap (handleDown returns immediately when it did).
import type { WorldMapContext } from '../WorldMapContext';

export function hitTestHeaderButtons(ctx: WorldMapContext, x: number, y: number): boolean {
  // Zoom button (top-left over the map)
  const zb = ctx.zoomBtnRect;
  if (zb.w > 0 && x >= zb.x && x <= zb.x + zb.w && y >= zb.y && y <= zb.y + zb.h) {
    ctx.view.setZoom(((ctx.zoom % 3) + 1) as 1 | 2 | 3);
    return true;
  }

  // Header resource cluster — opens the Territory Overview panel (SLG_DESIGN_LOG.md §26)
  const rc = ctx.resClusterRect;
  if (rc.w > 0 && x >= rc.x && x <= rc.x + rc.w && y >= rc.y && y <= rc.y + rc.h) {
    ctx.panels.openTerritoryPanel();
    return true;
  }

  // Back button (floating top-left chip, drawn on topLayer — see WorldMapRenderer)
  const b = ctx.backRect;
  if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
    ctx.cb.onBack();
    return true;
  }

  // Shop button (header bar, immediately left of the home/auction buttons)
  const sb = ctx.shopBtnRect;
  if (x >= sb.x && x <= sb.x + sb.w && y >= sb.y && y <= sb.y + sb.h) {
    ctx.panels.openShopPanel();
    return true;
  }

  // Home button (header bar, immediately left of the shop button) — recenters the camera on the
  // player's own base without leaving the world map. Omitted (zero rect) before mainBaseTile exists.
  const hb = ctx.homeBtnRect;
  if (hb.w > 0 && x >= hb.x && x <= hb.x + hb.w && y >= hb.y && y <= hb.y + hb.h) {
    if (ctx.me?.mainBaseTile) {
      const [bx, by] = ctx.parseTileId(ctx.me.mainBaseTile);
      ctx.view.centerAt(bx, by);
      ctx.view.renderMap();
    }
    return true;
  }

  // Auction button (left column)
  const a = ctx.aucBtnRect;
  if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) {
    ctx.cb.onOpenAuction();
    return true;
  }

  // Marches badge (right column) — toggles the expanded list
  const mb = ctx.marchBadgeRect;
  if (mb.w > 0 && x >= mb.x && x <= mb.x + mb.w && y >= mb.y && y <= mb.y + mb.h) {
    ctx.marchesExpanded = !ctx.marchesExpanded;
    ctx.panels.renderHud();
    return true;
  }

  // Battle-replays badge (right column, below marches) — opens the last-100 replay browser
  const rb = ctx.replayBadgeRect;
  if (rb.w > 0 && x >= rb.x && x <= rb.x + rb.w && y >= rb.y && y <= rb.y + rb.h) {
    ctx.panels.openReplayPanel();
    return true;
  }

  // Bottom chat bar — opens the social overlay (also the entry point to family management)
  const cbr = ctx.chatBarRect;
  if (cbr.w > 0 && x >= cbr.x && x <= cbr.x + cbr.w && y >= cbr.y && y <= cbr.y + cbr.h) {
    ctx.markWorldChatSeen();
    ctx.cb.onOpenChat();
    return true;
  }

  return false;
}
