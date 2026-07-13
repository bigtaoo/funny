/**
 * familySendButton.test.ts — regression test for the FamilyScene "Send" button being a
 * silent no-op, fixed 2026-07-13.
 *
 * Background: after the FamilyScene mixin split, render.ts kept binding the visible
 * Send button's hit rect to doSendMsg() (actions.ts), but doSendMsg() had been left
 * as an empty stub — only pressing Enter inside the hidden channel-input overlay
 * (input.ts's openSendInput()) actually called worldApi.sendFamilyMessage(). Clicking
 * the Send button itself did nothing, so players who typed a message and clicked
 * Send (instead of pressing Enter) could never speak in the family channel.
 *
 * Fix: extracted the send call into submitMessage(body), shared by both the Enter-key
 * handler and doSendMsg(), which now reads the open input's value (or opens one if
 * none is open) instead of doing nothing.
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
  it('sends the open input\'s value and clears it (the fixed behavior)', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    const removeSpy = vi.fn();
    scene.sendInput = { value: '  hello family  ', remove: removeSpy };

    await scene.doSendMsg();

    // Regression: the old doSendMsg() was `async doSendMsg() {}` — this would fail
    // against that code since sendFamilyMessage was never called.
    expect(scene.cb.worldApi.sendFamilyMessage).toHaveBeenCalledTimes(1);
    expect(scene.cb.worldApi.sendFamilyMessage).toHaveBeenCalledWith('fam1', 'hello family', 'Tester');
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(scene.sendInput).toBeNull();
    expect(scene.loadChannel).toHaveBeenCalledTimes(1);
    expect(scene.render).toHaveBeenCalledTimes(1);
  });

  it('opens the send input instead of doing nothing when none is open yet', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    scene.sendInput = null;

    await scene.doSendMsg();

    expect(scene.openSendInput).toHaveBeenCalledTimes(1);
    expect(scene.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
  });

  it('does not call the API for a blank/whitespace-only message', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    scene.sendInput = { value: '   ', remove: vi.fn() };

    await scene.doSendMsg();

    expect(scene.cb.worldApi.sendFamilyMessage).not.toHaveBeenCalled();
  });

  it('shows a toast and does not clear render state when the API call fails', async () => {
    const scene = new FamilyWithActions() as unknown as TestScene;
    scene.cb.worldApi.sendFamilyMessage.mockRejectedValueOnce(new Error('network down'));
    scene.sendInput = { value: 'hi', remove: vi.fn() };

    await scene.doSendMsg();

    expect(scene.showToast).toHaveBeenCalledTimes(1);
    expect(scene.loadChannel).not.toHaveBeenCalled();
  });
});
