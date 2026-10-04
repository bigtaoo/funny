// Coins recharge tab: USD purchase tiers rendered as an icon-card grid (price · treasure glyph · coins
// + bonus · buy). The tab itself only appears when rechargeCoins is injected.
//
// CoinsPanel depends on ActionsPanel (via the narrow ActionHandlers interface — onRecharge)
// but ActionsPanel has no dependency back on CoinsPanel: a one-way dependency, so a plain independent
// class over `core` + `actions` (2026-08-11: converted from the former `XMixin(Base)` inheritance
// chain, per claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import { type IconKind } from '../../render/icons';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { bottomNavH } from '../../ui/widgets/HubTabs';
import type { ShopSceneCore, CardSpec } from './core';
import type { ActionHandlers } from './actions';
import { drawCard } from './card';
import { IAP_TIERS_LIST } from '@nw/shared/economy/iapTiers';

// Per-tier treasure glyph — escalating gold so bigger tiers read richer. t099/t199/t499 share the
// single-coin glyph (no glyph smaller than 'coin' exists for the two mobile-only tiers,
// ECONOMY_BALANCE.md §2.2); t999+ keep their pre-2026-09-23 icons unchanged.
const COIN_TIER_ICONS: Record<string, IconKind> = {
  t099: 'coin', t199: 'coin', t499: 'coin', t999: 'coins', t1999: 'coinStack', t4999: 'coinSack', t9999: 'coinChest',
};

export class CoinsPanel {
  constructor(private readonly core: ShopSceneCore, private readonly actions: ActionHandlers) {}

  /** Coins recharge tab: USD tiers as an icon-card grid (price · treasure glyph · coins + bonus · buy). */
  drawCoinsGrid(body: PIXI.Container, top: number): void {
    const core = this.core;
    const { h, landscape } = core;
    const bodyTop = top + Math.round(h * 0.02);
    // Portrait's group nav is a bottom bar (§18) — reserve bottomNavH off the bottom.
    const availH = h - bodyTop - Math.round(h * 0.02) - (landscape ? 0 : bottomNavH(h));
    const busy = core.bt.busy;

    // The first-purchase 2× bonus is a one-time, account-wide grant (server CAS on wallets.firstPurchasedAt).
    // Only advertise it while the account still has it available, so returning players aren't shown a badge
    // for a bonus their purchase won't actually receive. Absent monetization mirror (offline) = assume available.
    const firstDoubleAvailable = core.cb.getMonetization?.().firstPurchaseUsed !== true;

    // t099/t199 (`mobileOnly`) only render when the platform can actually sell them — see
    // ShopSceneCallbacks.includeMobileOnlyCoinTiers's doc comment for why (Paddle fee economics,
    // not a store restriction).
    const tiers = IAP_TIERS_LIST.filter((tier) => !tier.mobileOnly || core.cb.includeMobileOnlyCoinTiers);
    const specs: CardSpec[] = tiers.map((tier) => {
      const bonus = tier.coins - tier.base;
      const lines: { text: string; color: number }[] = [];
      if (bonus > 0) lines.push({ text: `+${bonus}`, color: C.green });
      if (tier.bestValue) lines.push({ text: t('shop.bestValue'), color: C.gold });
      if (firstDoubleAvailable) lines.push({ text: t('shop.firstDouble'), color: 0xff6b00 });
      const tierId = tier.id;
      return {
        icon: COIN_TIER_ICONS[tierId] ?? 'coin', iconColor: C.gold,
        title: `$${(tier.usdCents / 100).toFixed(2)}`,
        coinAmount: tier.coins,
        lines,
        highlight: tier.bestValue,
        buttons: [{ label: t('shop.buy'), enabled: !busy, primary: true, icon: 'coin', fn: () => void this.actions.onRecharge(tierId) }],
      };
    });

    const { listX, listW, gap, cols, cellW, cellH } = core.gridMetrics();
    const rows = Math.ceil(specs.length / cols);
    const gridH = rows * (cellH + gap);

    const totalH = gridH;
    // Clamp the viewport so it always cuts mid-row when there's more below — never flush with a
    // row boundary, so a partial next card is visibly peeking above the fold.
    const viewH = peekViewportH(availH, cellH + gap, totalH);
    core.maskBody(top, viewH);
    core.maxScroll = Math.max(0, totalH - viewH);
    core.scrollY = Math.max(0, Math.min(core.scrollY, core.maxScroll));

    specs.forEach((spec, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = listX + col * (cellW + gap);
      const cy = bodyTop + row * (cellH + gap) - core.scrollY;
      if (cy + cellH >= top && cy <= bodyTop + viewH) drawCard(core, body, spec, cx, cy, cellW, cellH);
    });

    drawScrollIndicator(core.container, { x: listX, y: bodyTop, w: listW, h: viewH }, core.scrollY, Math.max(0, totalH - viewH));
  }
}
