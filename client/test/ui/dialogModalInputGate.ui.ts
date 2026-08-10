// 2026-08-10 bug report: "open Feedback, send once, reopen, tap Close — instead of returning to the
// Lobby the game lands on some earlier screen". Third report against this dialog; the two previous
// fixes both missed the actual mechanism.
//
// Root cause: FeedbackDialog/AppealDialog are stage-level overlays (app.ts mounts them on
// `app.stage`) sitting on top of a scene that stays alive AND still subscribed to the InputManager.
// The Lobby routes taps through `input.onDown(...)` (LobbyScene/base.ts), fed straight from DOM
// pointer listeners by WebAdapter — PixiJS hit-testing is not involved at all, so the 2026-08-09
// "dim backdrop swallows taps" fix (eventMode/hitArea, covered in caretRegression.ui.ts) could not
// stop it: no display object can block an event that never enters PixiJS. Result: every tap on the
// dialog ALSO fired whatever Lobby hit-rect sits at the same coordinates. The overlap is exact and
// reproducible (asserted below): the input field lands on the big Start button, Submit on the
// campaign pillar, Close on the world pillar. Tapping Close therefore navigated the Lobby away
// (goto → SceneManager's DialogGate closes the dialog) and the player was left on the SLG map /
// campaign map instead of the Lobby.
//
// Fix: `input.holdForModal(true)` for the dialog's whole lifetime (InputManager.modals) — a gate at
// the input SOURCE, the same place the fade gate (`suppress`) already lives, and the only layer that
// can see a DOM-fed tap. The dialogs' own buttons are pure PixiJS `pointertap` handlers, so the gate
// never touches them.
//
// See test/appDialogInputGate.test.ts for the static guard that app.ts still calls it.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import { FeedbackDialog } from '../../src/ui/dialogs/FeedbackDialog';
import type { LobbySceneCallbacks } from '../../src/scenes/LobbyScene';

// Minimal DOM stub — FeedbackDialog.openInput() is never called here, but the shared harness style
// (caretRegression.ui.ts) keeps it available so a future test in this file can tap the field.
const gDoc = globalThis as unknown as { document?: unknown };
if (!gDoc.document) {
  gDoc.document = {
    body: { appendChild(): void {} },
    createElement(): Record<string, unknown> {
      return {
        type: '', value: '', maxLength: 0, style: { cssText: '' },
        focus(): void {}, remove(): void {}, addEventListener(): void {},
      };
    },
  };
}

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Every navigation callback the online Lobby wires, recording which one a tap reached. */
function lobbyCallbacks(fired: string[]): LobbySceneCallbacks {
  const nav = (name: string) => () => { fired.push(name); };
  return {
    online: true,
    playerName: 'Tester',
    pvp: { rank: 'bronze', elo: 1000 },
    onStartGame: nav('onStartGame'),
    onStartRanked: nav('onStartRanked'),
    onOpenCampaign: nav('onOpenCampaign'),
    onOpenRoom: nav('onOpenRoom'),
    onOpenSocial: nav('onOpenSocial'),
    onOpenShop: nav('onOpenShop'),
    onOpenCards: nav('onOpenCards'),
    onOpenStats: nav('onOpenStats'),
    onOpenProfile: nav('onOpenProfile'),
    onOpenMail: nav('onOpenMail'),
    onOpenFeedback: nav('onOpenFeedback'),
    onOpenAuction: nav('onOpenAuction'),
    onOpenDaily: nav('onOpenDaily'),
    onOpenEvents: nav('onOpenEvents'),
    onOpenWorld: nav('onOpenWorld'),
    onOpenAchievements: nav('onOpenAchievements'),
    onOpenLeaderboard: nav('onOpenLeaderboard'),
    onOpenRecharge: nav('onOpenRecharge'),
  } as unknown as LobbySceneCallbacks;
}

/**
 * The dialog's three interactive controls, in build() order: input field, Submit, Close. They are
 * the only `eventMode: 'static'` children without an explicit hitArea (that one is the dim backdrop).
 */
