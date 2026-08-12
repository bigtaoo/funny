/**
 * familyChannelInput.test.ts — regression test for the FamilyScene channel send box being
 * impossible to type into, fixed 2026-07-14.
 *
 * Background: openSendInput() created a hidden <input>, focused it, and listened only for
 * Enter (keydown) + blur. Nothing mirrored the hidden input's value back onto the scene, and
 * the on-canvas field always drew the static placeholder — so typing produced no visible
 * feedback and the chat box looked completely dead ("聊天输入框无法输入").
 *
 * Fix: openSendInput() now seeds the hidden input with the current draft, sets sendText on
 * every 'input' event and re-renders, so renderChannel() can show the typed text + a blinking
 * caret (see caretRegression.ui.ts for the render half).
 */
import { describe, it, expect, vi } from 'vitest';
import { InputPanel } from '../src/scenes/FamilyScene/input';
import type { FamilySceneCore } from '../src/scenes/FamilyScene/core';
import type { DataHandlers } from '../src/scenes/FamilyScene/data';

/** Fake DOM <input> that records its event listeners so a test can fire them by name. */
interface FakeInput {
  type: string; value: string; maxLength: number; style: { cssText: string };
  _listeners: Record<string, (e: unknown) => void>;
  focus(): void; remove(): void;
  addEventListener(t: string, cb: (e: unknown) => void): void;
}

/** Installs a minimal global `document` whose createElement returns listener-capturing inputs. */
function installDocument(): { created: FakeInput[] } {
  const created: FakeInput[] = [];
  (globalThis as unknown as { document: unknown }).document = {
    body: { appendChild(): void {} },
    createElement(): FakeInput {
      const el: FakeInput = {
        type: '', value: '', maxLength: 0, style: { cssText: '' }, _listeners: {},
        focus(): void {}, remove(): void {},
        addEventListener(t: string, cb: (e: unknown) => void): void { this._listeners[t] = cb; },
      };
      created.push(el);
      return el;
    },
  };
  return { created };
}

/** Bare-bones stand-in for FamilySceneCore — only the fields openSendInput() reads/writes. */
function fakeCore(): FamilySceneCore {
  return {
    destroyed: false,
    sendInput: null,
    sendText: '',
    caretOn: false,
    caretTimer: 99,
    render: vi.fn(),
  } as unknown as FamilySceneCore;
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
    const { created } = installDocument();
    const core = fakeCore();
    const input = new InputPanel(core, fakeData);

    input.openSendInput();
    const el = created[0]!;
    expect(core.sendInput).toBe(el);
    // Focusing the field kicks the caret on and resets its blink phase.
    expect(core.caretOn).toBe(true);
    expect(core.caretTimer).toBe(0);

    el.value = 'hel';
    el._listeners.input!({});
    expect(core.sendText).toBe('hel');

    el.value = 'hello';
    el._listeners.input!({});
    expect(core.sendText).toBe('hello');
    expect(core.render).toHaveBeenCalled();
  });

  it('seeds the hidden input with the existing draft so reopening keeps the text', () => {
    const { created } = installDocument();
    const core = fakeCore();
    core.sendText = 'draft in progress';
    const input = new InputPanel(core, fakeData);

    input.openSendInput();

    expect(created[0]!.value).toBe('draft in progress');
  });

  it('blur clears sendInput and re-renders', () => {
    const { created } = installDocument();
    const core = fakeCore();
    const input = new InputPanel(core, fakeData);

    input.openSendInput();
    created[0]!._listeners.blur!({});

    expect(core.sendInput).toBeNull();
    expect(core.render).toHaveBeenCalled();
  });

  it('does not re-render after the scene is destroyed', () => {
    const { created } = installDocument();
    const core = fakeCore();
    const input = new InputPanel(core, fakeData);

    input.openSendInput();
    (core.render as ReturnType<typeof vi.fn>).mockClear();
    core.destroyed = true;

    created[0]!.value = 'x';
    created[0]!._listeners.input!({});

    expect(core.sendText).toBe('x');            // value still mirrored…
    expect(core.render).not.toHaveBeenCalled(); // …but no render on a torn-down scene
  });
});
