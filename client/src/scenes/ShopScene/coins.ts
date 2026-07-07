// Coins recharge tab: USD purchase tiers rendered as an icon-card grid (price · treasure glyph · coins
// + bonus · buy), followed by a full-width promo-code redemption row (B-PROMO). The tab itself only
// appears when rechargeCoins is injected; the promo row only when redeemPromo is.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { type IconKind } from '../../render/icons';
import { type Constructor, type ShopSceneBaseCtor, type CardSpec } from './base';

interface CoinTierDef {
  id: string;
  usdCents: number;
  coins: number;
  base: number;
  bestValue?: boolean;
}

// Web-only tiers ($4.99–$99.99, matching ECONOMY_BALANCE.md §2.2 USD table).
const WEB_COIN_TIERS: CoinTierDef[] = [
  { id: 't499',  usdCents:  499, base:  500, coins:   550 },
  { id: 't999',  usdCents:  999, base: 1000, coins:  1150 },
  { id: 't1999', usdCents: 1999, base: 2000, coins:  2400, bestValue: true },
  { id: 't4999', usdCents: 4999, base: 5000, coins:  6500 },
  { id: 't9999', usdCents: 9999, base: 10000, coins: 13500 },
];

// Per-tier treasure glyph — escalating gold so bigger tiers read richer (ascending order).
const COIN_TIER_ICONS: IconKind[] = ['coin', 'coins', 'coinStack', 'coinSack', 'coinChest'];

export interface CoinsHandlers {
  drawCoinsGrid(body: PIXI.Container, top: number): void;
  drawPromoRow(body: PIXI.Container, x: number, y: number, w: number, h: number): void;
}

export function CoinsMixin<TBase extends ShopSceneBaseCtor>(Base: TBase): TBase & Constructor<CoinsHandlers> {
  return class extends Base {
    /** Coins recharge tab: USD tiers as an icon-card grid (price · treasure glyph · coins + bonus · buy), then a full-width promo-code redemption row. */
    drawCoinsGrid(body: PIXI.Container, top: number): void {
      const { h } = this;
      const bodyTop = top + Math.round(h * 0.02);
      const viewH = h - bodyTop - Math.round(h * 0.02);
      const busy = this.bt.busy;

      const specs: CardSpec[] = WEB_COIN_TIERS.map((tier, idx) => {
        const bonus = tier.coins - tier.base;
        const lines: { text: string; color: number }[] = [];
        if (bonus > 0) lines.push({ text: `+${bonus}`, color: C.green });
        if (tier.bestValue) lines.push({ text: t('shop.bestValue'), color: C.gold });
        lines.push({ text: t('shop.firstDouble'), color: 0xff6b00 });
        const tierId = tier.id;
        return {
          icon: COIN_TIER_ICONS[idx] ?? 'coin', iconColor: C.gold,
          title: `$${(tier.usdCents / 100).toFixed(2)}`,
          coinAmount: tier.coins,
          lines,
          highlight: tier.bestValue,
          buttons: [{ label: t('shop.buy'), enabled: !busy, primary: true, fn: () => void this.onRecharge(tierId) }],
        };
      });

      const { listX, listW, gap, cols, cellW, cellH } = this.gridMetrics();
      const rows = Math.ceil(specs.length / cols);
      const gridH = rows * (cellH + gap);

      // Promo-code redemption (B-PROMO) lives on the Coins tab, full-width below the tier grid.
      const promoH = this.cb.redeemPromo ? Math.round(h * 0.09) : 0;
      const totalH = gridH + (promoH ? promoH + gap : 0);
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - viewH)));

      specs.forEach((spec, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = listX + col * (cellW + gap);
        const cy = bodyTop + row * (cellH + gap) - this.scrollY;
        if (cy + cellH >= top && cy <= h) this.drawCard(body, spec, cx, cy, cellW, cellH);
      });

      if (promoH) {
        const py = bodyTop + gridH - this.scrollY;
        if (py + promoH >= top && py <= h) this.drawPromoRow(body, listX, py, listW, promoH);
      }
    }

    /** Promo-code row: full-width [text field showing code / placeholder] [Redeem button]. */
    drawPromoRow(body: PIXI.Container, x: number, y: number, w: number, h: number): void {
      const btnW = Math.round(w * 0.20);
      const gap = Math.round(w * 0.02);
      const fieldW = w - btnW - gap;

      // Field box.
      const focused = this.promoFocused;
      const field = sketchPanel(fieldW, h, {
        fill: C.paper, border: focused ? C.accent : C.line,
        width: focused ? 2.2 : 1.4, seed: seedFor(x, y, fieldW),
      });
      field.x = x; field.y = y;
      body.addChild(field);

      const display = this.promoCode || t('shop.promoPlaceholder');
      const isPlaceholder = !this.promoCode;
      const fieldTxt = txt(display, Math.round(h * 0.30), isPlaceholder ? C.mid : C.dark, true);
      fieldTxt.anchor.set(0, 0.5); fieldTxt.x = x + Math.round(fieldW * 0.04); fieldTxt.y = y + h / 2;
      body.addChild(fieldTxt);

      // Blinking caret when focused.
      if (focused) {
        const caret = txt('|', Math.round(h * 0.34), C.accent, true);
        caret.anchor.set(0, 0.5);
        caret.x = fieldTxt.x + fieldTxt.width + 2;
        caret.y = y + h / 2;
        body.addChild(caret);
      }

      this.hits.push({ rect: { x, y, w: fieldW, h }, fn: () => this.focusPromo() });

      // Redeem button.
      const bx = x + fieldW + gap;
      const canRedeem = !this.bt.busy && this.promoCode.trim().length > 0;
      const btn = sketchPanel(btnW, h, {
        fill: canRedeem ? C.dark : C.btnOff,
        border: canRedeem ? C.green : C.light,
        width: 2, seed: seedFor(bx, y, btnW),
      });
      btn.x = bx; btn.y = y;
      body.addChild(btn);

      const blabel = txt(t('shop.promoRedeem'), Math.round(h * 0.30), canRedeem ? 0xffffff : C.mid, true);
      blabel.anchor.set(0.5, 0.5); blabel.x = bx + btnW / 2; blabel.y = y + h / 2;
      body.addChild(blabel);

      if (canRedeem) {
        this.hits.push({ rect: { x: bx, y, w: btnW, h }, fn: () => void this.onRedeem() });
      }
    }
  };
}
