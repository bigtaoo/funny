import type { ITextInput, TextInputOptions } from '../IPlatform';

/**
 * Web / CrazyGames implementation of `IPlatform.openTextInput` (ASSET_PACKAGING §4.3/§4.4 item 1):
 * an off-screen `<input>` appended to `document.body`. This is the exact technique every scene used
 * to build inline for itself (LoginScene, ChatScene, FamilyScene's send box, …) — centralized here
 * so WebPlatform and CrazyGamesPlatform share one implementation instead of twelve copies.
 *
 * Lives under `platform/web/` on purpose: that path is excluded from the WeChat-reachable-DOM scan
 * (`test/harness/domUsageScan.ts`'s `OFF_PATH`), same as `WebPlatform.ts` itself — this file is the
 * one place in the client that's *supposed* to touch `document`.
 */
export function openDomTextInput(opts: TextInputOptions): ITextInput {
  const el = document.createElement('input');
  el.type = opts.password ? 'password' : 'text';
  el.value = opts.value;
  el.maxLength = opts.maxLength;
  el.autocomplete = 'off';
  el.setAttribute('autocapitalize', 'off');
  el.setAttribute('autocorrect', 'off');
  // Mobile soft-keyboard Enter-key label — the web/CrazyGames half of confirmType's parity with
  // WeChat's wx.showKeyboard confirmType (same five values by design).
  if (opts.confirmType) el.setAttribute('enterkeyhint', opts.confirmType);
  // Off-screen but focusable, so mobile soft keyboards still appear (LoginScene's original
  // technique). font-size 16px avoids iOS Safari's auto-zoom-on-focus; opacity ~0 keeps it
  // invisible without `display:none`/`visibility:hidden`, either of which blocks focus on iOS.
  el.style.cssText =
    'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;' +
    'border:0;padding:0;margin:0;font-size:16px;z-index:-1;';
  document.body.appendChild(el);

  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    el.remove();
    opts.onComplete();
  };

  el.addEventListener('input', () => opts.onInput(el.value));
  // Never auto-closes — see TextInputOptions.onConfirm's doc comment. A plain `<input>` doesn't
  // blur on Enter by itself either, so this matches every hidden-input call site's prior behavior
  // without each of them needing to special-case it.
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); opts.onConfirm?.(el.value); }
  });
  el.addEventListener('blur', finish);

  el.focus();
  // Caret at the end of the seeded value (LoginScene's original focus() behavior) — without this
  // the caret lands at position 0 and the first keystroke inserts before the existing text.
  const n = el.value.length;
  try { el.setSelectionRange(n, n); } catch { /* password/number-mode inputs may not support it */ }

  return {
    setValue(value: string): void {
      if (closed) return;
      el.value = value;
    },
    close(): void {
      finish();
    },
  };
}
