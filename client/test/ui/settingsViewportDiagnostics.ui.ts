// SettingsScene's viewport/safe-area readout (`panels.drawViewportDiagnostics`).
//
// Why it is in the shipped UI: the iPhone-13 portrait safe-area bug has been diagnosed twice from
// arithmetic and "fixed" once without a single number off the device, because the environment we can
// inspect (desktop Chrome) reports zero insets in a full-height viewport and reproduces none of it.
// These lines turn "please describe what it looks like" into one screenshot — see
// layout/viewportGeometry.ts's header.
//
// Since the flow-layout rewrite (UI_DESIGN_LOG_2026-09 §65) it is simply the last thing on the page,
// below both columns. Worth asserting: it is reachable (scrolling included), below everything else,
// and LEGIBLE at device scale — a 1080-wide design rect renders at ~0.36x on a 390pt phone, and an
// unreadable diagnostic is the same as no diagnostic.
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { SettingsScene } from '../../src/scenes/SettingsScene';
import type { SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';
import type { ViewportGeometry } from '../../src/layout/viewportGeometry';
import { createFakeTextInput } from '../harness/fakeTextInput';
import { collectTexts, scrollTo, ONLINE, type TextNode } from '../harness/settingsScene';

initI18n('en');

/** The reported iPhone-13 state: viewport shrunk by 47+34, env() reporting nothing. */
const EATEN: ViewportGeometry = {
  innerW: 390, innerH: 763,
  screenW: 390, screenH: 844,
  visualW: 390, visualH: 763, visualOffsetTop: 0,
  dpr: 3,
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  nativeShell: true,
};

/** `geom: null` = a platform that cannot answer. Not `undefined`, which a default parameter would
 *  quietly replace with EATEN — the exact way the first version of this suite passed vacuously. */
function sceneOn(layout: ReturnType<typeof createLayout>, geom: ViewportGeometry | null = EATEN): SettingsScene {
  const cb: SettingsSceneCallbacks = {
    onBack() {},
    playerName: 'Tester',
    ...ONLINE,
    openTextInput: createFakeTextInput().openTextInput,
    getViewportGeometry: () => geom ?? undefined,
  };
  return new SettingsScene(layout, new InputManager(), cb);
}

const isReadout = (n: TextNode): boolean => n.text.startsWith('inner ') || n.text.startsWith('env ');

/** Every readout line, top-down, with the page scrolled to its end (where the readout lives). */
function readout(s: SettingsScene): { lines: TextNode[]; rest: TextNode[] } {
  scrollTo(s, s.pageMaxScroll);
  const all = collectTexts(s.container);
  return { lines: all.filter(isReadout).sort((a, b) => a.top - b.top), rest: all.filter((n) => !isReadout(n)) };
}

describe('SettingsScene — viewport diagnostics', () => {
  it('prints the numbers a remote diagnosis needs, plus the verdict', () => {
    const texts = readout(sceneOn(createLayout(390, 844))).lines.map((n) => n.text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('inner 390x763');
    expect(texts[0]).toContain('screen 390x844');
    expect(texts[0]).toContain('dpr 3');
    expect(texts[1]).toContain('env 0/0/0/0');
    // The one word that says which of the three candidate explanations the device is actually in.
    expect(texts[1]).toContain('inset-eaten');
  });

  it('draws nothing at all when the platform cannot answer (WeChat, tests)', () => {
    expect(readout(sceneOn(createLayout(390, 844), null)).lines).toEqual([]);
  });

  // In a browser this row is debug text in front of every player, and `viewportVerdict` answers the
  // literal word `browser` — it makes no claim there. The shell is the only place the numbers matter.
  it('draws nothing in a browser, where the verdict makes no claim', () => {
    const browser: ViewportGeometry = { ...EATEN, nativeShell: false };
    expect(readout(sceneOn(createLayout(1920, 1080), browser)).lines).toEqual([]);
    expect(readout(sceneOn(createLayout(390, 844), browser)).lines).toEqual([]);
  });

  it.each([[390, 844, 2], [412, 915, 2], [800, 1280, 2], [360, 640, 2], [844, 390, 1], [1280, 800, 1]])(
    'is the last thing on the page, reachable and on-screen (%ix%i, %i line(s))',
    (w, h, n) => {
      const layout = createLayout(w, h);
      const s = sceneOn(layout);
      const { lines, rest } = readout(s);
      expect(lines).toHaveLength(n);
      const lowestOther = Math.max(...rest.map((r) => r.bottom));
      expect(lines[0]!.top, 'readout overlaps the page content above it').toBeGreaterThanOrEqual(lowestOther);
      if (n === 2) expect(lines[0]!.bottom, 'the two readout lines overlap').toBeLessThanOrEqual(lines[1]!.top + 1);
      expect(lines[n - 1]!.bottom, 'readout cannot be scrolled into view').toBeLessThanOrEqual(layout.designHeight);
      for (const l of lines) expect(l.right, 'readout runs off the right edge').toBeLessThanOrEqual(layout.designWidth);
    },
  );

  it('stays readable once design space is scaled onto the phone it is diagnosing', () => {
    // iPhone 13 portrait: the design rect is contained into the safe area, so the on-screen size of
    // any glyph is `fontSize * gameScale`. Anything under ~8 CSS px is unreadable in a photo.
    const layout = createLayout(390, 844, undefined, { top: 47, right: 0, bottom: 34, left: 0 });
    const gameScale = Math.min(390 / layout.designWidth, (844 - 47 - 34) / layout.designHeight);
    for (const line of readout(sceneOn(layout)).lines) {
      expect(line.size * gameScale, `"${line.text}" renders at ${(line.size * gameScale).toFixed(1)} CSS px`)
        .toBeGreaterThanOrEqual(8);
    }
  });
});
