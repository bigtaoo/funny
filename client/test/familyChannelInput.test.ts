/**
 * familyChannelInput.test.ts — regression test for the FamilyScene channel send box being
 * impossible to type into, fixed 2026-07-14.
 *
 * Background: openSendInput() created a hidden <input>, focused it, and listened only for
 * Enter (keydown) + blur. Nothing mirrored the hidden input's value back onto the scene, and
 * the on-canvas field always drew the static placeholder — so typing produced no visible
 * feedback and the chat box looked completely dead ("聊天输入框无法输入").
 *
 * Fix: openSendInput() now seeds the text-entry session with the current draft, mirrors every
 * keystroke (onInput) into sendText, and re-renders, so renderChannel() can show the typed text +
 * a blinking caret (see caretRegression.ui.ts for the render half).
 *
 * 2026-09-01: converted off a fake global `document` to `cb.openTextInput` (ASSET_PACKAGING
 * §4.3/§4.4 item 1) — see test/harness/fakeTextInput.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { InputPanel } from '../src/scenes/FamilyScene/input';
import type { FamilySceneCore } from '../src/scenes/FamilyScene/core';
import { FamilyRepaint } from '../src/scenes/FamilyScene/repaint';
import type { DataHandlers } from '../src/scenes/FamilyScene/data';
import { createFakeTextInput } from './harness/fakeTextInput';

/** Bare-bones stand-in for FamilySceneCore — only the fields openSendInput() reads/writes.
 *  `repaint` is the real thing (2026-08-25): a keystroke rewrites the send field's own Text now, and
 *  with nothing rendered here there is no Text registered, so it falls back to core.render() — the
 *  production fallback, which is what the assertions below observe. */
function fakeCore(cb: { openTextInput: FamilySceneCore['cb']['openTextInput'] }): FamilySceneCore {
  const core = {
    destroyed: false,
    sendInput: null,
    sendText: '',
    caretOn: false,
    caretTimer: 99,
    render: vi.fn(),
    cb,
  } as unknown as FamilySceneCore;
  (core as unknown as { repaint: FamilyRepaint }).repaint = new FamilyRepaint(core);
  return core;
}

const fakeData: DataHandlers = {
  loadData: vi.fn(),
  loadMyFamily: vi.fn(),
  loadChannel: vi.fn(),
  loadJoinRequests: vi.fn(),
  applyFamilyMsg: vi.fn(),
};

describe('FamilyScene channel input — openSendInput()', () => {
  it('mirrors typed characters into sendText and re-renders (the "can\'t type into chat" fix)', () => {
    const { openTextInput, sessions } = createFakeTextInput();
    const core = fakeCore({ openTextInput });
    const input = new InputPanel(core, fakeData);

    input.openSendInput();
    const session = sessions[0]!;
    expect(core.sendInput).toBe(session.handle);
    // Focusing the field kicks the caret on and resets its blink phase.
    expect(core.caretOn).toBe(true);
    expect(core.caretTimer).toBe(0);

    session.opts.onInput('hel');
    expect(core.sendText).toBe('hel');

    session.opts.onInput('hello');
    expect(core.sendText).toBe('hello');
    expect(core.render).toHaveBeenCalled();
  });

  it('seeds the text-entry session with the existing draft so reopening keeps the text', () => {
    const { openTextInput, sessions } = createFakeTextInput();
    const core = fakeCore({ openTextInput });
    core.sendText = 'draft in progress';
    const input = new InputPanel(core, fakeData);

    input.openSendInput();

    expect(sessions[0]!.opts.value).toBe('draft in progress');
  });

  it('closing (blur-equivalent) clears sendInput and re-renders', () => {
    const { openTextInput, sessions } = createFakeTextInput();
    const core = fakeCore({ openTextInput });
    const input = new InputPanel(core, fakeData);

    input.openSendInput();
    sessions[0]!.handle.close();

    expect(core.sendInput).toBeNull();
    expect(core.render).toHaveBeenCalled();
  });

  it('does not re-render after the scene is destroyed', () => {
    const { openTextInput, sessions } = createFakeTextInput();
    const core = fakeCore({ openTextInput });
    const input = new InputPanel(core, fakeData);

    input.openSendInput();
    (core.render as ReturnType<typeof vi.fn>).mockClear();
    core.destroyed = true;

    sessions[0]!.opts.onInput('x');

    expect(core.sendText).toBe('x');            // value still mirrored…
    expect(core.render).not.toHaveBeenCalled(); // …but no render on a torn-down scene
  });
});
