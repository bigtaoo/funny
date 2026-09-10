// SettingsScene's viewport/safe-area readout (`panels.drawViewportDiagnostics`).
//
// Why it is in the shipped UI: the iPhone-13 portrait safe-area bug has been diagnosed twice from
// arithmetic and "fixed" once without a single number off the device, because the environment we can
// inspect (desktop Chrome) reports zero insets in a full-height viewport and reproduces none of it.
// These two lines turn "please describe what it looks like" into one screenshot — see
// layout/viewportGeometry.ts's header.
//
// Two things are worth asserting and neither shows up in a screenshot of one viewport:
//  * it FITS. This scene has no flow layout — every section is a hand-tuned fraction of `h` — so a
//    new row that collides simply draws on top of its neighbour (the lesson
//    settingsDataSaverRow.ui.ts was created to pay for). The band under the Legal links is ~100px in
//    portrait and only ~55px in landscape, which is why the readout collapses to one line there.
//  * it is LEGIBLE at device scale. A 1080-wide design rect renders at ~0.36x on a 390pt phone, so a
//    line the design space can fit is not automatically a line anyone can read in the photo — and an
//    unreadable diagnostic is the same as no diagnostic.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { SettingsScene } from '../../src/scenes/SettingsScene';
import type { SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';
import type { ViewportGeometry } from '../../src/layout/viewportGeometry';
import { createFakeTextInput } from '../harness/fakeTextInput';

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

interface Node { text: string; size: number; top: number; bottom: number; right: number }

function collect(root: PIXI.Container): Node[] {
  const out: Node[] = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) {
        const b = ch.getBounds();
        // Post-scale font size: the draw shrinks a too-wide line, and a shrunk line is what the
        // player actually has to read.
        const size = Number(ch.style.fontSize) * ch.scale.y;
        out.push({ text: ch.text, size, top: b.y, bottom: b.y + b.height, right: b.x + b.width });
        continue;
      }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

/** `geom: null` = a platform that cannot answer. Not `undefined`, which a default parameter would
 *  quietly replace with EATEN — the exact way the first version of this suite passed vacuously. */
function sceneOn(layout: ReturnType<typeof createLayout>, geom: ViewportGeometry | null = EATEN): SettingsScene {
  const cb: SettingsSceneCallbacks = {
    onBack() {},
    playerName: 'Tester',
    publicId: '123456789',
    pvp: { rank: 'bronze', elo: 1000 },
    renameCost: 500,
    getCoins: () => 0,
    onRename: async (name: string) => ({ ok: true, name }),
    onReplayTutorial() {},
    onLogout() {},
    onDeleteAccount: async () => ({ ok: true }),
    openTextInput: createFakeTextInput().openTextInput,
    getViewportGeometry: () => geom ?? undefined,
  };
  return new SettingsScene(layout, new InputManager(), cb);
}

/** Every readout line, TOP-DOWN — the draw order is bottom-up (the row stacks off the bottom edge). */
function readout(s: SettingsScene): Node[] {
  return collect(s.container)
    .filter((n) => n.text.startsWith('inner ') || n.text.startsWith('env '))
    .sort((a, b) => a.top - b.top);
}

describe('SettingsScene — viewport diagnostics', () => {
  it('prints the numbers a remote diagnosis needs, plus the verdict', () => {
    const lines = readout(sceneOn(createLayout(390, 844))).map((n) => n.text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('inner 390x763');
    expect(lines[0]).toContain('screen 390x844');
    expect(lines[0]).toContain('dpr 3');
    expect(lines[1]).toContain('env 0/0/0/0');
    // The one word that says which of the three candidate explanations the device is actually in.
    expect(lines[1]).toContain('inset-eaten');
  });

  it('draws nothing at all when the platform cannot answer (WeChat, tests)', () => {
    expect(readout(sceneOn(createLayout(390, 844), null))).toEqual([]);
  });

  it.each([[390, 844], [412, 915], [800, 1280]])('fits under the legal links in portrait (%ix%i)', (w, h) => {
    const layout = createLayout(w, h);
    const s = sceneOn(layout);
    const lines = readout(s);
    expect(lines).toHaveLength(2);

    const nodes = collect(s.container);
    const terms = nodes.find((n) => n.text === '· ' + t('consent.terms'))!;
    expect(lines[0]!.top, 'readout overlaps the legal links above it').toBeGreaterThanOrEqual(terms.bottom);
    expect(lines[0]!.bottom, 'the two readout lines overlap each other').toBeLessThanOrEqual(lines[1]!.top + 1);
    expect(lines[1]!.bottom, 'readout runs off the bottom of the design rect').toBeLessThanOrEqual(layout.designHeight);
    for (const l of lines) expect(l.right, 'readout runs off the right edge').toBeLessThanOrEqual(layout.designWidth);
  });

  it.each([[844, 390], [1280, 800]])('collapses to one line in landscape, where the band is half as tall (%ix%i)', (w, h) => {
    const layout = createLayout(w, h);
    const s = sceneOn(layout);
    const lines = readout(s);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain('inner 390x763');
    expect(lines[0]!.text).toContain('inset-eaten');

    const terms = collect(s.container).find((n) => n.text === '· ' + t('consent.terms'))!;
    expect(lines[0]!.top, 'readout overlaps the legal links above it').toBeGreaterThanOrEqual(terms.bottom);
    expect(lines[0]!.bottom).toBeLessThanOrEqual(layout.designHeight);
    expect(lines[0]!.right).toBeLessThanOrEqual(layout.designWidth);
  });

  it('stays readable once design space is scaled onto the phone it is diagnosing', () => {
    // iPhone 13 portrait: the design rect is contained into the safe area, so the on-screen size of
    // any glyph is `fontSize * gameScale`. Anything under ~8 CSS px is unreadable in a photo, which
    // is the only channel this readout has.
    const layout = createLayout(390, 844, undefined, { top: 47, right: 0, bottom: 34, left: 0 });
    const gameScale = Math.min((390 - 0) / layout.designWidth, (844 - 47 - 34) / layout.designHeight);
    for (const line of readout(sceneOn(layout))) {
      expect(line.size * gameScale, `"${line.text}" renders at ${(line.size * gameScale).toFixed(1)} CSS px`)
        .toBeGreaterThanOrEqual(8);
    }
  });
});
