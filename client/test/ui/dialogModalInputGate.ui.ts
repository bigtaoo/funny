// 2026-08-10 bug report: "open Feedback, send once, reopen, tap Close — instead of returning to the
// Lobby the game lands on some earlier screen". Third report against this dialog; the two previous
// fixes both missed the actual mechanism.
//
// Root cause: FeedbackDialog/AppealDialog are stage-level overlays (app.ts mounts them on
// `app.stage`) sitting on top of a scene that stays alive AND still subscribed to the InputManager.
// The Lobby routes taps through `input.onDown(...)` (LobbyScene/build.ts's handleDown, wired from
// the outer LobbyScene.ts assembly), fed straight from DOM
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
import { AppealDialog } from '../../src/ui/dialogs/AppealDialog';
import { SceneManager, type Scene, type DialogGate } from '../../src/scenes/SceneManager';
import type { LobbySceneCallbacks } from '../../src/scenes/LobbyScene';
import { openDomTextInput } from '../../src/platform/web/domTextInput';

// Minimal DOM stub so the real openDomTextInput() (wired into FeedbackDialog/AppealDialog below as
// `cb.openTextInput`, ASSET_PACKAGING §4.3/§4.4 item 1) runs under the plain-Node headless harness
// — the reported click-through bug (tapDialog below) does open the field. Same shape as
// caretRegression.ui.ts's stub.
const gDoc = globalThis as unknown as { document?: unknown };
if (!gDoc.document) {
  gDoc.document = {
    body: { appendChild(): void {} },
    createElement(): Record<string, unknown> {
      return {
        type: '', value: '', maxLength: 0, style: { cssText: '' },
        parentNode: null,
        focus(): void {}, remove(): void {}, setAttribute(): void {}, addEventListener(): void {},
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
    openTextInput: openDomTextInput,
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
          (m.lobby as unknown as { core: { state: string } }).core.state = 'idle'; // undo onStartRanked's state latch
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
        expect((m.lobby as unknown as { core: { state: string } }).core.state).toBe('idle');
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

// ── The reported flow, end to end ─────────────────────────────────────────────
// Everything above tests one tap at a time against a Lobby that isn't wired to navigate. This block
// assembles the production shape instead — real SceneManager (with its DialogGate + InputGate), real
// LobbyScene whose nav callbacks really call goto(), real FeedbackDialog, and app.ts's own
// sink/close-helper pair — and replays the exact sequence from the bug report:
// open → tap field → type → Submit → Close → open again → Close.
//
// A "tap" here fires BOTH paths a real tap fires: the DOM-fed InputManager emit (what leaks to the
// scene) and the PixiJS `pointertap` on the dialog's own display object (what the dialog listens to).
// Driving only one of them is exactly how this bug survived two rounds of fixes.

/** Fake PIXI.Application exposing what SceneManager touches, plus a manual frame(). Same shape as sceneManager.ui.ts's. */
function makeApp(w: number, h: number): { app: PIXI.Application; stage: PIXI.Container; frame: () => void } {
  let tick: (() => void) | null = null;
  const stage = new PIXI.Container();
  const app = {
    ticker: { add: (fn: () => void) => { tick = fn; }, deltaMS: 16 },
    stage,
    screen: { width: w, height: h },
  } as unknown as PIXI.Application;
  return { app, stage, frame: (): void => tick?.() };
}

function stubScene(name: string): Scene & { name: string } {
  return { name, container: new PIXI.Container(), update: () => {}, destroy: () => {} };
}

/**
 * The app.ts wiring, reproduced: a SceneManager whose `dialogGate` closes the feedback dialog, and a
 * sink/close pair that raises and lowers the modal gate around it. `gated: false` reproduces the
 * pre-fix build (dialog mounted, gate never raised) so each assertion below has its own control.
 */
function appLike(w: number, h: number, opts: { gated?: boolean } = {}) {
  const gated = opts.gated ?? true;
  const { app, frame } = makeApp(w, h);
  const layer = new PIXI.Container();
  const input = new InputManager();
  const dialogGate: DialogGate = { close: () => {} };
  const mgr = new SceneManager(app, layer, input, dialogGate);

  const fired: string[] = [];
  const layout = createLayout(w, h);
  // The Lobby's nav callbacks really navigate here, so "where did the player land" is observable —
  // mirroring nav/lobby.ts, which routes all of these through nav.goXxx() → manager.goto().
  const navTo = (name: string) => () => { fired.push(name); mgr.goto(stubScene(name)); };
  const cb = lobbyCallbacks(fired) as unknown as Record<string, unknown>;
  for (const k of ['onStartRanked', 'onOpenCampaign', 'onOpenWorld', 'onOpenRoom']) cb[k] = navTo(k);

  const lobby = new LobbyScene(layout, input, cb as unknown as LobbySceneCallbacks);
  mgr.goto(lobby);

  let dlg: FeedbackDialog | null = null;
  const closeFeedback = (): void => {
    if (!dlg) return;
    app.stage.removeChild(dlg.container);
    dlg.destroy();
    dlg = null;
    if (gated) input.holdForModal(false);
  };
  dialogGate.close = closeFeedback;
  const submitted: string[] = [];
  const openFeedback = (): void => {
    if (dlg) return;
    dlg = new FeedbackDialog(layout.designWidth, layout.designHeight, {
      openTextInput: openDomTextInput,
      onSubmit: async (text) => { submitted.push(text); },
      onClose: closeFeedback,
    });
    app.stage.addChild(dlg.container);
    if (gated) input.holdForModal(true);
  };

  /** Fire both halves of a real tap on one of the open dialog's controls. */
  const tapDialog = (which: 'field' | 'submit' | 'close'): void => {
    const ctrl = dlg!.container.children
      .filter((c) => c.eventMode === 'static' && (c as PIXI.Container).hitArea == null)[
        { field: 0, submit: 1, close: 2 }[which]
      ]!;
    const b = ctrl.getBounds();
    input._emitDown(b.x + b.width / 2, b.y + b.height / 2); // DOM-fed path (leaks to the scene)
    (ctrl.emit as (event: string) => void)('pointertap');  // PixiJS path (the dialog's own handler)
  };

  return {
    input, mgr, frame, layer, fired, submitted, lobby, openFeedback, tapDialog,
    /** True while the Lobby is still the mounted scene — i.e. Close really did land back on the Lobby. */
    onLobby: (): boolean => layer.children.includes(lobby.container),
    dialogOpen: (): boolean => dlg !== null,
    setText: (s: string): void => { (dlg as unknown as { feedbackText: string }).feedbackText = s; },
    destroy: (): void => { closeFeedback(); },
  };
}

describe('FeedbackDialog — the reported open/send/reopen/close sequence (2026-08-10)', () => {
  for (const [label, w, h] of SIZES) {
    it(`${label}: closing after a successful send lands back on the Lobby`, async () => {
      const a = appLike(w, h);

      a.openFeedback();
      a.tapDialog('field');
      a.setText('great game');
      a.tapDialog('submit');
      await Promise.resolve(); await Promise.resolve(); // let submit()'s await settle
      expect(a.submitted).toEqual(['great game']);
      expect(a.dialogOpen()).toBe(true); // a successful send deliberately keeps the panel open

      a.tapDialog('close');
      expect(a.dialogOpen()).toBe(false);
      expect(a.onLobby()).toBe(true);

      // …then the second open + immediate close, which is where the report saw it break.
      a.openFeedback();
      a.tapDialog('close');
      expect(a.dialogOpen()).toBe(false);
      expect(a.onLobby()).toBe(true);
      expect(a.fired).toEqual([]); // no Lobby nav anywhere in the whole sequence
      a.destroy();
    });

    it(`${label}: control — the same sequence on the pre-fix build (no gate) navigates away instead`, () => {
      const a = appLike(w, h, { gated: false });

      a.openFeedback();
      a.tapDialog('field'); // leaks to the Lobby's Start button…

      // …which navigates, and goto() closes the dialog through the DialogGate on the way out, so the
      // player never even reaches Submit — this is the pre-fix reality the fix has to erase.
      expect(a.fired).toEqual(['onStartRanked']);
      expect(a.dialogOpen()).toBe(false);
      expect(a.onLobby()).toBe(false);
      a.destroy();
    });
  }

  // A stuck gate is worse than the bug it fixes: nothing on screen would respond to taps ever again.
  // The DialogGate path (a background nav closing the dialog on its own) is the one that could leak a
  // hold, since it bypasses the player's Close button entirely.
  it('a background nav closing the dialog releases the gate — the scene it lands on is live', () => {
    const a = appLike(800, 1280);
    a.openFeedback();

    // e.g. a friend-initiated match push, or an async world-shard resolve landing (2026-08-08 entry).
    a.mgr.goto(stubScene('pushed-match'));
    expect(a.dialogOpen()).toBe(false); // DialogGate closed it
    expect(a.onLobby()).toBe(false);

    // The gate must be down again: prove it by mounting a fresh input-subscribed Lobby and tapping it.
    const revived: string[] = [];
    const lobby2 = new LobbyScene(createLayout(800, 1280), a.input, lobbyCallbacks(revived));
    a.mgr.goto(lobby2);
    const strip = (lobby2 as unknown as { core: { feedbackStripRect: { x: number; y: number; w: number; h: number } } }).core.feedbackStripRect;
    a.input._emitDown(strip.x + strip.w / 2, strip.y + strip.h / 2);
    expect(revived).toEqual(['onOpenFeedback']);
    a.destroy();
  });

  it('a manual close followed by a background nav does not release the gate twice', () => {
    const a = appLike(800, 1280);
    a.openFeedback();
    a.tapDialog('close');        // release #1
    a.input.holdForModal(true);  // stand-in for a second modal (e.g. an appeal prompt) opening after
    a.mgr.goto(stubScene('pushed-match')); // DialogGate fires again with nothing open

    // If closeFeedback() lacked its `if (!dlg) return;` early-out, this second call would decrement
    // the count the other modal is holding and un-gate the scene underneath it.
    a.input._emitDown(10, 10);
    const seen: string[] = [];
    const lobby2 = new LobbyScene(createLayout(800, 1280), a.input, lobbyCallbacks(seen));
    const strip = (lobby2 as unknown as { core: { feedbackStripRect: { x: number; y: number; w: number; h: number } } }).core.feedbackStripRect;
    a.input._emitDown(strip.x + strip.w / 2, strip.y + strip.h / 2);
    expect(seen).toEqual([]);
    lobby2.destroy();
    a.destroy();
  });

  it('the gate does not touch the dialog\'s own controls (they are PixiJS events, not InputManager)', async () => {
    const a = appLike(800, 1280);
    a.openFeedback();
    a.setText('still works');
    a.tapDialog('submit');
    await Promise.resolve(); await Promise.resolve();
    expect(a.submitted).toEqual(['still works']); // Submit reached the dialog while the gate was up
    a.tapDialog('close');
    expect(a.dialogOpen()).toBe(false);           // …and so did Close
    a.destroy();
  });
});

// AppealDialog is the wider exposure of the same defect: it is triggered from the transport layer on
// ACCOUNT_BANNED/ACCOUNT_MUTED, so it can appear over ANY scene, not just the Lobby — and ~20 scenes
// subscribe to the InputManager the same broadcast way (grep `input.onDown(` under src/scenes).
describe('AppealDialog — same gate, over an arbitrary input-subscribed scene', () => {
  /** Stands in for any of the ~20 scenes that subscribe to InputManager directly. */
  function hostScene(input: InputManager): { taps: number[][]; destroy: () => void } {
    const taps: number[][] = [];
    const unsubs = [
      input.onDown((x, y) => taps.push([x, y])),
      input.onUp((x, y) => taps.push([x, y])),
      input.onMove((x, y) => taps.push([x, y])),
    ];
    return { taps, destroy: () => unsubs.forEach((u) => u()) };
  }

  for (const [label, w, h] of SIZES) {
    it(`${label}: none of its controls leak a tap to the scene underneath`, () => {
      const input = new InputManager();
      const host = hostScene(input);
      const dlg = new AppealDialog(w, h, 'ACCOUNT_BANNED', { openTextInput: openDomTextInput, onSubmit: async () => {}, onClose() {} });
      const controls = dlg.container.children
        .filter((c) => c.eventMode === 'static' && (c as PIXI.Container).hitArea == null);
      expect(controls).toHaveLength(3); // reason field, Submit, Cancel

      // Control first: without the gate the host sees every one of them.
      for (const c of controls) {
        const b = c.getBounds();
        input._emitDown(b.x + b.width / 2, b.y + b.height / 2);
      }
      expect(host.taps).toHaveLength(3);

      host.taps.length = 0;
      input.holdForModal(true);
      for (const c of controls) {
        const b = c.getBounds();
        input._emitDown(b.x + b.width / 2, b.y + b.height / 2);
        input._emitUp(b.x + b.width / 2, b.y + b.height / 2);
      }
      expect(host.taps).toEqual([]);

      dlg.destroy();
      host.destroy();
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
