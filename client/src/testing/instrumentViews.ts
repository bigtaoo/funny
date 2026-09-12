// The `__nwE2E` harness: wraps a real `AppViews` so a driver can see which screen is up, call the
// scene's own callbacks, and walk the real display tree.
//
// Lifted out of `entries/web-e2e.ts` (2026-09-12) because the WeChat layout probe
// (`entries/wechat-layout.ts`) needs exactly the same handle. There is no second implementation:
// the two entries install THIS module and differ only in what they do with the handle — Playwright
// reaches it across a process boundary via `page.evaluate`, the WeChat probe holds it directly.
//
// Never referenced by a production entry (web/wechat/mobile/crazygames) — only by the
// never-shipped `web-e2e` / `wechat-layout` targets. This is permanent, deliberate test
// infrastructure, not one of the throwaway scratch globals `test/no-debug-hooks-in-src.test.ts`
// scans `src/` for.
//
// ⚠ `globalThis`, not `window`. The mini-game runtime has no `window` of its own (our host shim
// defines a partial one, but nothing may depend on which fields it got), and webpack's WeChat
// output already sets `globalObject: 'globalThis'`. Chromium has `globalThis` too, so the browser
// side loses nothing — but `layoutAudit.ts` reads this handle from inside `page.evaluate`, so the
// NAME has to be the one both runtimes answer to.

import type * as PIXI from 'pixi.js-legacy';
import type { AppViews } from '../app/AppViews';
import type { InputManager } from '../inputSystem/InputManager';
import type { ScalingManager } from '../layout/ScalingManager';

export interface E2EState {
  screen?: string;
  [key: string]: unknown;
}

/**
 * What `instrumentViews` publishes. `views`/`state` are the navigation surface; `app`, `input` and
 * `scaling` are the three handles a driver needs to act on the picture rather than on the graph —
 * respectively: the real stage to measure, the funnel every platform adapter feeds pointer events
 * into, and the screen→design transform that turns a measured rect into coordinates that funnel
 * accepts. Playwright needs only `app` (it clicks real screen pixels through the browser); the
 * in-package walk has no browser to click with, so it needs all three.
 */
export interface E2EHandle {
  views: AppViews;
  state: E2EState;
  app?: PIXI.Application;
  input?: InputManager;
  scaling?: ScalingManager;
  /** Anything an entry adds on top (web-e2e's `bake` / `textMetrics`). */
  [key: string]: unknown;
}

/** An object whose values include at least one function — i.e. a scene's callbacks bag. */
function isCallbackBag(a: unknown): boolean {
  return !!a && typeof a === 'object' && Object.values(a).some((x) => typeof x === 'function');
}

/**
 * Wraps every `show*` method (and the `apply*` push methods on any handle it returns) so a driver
 * reading `__nwE2E.state` can see the current screen + the scene callback object for it
 * (`state.<screen>Cb`, e.g. `state.loginCb.onRegister(...)`) and the last pushed value for any
 * handle (`state.last<Xxx>`, e.g. `state.lastRoomState`) — mirroring the `screen`/`lastRoomState`
 * conventions test/harness/HeadlessAppViews.ts already uses for the headless full-link E2E, so the
 * two harnesses read the same way.
 *
 * Installs the handle on `globalThis.__nwE2E` and returns it, so an entry can bolt its own extras
 * onto the same object. Pass it straight to `startApp`'s `wrapViews` seam — it also returns the
 * views instance it was handed, so `startApp(platform, (v) => instrumentViews(v).views)` works.
 */
export function instrumentViews(views: AppViews): E2EHandle {
  const state: E2EState = {};
  const v = views as unknown as Record<string, (...a: unknown[]) => unknown>;
  const proto = Object.getPrototypeOf(views);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (!key.startsWith('show') || typeof v[key] !== 'function') continue;
    const orig = v[key].bind(views);
    const screenKey = key[4]!.toLowerCase() + key.slice(5);
    v[key] = (...args: unknown[]) => {
      state.screen = screenKey;
      // The callbacks object is args[0] for most `show*` methods, but not all: `showAgeGate(mode,
      // cb)` and `showRealLayerInterlude(url, textKey, cb)` lead with plain data. Pick the first
      // argument that actually carries functions, so `state.<screen>Cb` means the same thing on
      // every screen; keep the raw args too, for the ones whose data matters (the age gate's
      // 'ask' vs 'blocked' mode).
      state[`${screenKey}Cb`] = args.find(isCallbackBag) ?? args[0];
      state[`${screenKey}Args`] = args;
      const handle = orig(...args);
      if (handle && typeof handle === 'object') {
        const h = handle as Record<string, (...a: unknown[]) => unknown>;
        for (const hKey of Object.keys(h)) {
          if (typeof h[hKey] !== 'function') continue;
          const origH = h[hKey]!.bind(h);
          h[hKey] = (...hArgs: unknown[]) => {
            if (hKey.startsWith('apply')) {
              // Server/core push, e.g. applyRoomState → state.lastRoomState.
              state[`last${hKey.slice(5)}`] = hArgs[0];
            } else {
              // One-shot UI call the core makes on the handle, e.g. showFeatureGuide(title, body,
              // onDismiss) for the first-time feature-guide gate (ONBOARDING_DESIGN §4.1) that sits
              // in front of most lobby-reachable features. Record the args, and if the last one is a
              // callback (the guide's onDismiss / a toast's onTap convention) expose it directly so a
              // driver can invoke it to get past the gate: state.<name>Cb().
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
  // `app`, `input` and `scaling` too, so a driver can walk the real display tree and assert on
  // measured geometry instead of eyeballing a screenshot — the only way to check text layout with
  // the REAL font, since the headless harness's `measureText` mock is a flat 7px/char and
  // font-size-independent (see claudedocs/client-testing.md). Read off `PixiAppViews`'s
  // `private readonly` fields rather than plumbed through `startApp`: `wrapViews` is the only
  // injection point that exists and it is handed the views instance alone, and TS privacy is erased
  // at runtime. A production seam for a test-only need would be the worse trade.
  const priv = views as unknown as {
    app?: PIXI.Application; input?: InputManager; scaling?: ScalingManager;
  };
  const handle: E2EHandle = {
    views, state, app: priv.app, input: priv.input, scaling: priv.scaling,
  };
  (globalThis as unknown as { __nwE2E: E2EHandle }).__nwE2E = handle;
  return handle;
}
