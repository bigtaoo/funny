// Shop nav functions: goShop/goGacha/goDaily/goEvents/goBattlePass/goRecharge. These six call each
// other extensively (peer-tab navigation within the shop group) so they stay in one factory;
// they call out to shop/badges.ts (pure helpers) and shop/iap.ts (createShopIap) one-way only.
// Split out of createShopNav (see shop.ts).
import * as analytics from '../../../analytics';
import { ApiError } from '../../../net/ApiClient';
import type { AppCtx, Nav } from '../../appCtx';
import { TOKEN_KEY } from '../../appConstants';
import { shopCardBadgeClaimable, battlePassBadgeClaimable, rechargeBadgeClaimable } from './badges';
import { createShopIap } from './iap';

type ShopNav = Pick<Nav, 'goShop' | 'goGacha' | 'goDaily' | 'goEvents' | 'goBattlePass' | 'goRecharge'>;

export function createShopNav(ctx: AppCtx): ShopNav {
  const { api, saveManager, platform, state, views, nav } = ctx;
  const { doRechargeCoins, doBuySubscription, doBuyStarter } = createShopIap(ctx);

  function goShop(onBack?: () => void, initialTab?: 'shop' | 'coins'): void {
    if (!api) { nav.goLobby(); return; }
    const client = api;
    state.inLobby = false;
    analytics.track('shop_open', {});
    analytics.track('screen_view', { scene: 'ShopScene' });
    // Conversion flag: whether a purchase was made during this shop visit; reported with shop_close on exit (funnel bottom, §9.3).
    let converted = false;
    const shopOpenTs = Date.now();
    // Battle pass merged into the shop (LOBBY_IA_REDESIGN §3): the battle-pass entry is only shown when logged in online; back returns to the shop.
    const shopLoggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    views.showShop({
      ...(initialTab ? { initialTab } : {}),
      openTextInput: (opts) => platform.openTextInput(opts),
      onBack() {
        analytics.track('shop_close', { converted, time_sec: Math.round((Date.now() - shopOpenTs) / 1000) });
        if (onBack) onBack(); else nav.goLobby();
      },
      getCoins: () => saveManager.get().wallet.coins,
      onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      getOwnedSkins: () => saveManager.get().inventory.skins,
      loadItems: () => client.getShopItems(),
      async buy(itemId, qty) {
        try {
          const { save } = await client.shopBuy(itemId, qty);
          saveManager.adoptServer(save);
          converted = true;
          analytics.track('shop_buy', { item_id: itemId, currency: 'coins', qty: qty ?? 1 });
          return { ok: true };
        } catch (e) {
          return {
            ok: false,
            key: e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS'
              ? 'shop.insufficient' : 'shop.error',
          };
        }
      },
      async recharge(code) {
        try {
          const { save } = await client.iapVerify('dev', code);
          saveManager.adoptServer(save);
          return { ok: true };
        } catch {
          return { ok: false, key: 'shop.error' };
        }
      },
      // Real coin recharge (COMMERCIAL_DESIGN §IAP client): only when logged in online AND the
      // platform routes to a store (web→Paddle, native→Apple/Google; WeChat/CrazyGames → hidden).
      // Providing this callback is what makes the shop's "Coins" tab appear.
      ...(shopLoggedIn && platform.iapKind() !== null ? {
        rechargeCoins: (tierId: string) => doRechargeCoins(tierId, client, () => { converted = true; }),
      } : {}),
      // Promo-code redemption (B-PROMO): only available when online + logged in.
      ...(shopLoggedIn ? {
        async redeemPromo(code: string) {
          try {
            const { save } = await client.redeemPromoCode(code);
            saveManager.adoptServer(save);
            analytics.track('promo_redeem', { code });
            return { ok: true as const };
          } catch (e) {
            const errCode = e instanceof ApiError ? e.code : '';
            const key = errCode === 'PROMO_NOT_FOUND' || errCode === 'PROMO_ALREADY_USED'
              ? 'shop.promoInvalid' : 'shop.promoError';
            return { ok: false as const, key };
          }
        },
      } : {}),
      // Monetization deals (GACHA_DESIGN §5–§6): monthly/year card + starter packs.
      // getMonetization/claimMonthlyCard are read/claim-only (safe regardless of purchase capability) and
      // stay available whenever logged in; the three *buy* callbacks are real-money purchases and are only
      // exposed when the platform has an actual payment channel wired (apple/google/paddle) — same
      // `iapKind() !== null` gate as the Coins tab above. WeChat/CrazyGames (iapKind()===null) have no
      // payment channel for these products yet (WeChat Pay is a TODO, see WechatPlatform.iapKind()), so
      // ShopScene hides the buy buttons there instead of leaving a button that always fails.
      ...(shopLoggedIn ? {
        getMonetization: () => {
          const m = saveManager.get().monetization;
          return {
            subscriptionExpiry: m?.subscriptionExpiry ?? 0,
            subscriptionLastClaimDay: m?.subscriptionLastClaimDay,
            starterUsed: m?.starterUsed ?? [],
            starterGrowthEligible: m?.starterGrowthEligible,
            firstPurchaseUsed: m?.firstPurchaseUsed,
          };
        },
        async claimMonthlyCard() {
          try {
            const { save, claimed } = await client.monthlyCardClaim();
            saveManager.adoptServer(save);
            return claimed > 0 ? { ok: true as const } : { ok: false as const, key: 'shop.monthlyNothing' as const };
          } catch { return { ok: false as const, key: 'shop.error' as const }; }
        },
      } : {}),
      ...(shopLoggedIn && platform.iapKind() !== null ? {
        buyMonthlyCard: () => doBuySubscription(
          'monthly_card', (p, r) => client.monthlyCardBuy(p, r), client, () => { converted = true; },
        ),
        buyYearCard: () => doBuySubscription(
          'year_card', (p, r) => client.yearCardBuy(p, r), client, () => { converted = true; },
        ),
        buyStarter: (productId: 'starter_draw' | 'starter_growth') =>
          doBuyStarter(productId, client, () => { converted = true; }),
      } : {}),
      // Shop group peer tabs (LOBBY_IA_REDESIGN P1.5): gacha / battle pass promoted to top tabs;
      // threading shopBack lets all three pages navigate to each other and return to the same origin (lobby / level-prep).
      openGacha() { goGacha({ shopBack: onBack }); },
      ...(shopLoggedIn ? { openBattlePass: () => goBattlePass({ shopBack: onBack }), getBattlePassBadge: () => battlePassBadgeClaimable(saveManager.get().battlePass) } : {}),
      ...(shopLoggedIn ? { openRecharge: () => goRecharge({ shopBack: onBack }), getRechargeBadge: () => rechargeBadgeClaimable(saveManager.get()) } : {}),
    });
  }

  /**
   * Gacha / loot box (S2-6). When `group` is provided = shop-group context (top [Shop|Coins|Gacha|BattlePass]
   * tab bar with peer navigation); omitted = standalone entry (back returns to the shop only).
   */
  function goGacha(group?: { shopBack?: () => void }): void {
    if (!api) { nav.goLobby(); return; }
    const client = api;
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'GachaScene' });
    const inGroup = !!group;
    const shopBack = group?.shopBack;
    const bpAvail = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const coinsAvail = bpAvail && platform.iapKind() !== null;
    views.showGacha({
      // Back always leaves the shop group entirely (returns to the origin — lobby / level-prep),
      // never hops through the Shop tab first: Shop/Coins/Gacha/BattlePass are peers, not a stack.
      onBack() { if (shopBack) shopBack(); else goShop(); },
      ...(inGroup ? { openShop: () => goShop(shopBack), getShopBadge: () => shopCardBadgeClaimable(saveManager.get().monetization) } : {}),
      ...(inGroup && coinsAvail ? { openCoins: () => goShop(shopBack, 'coins') } : {}),
      ...(inGroup && bpAvail ? { openBattlePass: () => goBattlePass({ shopBack }), getBattlePassBadge: () => battlePassBadgeClaimable(saveManager.get().battlePass) } : {}),
      ...(inGroup && bpAvail ? { openRecharge: () => goRecharge({ shopBack }), getRechargeBadge: () => rechargeBadgeClaimable(saveManager.get()) } : {}),
      getCoins: () => saveManager.get().wallet.coins,
      onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      getPity: (poolId) => saveManager.get().gacha.pity[poolId] ?? 0,
      getFatePoints: () => saveManager.get().monetization?.fatePoints ?? 0,
      loadPools: () => client.getGachaPools(),
      async draw(poolId, count) {
        try {
          const { save, results, overflow, cardGrants, equipmentGrants } = await client.gachaDraw(poolId, count);
          // Lean response (save.cardInv/equipmentInv are null) — adopt the patch, not the plain
          // adoptServer, or the null would wipe the locally-held inventory (see adoptServerPartial doc).
          saveManager.adoptServerPartial(save, { cardUpsert: cardGrants, upsert: equipmentGrants });
          analytics.track('gacha_draw', { pool_id: poolId, count });
          return { ok: true, results, overflow };
        } catch (e) {
          return {
            ok: false,
            key: e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS'
              ? 'gacha.insufficient' : 'gacha.error',
          };
        }
      },
      async redeemFate(itemId) {
        try {
          const { save, granted } = await client.redeemFate(itemId);
          saveManager.adoptServer(save);
          analytics.track('fate_redeem', { item_id: itemId });
          return { ok: true, granted };
        } catch (e) {
          return {
            ok: false,
            key: e instanceof ApiError && e.code === 'FATE_INSUFFICIENT'
              ? 'gacha.fate.insufficient' : 'gacha.error',
          };
        }
      },
    });
  }

  /** Daily check-in + daily quests (B5). Server-authoritative; requires an online login; entered from the lobby, returns to the lobby. */
  function goDaily(): void {
    if (!api) { nav.goLobby(); return; }
    const client = api;
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'DailyScene' });
    // Fetch the authoritative save once on entering the daily page so that retention progress
    // from a completed PvP/PvE session is shown immediately.
    void saveManager.refresh();
    views.showDaily({
      onBack() { nav.goLobby(); },
      getSave: () => saveManager.get(),
      getRetention: () => client.getRetention(),
      onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      async onCheckin() {
        const { save, day, reward } = await client.claimCheckin();
        saveManager.adoptServer(save);
        analytics.track('daily_checkin', { day });
        return { day, reward };
      },
      async onClaimDaily() {
        const { save, coins } = await client.claimDailyReward();
        saveManager.adoptServer(save);
        analytics.track('daily_reward_claim', { coins });
        return { coins };
      },
      async onClaimWeekly(threshold: number) {
        const { save, reward } = await client.claimWeeklyChest(threshold);
        saveManager.adoptServer(save);
        analytics.track('weekly_chest_claim', { threshold, kind: reward.kind });
        return { reward };
      },
      // onWatchAd is only handed to DailyScene when the platform has a real ad integration —
      // DailyScene hides the "Ads" tab entirely otherwise (no mock ad shown to a real player).
      ...(platform.hasRewardedAd() ? {
        // No blanket withTimeout: showRewardedAd() opens a user-paced ad player that may stay open
        // for the length of the video. Only the follow-up /ads/reward network call needs bounding,
        // and adsReward() itself already runs through ApiClient's own request timeout.
        async onWatchAd() {
          try {
            const ad = await platform.showRewardedAd(saveManager.get()?.accountId ?? '');
            if (!ad) return { ok: false, key: 'daily.ads.unavailable' };
            const { save, granted } = await client.adsReward(ad.adToken, ad.platform);
            saveManager.adoptServer(save);
            analytics.track('ads_reward', { coins: granted, platform: ad.platform });
            return { ok: true, coins: granted };
          } catch {
            // Both "cooldown not elapsed" and "daily cap reached" surface as DAILY_CAP_REACHED (429)
            // from the server — the button is already disabled in either state, so this only fires on
            // a race (e.g. two tabs open); a generic retry message is enough, no need to distinguish.
            return { ok: false, key: 'daily.ads.error' };
          }
        },
      } : {}),
    });
  }

  /** Limited-time events (B6). Server-authoritative; requires an online login; entered from the lobby, returns to the lobby. */
  function goEvents(): void {
    if (!api) { nav.goLobby(); return; }
    const client = api;
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'EventScene' });
    views.showEvents({
      onBack() { nav.goLobby(); },
      getEvents: () => client.getEvents(),
      async onClaimReward(eventId: string, rewardId: string) {
        const { pointsLeft } = await client.claimEventReward(eventId, rewardId);
        analytics.track('event_claim', { event_id: eventId, reward_id: rewardId });
        // Reward delivered via mail / commercial coins → fetch the authoritative save once to refresh the wallet (best-effort).
        void saveManager.refresh();
        return { pointsLeft };
      },
    });
  }

  /**
   * Battle pass (SE-9). When `group` is provided = shop-group context (top [Shop|Coins|Gacha|BattlePass]
   * tab bar, back returns to the shop); omitted = standalone entry (back returns to the lobby).
   * After the IA redesign, this is entered from the "Shop" tab (LOBBY_IA_REDESIGN §3);
   * `back` determines where the user returns to.
   */
  function goBattlePass(group?: { shopBack?: () => void }): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'BattlePassScene' });
    const loggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    const inGroup = !!group;
    const shopBack = group?.shopBack;
    const coinsAvail = loggedIn && platform.iapKind() !== null;
    views.showBattlePass({
      // Same peer-tab rule as Gacha's onBack above: leave the group directly, don't detour through Shop.
      onBack: () => { if (shopBack) shopBack(); else nav.goLobby(); },
      getCoins: () => saveManager.get().wallet.coins,
      onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      ...(inGroup ? { openShop: () => goShop(shopBack), getShopBadge: () => shopCardBadgeClaimable(saveManager.get().monetization), openGacha: () => goGacha({ shopBack }) } : {}),
      ...(inGroup && coinsAvail ? { openCoins: () => goShop(shopBack, 'coins') } : {}),
      ...(inGroup && loggedIn ? { openRecharge: () => goRecharge({ shopBack }), getRechargeBadge: () => rechargeBadgeClaimable(saveManager.get()) } : {}),
      ...(loggedIn
        ? {
            getBattlePass: () => saveManager.get().battlePass,
            ...(client
              ? {
                  onBuy: async () => {
                    const { battlePass } = await client.buyBattlePass();
                    if (battlePass) saveManager.adoptServer({ ...saveManager.get(), battlePass });
                    analytics.track('battlepass_buy', {});
                  },
                  onClaim: async (track: 'free' | 'paid', level: number) => {
                    const { battlePass, reward } = await client.claimBattlePass(track, level);
                    if (battlePass) saveManager.adoptServer({ ...saveManager.get(), battlePass });
                    analytics.track('battlepass_claim', { track, level, reward_kind: reward.kind, reward_count: reward.count });
                    return reward.kind === 'coins' ? reward.count : 0;
                  },
                }
              : {}),
          }
        : {}),
    });
  }

  /**
   * Cumulative recharge milestones (GACHA_DESIGN §13, ADR-045). When `group` is provided = shop-group
   * context (top tab bar, back returns to the shop); omitted = standalone entry (back returns to the lobby).
   */
  function goRecharge(group?: { shopBack?: () => void }): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'RechargeScene' });
    const loggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    const inGroup = !!group;
    const shopBack = group?.shopBack;
    const coinsAvail = loggedIn && platform.iapKind() !== null;
    views.showRecharge({
      onBack: () => { if (shopBack) shopBack(); else nav.goLobby(); },
      getCoins: () => saveManager.get().wallet.coins,
      onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      ...(inGroup ? { openShop: () => goShop(shopBack), getShopBadge: () => shopCardBadgeClaimable(saveManager.get().monetization), openGacha: () => goGacha({ shopBack }) } : {}),
      ...(inGroup && coinsAvail ? { openCoins: () => goShop(shopBack, 'coins') } : {}),
      ...(inGroup && loggedIn ? { openBattlePass: () => goBattlePass({ shopBack }), getBattlePassBadge: () => battlePassBadgeClaimable(saveManager.get().battlePass) } : {}),
      ...(loggedIn && client
        ? {
            getData: () => ({
              totalRechargeCents: saveManager.get().monetization?.totalRechargeCents ?? 0,
              claimed: saveManager.get().rechargeMilestone?.claimed ?? [],
            }),
            onClaim: async (tierId: number) => {
              const { save, rewards } = await client.claimRechargeMilestone(tierId);
              saveManager.adoptServer(save);
              analytics.track('recharge_milestone_claim', { tier_id: tierId });
              return rewards;
            },
          }
        : {}),
    });
  }

  return { goShop, goGacha, goDaily, goEvents, goBattlePass, goRecharge };
}
