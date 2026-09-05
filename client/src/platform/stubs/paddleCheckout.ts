// Build-time stand-in for platform/web/paddleCheckout.ts on the `mobile` target, swapped in by the
// NormalModuleReplacementPlugin in webpack.config.js — see the comment there.
//
// Mirror image of the Capacitor stubs next door (capacitorCore.ts / localNotifications.ts): those
// keep native-only code out of the web bundles, this keeps web-only code out of the native one.
// The difference is that this one is not about bytes. The real module loads paddle.js from Paddle's
// CDN and opens a hosted checkout; inside an App Store build that is an alternative purchase
// mechanism, which App Review guideline 3.1.1 treats as grounds for removal. Runtime guards already
// keep callers away (WebPlatform.iapKind() answers null in the shell, so the shop never offers a
// recharge), but a guard is a promise about behaviour — this is the shipped binary simply not
// containing the payment SDK loader, the CDN URL, or any Paddle API call.
//
// Reaching this throw means a caller found its way past those guards, which is a bug in the caller,
// not a case to handle: the native shell bills through StoreKit (window.NWBilling → /iap/verify).

export class PaddleCheckout {
  open(): Promise<{ completed: boolean }> {
    return Promise.reject(new Error('paddle checkout is not part of the native build'));
  }
}
