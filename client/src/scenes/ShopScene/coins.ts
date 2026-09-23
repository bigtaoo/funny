// Coins recharge tab: USD purchase tiers rendered as an icon-card grid (price · treasure glyph · coins
// + bonus · buy), followed by a full-width promo-code redemption row (B-PROMO). The tab itself only
// appears when rechargeCoins is injected; the promo row only when redeemPromo is.
//
// CoinsPanel depends on ActionsPanel (via the narrow ActionHandlers interface — onRecharge/onRedeem)
// but ActionsPanel has no dependency back on CoinsPanel: a one-way dependency, so a plain independent
// class over `core` + `actions` (2026-08-11: converted from the former `XMixin(Base)` inheritance
// chain, per claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { type IconKind } from '../../render/icons';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { bottomNavH } from '../../ui/widgets/HubTabs';
import { snapFont } from '../../render/fontScale';
import type { ShopSceneCore, CardSpec } from './core';
import { drawButtonLabel } from '../../ui/widgets/buttonLabel';
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

  /** Coins recharge tab: USD tiers as an icon-card grid (price · treasure glyph · coins + bonus · buy), then a full-width promo-code redemption row. */
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

    // Promo-code redemption (B-PROMO) lives on the Coins tab, full-width below the tier grid.
    const promoH = core.cb.redeemPromo ? Math.round(h * 0.09) : 0;
    // `gridH` already has one trailing `gap` baked in past the last card row (rows * (cellH+gap)) —
    // that's exactly the gap the promo row is positioned below (`py = bodyTop + gridH - scrollY`).
    // Adding another `+ gap` here double-counted it (2026-08-03 fix), leaving a permanent gap-sized
    // dead-scroll strip below the promo row that could never be scrolled away.
    const totalH = gridH + promoH;
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

    if (promoH) {
      // Always emit the promo row (it's a single lightweight row): with the taller image-cards the
      // tier grid can push it below the initial fold, but it's part of the scroll content and the
      // body mask clips it, so it must stay in the tree to be reachable once the grid scrolls.
      const py = bodyTop + gridH - core.scrollY;
      this.drawPromoRow(body, listX, py, listW, promoH);
    }

    drawScrollIndicator(core.container, { x: listX, y: bodyTop, w: listW, h: viewH }, core.scrollY, Math.max(0, totalH - viewH));
  }

  /** Promo-code row: full-width [text field showing code / placeholder] [Redeem button]. */
  drawPromoRow(body: PIXI.Container, x: number, y: number, w: number, h: number): void {
    const core = this.core;
    const btnW = Math.round(w * 0.20);
    const gap = Math.round(w * 0.02);
    const fieldW = w - btnW - gap;

    // Field box.
    const focused = core.promoFocused;
    const field = sketchPanel(fieldW, h, {
      fill: C.paper, border: focused ? C.accent : C.line,
      width: focused ? 2.2 : 1.4, seed: seedFor(x, y, fieldW),
    });
    field.x = x; field.y = y;
    body.addChild(field);

    const display = core.promoCode || t('shop.promoPlaceholder');
    const isPlaceholder = !core.promoCode;
    const fieldTxt = txt(display, snapFont(Math.round(h * 0.30)), isPlaceholder ? C.mid : C.dark, true);
    fieldTxt.anchor.set(0, 0.5); fieldTxt.x = x + Math.round(fieldW * 0.04); fieldTxt.y = y + h / 2;
    body.addChild(fieldTxt);

    // Blinking caret when focused.
    if (focused) {
      const caret = txt('|', snapFont(Math.round(h * 0.34)), C.accent, true);
      caret.anchor.set(0, 0.5);
      caret.x = fieldTxt.x + fieldTxt.width + 2;
      caret.y = y + h / 2;
      body.addChild(caret);
    }

    core.hits.push({ rect: { x, y, w: fieldW, h }, fn: () => core.focusPromo(() => void this.actions.onRedeem()) });

    // Redeem button.
    const bx = x + fieldW + gap;
    const canRedeem = !core.bt.busy && core.promoCode.trim().length > 0;
    const btn = sketchPanel(btnW, h, {
      fill: canRedeem ? C.dark : C.btnOff,
      border: canRedeem ? C.green : C.light,
      width: 2, seed: seedFor(bx, y, btnW),
    });
    btn.x = bx; btn.y = y;
    body.addChild(btn);

    drawButtonLabel(body, bx, y, btnW, h, t('shop.promoRedeem'), 'gift', canRedeem ? 0xffffff : C.mid,
      snapFont(Math.round(h * 0.30)));

    if (canRedeem) {
      core.hits.push({ rect: { x: bx, y, w: btnW, h }, fn: () => void this.actions.onRedeem() });
    }
  }
}
