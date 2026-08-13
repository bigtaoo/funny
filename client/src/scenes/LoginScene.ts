import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { FS } from '../render/fontScale';
import { MIN_PASSWORD_LEN, MIN_LOGIN_ID_LEN, type LoginSceneCallbacks, type View, type Field, type Hit } from './LoginScene/types';
import { drawLanding, drawForm, drawSubmitting, PRESS_DUR, type FormHost } from './LoginScene/forms';

export type { AuthOutcome, LoginSceneCallbacks } from './LoginScene/types';

// ── LoginScene (SA-3) — account login / register + single-player entry ─────────
//
// Canvas-drawn (mirrors RoomScene/LobbyScene). Free-text entry is captured by a
// single hidden <input> overlaid on the page (works with desktop keyboards and
// mobile soft keyboards); the value is mirrored onto canvas-drawn field boxes
// (password masked as dots). Tapping a field focuses the hidden input.
//
// Views: landing → (password | register) → submitting. OAuth is deferred (SA-2),
// so there's no oauthWait view yet. Copy lives in the i18n `auth.*` namespace.
//
// The actual REST call + token persistence + navigation live in app.ts; the
// scene only collects input and reports the outcome (to clear "submitting" and
// show an error key on failure). On success app navigates away (scene destroyed).
//
// 2026-08-13: the landing/form/submitting views + field/hint/button drawers were pulled out into
// LoginScene/forms.ts as form① free functions (claudedocs/client-modules.md "单文件 500 行收敛")
// — this file kept scene lifecycle, the hidden-input wiring, and the validate/submit logic those
// views call back into.

