import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../render/sketchUi';

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

export type AuthOutcome =
  | { ok: true }
  | { ok: false; errorKey: TranslationKey; detail?: string };

export interface LoginSceneCallbacks {
  onLogin(loginId: string, password: string): Promise<AuthOutcome>;
  onRegister(loginId: string, password: string, displayName?: string): Promise<AuthOutcome>;
  /** Continue without an account (offline single-player). */
  onPlayOffline(): void;
}

// Mirror the server's account rules (server/shared/src/password.ts) so the client
// validates live before submitting. Keep in sync if the server limits change.
const MIN_PASSWORD_LEN = 6;
const MIN_LOGIN_ID_LEN = 3;

type View = 'landing' | 'password' | 'register' | 'submitting';
type Field = 'loginId' | 'password' | 'confirmPassword' | 'displayName';

interface Hit { rect: Rect; fn: () => void; }

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

  /** Active button press: grows the button, then fires its action when the pop ends. */
  private press: { key: string; t: number; fn: () => void } | null = null;
  private static readonly PRESS_DUR = 0.12; // seconds — quick tap-grow before the action fires
  private static readonly PRESS_AMP = 0.12; // peak scale-up (1.0 → 1.12 → 1.0)

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
      if (this.press.t >= LoginScene.PRESS_DUR) {
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
    this.unsubs.forEach((u) => u());
    if (this.hiddenInput) {
      this.hiddenInput.remove();
      this.hiddenInput = null;
    }
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
    this.container.removeChildren();
    this.hits = [];
    this.spinnerText = null;

    this.drawBackground();
    this.drawHeader();

    switch (this.view) {
      case 'landing':    this.drawLanding();    break;
      case 'password':   this.drawForm(false);  break;
      case 'register':   this.drawForm(true);   break;
      case 'submitting': this.drawSubmitting(); break;
    }
  }

  private drawBackground(): void {
    this.container.addChild(buildPaperBackground('loginbg', this.w, this.h));
  }

  private drawHeader(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark); titleBg.drawRect(0, 0, w, tbH); titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('auth.title'), Math.round(h * 0.034), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    // Back button (only on form views).
    if (this.view === 'password' || this.view === 'register') {
      const back = txt(t('auth.back'), Math.round(h * 0.026), C.light);
      back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
      this.container.addChild(back);
      const pad = Math.round(h * 0.02);
      this.hits.push({
        rect: { x: 0, y: 0, w: back.x + back.width + pad, h: tbH },
        fn: () => this.goView('landing'),
      });
    }
  }

  private drawLanding(): void {
    const { w, h } = this;
    const btnW = Math.round(w * 0.66);
    const btnH = Math.round(h * 0.10);
    const btnX = (w - btnW) / 2;
    const gap = Math.round(h * 0.035);
    const y0 = Math.round(h * 0.28);

    this.addButton(t('auth.login'), btnX, y0, btnW, btnH, C.dark, C.accent, () => this.goView('password'));
    this.addButton(t('auth.register'), btnX, y0 + btnH + gap, btnW, btnH, C.dark, C.gold, () => this.goView('register'));

    // Single-player entry — visually secondary (paper fill).
    const offY = y0 + 2 * (btnH + gap) + Math.round(h * 0.02);
    this.addButton(t('auth.playOffline'), btnX, offY, btnW, btnH, C.paper, C.green,
      () => this.cb.onPlayOffline(), C.dark);

    const hint = txt(t('auth.offlineHint'), Math.round(h * 0.020), C.mid);
    hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = offY + btnH + Math.round(h * 0.012);
    this.container.addChild(hint);
  }

  private drawForm(isRegister: boolean): void {
    const { w, h } = this;
    const fieldW = Math.round(w * 0.78);
    const fieldH = Math.round(h * 0.072);
    const fieldX = (w - fieldW) / 2;
    const gap = Math.round(h * 0.028);
    const hintH = Math.round(h * 0.026);
    // Register stacks more fields + live hints → start higher to keep it on-screen.
    let y = Math.round(h * (isRegister ? 0.16 : 0.22));

    const pw = this.fields.password;
    const cpw = this.fields.confirmPassword;

    this.drawField('loginId', t('auth.loginIdLabel'), fieldX, y, fieldW, fieldH, false);
    y += fieldH;
    if (isRegister) {
      this.drawHint(t('auth.hint.loginId'), this.fields.loginId.trim().length >= MIN_LOGIN_ID_LEN, fieldX, y, fieldW);
      y += hintH;
    }
    y += gap;

    this.drawField('password', t('auth.passwordLabel'), fieldX, y, fieldW, fieldH, true);
    y += fieldH;
    if (isRegister) {
      this.drawHint(t('auth.hint.password'), pw.length >= MIN_PASSWORD_LEN, fieldX, y, fieldW);
      y += hintH;
    }
    y += gap;

    if (isRegister) {
      this.drawField('confirmPassword', t('auth.confirmPasswordLabel'), fieldX, y, fieldW, fieldH, true);
      y += fieldH;
      this.drawHint(t('auth.hint.match'), cpw.length > 0 && pw === cpw, fieldX, y, fieldW);
      y += hintH + gap;
      this.drawField('displayName', t('auth.displayNameLabel'), fieldX, y, fieldW, fieldH, false);
      y += fieldH + gap;
    }

    // Error line (+ raw detail beneath, for diagnosis).
    if (this.errorKey) {
      const errLbl = txt(t(this.errorKey), Math.round(h * 0.022), C.red, true);
      errLbl.anchor.set(0.5, 0.5); errLbl.x = w / 2; errLbl.y = y + Math.round(h * 0.005);
      this.container.addChild(errLbl);
      if (this.errorDetail) {
        const det = txt(this.errorDetail, Math.round(h * 0.016), C.mid);
        det.anchor.set(0.5, 0); det.x = w / 2; det.y = y + Math.round(h * 0.02);
        det.style.wordWrap = true; det.style.wordWrapWidth = fieldW; det.style.align = 'center';
        this.container.addChild(det);
        y += Math.round(h * 0.03);
      }
    }
    y += Math.round(h * 0.04);

    // Submit — enabled only when the form would actually pass validation, so its
    // appearance (vivid vs. faded-grey) tells the user at a glance if it's ready.
    this.addButton(
      isRegister ? t('auth.submitRegister') : t('auth.submitLogin'),
      fieldX, y, fieldW, Math.round(h * 0.092),
      C.dark, isRegister ? C.gold : C.accent, () => this.onSubmit(),
      0xffffff, undefined, this.submitEnabled(isRegister),
    );
    y += Math.round(h * 0.092) + Math.round(h * 0.03);

    // Switch login/register.
    const swap = txt(isRegister ? t('auth.toLogin') : t('auth.toRegister'), Math.round(h * 0.024), C.accent, true);
    swap.anchor.set(0.5, 0.5); swap.x = w / 2; swap.y = y;
    this.container.addChild(swap);
    const sp = Math.round(h * 0.02);
    this.hits.push({
      rect: { x: w / 2 - swap.width / 2 - sp, y: y - swap.height / 2 - sp, w: swap.width + 2 * sp, h: swap.height + 2 * sp },
      fn: () => this.goView(isRegister ? 'password' : 'register'),
    });
  }

  /**
   * Whether the submit button should be enabled. Mirrors the validation in
   * `onSubmit` so the button's enabled look and the actual gate never disagree.
   * Login only needs both fields non-empty; register enforces the full rules.
   */
  private submitEnabled(isRegister: boolean): boolean {
    const loginId = this.fields.loginId.trim();
    const pw = this.fields.password;
    if (!isRegister) return loginId.length > 0 && pw.length > 0;
    return (
      loginId.length >= MIN_LOGIN_ID_LEN &&
      pw.length >= MIN_PASSWORD_LEN &&
      this.fields.confirmPassword.length > 0 &&
      pw === this.fields.confirmPassword
    );
  }

  private drawField(
    field: Field, label: string, x: number, y: number, w: number, h: number, masked: boolean,
  ): void {
    const value = this.fields[field];
    const isFocused = this.focused === field;

    // Label above the box.
    const lbl = txt(label, Math.round(h * 0.30), C.mid);
    lbl.anchor.set(0, 1); lbl.x = x; lbl.y = y - Math.round(h * 0.08);
    this.container.addChild(lbl);

    const box = sketchPanel(w, h, { fill: C.paper, border: isFocused ? C.accent : C.line, width: 2, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    this.container.addChild(box);

    const shown = masked ? '•'.repeat(value.length) : value;
    const display = shown + (isFocused && this.caretOn ? '|' : '');
    const placeholder = value.length === 0 && !isFocused;
    const valTxt = txt(placeholder ? t('auth.tapToType') : display, Math.round(h * 0.40),
      placeholder ? C.light : C.dark);
    valTxt.anchor.set(0, 0.5); valTxt.x = x + Math.round(w * 0.04); valTxt.y = y + h / 2;
    this.container.addChild(valTxt);

    this.hits.push({ rect: { x, y, w, h }, fn: () => this.focus(field) });
  }

  /** Live requirement line under a field: ✓ green when satisfied, • grey otherwise. */
  private drawHint(text: string, ok: boolean, x: number, y: number, w: number): void {
    const { h } = this;
    const hint = txt((ok ? '✓ ' : '• ') + text, Math.round(h * 0.019), ok ? C.green : C.mid);
    hint.anchor.set(0, 0); hint.x = x + Math.round(w * 0.02); hint.y = y + Math.round(h * 0.004);
    this.container.addChild(hint);
  }

  private drawSubmitting(): void {
    const { w, h } = this;
    const label = txt(t('auth.loggingIn'), Math.round(h * 0.032), C.dark, true);
    label.anchor.set(0.5, 0.5); label.x = w / 2; label.y = h * 0.45;
    this.container.addChild(label);
    this.spinnerText = label;
  }

  /**
   * Draw a rounded button and register its hit rect.
   *
   * `enabled=false` renders a clearly inert button (pale grey fill, muted text,
   * faded) and ignores taps — so the user can tell at a glance whether it's
   * actionable instead of guessing. Enabled taps grow the button (press pop) and
   * defer the action until the pop ends (see `update`).
   */
  private addButton(
    label: string, x: number, y: number, w: number, h: number,
    fill: number, stroke: number, fn: () => void, textColor = 0xffffff,
    fontSize?: number, enabled = true,
  ): void {
    const f  = enabled ? fill : C.btnDis;
    const st = enabled ? stroke : C.btnOff;
    const tc = enabled ? textColor : C.mid;

    // Build the button centered on its own container so the press pop scales
    // about the middle (not the top-left corner).
    const cont = new PIXI.Container();
    cont.x = x + w / 2; cont.y = y + h / 2;

    const g = sketchPanel(w, h, { fill: f, border: st, width: enabled ? 2 : 1.5, seed: seedFor(x, y, w) });
    g.x = -w / 2; g.y = -h / 2;
    cont.addChild(g);

    const tl = txt(label, fontSize ?? Math.round(h * 0.36), tc, true);
    tl.anchor.set(0.5, 0.5); tl.x = 0; tl.y = 0;
    cont.addChild(tl);

    if (!enabled) cont.alpha = 0.55;

    const key = `${x},${y},${w},${h}`;
    if (enabled && this.press && this.press.key === key) {
      const p = Math.min(1, this.press.t / LoginScene.PRESS_DUR);
      cont.scale.set(1 + LoginScene.PRESS_AMP * Math.sin(Math.PI * p));
    }
    this.container.addChild(cont);

    this.hits.push({
      rect: { x, y, w, h },
      fn: enabled ? () => { this.press = { key, t: 0, fn }; } : () => { /* disabled: inert */ },
    });
  }
}
