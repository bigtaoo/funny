// The invariant that would have caught the volume block's first placement (AUDIO_DESIGN.md §0.2).
//
// SettingsScene.handleDown() checks `audioSliders` BEFORE the hit table, so a slider rect that
// overlaps a button does not just sit on top of it — it silently eats the press: the slider takes
// over the pointer, the button never runs, and no cue fires (sliders are deliberately not hits).
// The first version overlapped ~half of the German language button, and the failure mode was
// "pressing Deutsch does nothing except quietly move my SFX volume". Nothing else in the suite can
// see that: both rects are correct on their own, both panels render, every unit test passes.
//
// Measured in the browser before the fix (canvas 1920x855): pressing (1400, 465) — the centre of
// the Deutsch button — left the locale unchanged and moved `sfx` to 0.219, with zero cues.
//
// The assertion is deliberately about ALL sliders vs ALL hits rather than about the two panels that
// happened to collide. The next collision will be with whatever panel is added next, and the reason
// the first one was missed is that the placement was reasoned about panel-by-panel.
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree, no renderer.
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, getSupportedLocales } from '../../src/i18n';
import { SettingsScene, type SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';
import type { Rect } from '../../src/layout/ILayout';
import type { Hit } from '../../src/ui/hits';
import type { AudioSlider } from '../../src/scenes/SettingsScene/audioPanel';

initI18n('en');

interface Internals { hits: Hit[]; audioSliders: AudioSlider[] }

/**
 * Every scene shape that changes which rectangles exist. `offline` hides the rename button and the
 * balance line; `onReplayTutorial` adds the Help column; `onDeleteAccount` adds a third button to
 * the Account column. The rename button is the one that pins the volume block's x origin, and it
 * exists ONLY when logged in — which is exactly why an offline screenshot could not see it.
 */
const SHAPES: ReadonlyArray<{ name: string; cb: Partial<SettingsSceneCallbacks> }> = [
  {
    name: 'online, free rename, tutorial replay + account deletion',
    cb: {
      publicId: '123456789',
      pvp: { rank: 'gold', elo: 1800 },
      renameCost: 500,
      freeRename: true,
      getCoins: () => 0,
      onRename: async (name: string) => ({ ok: true, name }),
      onReplayTutorial() {},
      onLogout() {},
      onDeleteAccount: async () => ({ ok: true }),
    },
  },
  {
    name: 'online, paid rename with a short balance (button disabled)',
    cb: {
      publicId: '123456789',
      renameCost: 500,
      freeRename: false,
      getCoins: () => 10,
      onRename: async (name: string) => ({ ok: true, name }),
      onLogout() {},
    },
  },
  {
    name: 'offline guest',
    cb: { offline: true, onLogin() {}, onReplayTutorial() {} },
  },
];

/** Landscape and portrait: the layout is fraction-of-w/h throughout, but the label widths are not. */
const SIZES: ReadonlyArray<[number, number]> = [[1920, 855], [800, 1280], [1024, 768], [720, 1440]];

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function build(w: number, h: number, cb: Partial<SettingsSceneCallbacks>): SettingsScene {
  return new SettingsScene(createLayout(w, h), new InputManager(), {
    onBack() {},
    playerName: 'Tester',
    ...cb,
  } as SettingsSceneCallbacks);
}

describe('SettingsScene: a volume slider never covers a button', () => {
  for (const shape of SHAPES) {
    for (const [w, h] of SIZES) {
      it(`${shape.name} @ ${w}x${h}`, () => {
        const scene = build(w, h, shape.cb);
        const { hits, audioSliders } = scene as unknown as Internals;

        // Canary: without both lists populated the assertion below is vacuous, and a future
        // refactor that renames either field would turn this file green instead of red.
        expect(audioSliders, 'the volume block draws three sliders').toHaveLength(3);
        expect(hits.length, 'the scene draws buttons').toBeGreaterThan(2);

        const clashes = audioSliders.flatMap((s, si) =>
          hits.filter((hit) => overlaps(s.rect, hit.rect)).map((hit) => ({
            slider: ['master', 'bgm', 'sfx'][si],
            sliderRect: s.rect,
            hitRect: hit.rect,
          })),
        );
        expect(
          clashes,
          'handleDown() checks audioSliders before hits, so an overlap means this button is dead ' +
          'and presses on it silently move a volume instead. See audioPanel.ts placement note.',
        ).toEqual([]);
        scene.destroy();
      });
    }
  }

  it('the language row really is full-width — the assumption the first placement got wrong', () => {
    // Not a tautology: it pins down WHY the block cannot live at 0.56w/0.385h. If a future change
    // narrows the language row back into the left column, this fails and whoever sees it can move
    // the volume block back down on purpose rather than by accident.
    const scene = build(1920, 855, SHAPES[0]!.cb);
    const { hits } = scene as unknown as Internals;
    const locales = getSupportedLocales().length;
    expect(locales, 'three locales are what pushes the row past the column boundary').toBe(3);
    // startX 0.12w + 3 buttons of 0.22w + 2 gaps of 0.03w = 0.84w, i.e. past drawHelp's 0.56w column.
    const rightmost = Math.max(...hits.map((hit) => hit.rect.x + hit.rect.w));
    expect(rightmost).toBeGreaterThan(1920 * 0.56);
    scene.destroy();
  });

  it('the three slider rows do not overlap each other either', () => {
    const scene = build(1920, 855, SHAPES[0]!.cb);
    const { audioSliders } = scene as unknown as Internals;
    for (let i = 1; i < audioSliders.length; i++) {
      expect(
        overlaps(audioSliders[i - 1]!.rect, audioSliders[i]!.rect),
        `slider rows ${i - 1} and ${i} overlap — the upper row would steal the lower one`,
      ).toBe(false);
    }
    scene.destroy();
  });
});
