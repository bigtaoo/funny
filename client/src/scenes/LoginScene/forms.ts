// LoginScene's landing/form/submitting views + the shared field/hint/button drawers, extracted as
// form① free functions (claudedocs/client-modules.md "单文件 500 行收敛"). `press`/`spinnerText`
// are exposed as getter/setter pairs (not plain properties) because addButton/drawSubmitting
// reassign them wholesale — a plain copied property would only rebind this throwaway host object,
// never reaching back to the scene's own field (same reasoning as RoomScene/views.ts's RoomViewHost).
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { FS, snapFont } from '../../render/fontScale';
import { MIN_PASSWORD_LEN, MIN_LOGIN_ID_LEN, type LoginSceneCallbacks, type Field, type View } from './types';
import type { Hit } from '../../ui/hits';

/** Quick tap-grow-then-fire press animation, shared by every button this scene draws.
 *  PRESS_DUR is also read by LoginScene.update() to know when to fire the deferred action. */
export const PRESS_DUR = 0.12; // seconds — quick tap-grow before the action fires
const PRESS_AMP = 0.12; // peak scale-up (1.0 → 1.12 → 1.0)

export interface FormHost {
  readonly container: PIXI.Container;
  readonly w: number;
  readonly h: number;
  readonly cb: LoginSceneCallbacks;
  readonly fields: Record<Field, string>;
  readonly focused: Field | null;
  readonly caretOn: boolean;
  readonly errorKey: TranslationKey | null;
  readonly errorDetail: string | null;
  hits: Hit[];
  press: { key: string; t: number; fn: () => void } | null;
  spinnerText: PIXI.Text | null;
  goView(v: View): void;
  onSubmit(): void;
  focus(field: Field): void;
}

export function drawLanding(host: FormHost): void {
  const { w, h } = host;
  const btnW = Math.round(w * 0.66);
  const btnH = Math.round(h * 0.10);
  const btnX = (w - btnW) / 2;
  const gap = Math.round(h * 0.035);
  const y0 = Math.round(h * 0.28);

  addButton(host, t('auth.login'), btnX, y0, btnW, btnH, C.dark, C.accent, () => host.goView('password'));
  addButton(host, t('auth.register'), btnX, y0 + btnH + gap, btnW, btnH, C.dark, C.gold, () => host.goView('register'));

  // Single-player entry — visually secondary (paper fill).
  const offY = y0 + 2 * (btnH + gap) + Math.round(h * 0.02);
  addButton(host, t('auth.playOffline'), btnX, offY, btnW, btnH, C.paper, C.green,
    () => host.cb.onPlayOffline(), C.dark);

  // Wrap within the design width so long locales (EN/DE run wider than the 1080
  // design width in monospace) stay on-screen instead of clipping both edges.
  const hint = txt(t('auth.offlineHint'), FS.label, C.mid, false, Math.round(w * 0.86));
  hint.style.align = 'center';
  hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = offY + btnH + Math.round(h * 0.012);
  host.container.addChild(hint);
}

/**
 * Whether the submit button should be enabled. Mirrors the validation in
 * LoginScene.onSubmit so the button's enabled look and the actual gate never disagree.
 * Login only needs both fields non-empty; register enforces the full rules.
 */
function submitEnabled(fields: Record<Field, string>, isRegister: boolean): boolean {
  const loginId = fields.loginId.trim();
  const pw = fields.password;
  if (!isRegister) return loginId.length > 0 && pw.length > 0;
  return (
    loginId.length >= MIN_LOGIN_ID_LEN &&
    pw.length >= MIN_PASSWORD_LEN &&
    fields.confirmPassword.length > 0 &&
    pw === fields.confirmPassword
  );
}

export function drawForm(host: FormHost, isRegister: boolean): void {
  const { w, h, fields } = host;
  const fieldW = Math.round(w * 0.78);
  const fieldH = Math.round(h * 0.072);
  const fieldX = (w - fieldW) / 2;
  const gap = Math.round(h * 0.028);
  const hintH = Math.round(h * 0.026);
  // Register stacks more fields + live hints → start higher to keep it on-screen.
  let y = Math.round(h * (isRegister ? 0.16 : 0.22));

  const pw = fields.password;
  const cpw = fields.confirmPassword;

  drawField(host, 'loginId', t('auth.loginIdLabel'), fieldX, y, fieldW, fieldH, false);
  y += fieldH;
  if (isRegister) {
    drawHint(host, t('auth.hint.loginId'), fields.loginId.trim().length >= MIN_LOGIN_ID_LEN, fieldX, y, fieldW);
    y += hintH;
  }
  y += gap;

  drawField(host, 'password', t('auth.passwordLabel'), fieldX, y, fieldW, fieldH, true);
  y += fieldH;
  if (isRegister) {
    drawHint(host, t('auth.hint.password'), pw.length >= MIN_PASSWORD_LEN, fieldX, y, fieldW);
    y += hintH;
  }
  y += gap;

  if (isRegister) {
    drawField(host, 'confirmPassword', t('auth.confirmPasswordLabel'), fieldX, y, fieldW, fieldH, true);
    y += fieldH;
    drawHint(host, t('auth.hint.match'), cpw.length > 0 && pw === cpw, fieldX, y, fieldW);
    y += hintH + gap;
    drawField(host, 'displayName', t('auth.displayNameLabel'), fieldX, y, fieldW, fieldH, false);
    y += fieldH + gap;
  }

  // Error line (+ raw detail beneath, for diagnosis).
  if (host.errorKey) {
    const errLbl = txt(t(host.errorKey), FS.label, C.red, true);
    errLbl.anchor.set(0.5, 0.5); errLbl.x = w / 2; errLbl.y = y + Math.round(h * 0.005);
    host.container.addChild(errLbl);
    if (host.errorDetail) {
      const det = txt(host.errorDetail, FS.body, C.mid);
      det.anchor.set(0.5, 0); det.x = w / 2; det.y = y + Math.round(h * 0.02);
      det.style.wordWrap = true; det.style.wordWrapWidth = fieldW; det.style.align = 'center';
      host.container.addChild(det);
      y += Math.round(h * 0.03);
    }
  }
  y += Math.round(h * 0.04);

  // Submit — enabled only when the form would actually pass validation, so its
  // appearance (vivid vs. faded-grey) tells the user at a glance if it's ready.
  addButton(
    host,
    isRegister ? t('auth.submitRegister') : t('auth.submitLogin'),
    fieldX, y, fieldW, Math.round(h * 0.092),
    C.dark, isRegister ? C.gold : C.accent, () => host.onSubmit(),
    0xffffff, undefined, submitEnabled(fields, isRegister),
  );
  y += Math.round(h * 0.092) + Math.round(h * 0.03);

  // Switch login/register.
  const swap = txt(isRegister ? t('auth.toLogin') : t('auth.toRegister'), FS.heading, C.accent, true);
  swap.anchor.set(0.5, 0.5); swap.x = w / 2; swap.y = y;
  host.container.addChild(swap);
  const sp = Math.round(h * 0.02);
  host.hits.push({
    rect: { x: w / 2 - swap.width / 2 - sp, y: y - swap.height / 2 - sp, w: swap.width + 2 * sp, h: swap.height + 2 * sp },
    fn: () => host.goView(isRegister ? 'password' : 'register'),
  });
}

