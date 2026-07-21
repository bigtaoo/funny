// Shop / IAP recharge / gacha / daily / events / battle pass navigation. Extracted from createAppCore.
import * as analytics from '../../analytics';
import { ApiClient, ApiError } from '../../net/ApiClient';
import type { ShopActionResult } from '../../scenes/ShopScene';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import type { AppCtx, Nav } from '../appCtx';
import { log, TOKEN_KEY } from '../appConstants';
import { hasBattlePassClaimable } from '../../game/meta/battlepass';

type ShopNav = Pick<Nav, 'goShop' | 'goGacha' | 'goDaily' | 'goEvents' | 'goBattlePass'>;

export function createShopNav(ctx: AppCtx): ShopNav {
  const { api, saveManager, platform, state, views, nav, featureFlags } = ctx;

  /**
   * Mirrors ShopScene's own Shop-tab badge (LOBBY_IA_REDESIGN P1.5): true when the monthly/year
   * card is active and today's daily reward is still unclaimed. Shared by every peer tab
   * (Gacha/BattlePass) so a user who lands there via the lobby's shop icon still sees the
   * monthly-card claim indicator on the Shop tab, wherever they are in the group.
   */
  function shopCardBadgeClaimable(): boolean {
    const m = saveManager.get().monetization;
    if (!m) return false;
    if ((m.subscriptionExpiry ?? 0) <= Date.now()) return false;
    const todayKey = new Date().toISOString().slice(0, 10);
    return m.subscriptionLastClaimDay !== todayKey;
  }

  /** Mirrors the Shop-tab badge helper above, for the BattlePass peer tab's claimable-level-reward dot. */
  function battlePassBadgeClaimable(): boolean {
    return hasBattlePassClaimable(saveManager.get().battlePass);
  }

  /**
   * Real coin recharge (COMMERCIAL_DESIGN §IAP client). Branches on the platform store:
   * - native ('apple'/'google'): run the store purchase via the injected bridge → verify the
   *   receipt at /iap/verify → adopt the returned authoritative save synchronously.
   * - web ('paddle'): create a checkout transaction → open Paddle.js → on completion, poll the
   *   save briefly (coins are credited asynchronously by /paddle/webhook).
   *
   * Timeout policy: only the *network* calls are bounded by withTimeout — the payment UI
   * (openPaddleCheckout / nativeIapPurchase) is user-paced and left unbounded (a Paddle overlay
   * or a StoreKit sheet may sit open for minutes; the caller must NOT time it out). This is why
   * ShopScene.onRecharge no longer wraps this in a blanket timeout, unlike buy/redeem.
   * Returns a ShopActionResult toast key; never throws.
   */
  async function doRechargeCoins(
    tierId: string,
    client: ApiClient,
    onConverted: () => void,
  ): Promise<ShopActionResult> {
    const kind = platform.iapKind();
    try {
      if (kind === 'apple' || kind === 'google') {
        const { receipt } = await platform.nativeIapPurchase(tierId); // user-paced native store sheet — unbounded
        const { save } = await withTimeout(client.iapVerify(kind, receipt));
        saveManager.adoptServer(save);
        onConverted();
        analytics.track('iap_purchase', { tier: tierId, platform: kind });
        return { ok: true };
      }
      if (kind === 'paddle') {
        const token = featureFlags?.getPaddleClientToken() ?? null;
        if (!token) { log.warn('paddle recharge: client token unavailable (server NW_PADDLE_CLIENT_TOKEN unset?)'); return { ok: false, key: 'shop.rechargeError' }; }
        const { transactionId } = await withTimeout(client.paddleCheckout(tierId));
        const { completed } = await platform.openPaddleCheckout(transactionId, token); // user-paced overlay — unbounded
        if (!completed) return { ok: false, key: 'shop.rechargeCancelled' };
        onConverted();
        analytics.track('iap_purchase', { tier: tierId, platform: 'paddle' });
        // Webhook credits coins asynchronously — poll the authoritative save so the wallet reflects it.
        const before = saveManager.get().wallet.coins;
        const credited = await pollForCoinIncrease(before);
        return credited ? { ok: true } : { ok: false, key: 'shop.rechargePending' };
      }
      return { ok: false, key: 'shop.rechargeError' };
    } catch (e) {
      log.warn('recharge failed', { tier: tierId, kind, err: e instanceof Error ? e.message : String(e) });
      // A bounded network call timed out (checkout creation / verify) → network-timeout toast; else generic.
      return { ok: false, key: e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.rechargeError' };
    }
  }

  /** Poll the authoritative save until coins rise above `before` (Paddle webhook lag) or attempts run out (~10s). */
  async function pollForCoinIncrease(before: number): Promise<boolean> {
    const delays = [1000, 1500, 2000, 2500, 3000];
    for (const ms of delays) {
      await new Promise((r) => setTimeout(r, ms));
      // Bound each refresh so a hung request can't stall the poll (ApiClient has no fetch timeout of its own).
      try { await withTimeout(saveManager.refresh()); } catch { /* keep polling; transient / timed out */ }
      if (saveManager.get().wallet.coins > before) return true;
    }
    return false;
  }

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
      onBack() {
        analytics.track('shop_close', { converted, time_sec: Math.round((Date.now() - shopOpenTs) / 1000) });
        if (onBack) onBack(); else nav.goLobby();
      },
      getCoins: () => saveManager.get().wallet.coins,
      getOwnedSkins: () => saveManager.get().inventory.skins,
      loadItems: () => client.getShopItems(),
      async buy(itemId) {
        try {
          const { save } = await client.shopBuy(itemId);
          saveManager.adoptServer(save);
          converted = true;
          analytics.track('shop_buy', { item_id: itemId, currency: 'coins' });
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
      // Monetization deals (GACHA_DESIGN §5–§6): monthly card + starter packs, only when online + logged in.
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
        async buyMonthlyCard() {
          try {
            const { save } = await client.monthlyCardBuy();
            saveManager.adoptServer(save);
            converted = true;
            analytics.track('monthly_card_buy', {});
            return { ok: true as const };
          } catch (e) {
            const key = e instanceof ApiError && e.code === 'ALREADY_ACTIVE' ? 'shop.cardActive' as const : 'shop.error' as const;
            return { ok: false as const, key };
          }
        },
        async buyYearCard() {
          try {
            const { save } = await client.yearCardBuy();
            saveManager.adoptServer(save);
            converted = true;
            analytics.track('year_card_buy', {});
            return { ok: true as const };
          } catch (e) {
            const key = e instanceof ApiError && e.code === 'ALREADY_ACTIVE' ? 'shop.cardActive' as const : 'shop.error' as const;
            return { ok: false as const, key };
          }
        },
        async claimMonthlyCard() {
          try {
            const { save, claimed } = await client.monthlyCardClaim();
            saveManager.adoptServer(save);
            return claimed > 0 ? { ok: true as const } : { ok: false as const, key: 'shop.monthlyNothing' as const };
          } catch { return { ok: false as const, key: 'shop.error' as const }; }
        },
        async buyStarter(productId: 'starter_draw' | 'starter_growth') {
          try {
            const { save } = await client.starterBuy(productId);
            saveManager.adoptServer(save);
            converted = true;
            analytics.track('starter_buy', { product_id: productId });
            return { ok: true as const };
          } catch (e) {
            const key = e instanceof ApiError && e.code === 'ALREADY_PURCHASED' ? 'shop.alreadyOwned' as const : 'shop.error' as const;
            return { ok: false as const, key };
          }
        },
      } : {}),
      // Shop group peer tabs (LOBBY_IA_REDESIGN P1.5): gacha / battle pass promoted to top tabs;
      // threading shopBack lets all three pages navigate to each other and return to the same origin (lobby / level-prep).
      openGacha() { goGacha({ shopBack: onBack }); },
      ...(shopLoggedIn ? { openBattlePass: () => goBattlePass({ shopBack: onBack }), getBattlePassBadge: battlePassBadgeClaimable } : {}),
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
      ...(inGroup ? { openShop: () => goShop(shopBack), getShopBadge: shopCardBadgeClaimable } : {}),
      ...(inGroup && coinsAvail ? { openCoins: () => goShop(shopBack, 'coins') } : {}),
      ...(inGroup && bpAvail ? { openBattlePass: () => goBattlePass({ shopBack }), getBattlePassBadge: battlePassBadgeClaimable } : {}),
      getCoins: () => saveManager.get().wallet.coins,
      getPity: (poolId) => saveManager.get().gacha.pity[poolId] ?? 0,
      getFatePoints: () => saveManager.get().monetization?.fatePoints ?? 0,
      loadPools: () => client.getGachaPools(),
      async draw(poolId, count) {
        try {
          const { save, results, overflow } = await client.gachaDraw(poolId, count);
          saveManager.adoptServer(save);
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
      ...(inGroup ? { openShop: () => goShop(shopBack), getShopBadge: shopCardBadgeClaimable, openGacha: () => goGacha({ shopBack }) } : {}),
      ...(inGroup && coinsAvail ? { openCoins: () => goShop(shopBack, 'coins') } : {}),
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

  return { goShop, goGacha, goDaily, goEvents, goBattlePass };
}
