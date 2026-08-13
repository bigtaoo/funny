// WorldMapNet's tile-action cluster (relocate/watchtower/structures/abandon) + the world-info panel
// actions (shop buy / nation rename), extracted as form① free functions (claudedocs/
// client-modules.md "单文件 500 行收敛"). Every one of these already took only `this.ctx` as its
// dependency, so this is a near-mechanical `this.ctx` -> `ctx` port.
import { t } from '../../../i18n';
import { ui as C } from '../../../render/sketchUi';
import { ARROW_TOWER_COST, BLOCKER_COST } from '@nw/shared';
import { RELOCATE_COST, WATCHTOWER_COST_METAL, WATCHTOWER_COST_PAPER } from '../constants';
import type { WorldMapContext } from '../WorldMapContext';
import { loadMapViewport, refreshTerritories } from './loaders';
import { errorMsg } from './errors';

/** Second confirmation before relocation (shows cost); confirm → doRelocate. */
export function confirmRelocate(ctx: WorldMapContext, tx: number, ty: number): void {
  ctx.panels.showModal(
    [t('world.relocateTitle'), t('world.relocateConfirm').replace('{n}', String(RELOCATE_COST))],
    [
      { label: t('world.relocateBtn'), action: () => void doRelocate(ctx, tx, ty) },
      { label: '✕', action: () => ctx.panels.closeModal() },
    ],
  );
}

