/**
 * familySendButton.test.ts — regression tests for the FamilyScene "Send" button.
 *
 * History:
 * - 2026-07-13: doSendMsg() was left as an empty stub after the mixin split — clicking Send did
 *   nothing at all. Fixed by extracting submitMessage(body), shared with the Enter-key handler.
 * - 2026-07-15: doSendMsg() read the body from `this.sendInput.value`. Clicking Send blurs the
 *   focused hidden <input> first — its own 'blur' handler (input.ts) nulls `this.sendInput`
 *   *before* the click's hit-test handler runs — so doSendMsg() saw `sendInput === null` even
 *   though the user had typed a message, and silently reopened an empty input instead of
 *   sending ("点Send没有任何反应"). Fixed by sourcing the body from `this.sendText` instead —
 *   it mirrors the input's value on every keystroke (see input.ts's 'input' listener) and stays
 *   correct regardless of the hidden input's DOM focus state.
 * - 2026-07-15 (latency): submitMessage() blocked the whole repaint on POST + full channel
 *   refetch (two sequential round-trips ≈ 2-3s), so Send felt frozen / like nothing happened.
 *   Now it optimistically prepends the sender's own message (newest-first) and repaints
 *   immediately, then reconciles in the background — rolling the echo back on failure.
 * - 2026-08-11: doSendMsg()/submitMessage() moved from the (now-retired) actions.ts mixin onto
 *   InputPanel, alongside openSendInput() — see scenes/FamilyScene/core.ts's file-header comment
 *   for why (the pair was FamilyScene's one genuine bidirectional dependency in the mixin→
 *   composition conversion). Behavior is unchanged; only the import/construction changed.
 */
import { describe, it, expect, vi } from 'vitest';
import { InputPanel } from '../src/scenes/FamilyScene/input';
import type { FamilySceneCore } from '../src/scenes/FamilyScene/core';
import type { DataHandlers } from '../src/scenes/FamilyScene/data';
import { BusyTracker } from '../src/ui/busyTracker';

interface Msg { id: string; senderId: string; senderName: string; body: string; ts: number }

/** Bare-bones stand-in for FamilySceneCore — only the fields doSendMsg()/submitMessage() touch. */
function fakeCore(): FamilySceneCore {
  return {
    destroyed: false,
    family: { familyId: 'fam1' },
    members: [] as unknown[],
    messages: [] as Msg[],
    scrollYChannel: 0,
    channelStick: true,
    sendInput: null as { value: string; remove: () => void } | null,
    sendText: '',
    bt: new BusyTracker(),
    cb: {
      worldApi: { sendFamilyMessage: vi.fn().mockResolvedValue(undefined) },
      playerName: 'Tester',
      myAccountId: 'me',
    },
    render: vi.fn(),
    showToast: vi.fn(),
    errorMsg: (e: unknown): string => String(e),
  } as unknown as FamilySceneCore;
}

function fakeData(): DataHandlers {
  return {
    loadData: vi.fn(),
    loadMyFamily: vi.fn(),
    // loadChannel replaces `messages` wholesale in production; the mock leaves it as-is so tests
    // can observe the optimistic echo the reconcile would otherwise overwrite.
    loadChannel: vi.fn().mockResolvedValue(undefined),
    loadJoinRequests: vi.fn(),
    applyFamilyMsg: vi.fn(),
  };
}

