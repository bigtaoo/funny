// The invariant that would have caught the volume block's first placement (AUDIO_DESIGN.md §0.2).
//
// SettingsScene.handleDown() checks `audioSliders` BEFORE the hit table, so a slider rect that
// overlaps a button does not just sit on top of it — it silently eats the press: the slider takes
// over the pointer, the button never runs, and no cue fires (sliders are deliberately not hits).
// The first version overlapped ~half of the German language button.
//
// The flow layout (UI_DESIGN_LOG_2026-09 §65) gives every slider a row of its own, so the collision
// is now structural rather than a matter of hand-tuned fractions — but the check stays, and it is
// widened to hit-vs-hit as well: two overlapping buttons are the same "this tap does the other thing"
// failure without any slider involved. Checked at the top AND the bottom of the scroll range,
// because the rects are clipped to the viewport and a clipping bug shows up only once scrolled.
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree, no renderer.
import { describe, it, expect, afterEach } from 'vitest';
import { initI18n, setLocale } from '../../src/i18n';
import type { SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';
import { buildSettings, internals, overlaps, pageView, scrollTo, ONLINE } from '../harness/settingsScene';

initI18n('en');

/**
 * Every scene shape that changes which rectangles exist. `offline` swaps the rename row and the
 * logout row for the login button; a short balance disables the rename button (no hit at all).
 */
const SHAPES: ReadonlyArray<{ name: string; cb: Partial<SettingsSceneCallbacks> }> = [
  { name: 'online, free rename, everything present', cb: { ...ONLINE, freeRename: true, onSetAvatar() {}, getAnalyticsConsent: () => false, onSetAnalyticsConsent() {} } },
  { name: 'online, paid rename with a short balance (button disabled)', cb: { ...ONLINE, freeRename: false, getCoins: () => 10, onReplayTutorial: undefined } },
  { name: 'offline guest', cb: { offline: true, onLogin() {}, onReplayTutorial() {} } },
];

const SIZES: ReadonlyArray<[number, number]> = [[1920, 855], [800, 1280], [1024, 768], [720, 1440], [360, 640]];

afterEach(() => setLocale('en'));

describe('SettingsScene: no tap target covers another', () => {
  for (const shape of SHAPES) {
    for (const [w, h] of SIZES) {
      it(`${shape.name} @ ${w}x${h}`, () => {
        for (const locale of ['zh', 'en', 'de'] as const) {
          setLocale(locale);
          const scene = buildSettings(w, h, shape.cb);
          for (const at of ['top', 'bottom'] as const) {
            scrollTo(scene, at === 'top' ? 0 : scene.pageMaxScroll);
            const { hits, audioSliders } = internals(scene);
            const view = pageView(scene);
            // Canary: without both lists populated the assertions below are vacuous.
            expect(hits.length, 'the scene draws buttons').toBeGreaterThan(2);
            if (at === 'top') expect(audioSliders, 'the volume section draws three sliders').toHaveLength(3);

            const sliderClashes = audioSliders.flatMap((s) => hits.filter((hit) => overlaps(s.rect, hit.rect)).map((hit) => ({ slider: s.rect, hit: hit.rect })));
            expect(sliderClashes, `${locale}/${at}: a slider covers a button — presses on it would move a volume instead`).toEqual([]);

            const hitClashes = hits.flatMap((a, i) => hits.slice(i + 1).filter((b) => overlaps(a.rect, b.rect)).map((b) => ({ a: a.rect, b: b.rect })));
            expect(hitClashes, `${locale}/${at}: two buttons overlap`).toEqual([]);

            // Page rects are clipped to the viewport; only the header's back button lives above it.
            for (const s of audioSliders) {
              expect(s.rect.y, `${locale}/${at}: a slider reaches above the page viewport`).toBeGreaterThanOrEqual(view.y);
              expect(s.rect.y + s.rect.h).toBeLessThanOrEqual(view.y + view.h);
            }
          }
          scene.destroy();
        }
      });
    }
  }

  it('the three slider rows do not overlap each other either', () => {
    const { audioSliders } = internals(buildSettings(1920, 855, SHAPES[0]!.cb));
    for (let i = 1; i < audioSliders.length; i++) {
      expect(
        overlaps(audioSliders[i - 1]!.rect, audioSliders[i]!.rect),
        `slider rows ${i - 1} and ${i} overlap — the upper row would steal the lower one`,
      ).toBe(false);
    }
  });
});