export async function doRelocate(ctx: WorldMapContext, tx: number, ty: number): Promise<void> {
  ctx.panels.closeModal();
  try {
    ctx.me = await ctx.cb.worldApi.relocateBase(ctx.cb.worldId, tx, ty);
    ctx.tileCache.clear(); // capital position changed + old location reverts to neutral — re-fetch the entire viewport
    if (ctx.me.mainBaseTile) {
      const [bx, by] = ctx.parseTileId(ctx.me.mainBaseTile);
      ctx.view.centerAt(bx, by);
    }
    await loadMapViewport(ctx);
    ctx.panels.showToast(t('world.relocated'));
    ctx.view.renderMap(); ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

/** Second confirmation before building a watchtower (shows resource cost); confirm → doWatchtower. */
export function confirmWatchtower(ctx: WorldMapContext, tx: number, ty: number): void {
  ctx.panels.showModal(
    [
      t('world.watchtowerTitle'),
      t('world.watchtowerConfirm')
        .replace('{paper}', String(WATCHTOWER_COST_PAPER))
        .replace('{metal}', String(WATCHTOWER_COST_METAL)),
    ],
    [
      { label: t('world.watchtowerBtn'), action: () => void doWatchtower(ctx, tx, ty) },
      { label: '✕', action: () => ctx.panels.closeModal() },
    ],
  );
}

export async function doWatchtower(ctx: WorldMapContext, tx: number, ty: number): Promise<void> {
  ctx.panels.closeModal();
  try {
    // P1-3: buildWatchtower's response now carries `me` (resources deducted) directly — adopt it
    // instead of a separate GET /world/me.
    const { me } = await ctx.cb.worldApi.buildWatchtower(ctx.cb.worldId, tx, ty);
    if (me) ctx.me = me; // defensive: never null out the cached state if a response omits it
    ctx.tileCache.clear();                                  // new tower expands vision → re-fetch entire viewport to reveal tiles
    await loadMapViewport(ctx);
    ctx.panels.showToast(t('world.watchtowerBuilt'));
    ctx.view.renderMap(); ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

/** ADR-051 (P5): confirm dialog (shows resource cost) before building a structure; confirm → doBuildStructure. */
export function confirmBuildStructure(ctx: WorldMapContext, tx: number, ty: number, kind: 'arrowTower' | 'blocker'): void {
  const cost = kind === 'arrowTower' ? ARROW_TOWER_COST : BLOCKER_COST;
  ctx.panels.showModal(
    [
      t(kind === 'arrowTower' ? 'world.arrowTowerTitle' : 'world.blockerTitle'),
      t('world.structureConfirm')
        .replace('{paper}', String(cost.paper ?? 0))
        .replace('{metal}', String(cost.metal ?? 0)),
    ],
    [
      { label: t('world.buildBtn'), action: () => void doBuildStructure(ctx, tx, ty, kind) },
      { label: '✕', action: () => ctx.panels.closeModal() },
    ],
  );
}

export async function doBuildStructure(ctx: WorldMapContext, tx: number, ty: number, kind: 'arrowTower' | 'blocker'): Promise<void> {
  ctx.panels.closeModal();
  try {
    // P1-3: buildStructure's response now carries `me` (resources deducted) directly — adopt it
    // instead of a separate GET /world/me.
    const { me } = await ctx.cb.worldApi.buildStructure(ctx.cb.worldId, tx, ty, kind);
    if (me) ctx.me = me; // defensive: never null out the cached state if a response omits it
    ctx.tileCache.delete(`${tx}:${ty}`);
    await loadMapViewport(ctx);
    ctx.panels.showToast(t('world.structureBuilt'));
    ctx.view.renderMap(); ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

export async function doDemolishStructure(ctx: WorldMapContext, tx: number, ty: number): Promise<void> {
  ctx.panels.closeModal();
  try {
    await ctx.cb.worldApi.demolishStructure(ctx.cb.worldId, tx, ty);
    ctx.tileCache.delete(`${tx}:${ty}`);
    await loadMapViewport(ctx);
    ctx.panels.showToast(t('world.structureDemolished'));
    ctx.view.renderMap(); ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

export async function doAbandon(ctx: WorldMapContext, tx: number, ty: number): Promise<void> {
  ctx.panels.closeModal();
  try {
    // P1-3: abandonTile already returns the full updated player world state — adopt it directly
    // instead of a separate GET /world/me (was previously discarded and re-fetched, see finding B).
    ctx.me = await ctx.cb.worldApi.abandonTile(ctx.cb.worldId, tx, ty);
    // Remove from cache so it shows as empty
    ctx.tileCache.delete(`${tx}:${ty}`);
    await loadMapViewport(ctx);
    ctx.view.renderMap(); ctx.panels.renderHud();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

/** Same as doAbandon but for a row in the Territory Overview list: keeps the panel open and
 * refreshes the list in place instead of closing the modal. */
export async function doAbandonFromList(ctx: WorldMapContext, tx: number, ty: number): Promise<void> {
  try {
    // P1-3: same as doAbandon above — adopt `me` from the response directly.
    ctx.me = await ctx.cb.worldApi.abandonTile(ctx.cb.worldId, tx, ty);
    ctx.tileCache.delete(`${tx}:${ty}`);
    await Promise.all([loadMapViewport(ctx), refreshTerritories(ctx)]);
    ctx.view.renderMap(); ctx.panels.renderHud();
    if (ctx.territoryPanelOpen) ctx.panels.renderTerritoryPanel();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

// ── World info panel (C5): nations / season / SLG shop ───────────────────────
// Tabbed modal rendered into modalLayer. Season is read-only; nations lets the
// capital owner rename theirs (setNationName, server re-checks ownerId). The shop
// buys via worldApi.buyShopItem → commercial.spend (server-authoritative, toast on
// INSUFFICIENT_FUNDS) and shows the SaveData coin balance via the getCoins callback.

export async function doBuyShopItem(ctx: WorldMapContext, itemId: string): Promise<void> {
  try {
    // P1-3: buyShopItem already returns the full updated player world state — adopt it directly
    // instead of a separate refreshMe() round-trip.
    ctx.me = await ctx.cb.worldApi.buyShopItem(ctx.cb.worldId, itemId);
    ctx.panels.showToast(t('world.shopBought'));
    if (ctx.territoryPanelOpen && ctx.territoryTab === 'world') ctx.panels.renderTerritoryPanel();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}

export async function doRename(ctx: WorldMapContext, capitalIdx: number, name: string): Promise<void> {
  try {
    await ctx.cb.worldApi.setNationName(ctx.cb.worldId, capitalIdx, name);
    const n = ctx.nations.find(x => x.capitalIdx === capitalIdx);
    if (n) n.nationName = name;
    if (ctx.territoryPanelOpen && ctx.territoryTab === 'world') ctx.panels.renderTerritoryPanel();
  } catch (e) {
    ctx.panels.showToast(errorMsg(e), C.red);
  }
}
