/**
 * appRenderResolutionWiring.test.ts — static guards for the two resolution call sites in `app.ts`
 * (ADR-099 / ADR-100). Both fail silently if removed: without `setTextResolution` every label on a
 * resolution-2 renderer is simply rasterized twice again, and without `installAdaptiveResolution`
 * a struggling device just stays slow. `startApp()` is not unit-testable end to end (same reasoning
 * as appAssetGateWiring.test.ts), so this pins the wiring; the behaviour lives in
 * test/ui/textRasterOnce.ui.ts and test/adaptiveResolution.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../src/app.ts'), 'utf8');

describe('app.ts render-resolution wiring', () => {
  it('sets the Text default resolution from the renderer before anything builds a label', () => {
    const set = src.indexOf('setTextResolution(app.renderer.resolution);');
    expect(set).toBeGreaterThan(src.indexOf('new PIXI.Application('));
    // The first labels come from the boot LoadingOverlay and the first scene, both built after these.
    expect(set).toBeLessThan(src.indexOf('new GlobalToast('));
    expect(set).toBeLessThan(src.indexOf('new SceneManager('));
    expect(set).toBeLessThan(src.indexOf('new LoadingOverlay('));
  });

  it('installs the adaptive resolution governor on the scene manager\'s paint mode', () => {
    expect(src).toMatch(/installAdaptiveResolution\(app, \(\) => manager\.paintMode,/);
  });

  it('keeps the render profile honest after a drop (the object PerfMonitor holds is the one rewritten)', () => {
    expect(src).toMatch(/new PerfMonitor\(\)\.install\(app\.ticker, renderInfo\)/);
    expect(src).toMatch(/renderInfo\.resolution = d\.to;/);
    expect(src).toMatch(/renderInfo\.resFrom = d\.from;/);
  });
});
