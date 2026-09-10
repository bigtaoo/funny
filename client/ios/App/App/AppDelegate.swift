import UIKit
import Capacitor
import StoreKit
import WebKit
import GoogleMobileAds

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// MARK: - Native StoreKit 2 billing bridge (window.NWBilling)
//
// Injects `window.NWBilling` into Capacitor's WKWebView so the web bundle routes recharges and the
// four non-coin SKUs through Apple IAP instead of Paddle (client/src/platform/iap.ts,
// WebPlatform.iapKind).
//
// ── StoreKit 2 since 2026-09-07 (IOS_RELEASE.md §6 phase B) ──
// This was StoreKit 1 (SKProductsRequest + SKPaymentQueue observer) handing the base64 app receipt
// to JS, which POSTed it to /iap/verify. Three things the move buys, in the order they matter:
//
//   1. `appAccountToken`. A subscription renewal is billed inside Apple's systems and the
//      notification that reports it carries no identifier of ours — unless the purchase attached
//      one. This is that identifier, allocated server-side before the purchase (/bootstrap), so a
//      renewal names its owner even if the app never got to report the original sale.
//   2. `Transaction.updates` / `Transaction.unfinished`. Transactions that arrive outside a
//      purchase() call — an Ask-to-Buy approval, a restore on another device, anything a previous
//      install left unfinished — appear only here. StoreKit 1 surfaced them through the payment
//      queue observer; with StoreKit 2 there is no equivalent unless these streams are consumed.
//   3. No receipt parsing anywhere. A verified `Transaction` is signed by Apple, so JS forwards a
//      bare transaction id and the server asks the App Store Server API for the authoritative
//      record (server/commercial/src/iap/appleServerApi.ts).
//
// ── The finish() rule ──
// Nothing is finished here. A transaction is finished only after JS reports it and the SERVER says
// it granted (`window.NWBilling.finish`). Until then StoreKit redelivers it on every launch, which
// is exactly what should happen to "money taken, coins not delivered": finishing on arrival would
// make that state both unrecoverable and invisible. The cost is that a permanently unusable
// transaction is retried once per session forever — cheap, and visible in the server logs.
//
// Product IDs follow the server's conventions: `<bundleId>.coins.<tierId>` for coin tiers and the
// four suffixes in `nonCoinProductSuffixes` for the rest (server/commercial/src/iap/productResolve.ts;
// the two tables are pinned to each other by client/test/nativePaymentIsolation.test.ts). The server
// must set NW_IAP_BUNDLE=com.gamestao.nivara so the mapping matches (IAP_CREDENTIALS.md).
//
// Wired via Main.storyboard (customClass=NWBridgeViewController, module=App) so no new file needs
// to be added to the Xcode target's build phases — it compiles as part of the existing App target.
final class NWBridgeViewController: CAPBridgeViewController,
    WKScriptMessageHandler, FullScreenContentDelegate {

    private static let handlerName = "nwbilling"

    // ── AdMob rewarded-ad bridge (window.NWAds) constants — implementation below, MARK: NWAds ──
    private static let adsHandlerName = "nwads"
    // Real AdMob rewarded ad unit (created 2026-07-21, IAP_CREDENTIALS.md §2.1) in release builds;
    // Google's official test unit in debug builds, so local/simulator testing never sends real ad
    // requests against our own AdMob account before the app has gone through App Review.
    #if DEBUG
    private static let rewardedAdUnitId = "ca-app-pub-3940256099942544/1712485313"
    #else
    private static let rewardedAdUnitId = "ca-app-pub-5437693117291100/3500329092"
    #endif

    /// One transaction Apple has verified, waiting for JS to report it and call finish().
    private struct QueuedTx {
        let transactionId: String
        /// The key JS knows the product by ('t499', 'monthly_card', …) — it decides which endpoint reports it.
        let productKey: String
    }

    /// Verified transactions the server has not acknowledged yet, keyed by transaction id.
    private var unfinished: [String: StoreKit.Transaction] = [:]
    /// Transactions already handed to JS this session (by purchase() or pending()) — kept out of the
    /// queue so one transaction is not reported twice. The consequence when a report then fails: the
    /// transaction is not offered again until the next launch, where it comes back through
    /// `Transaction.unfinished` (nothing finished it, so it is still owed). One retry per launch is
    /// the right cadence for something the player is not waiting on.
    private var handed: Set<String> = []
    /// Queue drained by `window.NWBilling.pending()`, oldest first.
    private var queued: [QueuedTx] = []
    private var updatesTask: Task<Void, Never>?

    /// `Transaction.unfinished` replays everything this install still owes content for, which after a
    /// StoreKit 1 → 2 migration or a restore is a long tail of history rather than a handful of
    /// events. The queue is bounded so one boot cannot turn into hundreds of POSTs; anything past the
    /// cap stays in StoreKit's own queue and is picked up on a later launch.
    private static let maxQueued = 50

    // JS injected into every page load: defines window.NWBilling + a promise-settle registry.
    private static let bridgeJS = """
    (function(){
      if (window.NWBilling && window.NWBilling.__nw) return;
      var seq = 0; var pending = {};
      window.__nwBillingSettle = function(id, ok, payload){
        var p = pending[id]; if(!p) return; delete pending[id];
        if(ok){ p.resolve(payload); } else { p.reject(new Error(payload || 'purchase_failed')); }
      };
      function call(msg, unwrap){
        return new Promise(function(resolve, reject){
          var id = 'nw' + (++seq);
          pending[id] = { resolve: function(payload){ resolve(unwrap(payload)); }, reject: reject };
          msg.id = id;
          try { window.webkit.messageHandlers.nwbilling.postMessage(msg); }
          catch (e) { delete pending[id]; reject(e); }
        });
      }
      window.NWBilling = {
        __nw: 2,
        kind: 'apple',
        // Resolves with the Apple transaction id, carried in `receipt` for contract compatibility —
        // the JS side and the server both accept a bare id there (client/src/platform/iap.ts).
        // `appAccountToken` is optional: an older JS bundle running on this binary just omits it.
        purchase: function(tierId, appAccountToken){
          return call({ tierId: String(tierId), appAccountToken: appAccountToken ? String(appAccountToken) : null },
                      function(p){ return { receipt: p }; });
        },
        // A transaction id belonging to this device's subscription, or null when there is none.
        // Read by the auto-renewable subscription sync (src/platform/appleSubscriptionSync.ts).
        // Still named `receipt` because that is what an older JS bundle asks for; under StoreKit 2
        // there is no receipt to read and the server needs no more than an id.
        receipt: function(){
          return call({ op: 'receipt' }, function(p){ return p ? p : null; });
        },
        // Transactions StoreKit delivered outside a purchase() call, each { transactionId, productKey }.
        // The caller reports each one to the server and only then calls finish() on it.
        pending: function(){
          return call({ op: 'pending' }, function(p){ try { return JSON.parse(p || '[]'); } catch (e) { return []; } });
        },
        // Tell StoreKit the content was delivered. Only ever called after the server granted.
        finish: function(transactionId){
          return call({ op: 'finish', transactionId: String(transactionId) }, function(){ return undefined; });
        }
      };
    })();
    """

    // JS injected into every page load: defines window.NWAds, detected by WebPlatform.hasRewardedAd()
    // (client/src/platform/web/WebPlatform.ts) to decide whether the DailyScene "Ads" tab shows at all.
    private static let adsBridgeJS = """
    (function(){
      if (window.NWAds && window.NWAds.__nw) return;
      var seq = 0; var pending = {};
      window.__nwAdsSettle = function(id, ok, payload){
        var p = pending[id]; if(!p) return; delete pending[id];
        if(ok){ p.resolve({ adToken: payload, platform: 'admob_client' }); } else { p.reject(new Error(payload || 'ad_failed')); }
      };
      window.NWAds = {
        __nw: true,
        kind: 'admob',
        showRewarded: function(accountId){
          return new Promise(function(resolve, reject){
            var id = 'nwad' + (++seq);
            pending[id] = { resolve: resolve, reject: reject };
            try {
              window.webkit.messageHandlers.nwads.postMessage({ id: id, accountId: String(accountId || '') });
            } catch (e) { delete pending[id]; reject(e); }
          });
        }
      };
    })();
    """

    override func capacitorDidLoad() {
        guard let ucc = webView?.configuration.userContentController else { return }
        ucc.add(self, name: Self.handlerName)
        // atDocumentStart user script covers the real app navigation and any reload…
        ucc.addUserScript(WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // …and an immediate eval covers the case where navigation already began before this hook.
        webView?.evaluateJavaScript(Self.bridgeJS, completionHandler: nil)
        startTransactionListener()

        // AdMob rewarded-ad bridge (window.NWAds) — see the matching MARK section below.
        MobileAds.shared.start(completionHandler: nil)
        ucc.add(self, name: Self.adsHandlerName)
        ucc.addUserScript(WKUserScript(source: Self.adsBridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView?.evaluateJavaScript(Self.adsBridgeJS, completionHandler: nil)
        preloadRewardedAd()
    }

    deinit { updatesTask?.cancel() }

    // The JS side buys more than coin tiers through this same bridge: the shop's subscription cards
    // and starter packs also call window.NWBilling.purchase(), with the product key instead of a
    // tier id (client/src/app/nav/shop/iap.ts — doBuySubscription / doBuyStarter). Those four have
    // their own product-id convention on the verifying end, `<bundle>.sub.monthly` / `.sub.year` /
    // `.starter.draw` / `.starter.growth` (server/commercial/src/iap/productResolve.ts,
    // resolveNonCoinProduct). Deriving every id as `<bundle>.coins.<key>` — as this did until
    // 2026-09-03 — asked StoreKit for four products that exist in no App Store Connect account, so
    // all four buttons failed with `invalid_product`, and had the products been created under that
    // name the receipt would then have resolved to nothing server-side, after the player was
    // charged. Both sides must name the same product; this table is that agreement.
    private static let nonCoinProductSuffixes: [String: String] = [
        "monthly_card": "sub.monthly",
        "year_card": "sub.year",
        "starter_draw": "starter.draw",
        "starter_growth": "starter.growth",
    ]

    private static func bundleId() -> String {
        return Bundle.main.bundleIdentifier ?? "com.gamestao.nivara"
    }

    private static func productId(for tierId: String) -> String {
        let bundle = bundleId()
        if let suffix = nonCoinProductSuffixes[tierId] { return "\(bundle).\(suffix)" }
        return "\(bundle).coins.\(tierId)"
    }

    /// The inverse of `productId(for:)`: which key JS knows this App Store product by, or nil for a
    /// product this build has no name for (a retired SKU, or one only a newer JS bundle knows).
    private static func productKey(for productId: String) -> String? {
        let bundle = bundleId()
        let coinPrefix = "\(bundle).coins."
        if productId.hasPrefix(coinPrefix) { return String(productId.dropFirst(coinPrefix.count)) }
        for (key, suffix) in nonCoinProductSuffixes where productId == "\(bundle).\(suffix)" { return key }
        return nil
    }

    /// The two auto-renewable product ids, for the subscription lookup `receipt()` answers with.
    private static func subscriptionProductIds() -> [String] {
        return ["monthly_card", "year_card"]
            .compactMap { nonCoinProductSuffixes[$0] }
            .map { "\(bundleId()).\($0)" }
    }

    /// Unwrap a StoreKit verification result, or nil when Apple's signature did not check out.
    ///
    /// `.unverified` is not "probably fine": acting on it would let a tampered device mint
    /// transactions. Such a transaction is also deliberately NOT finished — it stays in StoreKit's
    /// queue instead of being silently consumed, so a genuine purchase behind a transient
    /// verification failure is not thrown away.
    private static func verified(_ result: VerificationResult<StoreKit.Transaction>) -> StoreKit.Transaction? {
        if case .verified(let tx) = result { return tx }
        return nil
    }

    // MARK: Transaction listener
    //
    // Two streams, both required. `Transaction.unfinished` is finite and yields the backlog this
    // install still owes content for; `Transaction.updates` runs for the process lifetime and
    // delivers what arrives later (an Ask-to-Buy approval, a renewal, a purchase made on another
    // device). Started from capacitorDidLoad, before the web view can ask for anything, so a
    // transaction that lands during startup is queued rather than missed. The backlog is drained
    // first and the live stream is attached after it: a transaction arriving in that gap is not
    // finished by anyone, so it simply reappears in `unfinished` on the next launch.
    private func startTransactionListener() {
        updatesTask = Task { [weak self] in
            for await result in StoreKit.Transaction.unfinished {
                await self?.ingest(result)
            }
            for await result in StoreKit.Transaction.updates {
                await self?.ingest(result)
            }
        }
    }

    @MainActor
    private func ingest(_ result: VerificationResult<StoreKit.Transaction>) {
        guard let tx = Self.verified(result) else { return }
        let id = String(tx.id)
        unfinished[id] = tx
        // Already reported this session — either purchase() just handed it over, or pending() did.
        if handed.contains(id) { return }
        guard let key = Self.productKey(for: tx.productID) else { return }
        if queued.contains(where: { $0.transactionId == id }) { return }
        if queued.count >= Self.maxQueued { return }
        queued.append(QueuedTx(transactionId: id, productKey: key))
    }

    // MARK: WKScriptMessageHandler — window.NWBilling.* and window.NWAds.showRewarded
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == Self.adsHandlerName {
            guard let body = message.body as? [String: Any],
                  let jsId = body["id"] as? String else { return }
            handleShowRewarded(jsId: jsId, accountId: body["accountId"] as? String)
            return
        }
        guard message.name == Self.handlerName,
              let body = message.body as? [String: Any],
              let jsId = body["id"] as? String else { return }

        switch body["op"] as? String {
        case "receipt":
            Task { await handleSubscriptionId(jsId: jsId) }
        case "pending":
            handlePending(jsId: jsId)
        case "finish":
            guard let transactionId = body["transactionId"] as? String else {
                settle(jsId, ok: false, payload: "missing_transaction_id"); return
            }
            Task { await handleFinish(jsId: jsId, transactionId: transactionId) }
        default:
            guard let tierId = body["tierId"] as? String else { return }
            Task {
                await handlePurchase(jsId: jsId, tierId: tierId,
                                     appAccountToken: body["appAccountToken"] as? String)
            }
        }
    }

    // MARK: Purchase
    @MainActor
    private func handlePurchase(jsId: String, tierId: String, appAccountToken: String?) async {
        guard AppStore.canMakePayments else {
            settle(jsId, ok: false, payload: "payments_disabled"); return
        }
        do {
            let products = try await Product.products(for: [Self.productId(for: tierId)])
            guard let product = products.first else {
                settle(jsId, ok: false, payload: "invalid_product"); return
            }
            var options: Set<Product.PurchaseOption> = []
            // The account this purchase belongs to, as a UUID the server allocated and recorded
            // beforehand (/bootstrap → appleAccountTokens). Apple echoes it back on every
            // notification about this transaction, which is what lets a renewal be attributed
            // without the app having reported the original sale. A value that is not a UUID is
            // dropped rather than failing the sale: the money is the player's, the token is our
            // bookkeeping, and the appleTransactionLinks fallback still covers it.
            if let raw = appAccountToken, let uuid = UUID(uuidString: raw) {
                options.insert(.appAccountToken(uuid))
            }
            switch try await product.purchase(options: options) {
            case .success(let verification):
                guard let tx = Self.verified(verification) else {
                    settle(jsId, ok: false, payload: "unverified"); return
                }
                let id = String(tx.id)
                unfinished[id] = tx
                handed.insert(id)
                settle(jsId, ok: true, payload: id)
            case .userCancelled:
                settle(jsId, ok: false, payload: "cancelled")
            case .pending:
                // Ask-to-Buy or an SCA challenge: there is no transaction yet. If it is approved —
                // possibly days later, possibly while the app is closed — it arrives on
                // Transaction.updates and is reported through pending() then.
                settle(jsId, ok: false, payload: "deferred")
            @unknown default:
                settle(jsId, ok: false, payload: "failed")
            }
        } catch {
            settle(jsId, ok: false, payload: error.localizedDescription)
        }
    }

    // MARK: Unfinished-transaction handoff
    private func handlePending(jsId: String) {
        for tx in queued { handed.insert(tx.transactionId) }
        let items = queued.map { ["transactionId": $0.transactionId, "productKey": $0.productKey] }
        let json = (try? JSONSerialization.data(withJSONObject: items))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        settle(jsId, ok: true, payload: json)
    }

    @MainActor
    private func handleFinish(jsId: String, transactionId: String) async {
        queued.removeAll { $0.transactionId == transactionId }
        handed.remove(transactionId)
        if let tx = unfinished.removeValue(forKey: transactionId) {
            await tx.finish()
        }
        // Resolves either way: JS may retry finish() after a dropped response, and a transaction
        // finished in an earlier session is simply no longer known to StoreKit. Both are success.
        settle(jsId, ok: true, payload: "")
    }

    // MARK: Subscription id for the cold-start sync
    //
    // `Transaction.latest(for:)` rather than `currentEntitlements`: a subscription that has already
    // lapsed still has a last period that may never have been granted, and that is precisely the
    // case the sync exists for. A coin transaction id would be useless here — the server expands the
    // id into the whole history behind it, and a consumable's history holds no subscription periods.
    @MainActor
    private func handleSubscriptionId(jsId: String) async {
        var newest: StoreKit.Transaction?
        for productId in Self.subscriptionProductIds() {
            guard let result = await StoreKit.Transaction.latest(for: productId),
                  let tx = Self.verified(result) else { continue }
            if newest == nil || tx.purchaseDate > newest!.purchaseDate { newest = tx }
        }
        settle(jsId, ok: true, payload: newest.map { String($0.id) } ?? "")
    }

    // Settle the JS promise on the main thread via the injected registry.
    private func settle(_ jsId: String, ok: Bool, payload: String) {
        let escaped = payload
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
        let js = "window.__nwBillingSettle && window.__nwBillingSettle('\(jsId)', \(ok), '\(escaped)')"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // MARK: - AdMob rewarded-ad bridge (window.NWAds)
    //
    // Real reward verification happens server-side via AdMob's Server-Side Verification callback
    // (already configured in the AdMob console → /ads/callback/admob, see server/metaserver/src/ads.ts
    // registerAdCallbackRoutes) — this bridge's `adToken` is just a locally-generated unique string to
    // satisfy the client-side POST /ads/reward's replay-dedup check (`platform: 'admob_client'`,
    // ADMOB_CLIENT_KEY unset → server accepts without signature verification, relies on SSV + cap).
    //
    // RewardedAd itself carries no verifiable server-side transaction id (unlike a StoreKit
    // receipt) — SSV's `custom_data` (set to accountId below) is what lets the server credit the
    // right account when Google's callback lands, independent of anything this bridge reports.

    private var rewardedAd: RewardedAd?
    private var pendingAdJsId: String?
    /**
     * Why the last `RewardedAd.load` failed, kept so the JS side can say it out loud.
     *
     * The NSLog below is the only other record, and this bridge only ever runs on a signed device
     * build — TestFlight, no Mac, no Console.app — so in practice nobody can read it. Without this,
     * every failure reached the player as one word, `ad_not_ready`, and AdMob's no-fill (expected
     * until the app is live on the App Store) was indistinguishable from a wrong ad unit id or an
     * SDK that never started. The error CODE is what separates them, so keep it in the string:
     * GADErrorCode 3 = no fill, 2 = network, 1 = invalid request, 0 = internal.
     *
     * nil has two distinct meanings, both of them useful: no load has failed yet (the first load is
     * still in flight — the player pressed the button within a second or two of launch), or the last
     * load succeeded and the ad was consumed.
     */
    private var lastAdLoadError: String?

    /**
     * An ad request tagged non-personalized (`npa=1`), which is what every request from this app
     * uses. This is the decision that keeps the App Privacy label honest (2026-09-03): the app
     * declares no tracking, shows no ATT prompt, and therefore must not ask Google for
     * personalised ads — `npa=1` says so explicitly rather than relying on the IDFA simply being
     * unavailable. It costs some eCPM and buys a label that matches the binary.
     *
     * SKAdNetwork (`SKAdNetworkItems` in Info.plist) deliberately stays: Apple's own App Privacy
     * guidance excludes it from the definition of tracking — it reports install attribution in
     * aggregate, with no user-level identifier and no ATT requirement.
     */
    private func nonPersonalizedRequest() -> Request {
        let request = Request()
        let extras = Extras()
        extras.additionalParameters = ["npa": "1"]
        request.register(extras)
        return request
    }

    /** Load the next ad in the background so `showRewarded` doesn't pay the network round-trip. */
    private func preloadRewardedAd() {
        Task { [weak self] in
            guard let self = self else { return }
            do {
                let ad = try await RewardedAd.load(with: Self.rewardedAdUnitId, request: self.nonPersonalizedRequest())
                ad.fullScreenContentDelegate = self
                self.rewardedAd = ad
                self.lastAdLoadError = nil
            } catch {
                let ns = error as NSError
                // Domain is included because a non-GAD domain immediately rules out "AdMob said no"
                // and points at the network stack or App Transport Security instead.
                self.lastAdLoadError = "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
                NSLog("[NWAds] preload failed: \(error.localizedDescription)")
            }
        }
    }

    /**
     * Presents the preloaded ad. No App Tracking Transparency prompt: this app serves
     * NON-PERSONALIZED ads only (see `nonPersonalizedRequest()`), so it never asks for the IDFA and
     * has nothing to ask permission for. Apple's App Privacy answers say "Data Used to Track You:
     * none", and an ATT prompt in an app that doesn't track is both a rejection risk and a needless
     * scare for the player.
     */
    private func handleShowRewarded(jsId: String, accountId: String?) {
        presentRewardedAd(jsId: jsId, accountId: accountId)
    }

    private func presentRewardedAd(jsId: String, accountId: String?) {
        guard let ad = rewardedAd else {
            // Carries the reason, not just the symptom — see lastAdLoadError. JS files this string
            // as a `type=ad` anomaly (WebPlatform.showRewardedAd), so it is readable in Loki.
            let reason = lastAdLoadError ?? "first load still in flight"
            settleAds(jsId, ok: false, payload: "ad_not_ready: \(reason)")
            preloadRewardedAd() // try to have one ready for next time
            return
        }
        if let accountId = accountId, !accountId.isEmpty {
            let options = ServerSideVerificationOptions()
            options.customRewardText = accountId
            ad.serverSideVerificationOptions = options
        }
        pendingAdJsId = jsId
        rewardedAd = nil // consumed — preloadRewardedAd() (called from adDidDismiss below) fetches the next one
        ad.present(from: self) { [weak self] in
            // Reward earned — but don't settle yet: wait for adDidDismissFullScreenContent so the
            // JS promise only resolves once the ad view is actually gone (matches the WeChat/
            // CrazyGames bridges' "settle on close" convention in IPlatform.showRewardedAd()).
            self?.adRewardEarned = true
        }
    }

    private var adRewardEarned = false

    // MARK: FullScreenContentDelegate
    func adDidDismissFullScreenContent(_ ad: FullScreenPresentingAd) {
        guard let jsId = pendingAdJsId else { return }
        pendingAdJsId = nil
        let earned = adRewardEarned
        adRewardEarned = false
        settleAds(jsId, ok: earned, payload: earned ? UUID().uuidString : "dismissed_before_reward")
        preloadRewardedAd()
    }

    func ad(_ ad: FullScreenPresentingAd, didFailToPresentFullScreenContentWithError error: Error) {
        guard let jsId = pendingAdJsId else { return }
        pendingAdJsId = nil
        adRewardEarned = false
        settleAds(jsId, ok: false, payload: error.localizedDescription)
        preloadRewardedAd()
    }

    /** Resolve/reject the JS promise `window.NWAds.showRewarded` handed out for `jsId`. */
    private func settleAds(_ jsId: String, ok: Bool, payload: String) {
        let escaped = payload
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
        let js = "window.__nwAdsSettle && window.__nwAdsSettle('\(jsId)', \(ok), '\(escaped)')"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}

