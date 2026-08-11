// Shop tab: monthly/year subscription cards + starter packs + coin-priced skins, laid out as an
// icon-card grid. buildShopCards() assembles the declarative CardSpec list in a fixed order; drawShopGrid()
// pages it into the responsive grid and drives drag-scroll clamping.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt } from '../../render/sketchUi';
import { type IconKind } from '../../render/icons';
import { type MaterialKind } from '../../render/atlas/materialAtlas';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { bottomNavH } from '../../ui/widgets/HubTabs';
import { type Constructor, type ShopSceneBaseCtor, type CardSpec, type BtnSpec } from './base';
import { FS } from '../../render/fontScale';
import { skinDisplayName } from '../../game/meta/skinDefs';
import skinInfantryArtUrl from '../../assets/units/skins/skin_infantry.png';
import skinArcherArtUrl from '../../assets/units/skins/skin_archer.png';
import skinShieldBearerArtUrl from '../../assets/units/skins/skin_shieldbearer.png';
import monthlyCardArtUrl from '../../assets/gacha/monthly_card.png';
import yearCardArtUrl from '../../assets/shop/year_card.png';
import protectStoneArtUrl from '../../assets/shop/protect_stone.png';
import starterDrawArtUrl from '../../assets/shop/starter_draw.png';
import starterGrowthArtUrl from '../../assets/shop/starter_growth.png';

// Shop skin card thumbnails — the real skin illustrations (art/skins/<char>/), not the base unit's art.
const SKIN_PLACEHOLDER_ART: Record<string, string> = {
  skin_shop_c1: skinInfantryArtUrl as string,
  skin_shop_r1: skinArcherArtUrl as string,
  skin_shop_e1: skinShieldBearerArtUrl as string,
};

// Subscription-card / starter-pack display prices (USD cents). Mirror of GACHA_DESIGN §5/§6; these drive
// the strike-through + savings badge / price label only, no client-side coin debit. On web the buy button
// runs a real Paddle checkout for this amount; native (apple/google) runs the real store purchase via
// nativeIapPurchase() (nav/shop.ts doBuySubscription/doBuyStarter) — both platforms require a verified
// receipt before the server grants anything (2026-07-27, closes a prior "treated as authorized" gap).
// Year = 12×$4.99 ($59.99) at ~17% off → $49.99.
// 2026-08-11: switched from CNY to USD (see economy.ts's *_USD_CENTS constants) — CNY/China-region
// pricing deferred to a separate pass.
const MONTHLY_CARD_USD_CENTS = 499;
const YEAR_CARD_USD_CENTS = 4999;
const YEAR_CARD_LIST_USD_CENTS = 5999;
const STARTER_DRAW_USD_CENTS = 99;
const STARTER_GROWTH_USD_CENTS = 499;
// Savings badge amount: whole-dollar cents format as "$N" (not "$N.00") — the badge is a fixed-position
// top-right overlay on the card art (drawCard) with no width-fit/shrink, so keeping it as short as the
// old "省 ¥62"/"Save ¥62" int display avoids it running into the art underneath (2026-08-11, caught by
// screenshot-verifying the CNY→USD price switch: "Save $10.00" visibly overlapped the year-card ticket icon).
const fmtUsdSavings = (cents: number): string =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
// Bulk-buy shortcut for re-buyable consumables (item-kind shop entries, e.g. protect_enhance) — see
// ActionsMixin.onBuyBulk. Materials aren't included here: their per-item `qty` already bundles units,
// and a ×10 shortcut would interact with MATERIAL_SHOP_DAILY_CAP (purchase count, not unit count) in a
// way that needs its own UX, not just wired through unchanged.
const BULK_BUY_QTY = 10;

export interface ShopHandlers {
  drawShopGrid(body: PIXI.Container, top: number): void;
  buildShopCards(): CardSpec[];
}

