// BattlePassScene's shop-group nav rail + content-bounds calc, extracted as form① (claudedocs/
// client-modules.md "单文件 500 行收敛"). `hits` is a plain readonly array reference — this flow
// only ever pushes/unshifts into it, never reassigns it wholesale. `navHits` IS a getter/setter
// pair — drawSidebar reassigns it directly (`host.navHits = hits.map(...)`), and a plain copied
// property would only rebind this throwaway host object, never reaching back to BattlePassScene's
// own field (same reasoning as RoomScene/views.ts's RoomViewHost).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import type { Rect } from '../../layout/ILayout';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import type { BattlePassCallbacks } from '../BattlePassScene';

interface Hit { rect: Rect; fn: () => void; }

export interface NavHost {
  readonly container: PIXI.Container;
  readonly cb: BattlePassCallbacks;
  readonly w: number;
  readonly h: number;
  readonly landscape: boolean;
  readonly hits: Hit[];
  navHits: Hit[];
}

/**
 * Shop group nav [Shop|Coins|Gacha|BattlePass] (LOBBY_IA_REDESIGN §9), battle pass active. Only
 * drawn in group context (openShop injected). Landscape: a vertical rail (`sidebarNavW`, matching
 * every other hub's left tab rail) — consumes no vertical space, render() shifts body content
 * start x instead. Portrait: a bottom nav bar instead (§18), drawn after the body (see render())
 * so it's never run under by the scroll track; hits are unshifted to the front to match.
 */
export function drawSidebar(host: NavHost, tbH: number): void {
  if (!host.cb.openShop) return;
  const { w, h, landscape } = host;
  const tabs: HubTab[] = [{ label: t('shop.title'), active: false, icon: 'tag', badge: host.cb.getShopBadge?.() ?? false }];
  const actions: Array<() => void> = [() => host.cb.openShop?.()];
  if (host.cb.openCoins) {
    tabs.push({ label: t('shop.coinsTab'), active: false, icon: 'coin' });
    actions.push(() => host.cb.openCoins?.());
  }
  tabs.push({ label: t('gacha.title'), active: false, icon: 'capsule' });
  actions.push(() => host.cb.openGacha?.());
  tabs.push({ label: t('battlepass.title'), active: true, icon: 'trophy' });
  actions.push(() => {});
  if (host.cb.openRecharge) {
    tabs.push({ label: t('recharge.title'), active: false, icon: 'coinChest', badge: host.cb.getRechargeBadge?.() ?? false });
    actions.push(() => host.cb.openRecharge?.());
  }
  const onSelect = (i: number): void => actions[i]?.();
  if (!landscape) {
    const barH = bottomNavH(h);
    const { hits } = drawBottomNavTabs(host.container, w, h - barH, barH, tabs, onSelect);
    // Kept in navHits (see field doc) rather than unshifted into `host.hits` directly — the
    // scroll-content render path rebuilds `host.hits` via updateScrollPosition() right after this
    // call, which folds navHits back in; the no-scroll early-return path never calls
    // updateScrollPosition(), so it also unshifts directly here to take effect immediately.
    host.navHits = hits.map((hit) => ({ rect: hit.rect, fn: hit.fn }));
    host.hits.unshift(...hits);
    return;
  }
  const sidebarW = sidebarNavW(w, h, true);
  const { hits } = drawSidebarTabs(host.container, sidebarW, tbH, h, tabs, onSelect);
  host.hits.push(...hits);
}

/**
 * Content column bounds: left edge shifts right of the sidebar rail when in the shop group AND
 * landscape (portrait's bottom bar reserves no width — else the standalone 5%-of-w pad); right
 * edge always keeps the 5%-of-w pad.
 */
export function contentBounds(host: NavHost): { x0: number; w: number } {
  const { w, h, landscape } = host;
  const rightPad = Math.round(w * 0.05);
  const x0 = host.cb.openShop && landscape ? sidebarNavW(w, h, true) + Math.round(w * 0.02) : rightPad;
  return { x0, w: w - x0 - rightPad };
}