export class LoginScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: LoginSceneCallbacks;

  private view: View = 'landing';
  private readonly fields: Record<Field, string> = { loginId: '', password: '', confirmPassword: '', displayName: '' };
  private focused: Field | null = null;

  private errorKey: TranslationKey | null = null;
  /** Raw error detail (code / message) surfaced under the translated error line for diagnosis. */
  private errorDetail: string | null = null;

  private caretOn = true;
  private caretTimer = 0;

  private spinnerText: PIXI.Text | null = null;
  private dotCount = 0;
  private dotsTimer = 0;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() against any late (caret/async) re-render into a torn-down container. */
  private destroyed = false;

  /** Active button press: grows the button, then fires its action when the pop ends. */
  private press: { key: string; t: number; fn: () => void } | null = null;

  /** Hidden DOM input that captures keystrokes (incl. mobile soft keyboard). */
  private hiddenInput: HTMLInputElement | null = null;

  constructor(layout: ILayout, input: InputManager, cb: LoginSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.setupHiddenInput();
    this.render();
  }

  // ── Scene interface ──────────────────────────────────────────────────────────

  update(dt: number): void {
    // A button is mid-press: grow it for PRESS_DUR, then fire its action. Deferring
    // the action until the pop finishes makes the tap visibly register first.
    if (this.press) {
      this.press.t += dt;
      if (this.press.t >= PRESS_DUR) {
        const fn = this.press.fn;
        this.press = null;
        fn();
      } else {
        this.render();
      }
      return;
    }
    if (this.view === 'submitting' && this.spinnerText) {
      this.dotsTimer += dt;
      if (this.dotsTimer >= 0.4) {
        this.dotsTimer = 0;
        this.dotCount = (this.dotCount + 1) % 4;
        this.spinnerText.text = t('auth.loggingIn') + '.'.repeat(this.dotCount);
      }
      return;
    }
    // Blink the caret on the focused field.
    if (this.focused) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) {
        this.caretTimer = 0;
        this.caretOn = !this.caretOn;
        this.render();
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    if (this.hiddenInput) {
      this.hiddenInput.remove();
      this.hiddenInput = null;
    }
    this.container.destroy({ children: true });
  }

  // ── Hidden input (text capture) ───────────────────────────────────────────────

  private setupHiddenInput(): void {
    if (typeof document === 'undefined') return; // non-DOM platform (wx skips this scene)
    const el = document.createElement('input');
    el.type = 'text';
    el.autocomplete = 'off';
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('autocorrect', 'off');
    // Off-screen but focusable, so mobile soft keyboards still appear. font-size
    // 16px avoids iOS auto-zoom; opacity ~0 keeps it invisible.
    el.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;' +
      'border:0;padding:0;margin:0;font-size:16px;z-index:-1;';
    el.addEventListener('input', () => {
      if (this.focused) {
        this.fields[this.focused] = el.value;
        // Editing any field clears a stale validation/auth error so the form stays
        // live: the red line disappears as the user fixes the input (the green ✓
        // hints already update per keystroke), and the submit button never looks
        // "stuck" behind an error that no longer reflects the current values.
        if (this.errorKey) { this.errorKey = null; this.errorDetail = null; }
        this.render();
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.onSubmit(); }
    });
    document.body.appendChild(el);
    this.hiddenInput = el;
  }

  private focus(field: Field): void {
    this.focused = field;
    this.caretOn = true;
    this.caretTimer = 0;
    const el = this.hiddenInput;
    if (el) {
      el.type = field === 'password' || field === 'confirmPassword' ? 'password' : 'text';
      el.value = this.fields[field];
      el.focus();
      // Move caret to end.
      const n = el.value.length;
      try { el.setSelectionRange(n, n); } catch { /* type may not support it */ }
    }
    this.render();
  }

  private blur(): void {
    this.focused = null;
    this.hiddenInput?.blur();
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.press) return; // swallow taps while a button is mid-press
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        hit.fn();
        return;
      }
    }
    // Tap outside any field/button → blur.
    if (this.focused) { this.blur(); this.render(); }
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  private goView(v: View): void {
    this.view = v;
    this.errorKey = null;
    this.errorDetail = null;
    this.blur();
    if (v === 'landing') {
      this.fields.loginId = this.fields.password = this.fields.confirmPassword = this.fields.displayName = '';
    }
    this.render();
  }

  private onSubmit(): void {
    if (this.view !== 'password' && this.view !== 'register') return;
    const loginId = this.fields.loginId.trim();
    const password = this.fields.password;
    const isRegister = this.view === 'register';
    const formView: View = isRegister ? 'register' : 'password';
    if (!loginId || !password || (isRegister && !this.fields.confirmPassword)) {
      this.errorKey = 'auth.err.fields'; this.errorDetail = null; this.render(); return;
    }
    if (isRegister && loginId.length < MIN_LOGIN_ID_LEN) {
      this.errorKey = 'auth.err.loginId'; this.errorDetail = null; this.render(); return;
    }
    if (isRegister && password.length < MIN_PASSWORD_LEN) {
      this.errorKey = 'auth.err.weak'; this.errorDetail = null; this.render(); return;
    }
    if (isRegister && password !== this.fields.confirmPassword) {
      this.errorKey = 'auth.err.passwordMismatch'; this.errorDetail = null; this.render(); return;
    }

    const displayName = this.fields.displayName.trim() || undefined;
    this.blur();
    this.view = 'submitting';
    this.errorKey = null;
    this.errorDetail = null;
    this.render();

    // Always return to the form on any failure — including an unexpected rejection
    // — so the submit button is never stranded behind the (button-less) spinner.
    const fail = (errorKey: TranslationKey, detail?: string): void => {
      this.view = formView;
      this.errorKey = errorKey;
      this.errorDetail = detail ?? null;
      this.render();
    };

    const call = isRegister
      ? this.cb.onRegister(loginId, password, displayName)
      : this.cb.onLogin(loginId, password);
    void call
      .then((outcome) => {
        // On success app navigates away; only handle failure (scene still alive).
        if (!outcome.ok) fail(outcome.errorKey, outcome.detail);
      })
      .catch((e: unknown) => {
        console.error('[LoginScene] auth call rejected', e);
        fail('auth.err.network', e instanceof Error ? e.message : String(e));
      });
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container); // free per-keystroke/caret Text textures; see sketchUi

    this.hits = [];
    this.spinnerText = null;

    this.drawBackground();
    this.drawHeader();

    const host = this.formHost();
    switch (this.view) {
      case 'landing':    drawLanding(host);       break;
      case 'password':   drawForm(host, false);   break;
      case 'register':   drawForm(host, true);    break;
      case 'submitting': drawSubmitting(host);    break;
    }
  }

  /** Bundles what forms.ts's draw functions need instead of them closing over `this`. */
  private formHost(): FormHost {
    const scene = this;
    return {
      container: this.container, w: this.w, h: this.h, cb: this.cb,
      fields: this.fields, focused: this.focused, caretOn: this.caretOn,
      errorKey: this.errorKey, errorDetail: this.errorDetail,
      get hits() { return scene.hits; },
      set hits(v) { scene.hits = v; },
      get press() { return scene.press; },
      set press(v) { scene.press = v; },
      get spinnerText() { return scene.spinnerText; },
      set spinnerText(v) { scene.spinnerText = v; },
      goView: (v: View) => this.goView(v),
      onSubmit: () => this.onSubmit(),
      focus: (field: Field) => this.focus(field),
    };
  }

  private drawBackground(): void {
    this.container.addChild(buildPaperBackground('loginbg', this.w, this.h));
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
  }

  private drawHeader(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark); titleBg.drawRect(0, 0, w, tbH); titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('auth.title', { game: t('game.title') }), FS.headline, 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    // Back button (only on form views).
    if (this.view === 'password' || this.view === 'register') {
      const back = txt(t('auth.back'), FS.heading, C.light);
      back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
      this.container.addChild(back);
      const pad = Math.round(h * 0.02);
      this.hits.push({
        rect: { x: 0, y: 0, w: back.x + back.width + pad, h: tbH },
        fn: () => this.goView('landing'),
      });
    }
  }
}
