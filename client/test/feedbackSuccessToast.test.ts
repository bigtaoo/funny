// Static guard for the app.ts half of the 2026-09-17 feedback change: the dialog closes itself on a
// successful send (test/ui/feedbackSubmitOutcome.ui.ts covers that), which means the ONLY thing left
// telling the player it went through is the success toast raised here. Drop this one line and the
// panel just vanishes on Send, which reads like the tap dismissed it rather than sent it.
//
// Pure source-text check, same style/reasoning as appTickerDialogWiring.test.ts and
// appDialogInputGate.test.ts: app.ts's startApp() needs a real canvas/platform/backend and isn't
// unit-testable end to end (see HeadlessPlatform's comment), so nothing behavioural can see this
// wiring — and the dialog itself deliberately knows nothing about toasts.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const APP_TS = path.resolve(__dirname, '../src/app.ts');

describe('app.ts feedback success toast (2026-09-17: send now closes the panel)', () => {
  const src = fs.readFileSync(APP_TS, 'utf8');

  /** The onSubmit wrapper handed to the FeedbackDialog constructor in the feedback sink. */
  const wrapper = src.match(/onSubmit: async \(text\) => \{([\s\S]*?)\n {6}\},/);

  it('wraps core.submitFeedback rather than passing it through bare', () => {
    expect(wrapper, 'expected an `onSubmit: async (text) => { ... },` block in the feedback sink').not.toBeNull();
    expect(wrapper![1]).toMatch(/await core\.submitFeedback!\(text\)/);
  });

  it('toasts feedback.sent as a success only after the submit resolves', () => {
    const body = wrapper![1];
    expect(body).toMatch(/showToastMessage\(t\('feedback\.sent'\), 'success'\)/);
    // Order matters: toasting first would confirm a send that may still fail, and the dialog's own
    // catch would then contradict the toast still on screen.
    expect(body.indexOf('await core.submitFeedback')).toBeLessThan(body.indexOf('showToastMessage'));
  });

  it('mirrors the appeal dialog, which has told the player the same way since it landed', () => {
    // If the appeal wiring is ever changed, these two should move together — they are the only two
    // stage-level dialogs and a player meeting both should not get two different confirmation idioms.
    expect(src).toMatch(/showToastMessage\(t\('appeal\.submitted'\), 'success'\)/);
  });
});
