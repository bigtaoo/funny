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
import { InputMixin } from '../src/scenes/FamilyScene/input';
import type { FamilySceneBaseCtor } from '../src/scenes/FamilyScene/base';

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

/** Only the fields openSendInput() reads/writes. */
class FakeBase {
  destroyed = false;
  sendInput: unknown = null;
  sendText = '';
  caretOn = false;
  caretTimer = 99;
  render = vi.fn();
}

const FamilyWithInput = InputMixin(FakeBase as unknown as FamilySceneBaseCtor);

interface TestScene {
  destroyed: boolean;
  sendInput: FakeInput | null;
  sendText: string;
  caretOn: boolean;
  caretTimer: number;
  render: ReturnType<typeof vi.fn>;
  openSendInput(): void;
}

describe('FamilyScene channel input — openSendInput()', () => {
  it('mirrors typed characters into sendText and re-renders (the "can\'t type into chat" fix)', () => {
    const { created } = installDocument();
    const scene = new FamilyWithInput() as unknown as TestScene;

    scene.openSendInput();
    const el = created[0]!;
    expect(scene.sendInput).toBe(el);
    // Focusing the field kicks the caret on and resets its blink phase.
    expect(scene.caretOn).toBe(true);
    expect(scene.caretTimer).toBe(0);

    el.value = 'hel';
    el._listeners.input!({});
    expect(scene.sendText).toBe('hel');

    el.value = 'hello';
    el._listeners.input!({});
    expect(scene.sendText).toBe('hello');
    expect(scene.render).toHaveBeenCalled();
  });

  it('seeds the hidden input with the existing draft so reopening keeps the text', () => {
    const { created } = installDocument();
    const scene = new FamilyWithInput() as unknown as TestScene;
    scene.sendText = 'draft in progress';

    scene.openSendInput();

    expect(created[0]!.value).toBe('draft in progress');
  });

  it('blur clears sendInput and re-renders', () => {
    const { created } = installDocument();
    const scene = new FamilyWithInput() as unknown as TestScene;

    scene.openSendInput();
    created[0]!._listeners.blur!({});

    expect(scene.sendInput).toBeNull();
    expect(scene.render).toHaveBeenCalled();
  });

  it('does not re-render after the scene is destroyed', () => {
    const { created } = installDocument();
    const scene = new FamilyWithInput() as unknown as TestScene;

    scene.openSendInput();
    scene.render.mockClear();
    scene.destroyed = true;

    created[0]!.value = 'x';
    created[0]!._listeners.input!({});

    expect(scene.sendText).toBe('x');            // value still mirrored…
    expect(scene.render).not.toHaveBeenCalled(); // …but no render on a torn-down scene
  });
});
