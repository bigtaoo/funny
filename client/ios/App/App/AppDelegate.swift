import UIKit
import Capacitor
import StoreKit
import WebKit

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
    SKProductsRequestDelegate, SKPaymentTransactionObserver, WKScriptMessageHandler {

    private static let handlerName = "nwbilling"

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

    override func capacitorDidLoad() {
        SKPaymentQueue.default().add(self)
        guard let ucc = webView?.configuration.userContentController else { return }
        ucc.add(self, name: Self.handlerName)
        // atDocumentStart user script covers the real app navigation and any reload…
        ucc.addUserScript(WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // …and an immediate eval covers the case where navigation already began before this hook.
        webView?.evaluateJavaScript(Self.bridgeJS, completionHandler: nil)
    }

    deinit { SKPaymentQueue.default().remove(self) }

    private static func productId(for tierId: String) -> String {
        let bundle = Bundle.main.bundleIdentifier ?? "com.gamestao.nivara"
        return "\(bundle).coins.\(tierId)"
    }

    // MARK: WKScriptMessageHandler — receives { id, tierId } from window.NWBilling.purchase
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
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
}