describe('FamilyScene Send button — doSendMsg()', () => {
  it('sends the mirrored draft (sendText) and clears it', async () => {
    const core = fakeCore();
    const data = fakeData();
    const input = new InputPanel(core, data);
    const removeSpy = vi.fn();
    core.sendInput = { value: '  hello family  ', remove: removeSpy } as unknown as HTMLInputElement;
    core.sendText = '  hello family  ';

    await input.doSendMsg();

    expect(core.cb.worldApi.sendFamilyMessage).toHaveBeenCalledTimes(1);
    expect(core.cb.worldApi.sendFamilyMessage).toHaveBeenCalledWith('fam1', 'hello family', 'Tester');
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(core.sendInput).toBeNull();
    expect(core.sendText).toBe('');
    expect(data.loadChannel).toHaveBeenCalledTimes(1);
    // Two repaints: the optimistic echo (before the network) + the post-reconcile paint.
    expect(core.render).toHaveBeenCalledTimes(2);
  });

  it('regression: sends via sendText even when sendInput was already nulled by blur', async () => {
    // Reproduces the exact state doSendMsg() sees when a real click blurs the hidden input
    // (input.ts's blur handler runs first and sets sendInput = null) before the Send button's
    // own click handler fires — sendInput is gone, but sendText still holds the typed draft.
    const core = fakeCore();
    const input = new InputPanel(core, fakeData());
    core.sendInput = null;
    core.sendText = '顶顶顶顶';

    await input.doSendMsg();

    expect(core.cb.worldApi.sendFamilyMessage).toHaveBeenCalledTimes(1);
    expect(core.cb.worldApi.sendFamilyMessage).toHaveBeenCalledWith('fam1', '顶顶顶顶', 'Tester');
    expect(core.sendText).toBe('');
  });

  it('opens the send input instead of doing nothing when there is no draft yet', async () => {
    const core = fakeCore();
    const input = new InputPanel(core, fakeData());
    const openSpy = vi.spyOn(input, 'openSendInput').mockImplementation(() => {});
    core.sendInput = null;
    core.sendText = '';

    await input.doSendMsg();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(core.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
  });

  it('does not call the API for a blank/whitespace-only draft', async () => {
    const core = fakeCore();
    const input = new InputPanel(core, fakeData());
    vi.spyOn(input, 'openSendInput').mockImplementation(() => {});
    core.sendInput = { value: '   ', remove: vi.fn() } as unknown as HTMLInputElement;
    core.sendText = '   ';

    await input.doSendMsg();

    expect(core.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
  });

  it('shows a toast and does not clear render state when the API call fails', async () => {
    const core = fakeCore();
    const data = fakeData();
    const input = new InputPanel(core, data);
    (core.cb.worldApi.sendFamilyMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
    core.sendInput = { value: 'hi', remove: vi.fn() } as unknown as HTMLInputElement;
    core.sendText = 'hi';

    await input.doSendMsg();

    expect(core.showToast).toHaveBeenCalledTimes(1);
    expect(data.loadChannel).not.toHaveBeenCalled();
  });
});

describe('FamilyScene channel — submitMessage() optimistic echo (2026-07-15 latency fix)', () => {
  it('prepends the sender echo and repaints BEFORE the network round-trips resolve', async () => {
    const core = fakeCore();
    const data = fakeData();
    const input = new InputPanel(core, data);
    core.messages = [{ id: 'prev', senderId: 'other', senderName: 'Bob', body: 'earlier', ts: 1 }];
    core.channelStick = false; // pretend the user had scrolled up; sending must re-pin to the bottom

    // Hold the POST pending so we can observe the state between the optimistic paint and reconcile.
    let resolvePost!: () => void;
    (core.cb.worldApi.sendFamilyMessage as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<{ id: string }>((r) => { resolvePost = () => r({ id: 's1' }); }),
    );

    const pending = input.submitMessage('hello family');

    // Synchronously (POST still in flight): echo is already prepended, the channel re-pinned to the
    // bottom (renderChannel snaps scrollYChannel to the latest line while channelStick is set), one
    // paint, and the refetch has NOT run yet — this is what kills the 2-3s "frozen" feel.
    expect(core.messages).toHaveLength(2);
    expect(core.messages[0]).toMatchObject({ body: 'hello family', senderId: 'me', senderName: 'Tester' });
    expect((core.messages[1] as Msg).id).toBe('prev');
    expect(core.channelStick).toBe(true);
    expect(core.render).toHaveBeenCalledTimes(1);
    expect(data.loadChannel).not.toHaveBeenCalled();

    resolvePost();
    await pending;

    expect(data.loadChannel).toHaveBeenCalledTimes(1);
    expect(core.render).toHaveBeenCalledTimes(2);
  });

  it('rolls the optimistic echo back (and keeps prior messages) when the send fails', async () => {
    const core = fakeCore();
    const data = fakeData();
    const input = new InputPanel(core, data);
    core.messages = [{ id: 'prev', senderId: 'other', senderName: 'Bob', body: 'earlier', ts: 1 }];
    (core.cb.worldApi.sendFamilyMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));

    await input.submitMessage('doomed');

    expect(core.messages).toHaveLength(1);
    expect((core.messages[0] as Msg).id).toBe('prev');
    expect(core.showToast).toHaveBeenCalledTimes(1);
    expect(data.loadChannel).not.toHaveBeenCalled();
  });

  it('ignores an empty body and a missing family (no echo, no network)', async () => {
    const core = fakeCore();
    const input = new InputPanel(core, fakeData());
    await input.submitMessage('');
    expect(core.messages).toHaveLength(0);
    expect(core.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();

    core.family = null;
    await input.submitMessage('hi');
    expect(core.messages).toHaveLength(0);
    expect(core.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
  });
});

// ── the merged text-entry + send unit (2026-08-11 actions↔input merge) ────────────────────────────
//
// FamilyScene's one genuine bidirectional dependency in the mixin→composition conversion was
// actions.ts's doSendMsg ↔ input.ts's openSendInput/submitMessage; it was resolved by MERGING all
// four onto InputPanel rather than adding a lazy hook (see scenes/FamilyScene/input.ts's file-header
// comment). Every test above and in familyChannelInput.test.ts covers exactly one half of that
// merged unit at a time — and the "no draft yet → open the input" case even mocks openSendInput out
// entirely — so the two halves were never once driven against each other on the real class.
//
// That matters because they share mutable state on Core (`sendText` / `sendInput`) and the ORDER
// they touch it in is load-bearing: doSendMsg() clears `core.sendText` BEFORE calling
// openSendInput(), which seeds the fresh DOM input from `core.sendText`. Swap those two statements
// and the reopened field is silently pre-filled with the draft the user just sent — the exact class
// of "two merged code paths clobbering each other's state" a merge (rather than a hook) introduces.
describe('FamilyScene — the merged text-entry + send unit', () => {
  /** Fake DOM <input> capturing its listeners, same shape as familyChannelInput.test.ts's. */
  interface FakeInput {
    type: string; value: string; maxLength: number; style: { cssText: string };
    _listeners: Record<string, (e: unknown) => void>;
    focus(): void; remove(): void;
    addEventListener(t: string, cb: (e: unknown) => void): void;
    removed: boolean;
  }

  /** Installs a minimal global `document`; returns the created inputs + a restore function. */
  function installDocument(): { created: FakeInput[]; restore: () => void } {
    const created: FakeInput[] = [];
    const g = globalThis as unknown as { document?: unknown };
    const prev = g.document;
    g.document = {
      body: { appendChild(): void {} },
      createElement(): FakeInput {
        const el: FakeInput = {
          type: '', value: '', maxLength: 0, style: { cssText: '' }, _listeners: {}, removed: false,
          focus(): void {}, remove(): void { this.removed = true; },
          addEventListener(t: string, cb: (e: unknown) => void): void { this._listeners[t] = cb; },
        };
        created.push(el);
        return el;
      },
    };
    return { created, restore: () => { g.document = prev; } };
  }

  it('Send with no draft opens the real (unmocked) hidden input, and a second Send then submits exactly what was typed into it', async () => {
    const { created, restore } = installDocument();
    try {
      const core = fakeCore();
      const data = fakeData();
      const input = new InputPanel(core, data);
      // A whitespace-only "draft" (the user tapped Send after typing nothing but spaces) — trims to
      // an empty body, so this is still the open-the-field branch, but it leaves sendText non-empty
      // going in, which is what makes the ordering below observable.
      core.sendText = '   ';

      // ── 1st tap: nothing real typed yet ⇒ the merged class must open the text field, not send. ──
      await input.doSendMsg();

      expect(created).toHaveLength(1);
      expect(core.sendInput).toBe(created[0]);
      expect(core.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
      // Freshly opened, NOT pre-seeded: doSendMsg() clears sendText BEFORE handing off to
      // openSendInput(), which seeds the DOM value from it. Move that clear after the handoff and
      // the reopened field comes up holding the stale draft instead of empty.
      expect(created[0]!.value).toBe('');
      expect(core.sendText).toBe('');

      // ── the user types (openSendInput's own 'input' listener mirrors into core.sendText) ──
      created[0]!.value = 'merged flow works';
      created[0]!._listeners.input!({});
      expect(core.sendText).toBe('merged flow works');

      // ── tapping Send blurs the field first: openSendInput's blur handler nulls core.sendInput
      //    before doSendMsg's own handler runs (the 2026-07-15 bug's exact ordering). ──
      created[0]!._listeners.blur!({});
      expect(core.sendInput).toBeNull();

      // ── 2nd tap: a draft exists now ⇒ submit it, and do NOT reopen the field. ──
      await input.doSendMsg();

      expect(core.cb.worldApi.sendFamilyMessage).toHaveBeenCalledTimes(1);
      expect(core.cb.worldApi.sendFamilyMessage).toHaveBeenCalledWith('fam1', 'merged flow works', 'Tester');
      expect(core.messages).toHaveLength(1);
      expect(core.messages[0]).toMatchObject({ body: 'merged flow works', senderId: 'me' });
      expect(core.sendText).toBe('');
      expect(core.sendInput).toBeNull();
      expect(created).toHaveLength(1); // no second hidden input was opened
      expect(data.loadChannel).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('Enter inside the hidden input reaches submitMessage on the same instance (the other face of the merge)', async () => {
    const { created, restore } = installDocument();
    try {
      const core = fakeCore();
      const data = fakeData();
      const input = new InputPanel(core, data);

      input.openSendInput();
      const el = created[0]!;
      el.value = '  typed then Enter  ';
      el._listeners.input!({});

      await el._listeners.keydown!({ key: 'Enter' });

      // openSendInput's keydown handler calls this.submitMessage(body) directly — pre-merge that
      // was a cross-mixin call into actions.ts.
      expect(core.cb.worldApi.sendFamilyMessage).toHaveBeenCalledTimes(1);
      expect(core.cb.worldApi.sendFamilyMessage).toHaveBeenCalledWith('fam1', 'typed then Enter', 'Tester');
      expect(el.removed).toBe(true);      // the field closes on Enter
      expect(core.sendInput).toBeNull();
      expect(core.sendText).toBe('');
      expect(data.loadChannel).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('a non-Enter keypress inside the hidden input sends nothing and leaves the field open', async () => {
    const { created, restore } = installDocument();
    try {
      const core = fakeCore();
      const input = new InputPanel(core, fakeData());

      input.openSendInput();
      const el = created[0]!;
      el.value = 'half a sentence';
      el._listeners.input!({});
      await el._listeners.keydown!({ key: 'a' });

      expect(core.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
      expect(el.removed).toBe(false);
      expect(core.sendInput).toBe(el);
      expect(core.sendText).toBe('half a sentence');
    } finally {
      restore();
    }
  });
});
