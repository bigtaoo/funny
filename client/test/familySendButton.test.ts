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
 */
import { describe, it, expect, vi } from 'vitest';
import { ActionsMixin } from '../src/scenes/FamilyScene/actions';
import type { FamilySceneBaseCtor } from '../src/scenes/FamilyScene/base';

/** Bare-bones stand-in for FamilySceneBase — only the fields doSendMsg()/submitMessage() touch. */
class FakeFamilySceneBase {
  destroyed = false;
  family: { familyId: string } | null = { familyId: 'fam1' };
  members: unknown[] = [];
  sendInput: { value: string; remove: () => void } | null = null;
  sendText = '';
  cb = {
    worldApi: { sendFamilyMessage: vi.fn().mockResolvedValue(undefined) },
    playerName: 'Tester',
  };
  render = vi.fn();
  showToast = vi.fn();
  errorMsg = (e: unknown): string => String(e);
  loadChannel = vi.fn().mockResolvedValue(undefined);
  openSendInput = vi.fn();
}

interface TestScene {
  destroyed: boolean;
  family: { familyId: string } | null;
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
    expect(scene.render).toHaveBeenCalledTimes(1);
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
