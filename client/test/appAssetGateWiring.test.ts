/**
 * appAssetGateWiring.test.ts — static guards for the asset-loading call sites in `app.ts`
 * (ASSET_PACKAGING §3, §11.3) and in `PixiAppViews.showGacha` (§10).
 *
 * Both are single lines in `startApp()`, and both fail SILENTLY if removed: dropping the
 * `await preloadBoot(...)` just means the first lobby paints with whatever textures happen to
 * have arrived, and dropping `startIdlePrefetch()` just means the next gates go back to cold
 * downloads. Nothing throws, no behavioural test notices — `startApp()` needs a real
 * canvas/platform/backend and is not unit-testable end to end (see the same reasoning in
 * appTickerDialogWiring.test.ts, which this file mirrors).
 *
 * Behaviour of the two functions themselves is covered elsewhere: test/ui/bootManifestTiers.ui.ts
 * and test/ui/idlePrefetch.ui.ts. This file only asserts they are still plugged in, and in the
 * right order relative to the first scene.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const APP_TS = path.resolve(__dirname, '../src/app.ts');

describe('app.ts asset-gate wiring', () => {
  const src = fs.readFileSync(APP_TS, 'utf8');

  it('awaits the L0 boot gate behind a LoadingOverlay', () => {
    expect(src).toMatch(/new LoadingOverlay\(/);
    expect(src).toMatch(/await preloadBoot\(/);
  });

  it('destroys the loading overlay before the first scene is shown', () => {
    const gate = src.indexOf('await preloadBoot(');
    const destroy = src.indexOf('loading.destroy()');
    const start = src.indexOf('core.start()');
    expect(gate).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(gate);
    expect(start).toBeGreaterThan(destroy);
  });

  it('starts the L1 idle prefetch after the first scene, not before it', () => {
    const start = src.indexOf('core.start()');
    const prefetch = src.indexOf('startIdlePrefetch(');
    expect(prefetch).toBeGreaterThan(-1);
    // Order is the point: run ahead of core.start() and the prefetch competes with the first
    // scene's own construction and opening API calls — the exact contention it exists to avoid.
    expect(prefetch).toBeGreaterThan(start);
  });

  it('does not await the prefetch (it must never delay the first scene)', () => {
    expect(src).toMatch(/void startIdlePrefetch\(\)/);
    expect(src).not.toMatch(/await startIdlePrefetch\(/);
  });
});

/**
 * Same static-guard reasoning applied to the gacha gate (§10, 2026-08-25). PixiAppViews is not
 * importable here (its ~30 scene classes reach `@nw/shared`, which needs server/node_modules —
 * the very reason battleGate.ts was split out of app.ts), so this reads the source instead.
 *
 * The behaviour of the gate itself lives in test/ui/assetGate.ui.ts. What this pins is that
 * showGacha still goes THROUGH it — the failure mode being reverted to is silent: dropping the
 * gate just puts back `PIXI.Texture.from` on a cold cache, i.e. card backs that pop in blank
 * during the reveal. Nothing throws and no behavioural test notices.
 */
describe('PixiAppViews.showGacha asset-gate wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/app/PixiAppViews.ts'), 'utf8');
  const showGacha = /showGacha\([^)]*\): void \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? '';

  it('routes the gacha entry through the shared asset gate', () => {
    expect(showGacha, 'showGacha not found in PixiAppViews.ts').not.toBe('');
    expect(showGacha).toMatch(/enterWithAssets\(/);
    expect(showGacha).toMatch(/preloadGachaTextures/);
  });

  it('does not build GachaScene outside the gate', () => {
    // A `new GachaScene(...)` that is not inside the gate's `build` callback would race the
    // textures exactly as before. The only legitimate construction site is the callback.
    const gateStart = showGacha.indexOf('enterWithAssets(');
    expect(showGacha.indexOf('new GachaScene(')).toBeGreaterThan(gateStart);
  });
});
