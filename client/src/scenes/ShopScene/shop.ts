// Shop tab: monthly/year subscription cards + starter packs + coin-priced skins, laid out as an
// icon-card grid. buildShopCards() assembles the declarative CardSpec list in a fixed order; drawShopGrid()
// pages it into the responsive grid and drives drag-scroll clamping.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt } from '../../render/sketchUi';
import { type IconKind } from '../../render/icons';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { type Constructor, type ShopSceneBaseCtor, type CardSpec, type BtnSpec } from './base';

// Subscription-card display prices (¥). Mirror of @nw/shared MONTHLY/YEAR_CARD_PRICE_YUAN — the real IAP charge is
// server-authorized (no coins debited); these drive the strike-through + savings badge only. Year = 12×¥30 (¥360) at ~10% off → ¥298.
const MONTHLY_CARD_YUAN = 30;
const YEAR_CARD_YUAN = 298;
const YEAR_CARD_LIST_YUAN = 360;

export interface ShopHandlers {
  drawShopGrid(body: PIXI.Container, top: number): void;
  buildShopCards(): CardSpec[];
}

export function ShopMixin<TBase extends ShopSceneBaseCtor>(Base: TBase): TBase & Constructor<ShopHandlers> {
  return class extends Base {
    /** Shop tab: monthly/year cards + starter packs + skins as an icon-card grid. */
    drawShopGrid(body: PIXI.Container, top: number): void {
      const { w, h } = this;
      const bodyTop = top + Math.round(h * 0.02);
      const viewH = h - bodyTop - Math.round(h * 0.02);

      if (this.loading) {
        const lbl = txt(t('shop.loading'), Math.round(h * 0.028), C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = bodyTop + Math.round(h * 0.14);
        body.addChild(lbl);
        return;
      }

      const specs = this.buildShopCards();
      const { listX, listW, gap, cols, cellW, cellH } = this.gridMetrics();
      const rows = Math.ceil(specs.length / cols);
      const totalH = rows > 0 ? rows * (cellH + gap) : 0;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - viewH)));

      if (specs.length === 0) {
        const lbl = txt(t('shop.empty'), Math.round(h * 0.028), C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = bodyTop + Math.round(h * 0.14);
        body.addChild(lbl);
        return;
      }

      specs.forEach((spec, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = listX + col * (cellW + gap);
        const cy = bodyTop + row * (cellH + gap) - this.scrollY;
        if (cy + cellH >= top && cy <= h) this.drawCard(body, spec, cx, cy, cellW, cellH);
      });

      drawScrollIndicator(this.container, { x: listX, y: bodyTop, w: listW, h: viewH }, this.scrollY, Math.max(0, totalH - viewH));
    }

    /** Assemble the shop tab's card specs in a fixed order: monthly · year · starter packs · skins. */
    buildShopCards(): CardSpec[] {
      const specs: CardSpec[] = [];
      const busy = this.bt.busy;
      const mon = this.cb.getMonetization?.() ?? { subscriptionExpiry: 0, starterUsed: [] };
      const { active, claimedToday } = this.monthlyCardStatus();

      // Monthly card: Buy (locked while a card is active) + daily Claim.
      if (this.cb.buyMonthlyCard) {
        const buttons: BtnSpec[] = [
          active
            ? { label: t('shop.monthlyActive'), enabled: false, primary: true }
            : { label: t('shop.buy'), enabled: !busy, primary: true, fn: () => void this.runDeal(() => this.cb.buyMonthlyCard!(), 'shop.bought') },
        ];
        if (this.cb.claimMonthlyCard) {
          // Claim greys out both when the card is inactive (not purchased) and once today's reward is taken.
          // The label itself is the clear status — no ambiguous "claimed-or-inactive" toast on tap.
          buttons.push({
            label: claimedToday ? t('shop.monthlyClaimedToday') : t('shop.monthlyClaim'),
            enabled: !busy && active && !claimedToday,
            primary: false,
            fn: () => void this.runDeal(() => this.cb.claimMonthlyCard!(), 'shop.monthlyClaimed'),
          });
        }
        specs.push({
          icon: 'coinChest', iconColor: C.gold, title: t('shop.monthlyCard'), highlight: true,
          yuanPrice: MONTHLY_CARD_YUAN,
          lines: [{ text: active ? t('shop.monthlyActive') : t('shop.monthlyInactive'), color: active ? C.green : C.mid }],
          buttons,
        });
      }

      // Year card: 365-day, ~10% off vs 12 monthly cards. Same single-slot gate.
      if (this.cb.buyYearCard) {
        specs.push({
          icon: 'trophy', iconColor: C.gold, title: t('shop.yearCard'), highlight: true,
          yuanPrice: YEAR_CARD_YUAN, yuanStrike: YEAR_CARD_LIST_YUAN,
          badge: { text: t('shop.save', { amount: `¥${YEAR_CARD_LIST_YUAN - YEAR_CARD_YUAN}` }), color: C.green },
          lines: [{ text: active ? t('shop.monthlyActive') : t('shop.monthlyInactive'), color: active ? C.green : C.mid }],
          buttons: [
            active
              ? { label: t('shop.monthlyActive'), enabled: false, primary: true }
              : { label: t('shop.buy'), enabled: !busy, primary: true, fn: () => void this.runDeal(() => this.cb.buyYearCard!(), 'shop.bought') },
          ],
        });
      }

      // Starter packs: one card each, "owned" when already owned.
      if (this.cb.buyStarter) {
        const packs: { id: 'starter_draw' | 'starter_growth'; label: TranslationKey; icon: IconKind }[] = [
          { id: 'starter_draw', label: 'shop.starterDraw', icon: 'capsule' },
          { id: 'starter_growth', label: 'shop.starterGrowth', icon: 'gift' },
        ];
        for (const pk of packs) {
          const used = mon.starterUsed.includes(pk.id);
          specs.push({
            icon: pk.icon, iconColor: C.gold, title: t(pk.label),
            buttons: [{
              label: used ? t('shop.owned') : t('shop.buy'), enabled: !used && !busy, primary: true,
              fn: () => void this.runDeal(() => this.cb.buyStarter!(pk.id), 'shop.bought'),
            }],
          });
        }
      }

      // Skins (cosmetic → brush glyph; real skin art pending).
      if (this.items && this.items.length > 0) {
        const owned = new Set(this.cb.getOwnedSkins());
        for (const item of this.items) {
          const isOwned = owned.has(item.grants ?? item.id);
          const canBuy = !isOwned && !busy && this.cb.getCoins() >= item.cost;
          specs.push({
            icon: 'brush', iconColor: C.accent, title: `${t('shop.skinLabel')} · ${item.id}`,
            coinAmount: item.cost,
            buttons: [{
              label: isOwned ? t('shop.owned') : t('shop.buy'), enabled: canBuy, primary: true,
              fn: () => void this.onBuy(item.id),
            }],
          });
        }
      }

      return specs;
    }
  };
}
