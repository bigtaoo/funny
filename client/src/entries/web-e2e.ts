import type * as PIXI from 'pixi.js-legacy';
import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';
import type { AppViews } from '../app/AppViews';
import { setAudioBus, audioBus } from '../audio/audioBus';
import { ALL_CUES } from '../audio/cueCatalogue';
import { WebAudioBus } from '../platform/web/WebAudioBus';

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
  // `app` too, so a Playwright script can walk the real display tree (`app.stage`) and assert on
  // measured geometry instead of eyeballing a screenshot — the only way to check text layout with
  // the REAL font, since the headless harness's `measureText` mock is a flat 7px/char and
  // font-size-independent (see claudedocs/client-testing.md). Read off the `private readonly app`
  // field rather than plumbed through `startApp`: `wrapViews` is the only injection point that
  // exists and it is handed the views instance alone, and TS privacy is erased at runtime. A
  // production seam for a test-only need would be the worse trade.
  const app = (views as unknown as { app?: PIXI.Application }).app;
  (window as unknown as {
    __nwE2E: { views: AppViews; state: E2EState; app?: PIXI.Application };
  }).__nwE2E = { views, state, app };
  return views;
}

// Audio: the same backend the web entry installs, plus a handle on `window.__nwAudio` so a
// browser smoke can fire a cue and measure the SFX bus. Audio has no other observable surface —
// it cannot be screenshotted, and until the trigger points are wired (AUDIO_DESIGN.md §7 steps
// 3-4) nothing in the game fires a cue at all, so without this there is no way to hear or
// measure the pipeline end to end in a real browser. Permanent test infrastructure in the
// never-shipped e2e entry, exactly like __nwE2E above — not one of the throwaway debug globals
// test/no-debug-hooks-in-src.test.ts scans src/ for. (That guard matches the offending token as a
// literal, so this comment deliberately does not spell it out.)
const audio = new WebAudioBus();
setAudioBus(audio);
(window as unknown as { __nwAudio: unknown }).__nwAudio = {
  play: (cue: string, count?: number) => audioBus().play(cue as never, count),
  resume: () => audioBus().resume(),
  cues: ALL_CUES,
  /** How much of the shipped sample set actually decoded (0/0 until cueAssets.ts is filled). */
  loaded: () => audio.loaded,
};

startApp(new WebPlatform('game-canvas'), instrumentViews).catch(console.error);