function drawField(
  host: FormHost, field: Field, label: string, x: number, y: number, w: number, h: number, masked: boolean,
): void {
  const value = host.fields[field];
  const isFocused = host.focused === field;

  // Label above the box.
  const lbl = txt(label, snapFont(Math.round(h * 0.30)), C.mid);
  lbl.anchor.set(0, 1); lbl.x = x; lbl.y = y - Math.round(h * 0.08);
  host.container.addChild(lbl);

  const box = sketchPanel(w, h, { fill: C.paper, border: isFocused ? C.accent : C.line, width: 2, seed: seedFor(x, y, w) });
  box.x = x; box.y = y;
  host.container.addChild(box);

  const shown = masked ? '•'.repeat(value.length) : value;
  const display = shown + (isFocused && host.caretOn ? '|' : '');
  const placeholder = value.length === 0 && !isFocused;
  const valTxt = txt(placeholder ? t('auth.tapToType') : display, snapFont(Math.round(h * 0.40)),
    placeholder ? C.light : C.dark);
  valTxt.anchor.set(0, 0.5); valTxt.x = x + Math.round(w * 0.04); valTxt.y = y + h / 2;
  host.container.addChild(valTxt);

  host.hits.push({ rect: { x, y, w, h }, fn: () => host.focus(field) });
}

/** Live requirement line under a field: ✓ green when satisfied, • grey otherwise. */
function drawHint(host: FormHost, text: string, ok: boolean, x: number, y: number, w: number): void {
  const { h } = host;
  const fs = FS.bodyLg;
  const baseX = x + Math.round(w * 0.02);
  const ty = y + Math.round(h * 0.004);
  if (ok) {
    // Satisfied: a hand-drawn green check glyph (replaces the ✓ prefix).
    const ck = buildIcon('check', fs, C.green);
    ck.x = baseX; ck.y = ty;
    host.container.addChild(ck);
    const hint = txt(text, fs, C.green);
    hint.anchor.set(0, 0); hint.x = baseX + fs + 3; hint.y = ty;
    host.container.addChild(hint);
  } else {
    const hint = txt('• ' + text, fs, C.mid);
    hint.anchor.set(0, 0); hint.x = baseX; hint.y = ty;
    host.container.addChild(hint);
  }
}

export function drawSubmitting(host: FormHost): void {
  const { w, h } = host;
  const label = txt(t('auth.loggingIn'), FS.title, C.dark, true);
  label.anchor.set(0.5, 0.5); label.x = w / 2; label.y = h * 0.45;
  host.container.addChild(label);
  host.spinnerText = label;
}

/**
 * Draw a rounded button and register its hit rect.
 *
 * `enabled=false` renders a clearly inert button (pale grey fill, muted text,
 * faded) and ignores taps — so the user can tell at a glance whether it's
 * actionable instead of guessing. Enabled taps grow the button (press pop) and
 * defer the action until the pop ends (see LoginScene.update).
 */
export function addButton(
  host: FormHost,
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

  const tl = txt(label, snapFont(fontSize ?? Math.round(h * 0.36)), tc, true);
  tl.anchor.set(0.5, 0.5); tl.x = 0; tl.y = 0;
  cont.addChild(tl);

  if (!enabled) cont.alpha = 0.55;

  const key = `${x},${y},${w},${h}`;
  if (enabled && host.press && host.press.key === key) {
    const p = Math.min(1, host.press.t / PRESS_DUR);
    cont.scale.set(1 + PRESS_AMP * Math.sin(Math.PI * p));
  }
  host.container.addChild(cont);

  host.hits.push({
    rect: { x, y, w, h },
    fn: enabled ? () => { host.press = { key, t: 0, fn }; } : () => { /* disabled: inert */ },
  });
}
