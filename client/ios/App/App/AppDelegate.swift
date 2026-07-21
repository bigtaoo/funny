import UIKit
import Capacitor
import StoreKit
import WebKit
import GoogleMobileAds
import AppTrackingTransparency

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

// MARK: - Native StoreKit billing bridge (window.NWBilling)
//
// Injects `window.NWBilling` into Capacitor's WKWebView so the web bundle routes coin-tier
// recharges through Apple IAP instead of Paddle (client/src/platform/iap.ts, WebPlatform.iapKind).
// StoreKit 1 consumable flow: fetch product → queue payment → on success hand the base64 App Store
// receipt back to JS, which POSTs it to /iap/verify (server/commercial/src/iap.ts → appleVerify,
// which reads in_app[] latest product_id → coins). Product IDs follow the server default convention
// `<bundleId>.coins.<tierId>` (e.g. com.gamestao.nivara.coins.t499); the server must set
// NW_IAP_BUNDLE=com.gamestao.nivara (or NW_IAP_PRODUCT_MAP) so the mapping matches (IAP_CREDENTIALS.md).
//
// Wired via Main.storyboard (customClass=NWBridgeViewController, module=App) so no new file needs
// to be added to the Xcode target's build phases — it compiles as part of the existing App target.
final class NWBridgeViewController: CAPBridgeViewController,
    SKProductsRequestDelegate, SKPaymentTransactionObserver, WKScriptMessageHandler,
    FullScreenContentDelegate {

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

    // jsId <-> product correlation for the async StoreKit round-trip.
    private var requestToJsId: [ObjectIdentifier: String] = [:]      // SKProductsRequest -> jsId
    private var pendingByProduct: [String: [String]] = [:]           // productId -> [jsId] (FIFO)

    // JS injected into every page load: defines window.NWBilling + a promise-settle registry.
    private static let bridgeJS = """
    (function(){
      if (window.NWBilling && window.NWBilling.__nw) return;
      var seq = 0; var pending = {};
      window.__nwBillingSettle = function(id, ok, payload){
        var p = pending[id]; if(!p) return; delete pending[id];
        if(ok){ p.resolve({ receipt: payload }); } else { p.reject(new Error(payload || 'purchase_failed')); }
      };
      window.NWBilling = {
        __nw: true,
        kind: 'apple',
        purchase: function(tierId){
          return new Promise(function(resolve, reject){
            var id = 'nw' + (++seq);
            pending[id] = { resolve: resolve, reject: reject };
            try {
              window.webkit.messageHandlers.nwbilling.postMessage({ id: id, tierId: String(tierId) });
            } catch (e) { delete pending[id]; reject(e); }
          });
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
        SKPaymentQueue.default().add(self)
        guard let ucc = webView?.configuration.userContentController else { return }
        ucc.add(self, name: Self.handlerName)
        // atDocumentStart user script covers the real app navigation and any reload…
        ucc.addUserScript(WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // …and an immediate eval covers the case where navigation already began before this hook.
        webView?.evaluateJavaScript(Self.bridgeJS, completionHandler: nil)

        // AdMob rewarded-ad bridge (window.NWAds) — see the matching MARK section below.
        MobileAds.shared.start(completionHandler: nil)
        ucc.add(self, name: Self.adsHandlerName)
        ucc.addUserScript(WKUserScript(source: Self.adsBridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView?.evaluateJavaScript(Self.adsBridgeJS, completionHandler: nil)
        preloadRewardedAd()
    }

    deinit { SKPaymentQueue.default().remove(self) }

    private static func productId(for tierId: String) -> String {
        let bundle = Bundle.main.bundleIdentifier ?? "com.gamestao.nivara"
        return "\(bundle).coins.\(tierId)"
    }

    // MARK: WKScriptMessageHandler — receives { id, tierId } from window.NWBilling.purchase,
    // or { id, accountId } from window.NWAds.showRewarded (see the ads MARK section below).
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == Self.adsHandlerName {
            guard let body = message.body as? [String: Any],
                  let jsId = body["id"] as? String else { return }
            handleShowRewarded(jsId: jsId, accountId: body["accountId"] as? String)
            return
        }
        guard message.name == Self.handlerName,
              let body = message.body as? [String: Any],
              let jsId = body["id"] as? String,
              let tierId = body["tierId"] as? String else { return }
        guard SKPaymentQueue.canMakePayments() else {
            settle(jsId, ok: false, payload: "payments_disabled"); return
        }
        let request = SKProductsRequest(productIdentifiers: [Self.productId(for: tierId)])
        request.delegate = self
        requestToJsId[ObjectIdentifier(request)] = jsId
        request.start()
    }

    // MARK: SKProductsRequestDelegate
    func productsRequest(_ request: SKProductsRequest, didReceive response: SKProductsResponse) {
        guard let jsId = requestToJsId.removeValue(forKey: ObjectIdentifier(request)) else { return }
        guard let product = response.products.first else {
            settle(jsId, ok: false, payload: "invalid_product"); return
        }
        pendingByProduct[product.productIdentifier, default: []].append(jsId)
        SKPaymentQueue.default().add(SKPayment(product: product))
    }

    func request(_ request: SKRequest, didFailWithError error: Error) {
        guard let skReq = request as? SKProductsRequest,
              let jsId = requestToJsId.removeValue(forKey: ObjectIdentifier(skReq)) else { return }
        settle(jsId, ok: false, payload: error.localizedDescription)
    }

    // MARK: SKPaymentTransactionObserver
    func paymentQueue(_ queue: SKPaymentQueue, updatedTransactions transactions: [SKPaymentTransaction]) {
        for tx in transactions {
            switch tx.transactionState {
            case .purchased, .restored:
                if let receipt = Self.appStoreReceiptBase64() {
                    resolveNext(for: tx.payment.productIdentifier, ok: true, payload: receipt)
                } else {
                    resolveNext(for: tx.payment.productIdentifier, ok: false, payload: "no_receipt")
                }
                SKPaymentQueue.default().finishTransaction(tx)
            case .failed:
                let cancelled = (tx.error as NSError?)?.code == SKError.paymentCancelled.rawValue
                resolveNext(for: tx.payment.productIdentifier, ok: false,
                            payload: cancelled ? "cancelled" : (tx.error?.localizedDescription ?? "failed"))
                SKPaymentQueue.default().finishTransaction(tx)
            case .purchasing, .deferred:
                break
            @unknown default:
                break
            }
        }
    }

    private func resolveNext(for productId: String, ok: Bool, payload: String) {
        guard var ids = pendingByProduct[productId], !ids.isEmpty else { return }
        let jsId = ids.removeFirst()
        pendingByProduct[productId] = ids.isEmpty ? nil : ids
        settle(jsId, ok: ok, payload: payload)
    }

    private static func appStoreReceiptBase64() -> String? {
        guard let url = Bundle.main.appStoreReceiptURL,
              let data = try? Data(contentsOf: url) else { return nil }
        return data.base64EncodedString()
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

    /** Load the next ad in the background so `showRewarded` doesn't pay the network round-trip. */
    private func preloadRewardedAd() {
        Task { [weak self] in
            guard let self = self else { return }
            do {
                let ad = try await RewardedAd.load(with: Self.rewardedAdUnitId, request: Request())
                ad.fullScreenContentDelegate = self
                self.rewardedAd = ad
            } catch {
                NSLog("[NWAds] preload failed: \(error.localizedDescription)")
            }
        }
    }

    /** Requests ATT (once, on first ad request — a no-op if already answered) then presents the preloaded ad. */
    private func handleShowRewarded(jsId: String, accountId: String?) {
        requestTrackingAuthorizationIfNeeded { [weak self] in
            self?.presentRewardedAd(jsId: jsId, accountId: accountId)
        }
    }

    private func presentRewardedAd(jsId: String, accountId: String?) {
        guard let ad = rewardedAd else {
            settleAds(jsId, ok: false, payload: "ad_not_ready")
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

    /** ATT must be requested before any ad request that could use IDFA; safe to call repeatedly (no-op once answered). */
    private func requestTrackingAuthorizationIfNeeded(_ completion: @escaping () -> Void) {
        if #available(iOS 14, *) {
            guard ATTrackingManager.trackingAuthorizationStatus == .notDetermined else { completion(); return }
            ATTrackingManager.requestTrackingAuthorization { _ in DispatchQueue.main.async(execute: completion) }
        } else {
            completion()
        }
    }

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

