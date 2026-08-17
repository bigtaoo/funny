// Build-time stand-in for @capacitor/core on every non-mobile target (web / crazygames / wechat),
// swapped in by the NormalModuleReplacementPlugin in webpack.config.js — see the comment there.
//
// The real package is ~28 KB of ESM (~9 KB into the minified bundle): a plugin registry, the
// native-bridge handshake, the `Plugins` proxy, exception types. All of it exists to talk to a
// native shell that a non-mobile bundle is never loaded by, so every question this module can
// answer there has a constant answer — which is all this stub is.
//
// Rule for extending it: only surface that is genuinely *constant* for a non-native bundle belongs
// here (the two below). Anything else — `registerPlugin`, `WebPlugin`, `isPluginAvailable` — means
// real Capacitor machinery is wanted on web, which this stub must not fake; drop the corresponding
// entry from the webpack table instead and take the bytes. Leaving it out is safe by construction:
// webpack reports an unknown named import as a build-time "export not found" warning.

export const Capacitor = {
  /** False by construction: a bundle built for web/crazygames/wechat is not the iOS shell. */
  isNativePlatform: (): boolean => false,
  /** What the real implementation also returns off-device — it has no other non-native value. */
  getPlatform: (): string => 'web',
};
