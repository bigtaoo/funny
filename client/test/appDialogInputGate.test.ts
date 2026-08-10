// Static guard for the 2026-08-10 "Feedback dialog's Close button navigates the Lobby away" bug.
//
// The behavioural half lives in test/ui/dialogModalInputGate.ui.ts (proving that a tap on the
// dialog's controls hits the Lobby's own hit-rects unless the InputManager gate is raised). This
// file's narrower job: catch someone editing app.ts and dropping the `input.holdForModal(...)`
// calls that raise it — app.ts's startApp() needs a real canvas/platform/backend and isn't
// unit-testable end to end (see HeadlessPlatform's comment), so nothing else can see that wiring.
// Same style/reasoning as appTickerDialogWiring.test.ts, which guards the sibling ticker wiring in
// the same block of app.ts.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const APP_TS = path.resolve(__dirname, '../src/app.ts');

describe('app.ts stage-level dialog input gate (2026-08-10: taps fell through to the live scene)', () => {
  const src = fs.readFileSync(APP_TS, 'utf8');

  it('raises the gate when each dialog is mounted', () => {
    // One per dialog: the feedback sink and the appeal sink.
    expect(src.match(/input\.holdForModal\(true\)/g) ?? []).toHaveLength(2);
  });

  it('releases it on every close path', () => {
    for (const closer of ['closeFeedbackDialog', 'closeAppealDialog']) {
      const m = src.match(new RegExp(`const ${closer} = \\(\\): void => \\{([\\s\\S]*?)\\n  \\};`));
      expect(m, `expected a ${closer} teardown helper in app.ts`).not.toBeNull();
      expect(m![1]).toMatch(/input\.holdForModal\(false\)/);
      // The early-out is what makes the release exactly-once: closeFeedbackDialog is also called by
      // SceneManager's DialogGate on every goto(), so without it a background nav after a manual
      // close would decrement the gate a second time.
      expect(m![1]).toMatch(/if \(!\w+\) return;/);
    }
  });

  it('routes both dialogs through those helpers rather than tearing down inline', () => {
    expect(src).toMatch(/onClose: closeFeedbackDialog/);
    expect(src).toMatch(/onClose: closeAppealDialog/);
    expect(src).toMatch(/dialogGate\.close = closeFeedbackDialog/);
  });
});
