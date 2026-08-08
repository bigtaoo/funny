// Static guard for the "FeedbackDialog cursor never blinks" bug (2026-08-08 bug report).
//
// Root cause: FeedbackDialog and AppealDialog are stage-level overlays mounted directly on
// app.stage (app.ts), outside SceneManager entirely — SceneManager.onTick only ticks the
// scenes it manages (current/overlayScene), so nothing else ever called these dialogs'
// update(), the method that advances FeedbackDialog's caret-blink timer. The fix added an
// app.ticker.add(...) callback in app.ts that drives both dialogs every frame (mirroring
// GlobalToast.tick()'s existing self-ticking role for its own stage-level overlay).
//
// This is a pure source-text check, not a behavioral one — see
// test/ui/caretRegression.ui.ts's "a real PIXI.Ticker driven exactly like app.ts" test for the
// behavioral half (proving that IF wired this way, the caret actually blinks). This file's job
// is narrower and cheaper: catch someone editing app.ts and dropping the wiring call itself,
// which no behavioral test constructing FeedbackDialog directly could ever detect (app.ts's
// startApp() needs a real canvas/platform/backend and isn't unit-testable end to end — see
// HeadlessPlatform's comment: it drives createAppCore, not the PIXI shell in app.ts).
// Mirrors the existing static-guard style already used for a different wiring-gap bug class:
// test/input-subscription-cleanup.test.ts.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const APP_TS = path.resolve(__dirname, '../src/app.ts');

describe('app.ts stage-level dialog ticker wiring (2026-08-08: cursor never blinked, nobody ticked it)', () => {
  const src = fs.readFileSync(APP_TS, 'utf8');

  it('registers an app.ticker.add(...) callback', () => {
    expect(src).toMatch(/app\.ticker\.add\(/);
  });

  it('that callback drives both feedbackDialog.update() and appealDialog.update()', () => {
    const m = src.match(/app\.ticker\.add\(\(\) => \{([\s\S]*?)\}\);/);
    expect(m, 'expected an app.ticker.add(() => { ... }); block in app.ts').not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/feedbackDialog\?\.update\(/);
    expect(body).toMatch(/appealDialog\?\.update\(/);
  });

  // Sanity check that the dialogs this test is guarding still exist as stage-level overlays —
  // if this structure ever changes (e.g. FeedbackDialog moves under SceneManager), the whole
  // premise of this file goes away and it should be deleted, not silently pass on stale checks.
  it('feedbackDialog/appealDialog are still declared as app.stage children outside SceneManager', () => {
    expect(src).toMatch(/let feedbackDialog: FeedbackDialog \| null = null;/);
    expect(src).toMatch(/let appealDialog: AppealDialog \| null = null;/);
    expect(src).toMatch(/app\.stage\.addChild\(dlg\.container\)/);
  });
});
