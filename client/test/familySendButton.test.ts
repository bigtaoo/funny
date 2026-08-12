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
    core.sendInput = { value: '  hello family  ', remove: removeSpy };
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
    core.sendInput = { value: '   ', remove: vi.fn() };
    core.sendText = '   ';

    await input.doSendMsg();

    expect(core.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
  });

  it('shows a toast and does not clear render state when the API call fails', async () => {
    const core = fakeCore();
    const data = fakeData();
    const input = new InputPanel(core, data);
    (core.cb.worldApi.sendFamilyMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
    core.sendInput = { value: 'hi', remove: vi.fn() };
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