function dialogControls(dlg: FeedbackDialog): Array<{ x: number; y: number }> {
  return dlg.container.children
    .filter((c) => c.eventMode === 'static' && (c as PIXI.Container).hitArea == null)
    .map((c) => {
      const b = c.getBounds();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
}

/**
 * Builds the production pairing: a live, input-subscribed Lobby with the dialog mounted over it.
 *
 * The dialog is sized to the DESIGN box here, while app.ts passes `app.screen.*` (physical pixels) —
 * the two spaces differ only by the Contain scale + letterbox offset ScalingManager applies, so a
 * control centred over a given fraction of the card is centred over the same fraction of the Lobby
 * either way. Using design units just lets the test compare coordinates directly.
 */
function mount(w: number, h: number): {
  input: InputManager; fired: string[]; lobby: LobbyScene; dlg: FeedbackDialog;
  controls: Array<{ x: number; y: number }>; destroy: () => void;
} {
  const fired: string[] = [];
  const input = new InputManager();
  const layout = createLayout(w, h);
  const lobby = new LobbyScene(layout, input, lobbyCallbacks(fired));
  const dlg = new FeedbackDialog(layout.designWidth, layout.designHeight, {
    onSubmit: async () => { fired.push('dialog.submit'); },
    onClose: () => { fired.push('dialog.close'); },
  });
  return {
    input, fired, lobby, dlg, controls: dialogControls(dlg),
    destroy: () => { dlg.destroy(); lobby.destroy(); },
  };
}

const SIZES: Array<[label: string, w: number, h: number]> = [
  ['portrait (800x1280)', 800, 1280],
  ['landscape (1280x800)', 1280, 800],
];

describe('Stage-level dialogs — taps must not reach the live scene underneath (2026-08-10 close-nav bug)', () => {
  for (const [label, w, h] of SIZES) {
    describe(label, () => {
      it('without the gate, every dialog control overlaps a live Lobby nav rect (the bug itself)', () => {
        const m = mount(w, h);
        expect(m.controls).toHaveLength(3); // input field, Submit, Close

        const hit: string[] = [];
        for (const c of m.controls) {
          m.fired.length = 0;
          m.input._emitDown(c.x, c.y);
          hit.push(m.fired.join(',') || '(none)');
          (m.lobby as unknown as { state: string }).state = 'idle'; // undo onStartRanked's state latch
        }
        // Pinned exactly, not just "something fired": if the Lobby layout moves these apart on its
        // own one day, this test should be re-read rather than silently keep passing on a new overlap.
        expect(hit).toEqual(['onStartRanked', 'onOpenCampaign', 'onOpenWorld']);
        m.destroy();
      });

      it('holdForModal(true) blocks all three — tapping Close no longer navigates the Lobby', () => {
        const m = mount(w, h);
        m.input.holdForModal(true); // what app.ts does when it mounts the dialog

        for (const c of m.controls) m.input._emitDown(c.x, c.y);
        expect(m.fired).toEqual([]);
        expect((m.lobby as unknown as { state: string }).state).toBe('idle');
        m.destroy();
      });

      it('the gate is lifted on close, so the Lobby is live again for the next tap', () => {
        const m = mount(w, h);
        m.input.holdForModal(true);
        m.input.holdForModal(false); // closeFeedbackDialog()

        const close = m.controls[2]!;
        m.input._emitDown(close.x, close.y);
        expect(m.fired).toEqual(['onOpenWorld']);
        m.destroy();
      });
    });
  }
});

describe('InputManager — modal gate semantics', () => {
  function probe(): { input: InputManager; downs: number[]; moves: number[]; ups: number[]; wheels: number[] } {
    const input = new InputManager();
    const downs: number[] = [], moves: number[] = [], ups: number[] = [], wheels: number[] = [];
    input.onDown((x) => downs.push(x));
    input.onMove((x) => moves.push(x));
    input.onUp((x) => ups.push(x));
    input.onWheel((x) => wheels.push(x));
    return { input, downs, moves, ups, wheels };
  }

  it('gates move/up/wheel too, not just down — a drag started before the dialog opened cannot continue', () => {
    const p = probe();
    p.input.holdForModal(true);
    p.input._emitDown(1, 1);
    p.input._emitMove(2, 2);
    p.input._emitUp(3, 3);
    p.input._emitWheel(4, 4, 10);
    expect([p.downs, p.moves, p.ups, p.wheels]).toEqual([[], [], [], []]);

    p.input.holdForModal(false);
    p.input._emitDown(1, 1);
    p.input._emitMove(2, 2);
    p.input._emitUp(3, 3);
    p.input._emitWheel(4, 4, 10);
    expect([p.downs, p.moves, p.ups, p.wheels]).toEqual([[1], [2], [3], [4]]);
  });

  it('counts, so an appeal prompt popping over an open feedback dialog survives the first close', () => {
    const p = probe();
    p.input.holdForModal(true);  // feedback opens
    p.input.holdForModal(true);  // appeal prompt lands on top
    p.input.holdForModal(false); // appeal dismissed — feedback is still up
    p.input._emitDown(1, 1);
    expect(p.downs).toEqual([]);

    p.input.holdForModal(false); // feedback closed
    p.input._emitDown(1, 1);
    expect(p.downs).toEqual([1]);
  });

  it('never goes negative — an unbalanced release cannot leave the gate stuck "below zero"', () => {
    const p = probe();
    p.input.holdForModal(false);
    p.input.holdForModal(false);
    p.input.holdForModal(true); // must gate, not merely climb back to 0
    p.input._emitDown(1, 1);
    expect(p.downs).toEqual([]);
  });

  // The two gates are independent by construction: a fade that settles while a dialog is up must not
  // clear the modal gate, and closing a dialog mid-fade must not unfreeze the fade's input freeze.
  it('is independent of the fade gate (suppress) in both directions', () => {
    const p = probe();
    p.input.holdForModal(true);
    p.input.suppress(true);
    p.input.suppress(false); // fade settled
    p.input._emitDown(1, 1);
    expect(p.downs).toEqual([]); // modal still holds

    p.input.suppress(true);
    p.input.holdForModal(false); // dialog closed mid-fade
    p.input._emitDown(1, 1);
    expect(p.downs).toEqual([]); // fade still holds
  });

  it('does not fire the fade-abort hook — a modal is not a transition to skip', () => {
    const p = probe();
    let aborts = 0;
    p.input.onSuppressedInput(() => { aborts++; });
    p.input.holdForModal(true);
    p.input._emitDown(1, 1);
    expect(aborts).toBe(0);

    // Sanity: the hook does still fire for the fade gate it belongs to.
    p.input.holdForModal(false);
    p.input.suppress(true);
    p.input._emitDown(1, 1);
    expect(aborts).toBe(1);
  });
});
