import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';
import type { AppViews } from '../app/AppViews';

// Test-only entry (client/test/browser Playwright specs) — boots the exact same real
// PixiJS/WebGL app as entries/web.ts, but wraps AppViews so a Playwright script can drive
// scene transitions by calling the real scene callbacks directly (window.__nwE2E) instead of
// clicking pixel coordinates on a single full-screen <canvas> with no per-widget DOM presence.
// Never referenced by any production entry (web/wechat/mobile/crazygames) — only reachable via
// `webpack --env TARGET=web-e2e` (see claudedocs/client-testing.md 缺口B).
//
// This is a different animal from the throwaway one-off debug global that
// test/no-debug-hooks-in-src.test.ts scans for and fails CI on: __nwE2E is permanent, deliberate
// test infrastructure isolated to this never-shipped entry file, not a forgotten scratch hook.

interface E2EState {
  screen?: string;
  [key: string]: unknown;
}

/**
 * Wraps every `show*` method (and the `apply*` push methods on any handle it returns) so a
 * Playwright script reading `window.__nwE2E.state` can see the current screen + the scene
 * callback object for it (`state.<screen>Cb`, e.g. `state.loginCb.onRegister(...)`) and the last
 * pushed value for any handle (`state.last<Xxx>`, e.g. `state.lastRoomState`) — mirroring the
 * `screen`/`lastRoomState` conventions test/harness/HeadlessAppViews.ts already uses for the
 * headless full-link E2E, so the two harnesses read the same way.
 */
function instrumentViews(views: AppViews): AppViews {
  const state: E2EState = {};
  const v = views as unknown as Record<string, (...a: unknown[]) => unknown>;
  const proto = Object.getPrototypeOf(views);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (!key.startsWith('show') || typeof v[key] !== 'function') continue;
    const orig = v[key].bind(views);
    const screenKey = key[4].toLowerCase() + key.slice(5);
    v[key] = (...args: unknown[]) => {
      state.screen = screenKey;
      state[`${screenKey}Cb`] = args[0];
      const handle = orig(...args);
      if (handle && typeof handle === 'object') {
        const h = handle as Record<string, (...a: unknown[]) => unknown>;
        for (const hKey of Object.keys(h)) {
          if (typeof h[hKey] !== 'function') continue;
          const origH = h[hKey].bind(h);
          h[hKey] = (...hArgs: unknown[]) => {
            if (hKey.startsWith('apply')) {
              // Server/core push, e.g. applyRoomState → state.lastRoomState.
              state[`last${hKey.slice(5)}`] = hArgs[0];
            } else {
              // One-shot UI call the core makes on the handle, e.g. showFeatureGuide(title, body,
              // onDismiss) for the first-time feature-guide gate (ONBOARDING_DESIGN §4.1) that sits
              // in front of most lobby-reachable features. Record the args, and if the last one is a
              // callback (the guide's onDismiss / a toast's onTap convention) expose it directly so a
              // Playwright script can invoke it to get past the gate: state.<name>Cb().
              state[`${hKey}Args`] = hArgs;
              const lastArg = hArgs[hArgs.length - 1];
              if (typeof lastArg === 'function') state[`${hKey}Cb`] = lastArg;
            }
            return origH(...hArgs);
          };
        }
      }
      return handle;
    };
  }
  (window as unknown as { __nwE2E: { views: AppViews; state: E2EState } }).__nwE2E = { views, state };
  return views;
}

startApp(new WebPlatform('game-canvas'), instrumentViews).catch(console.error);
