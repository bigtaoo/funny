// fakeTextInput.ts — a fake IPlatform.openTextInput for unit tests that used to install a fake
// global `document` (createElement/appendChild/addEventListener) to drive a scene's hidden-<input>
// wiring. Now that every scene goes through `cb.openTextInput` (ASSET_PACKAGING §4.3/§4.4 item 1),
// tests drive the same interaction by calling into the recorded `TextInputOptions` directly —
// `session.opts.onInput('x')` instead of `el.value = 'x'; el._listeners.input!({})`,
// `session.handle.close()` instead of `el._listeners.blur!({})`.
import { vi } from 'vitest';
import type { IPlatform, ITextInput, TextInputOptions } from '../../src/platform/IPlatform';

export interface FakeTextInputSession {
  readonly opts: TextInputOptions;
  readonly handle: ITextInput;
  closed: boolean;
  /** Last value passed to ITextInput.setValue() (mid-keystroke clipping, clear-after-submit, …). */
  lastSetValue: string | null;
}

export interface FakeTextInput {
  openTextInput: IPlatform['openTextInput'];
  /** One entry per openTextInput() call, in call order. */
  sessions: FakeTextInputSession[];
}

/** Mirrors the real close()-is-idempotent / setValue()-no-ops-after-close contract (WechatPlatform,
 *  platform/web/domTextInput.ts) so tests exercise the same semantics production code relies on. */
export function createFakeTextInput(): FakeTextInput {
  const sessions: FakeTextInputSession[] = [];
  const openTextInput = vi.fn((opts: TextInputOptions): ITextInput => {
    const session: FakeTextInputSession = { opts, closed: false, lastSetValue: null, handle: null as unknown as ITextInput };
    const handle: ITextInput = {
      setValue: (value) => { if (!session.closed) session.lastSetValue = value; },
      close: () => {
        if (session.closed) return;
        session.closed = true;
        opts.onComplete();
      },
    };
    (session as { handle: ITextInput }).handle = handle;
    sessions.push(session);
    return handle;
  });
  return { openTextInput, sessions };
}