export function ShopMixin<TBase extends ShopSceneBaseCtor>(Base: TBase): TBase & Constructor<ShopHandlers> {
  return class extends Base {
    /** Shop tab: monthly/year cards + starter packs + skins as an icon-card grid. */
    drawShopGrid(body: PIXI.Container, top: number): void {
      const { w, h, landscape } = this;
      const bodyTop = top + Math.round(h * 0.02);
      // Portrait's group nav is a bottom bar (§18) — reserve bottomNavH off the bottom.
      const availH = h - bodyTop - Math.round(h * 0.02) - (landscape ? 0 : bottomNavH(h));

      if (this.loading) {
        this.maskBody(top, availH);
        this.maxScroll = 0;
        const lbl = txt(t('shop.loading'), FS.title, C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = bodyTop + Math.round(h * 0.14);
        body.addChild(lbl);
        return;
      }

      const specs = this.buildShopCards();
      const { listX, listW, gap, cols, cellW, cellH } = this.gridMetrics();
      const rows = Math.ceil(specs.length / cols);
      const totalH = rows > 0 ? rows * (cellH + gap) : 0;
      // Clamp the viewport so it always cuts mid-row when there's more below — never flush with a
      // row boundary, so a partial next card is visibly peeking above the fold (not just the thin
      // ScrollIndicator thumb hinting it).
      const viewH = peekViewportH(availH, cellH + gap, totalH);
      this.maskBody(top, viewH);
      this.maxScroll = Math.max(0, totalH - viewH);
      this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll));

      if (specs.length === 0) {
        const lbl = txt(t('shop.empty'), FS.title, C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = bodyTop + Math.round(h * 0.14);
        body.addChild(lbl);
        return;
      }

      specs.forEach((spec, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = listX + col * (cellW + gap);
        const cy = bodyTop + row * (cellH + gap) - this.scrollY;
        if (cy + cellH >= top && cy <= bodyTop + viewH) this.drawCard(body, spec, cx, cy, cellW, cellH);
      });

      drawScrollIndicator(this.container, { x: listX, y: bodyTop, w: listW, h: viewH }, this.scrollY, Math.max(0, totalH - viewH));
    }

    /** Assemble the shop tab's card specs in a fixed order: monthly · year · starter packs · skins. */
    buildShopCards(): CardSpec[] {
      const specs: CardSpec[] = [];
      const busy = this.bt.busy;
      const mon = this.cb.getMonetization?.() ?? { subscriptionExpiry: 0, starterUsed: [] };
      const { active, claimedToday, expiringSoon } = this.monthlyCardStatus();

      // Monthly card: Buy (locked while a card is active) + daily Claim.
      if (this.cb.buyMonthlyCard) {
        const buttons: BtnSpec[] = [
          active
            ? { label: t('shop.monthlyActive'), enabled: false, primary: true }
            : { label: t('shop.buy'), enabled: !busy, primary: true, fn: () => void this.runUnboundedDeal(() => this.cb.buyMonthlyCard!(), 'shop.bought', t('shop.monthlyCard')) },
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
          icon: 'coinChest', iconColor: C.gold, artUrl: monthlyCardArtUrl as string, title: t('shop.monthlyCard'), highlight: true,
          usdCents: MONTHLY_CARD_USD_CENTS,
          lines: [{ text: active ? t('shop.monthlyActive') : t('shop.monthlyInactive'), color: active ? C.green : C.mid }],
          expiringSoonStamp: expiringSoon,
          buttons,
        });
      }

      // Year card: 365-day, ~10% off vs 12 monthly cards. Same single-slot gate.
      if (this.cb.buyYearCard) {
        specs.push({
          icon: 'trophy', iconColor: C.gold, artUrl: yearCardArtUrl as string, title: t('shop.yearCard'), highlight: true,
          usdCents: YEAR_CARD_USD_CENTS, usdStrikeCents: YEAR_CARD_LIST_USD_CENTS,
          badge: { text: t('shop.save', { amount: fmtUsdSavings(YEAR_CARD_LIST_USD_CENTS - YEAR_CARD_USD_CENTS) }), color: C.green },
          lines: [{ text: active ? t('shop.monthlyActive') : t('shop.monthlyInactive'), color: active ? C.green : C.mid }],
          buttons: [
            active
              ? { label: t('shop.monthlyActive'), enabled: false, primary: true }
              : { label: t('shop.buy'), enabled: !busy, primary: true, fn: () => void this.runUnboundedDeal(() => this.cb.buyYearCard!(), 'shop.bought', t('shop.yearCard')) },
          ],
        });
      }

      // Starter packs: one-time paid first-purchase-funnel products (GACHA_DESIGN §6, $0.99/$4.99 — NOT
      // free; 2026-07-27 fix, see STARTER_DRAW_USD_CENTS/STARTER_GROWTH_USD_CENTS above). Drop the card
      // entirely once claimed — a disabled "Owned" tile sitting in the grid forever reads as a broken
      // purchase, not a claimed reward. Unbounded: the buy button may run a real store purchase sheet /
      // Paddle overlay.
      if (this.cb.buyStarter) {
        const packs: { id: 'starter_draw' | 'starter_growth'; label: TranslationKey; icon: IconKind; art: string; usdCents: number }[] = [
          { id: 'starter_draw', label: 'shop.starterDraw', icon: 'capsule', art: starterDrawArtUrl as string, usdCents: STARTER_DRAW_USD_CENTS },
          { id: 'starter_growth', label: 'shop.starterGrowth', icon: 'gift', art: starterGrowthArtUrl as string, usdCents: STARTER_GROWTH_USD_CENTS },
        ];
        for (const pk of packs) {
          if (mon.starterUsed.includes(pk.id)) continue;
          if (pk.id === 'starter_growth' && mon.starterGrowthEligible === false) continue;
          specs.push({
            icon: pk.icon, iconColor: C.gold, artUrl: pk.art, title: t(pk.label),
            usdCents: pk.usdCents,
            buttons: [{
              label: t('shop.buy'), enabled: !busy, primary: true,
              fn: () => void this.runUnboundedDeal(() => this.cb.buyStarter!(pk.id), 'shop.bought', t(pk.label)),
            }],
          });
        }
      }

      // Consumable items (e.g. enhance protection) come first, then material bundles (gold→material
      // exchange, ECONOMY_NUMBERS §6.5), then skins (cosmetic → brush glyph; real skin art pending).
      // Each kind sorts ahead of the next regardless of their order in this.items.
      if (this.items && this.items.length > 0) {
        const owned = new Set(this.cb.getOwnedSkins());
        for (const item of this.items) {
          if (item.kind !== 'item') continue;
          // Consumables aren't "owned" — always re-buyable while affordable.
          const canBuy = !busy && this.cb.getCoins() >= item.cost;
          const canBuy10 = !busy && this.cb.getCoins() >= item.cost * BULK_BUY_QTY;
          const known = item.id === 'protect_enhance';
          const itemTitle = known ? t('shop.item.protect_enhance.name') : `${t('shop.itemLabel')} · ${item.id}`;
          specs.push({
            icon: 'armor', iconColor: C.accent, artUrl: known ? protectStoneArtUrl as string : undefined,
            title: itemTitle,
            lines: known ? [{ text: t('shop.item.protect_enhance.desc'), color: C.mid }] : [],
            coinAmount: item.cost,
            buttons: [
              { label: t('shop.buyX10'), enabled: canBuy10, primary: false, fn: () => void this.onBuyBulk(item.id, itemTitle, BULK_BUY_QTY) },
              { label: t('shop.buy'), enabled: canBuy, primary: true, fn: () => void this.onBuy(item.id, itemTitle) },
            ],
          });
        }
        for (const item of this.items) {
          if (item.kind !== 'material') continue;
          // Material bundles aren't "owned" either (stackable, re-buyable up to the server's daily cap —
          // a 400 here just means "try again tomorrow", surfaced via the normal onBuy error toast).
          // dailyLimit/purchasedToday (present iff the item is capped, see metaserver getShopItems) drive
          // the "used/cap" status line + grey the Buy button out client-side once reached, instead of only
          // finding out from a failed purchase.
          const capped = item.dailyLimit !== undefined && (item.purchasedToday ?? 0) >= item.dailyLimit;
          const canBuy = !busy && !capped && this.cb.getCoins() >= item.cost;
          const materialName = t(`material.${item.grants}` as TranslationKey);
          const matTitle = t('shop.item.material.title', { name: materialName, qty: item.qty ?? 1 });
          const statusLine = item.dailyLimit !== undefined
            ? t('shop.item.material.limit', { used: item.purchasedToday ?? 0, limit: item.dailyLimit })
            : undefined;
          specs.push({
            icon: (item.grants as IconKind) ?? 'scrap', iconColor: C.accent,
            materialKind: item.grants as MaterialKind,
            title: matTitle,
            lines: statusLine ? [{ text: statusLine, color: capped ? C.red : C.mid }] : [],
            coinAmount: item.cost,
            buttons: [{
              label: capped ? t('shop.item.material.capReached') : t('shop.buy'),
              enabled: canBuy, primary: true, fn: () => void this.onBuy(item.id, matTitle),
            }],
          });
        }
        for (const item of this.items) {
          if (item.kind === 'item' || item.kind === 'material') continue;
          const isOwned = owned.has(item.grants ?? item.id);
          const canBuy = !isOwned && !busy && this.cb.getCoins() >= item.cost;
          const skinTitle = skinDisplayName(item.id);
          specs.push({
            icon: 'brush', iconColor: C.accent, artUrl: SKIN_PLACEHOLDER_ART[item.id],
            title: skinTitle,
            coinAmount: item.cost,
            buttons: [{
              label: isOwned ? t('shop.owned') : t('shop.buy'), enabled: canBuy, primary: true,
              fn: () => void this.onBuy(item.id, skinTitle),
            }],
          });
        }
      }

      return specs;
    }
  };
}
