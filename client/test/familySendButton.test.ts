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
 */
import { describe, it, expect, vi } from 'vitest';
import { ActionsMixin } from '../src/scenes/FamilyScene/actions';
import type { FamilySceneBaseCtor } from '../src/scenes/FamilyScene/base';

/** Bare-bones stand-in for FamilySceneBase — only the fields doSendMsg()/submitMessage() touch. */
interface Msg { id: string; senderId: string; senderName: string; body: string; ts: number }

/** Bare-bones stand-in for FamilySceneBase — only the fields doSendMsg()/submitMessage() touch. */
class FakeFamilySceneBase {
  destroyed = false;
  family: { familyId: string } | null = { familyId: 'fam1' };
  members: unknown[] = [];
  messages: Msg[] = [];
  scrollYChannel = 0;
  channelStick = true;
  sendInput: { value: string; remove: () => void } | null = null;
  sendText = '';
  cb = {
    worldApi: { sendFamilyMessage: vi.fn().mockResolvedValue(undefined) },
    playerName: 'Tester',
    myAccountId: 'me',
  };
  render = vi.fn();
  showToast = vi.fn();
  errorMsg = (e: unknown): string => String(e);
  // loadChannel replaces `messages` wholesale in production; the mock leaves it as-is so tests can
  // observe the optimistic echo the reconcile would otherwise overwrite.
  loadChannel = vi.fn().mockResolvedValue(undefined);
  openSendInput = vi.fn();
}

interface TestScene {
  destroyed: boolean;
  family: { familyId: string } | null;
  messages: Msg[];
  scrollYChannel: number;
  channelStick: boolean;
  sendInput: { value: string; remove: () => void } | null;
  sendText: string;
  cb: FakeFamilySceneBase['cb'];
  render: FakeFamilySceneBase['render'];
  showToast: FakeFamilySceneBase['showToast'];
  loadChannel: FakeFamilySceneBase['loadChannel'];
  openSendInput: FakeFamilySceneBase['openSendInput'];
  doSendMsg(): Promise<void>;
  submitMessage(body: string): Promise<void>;
}

const FamilyWithActions = ActionsMixin(FakeFamilySceneBase as unknown as FamilySceneBaseCtor);

describe('FamilyScene Send button — doSendMsg()', () => {
  it('sends the mirrored draft (sendText) and clears it', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    const removeSpy = vi.fn();
    scene.sendInput = { value: '  hello family  ', remove: removeSpy };
    scene.sendText = '  hello family  ';

    await scene.doSendMsg();

    expect(scene.cb.worldApi.sendFamilyMessage).toHaveBeenCalledTimes(1);
    expect(scene.cb.worldApi.sendFamilyMessage).toHaveBeenCalledWith('fam1', 'hello family', 'Tester');
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(scene.sendInput).toBeNull();
    expect(scene.sendText).toBe('');
    expect(scene.loadChannel).toHaveBeenCalledTimes(1);
    // Two repaints: the optimistic echo (before the network) + the post-reconcile paint.
    expect(scene.render).toHaveBeenCalledTimes(2);
  });

  it('regression: sends via sendText even when sendInput was already nulled by blur', async () => {
    // Reproduces the exact state doSendMsg() sees when a real click blurs the hidden input
    // (input.ts's blur handler runs first and sets sendInput = null) before the Send button's
    // own click handler fires — sendInput is gone, but sendText still holds the typed draft.
    const scene = new FamilyWithActions() as unknown as TestScene;
    scene.sendInput = null;
    scene.sendText = '顶顶顶顶';

    await scene.doSendMsg();

    expect(scene.cb.worldApi.sendFamilyMessage).toHaveBeenCalledTimes(1);
    expect(scene.cb.worldApi.sendFamilyMessage).toHaveBeenCalledWith('fam1', '顶顶顶顶', 'Tester');
    expect(scene.openSendInput).not.toHaveBeenCalled();
    expect(scene.sendText).toBe('');
  });

  it('opens the send input instead of doing nothing when there is no draft yet', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    scene.sendInput = null;
    scene.sendText = '';

    await scene.doSendMsg();

    expect(scene.openSendInput).toHaveBeenCalledTimes(1);
    expect(scene.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
  });

  it('does not call the API for a blank/whitespace-only draft', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    scene.sendInput = { value: '   ', remove: vi.fn() };
    scene.sendText = '   ';

    await scene.doSendMsg();

    expect(scene.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
  });

  it('shows a toast and does not clear render state when the API call fails', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    scene.cb.worldApi.sendFamilyMessage.mockRejectedValueOnce(new Error('network down'));
    scene.sendInput = { value: 'hi', remove: vi.fn() };
    scene.sendText = 'hi';

    await scene.doSendMsg();

    expect(scene.showToast).toHaveBeenCalledTimes(1);
    expect(scene.loadChannel).not.toHaveBeenCalled();
  });
});

describe('FamilyScene channel — submitMessage() optimistic echo (2026-07-15 latency fix)', () => {
  it('prepends the sender echo and repaints BEFORE the network round-trips resolve', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    scene.messages = [{ id: 'prev', senderId: 'other', senderName: 'Bob', body: 'earlier', ts: 1 }];
    scene.channelStick = false; // pretend the user had scrolled up; sending must re-pin to the bottom

    // Hold the POST pending so we can observe the state between the optimistic paint and reconcile.
    let resolvePost!: () => void;
    scene.cb.worldApi.sendFamilyMessage.mockReturnValueOnce(
      new Promise<{ id: string }>((r) => { resolvePost = () => r({ id: 's1' }); }),
    );

    const pending = scene.submitMessage('hello family');

    // Synchronously (POST still in flight): echo is already prepended, the channel re-pinned to the
    // bottom (renderChannel snaps scrollYChannel to the latest line while channelStick is set), one
    // paint, and the refetch has NOT run yet — this is what kills the 2-3s "frozen" feel.
    expect(scene.messages).toHaveLength(2);
    expect(scene.messages[0]).toMatchObject({ body: 'hello family', senderId: 'me', senderName: 'Tester' });
    expect(scene.messages[1]!.id).toBe('prev');
    expect(scene.channelStick).toBe(true);
    expect(scene.render).toHaveBeenCalledTimes(1);
    expect(scene.loadChannel).not.toHaveBeenCalled();

    resolvePost();
    await pending;

    expect(scene.loadChannel).toHaveBeenCalledTimes(1);
    expect(scene.render).toHaveBeenCalledTimes(2);
  });

  it('rolls the optimistic echo back (and keeps prior messages) when the send fails', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    scene.messages = [{ id: 'prev', senderId: 'other', senderName: 'Bob', body: 'earlier', ts: 1 }];
    scene.cb.worldApi.sendFamilyMessage.mockRejectedValueOnce(new Error('network down'));

    await scene.submitMessage('doomed');

    expect(scene.messages).toHaveLength(1);
    expect(scene.messages[0]!.id).toBe('prev');
    expect(scene.showToast).toHaveBeenCalledTimes(1);
    expect(scene.loadChannel).not.toHaveBeenCalled();
  });

  it('ignores an empty body and a missing family (no echo, no network)', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    await scene.submitMessage('');
    expect(scene.messages).toHaveLength(0);
    expect(scene.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();

    scene.family = null;
    await scene.submitMessage('hi');
    expect(scene.messages).toHaveLength(0);
    expect(scene.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
  });
});
