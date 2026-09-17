// Behavioural coverage for the 2026-09-17 change: a successful send CLOSES the feedback panel
// (the confirmation is app.ts's success toast — see feedbackSuccessToast.test.ts for that half),
// while a failed send still leaves the panel open with the player's text intact.
//
// Before: submit() kept the dialog mounted and wrote an inline green "received, thanks" line into
// statusLabel. Nothing about the screen changed except that one small line and an emptied field, so
// "did it send?" was commonly answered by pressing Send a second time, and getting out still cost a
// separate tap on Close. The failure path is deliberately NOT symmetrical: closing there would throw
// away a note the player just typed, which is exactly when they cannot afford to lose it.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts), so
// the dialog is built for real and its buttons are tapped through real PixiJS pointertap events.
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { FeedbackDialog } from '../../src/ui/dialogs/FeedbackDialog';
import { ui as C } from '../../src/render/sketchUi';
import { initI18n, t } from '../../src/i18n';
import { createFakeTextInput, type FakeTextInput, type FakeTextInputSession } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Landscape + portrait: the submit path has no orientation branch, but build() does. */
const SIZES: [string, number, number][] = [['landscape', 1280, 800], ['portrait', 800, 1280]];

/** The text-input session opened by the most recent tap on the field. */
function lastSession(a: Harness): FakeTextInputSession {
  const s = a.input.sessions[a.input.sessions.length - 1];
  expect(s, 'tap the field first — no text-input session was opened').toBeDefined();
  return s!;
}

/** PIXI normalizes TextStyle.fill to a '#rrggbb' string, so compare the palette entry in that form. */
function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Reads the private status line the dialog uses for its inline (error-only) messages. */
function status(dlg: FeedbackDialog): PIXI.Text {
  return (dlg as unknown as { statusLabel: PIXI.Text }).statusLabel;
}

interface Harness {
  dlg: FeedbackDialog;
  input: FakeTextInput;
  closes: number;
  submitted: string[];
  /** Fire a real pointertap on one of the dialog's own controls (its PixiJS path, as app.ts sees it). */
  tap(which: 'field' | 'submit' | 'close'): void;
  /** Type into whatever text-input session the field opened, the way the platform layer would. */
  type(value: string): void;
  destroy(): void;
}

function open(w: number, h: number, onSubmit: (text: string) => Promise<void>): Harness {
  const input = createFakeTextInput();
  const submitted: string[] = [];
  const h0: Harness = {
    input, submitted, closes: 0,
    dlg: new FeedbackDialog(w, h, {
      openTextInput: input.openTextInput,
      onSubmit: async (text) => { submitted.push(text); await onSubmit(text); },
      onClose: () => { h0.closes += 1; },
    }),
    tap(which) {
      // Same control picking as dialogModalInputGate.ui.ts: the three interactive children in build()
      // order are the input box, Send, and Close (the full-screen dim has a hitArea, they do not).
      const ctrl = h0.dlg.container.children
        .filter((c) => c.eventMode === 'static' && (c as PIXI.Container).hitArea == null)[
          { field: 0, submit: 1, close: 2 }[which]
        ]!;
      (ctrl.emit as (event: string) => void)('pointertap');
    },
    type(value) {
      const session = h0.input.sessions[h0.input.sessions.length - 1];
      expect(session, 'tap the field before typing into it').toBeDefined();
      session!.opts.onInput(value);
    },
    destroy() { h0.dlg.destroy(); },
  };
  return h0;
}

const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('FeedbackDialog: a successful send closes the panel (2026-09-17)', () => {
  for (const [label, w, h] of SIZES) {
    it(`${label}: submits the trimmed text and calls onClose exactly once`, async () => {
      const a = open(w, h, async () => {});
      a.tap('field');
      a.type('  the ink splatter feels great  ');
      a.tap('submit');
      await settle();

      expect(a.submitted).toEqual(['the ink splatter feels great']);
      expect(a.closes).toBe(1);
      a.destroy();
    });

    it(`${label}: leaves no inline confirmation behind — the toast is the whole confirmation`, async () => {
      const a = open(w, h, async () => {});
      a.tap('field');
      a.type('nice game');
      a.tap('submit');
      await settle();

      // The old build wrote t('feedback.sent') here in green. If that ever comes back while the
      // dialog also closes, the player is being told the same thing twice in two places.
      expect(status(a.dlg).text).toBe('');
      a.destroy();
    });

    it(`${label}: closes the platform text input on the way out (no stray keyboard/<input> left open)`, async () => {
      const a = open(w, h, async () => {});
      a.tap('field');
      a.type('closing up');
      expect(lastSession(a).closed).toBe(false);

      a.tap('submit');
      await settle();
      expect(lastSession(a).closed).toBe(true);
      a.destroy();
    });
  }

  it('a second tap landing while the request is still in flight does not send twice or close twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const a = open(1280, 800, () => gate);

    a.tap('field');
    a.type('double tapped');
    a.tap('submit');
    a.tap('submit'); // impatient second tap, request still pending
    await settle();
    expect(a.submitted).toEqual(['double tapped']);

    release();
    await settle();
    expect(a.submitted).toEqual(['double tapped']);
    expect(a.closes).toBe(1);
    a.destroy();
  });
});

describe('FeedbackDialog: a failed send keeps the panel and the typed text', () => {
  for (const [label, w, h] of SIZES) {
    it(`${label}: shows the failure line in red and does not close`, async () => {
      const a = open(w, h, async () => { throw new Error('429 rate limited'); });
      a.tap('field');
      a.type('please add more skins');
      a.tap('submit');
      await settle();

      expect(a.closes).toBe(0);
      expect(status(a.dlg).text).toBe(t('feedback.err.failed'));
      expect(String(status(a.dlg).style.fill).toLowerCase()).toBe(hex(C.red));
      a.destroy();
    });

    it(`${label}: keeps the text so the retry does not start from a blank field`, async () => {
      let fail = true;
      const a = open(w, h, async () => { if (fail) throw new Error('offline'); });
      a.tap('field');
      a.type('a note worth keeping');
      a.tap('submit');
      await settle();

      // Not just the mirrored string: the echo label the player is looking at must still show it.
      const echoed = (a.dlg as unknown as { feedbackLabel: PIXI.Text }).feedbackLabel.text;
      expect(echoed).toContain('a note worth keeping');

      // …and the retry must actually be possible — the in-flight flag has to be cleared by the
      // catch, otherwise Send is dead for the rest of the dialog's life.
      fail = false;
      a.tap('submit');
      await settle();
      expect(a.submitted).toEqual(['a note worth keeping', 'a note worth keeping']);
      expect(a.closes).toBe(1);
      a.destroy();
    });
  }

  it('an empty (or whitespace-only) field never reaches the network and never closes', async () => {
    const onSubmit = vi.fn(async () => {});
    const a = open(1280, 800, onSubmit);
    a.tap('field');
    a.type('   ');
    a.tap('submit');
    await settle();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(a.closes).toBe(0);
    expect(status(a.dlg).text).toBe(t('feedback.err.empty'));
    a.destroy();
  });
});
