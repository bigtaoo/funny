import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, getLocale, setLocale, getSupportedLocales, Locale, TranslationKey } from '../i18n';
import { SketchPen } from '../render/sketch';
import { palette } from '../render/theme';
import { sketchPanel, seedFor, drawLoadingOverlay } from '../render/sketchUi';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { buildAvatar } from '../render/avatar';

// ── SettingsScene — personal profile + settings ────────────────────────────────
//
// Reached from the lobby's top-left profile chip. Canvas-drawn (mirrors ShopScene):
// a render()-on-change tree with a flat hit-list, plus a hidden <input> for the
// rename overlay. Shows the player's avatar + name, a rename action (spends coins,
// online only), a language switcher, and an account action (log in / log out).

const C = {
  bg:     0xf5f0e8,
  paper:  0xfaf6ee,
  dark:   0x2c2c2a,
  mid:    0x888888,
  light:  0xdddddd,
  accent: 0x4477cc,
  gold:   0xcc9900,
  green:  0x4a9e4a,
  red:    0xcc3333,
};

const LOCALE_LABEL: Record<Locale, string> = { zh: '中文', en: 'English', de: 'Deutsch' };

function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return new PIXI.Text(label, {
    fontSize: size, fill: color, fontFamily: 'monospace',
    fontWeight: bold ? 'bold' : 'normal',
  });
}

/** Outcome of a rename attempt — ok with the accepted name, or a message key to toast. */
export type RenameOutcome =
  | { ok: true; name: string }
  | { ok: false; key: TranslationKey };

export interface SettingsSceneCallbacks {
  onBack(): void;
  /** Display name shown next to the avatar. */
  playerName: string;
  /**
   * 9-digit public id — DISPLAY ONLY (player-facing identifier for chat / 投诉).
   * Never used as an identifier anywhere else; all interactions key off the uuid
   * (accountId). Absent → no id line. Shown here, on the profile screen, only.
   */
  publicId?: string;
  /** Ladder standing (logged-in only) for a small rank line under the name. */
  pvp?: { rank: string; elo: number };
  /** SA-4 offline mode — show a login entry instead of logout. */
  offline?: boolean;
  onLogin?(): void;
  onLogout?(): void;
  /** 称号系统（S10）入口；未提供则不显示。 */
  onOpenTitles?(): void;
  // ── rename (online only; absent → no rename UI) ──
  /** Coin cost of a rename; presence enables the rename button. */
  renameCost?: number;
  /** Current server-authoritative coin balance. */
  getCoins?(): number;
  /** Spend coins to change the display name. */
  onRename?(name: string): Promise<RenameOutcome>;
}

interface Hit { rect: Rect; fn: () => void; }

export class SettingsScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: SettingsSceneCallbacks;

  /** Mutable so a successful rename updates the on-screen name without leaving. */
  private playerName: string;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  // Rename overlay state.
  private renameOpen = false;
  private renameText = '';
  private readonly bt = new BusyTracker();
  private caretOn = true;
  private caretTimer = 0;
  private toast: { text: string; color: number } | null = null;
  private hiddenInput: HTMLInputElement | null = null;

  constructor(layout: ILayout, input: InputManager, cb: SettingsSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.playerName = cb.playerName;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.setupHiddenInput();
    this.render();
  }

  update(dt: number): void {
    if (this.renameOpen) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.render(); }
    }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.unsubs.forEach((u) => u());
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
  }

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  // ── Hidden input (rename capture) ────────────────────────────────────────────

  private setupHiddenInput(): void {
    if (typeof document === 'undefined') return; // non-DOM platform
    const el = document.createElement('input');
    el.type = 'text';
    el.maxLength = 24;
    el.autocomplete = 'off';
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('autocorrect', 'off');
    el.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;' +
      'border:0;padding:0;margin:0;font-size:16px;z-index:-1;';
    el.addEventListener('input', () => {
      if (this.renameOpen) { this.renameText = el.value; this.render(); }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this.submitRename(); }
    });
    document.body.appendChild(el);
    this.hiddenInput = el;
  }

  private openRename(): void {
    this.renameOpen = true;
    this.renameText = '';
    this.toast = null;
    this.caretOn = true; this.caretTimer = 0;
    const el = this.hiddenInput;
    if (el) { el.value = ''; el.focus(); }
    this.render();
  }

  private closeRename(): void {
    this.renameOpen = false;
    this.hiddenInput?.blur();
    this.render();
  }

  private async submitRename(): Promise<void> {
    if (this.bt.busy || !this.cb.onRename) return;
    const name = this.renameText.trim();
    if (!name) { this.closeRename(); return; }
    this.renameOpen = false;
    this.hiddenInput?.blur();
    this.bt.start();
    this.render();
    try {
      const res = await withTimeout(this.cb.onRename(name));
      if (res.ok) {
        this.playerName = res.name;
        this.toast = { text: t('settings.renameOk'), color: C.green };
      } else {
        this.toast = { text: t(res.key), color: C.red };
      }
    } catch (e) {
      this.toast = { text: e instanceof TimeoutError ? t('common.networkTimeout') : t('settings.renameFail'), color: C.red };
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private render(): void {
    this.container.removeChildren();
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    this.drawProfile(tbH);
    this.drawLanguage();
    if (this.cb.onOpenTitles) this.drawTitles();
    this.drawAccount();
    if (this.toast) this.drawToast();
    if (this.renameOpen) this.drawRenameOverlay();
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  private drawBackground(): void {
    const { w, h } = this;
    const bg = new PIXI.Graphics();
    bg.beginFill(C.bg); bg.drawRect(0, 0, w, h); bg.endFill();
    const pen = new SketchPen(bg, 0x5bd1c7);
    const lineGap = Math.round(h / 28);
    for (let y = lineGap; y < h; y += lineGap) {
      pen.line(0, y, w, y, { color: palette.ruleLine, width: 1.1, jitter: 0.7, taper: 0.9, double: false });
    }
    const mx = Math.round(w * 0.09);
    pen.line(mx, 0, mx, h, { color: palette.inkRed, width: 2.2, jitter: 1.0, taper: 0.95 });
    this.container.addChild(bg);
  }

  private drawHeader(): number {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);
    const bar = new PIXI.Graphics();
    bar.beginFill(C.dark); bar.drawRect(0, 0, w, tbH); bar.endFill();
    this.container.addChild(bar);

    const title = txt(t('settings.title'), Math.round(h * 0.042), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    const back = txt(t('settings.back'), Math.round(h * 0.026), C.light);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    this.container.addChild(back);
    const pad = Math.round(h * 0.018);
    this.hits.push({
      rect: { x: back.x - pad, y: back.y - back.height / 2 - pad, w: back.width + 2 * pad, h: back.height + 2 * pad },
      fn: () => this.cb.onBack(),
    });

    return tbH;
  }

  private drawProfile(tbH: number): void {
    const { w, h } = this;
    const cardX = Math.round(w * 0.12);
    const cardY = tbH + Math.round(h * 0.05);
    const av = Math.round(h * 0.12);

    const avatar = buildAvatar(av, this.playerName, 21);
    avatar.x = cardX; avatar.y = cardY;
    this.container.addChild(avatar);

    const nameX = cardX + av + Math.round(w * 0.04);
    const hasId = !!this.cb.publicId;
    const hasRank = !this.cb.offline && !!this.cb.pvp;
    // Stack name / #id / rank vertically next to the avatar; top line rises when
    // there are more lines so the block stays vertically centred on the avatar.
    const nameY = cardY + av * (hasId || hasRank ? 0.28 : 0.34);
    const name = txt(this.playerName, Math.round(h * 0.04), C.dark, true);
    name.anchor.set(0, 0.5); name.x = nameX; name.y = nameY;
    this.container.addChild(name);

    if (hasId) {
      // Display-only public id (#123456789); the uuid stays server-internal.
      const idLine = txt(t('settings.playerId', { id: this.cb.publicId! }), Math.round(h * 0.026), C.mid);
      idLine.anchor.set(0, 0.5); idLine.x = nameX; idLine.y = cardY + av * 0.56;
      this.container.addChild(idLine);
    }

    if (hasRank) {
      const pvp = this.cb.pvp!;
      const rankName = t(('rank.' + pvp.rank) as TranslationKey);
      const sub = pvp.rank === 'unranked' ? rankName : `${rankName} · ${pvp.elo}`;
      const rank = txt(sub, Math.round(h * 0.026), C.gold, true);
      rank.anchor.set(0, 0.5); rank.x = nameX; rank.y = cardY + av * (hasId ? 0.82 : 0.68);
      this.container.addChild(rank);
    }

    // Rename button (online only). Shows the coin cost; disabled if balance < cost.
    if (this.cb.onRename && this.cb.renameCost != null) {
      const cost = this.cb.renameCost;
      const coins = this.cb.getCoins?.() ?? 0;
      const affordable = coins >= cost && !this.bt.busy;
      const btnY = cardY + av + Math.round(h * 0.02);
      const label = t('settings.rename', { cost });
      this.addButton(label, btnY, affordable ? C.accent : C.light, affordable ? () => this.openRename() : null, Math.round(w * 0.46));

      const bal = txt(t('settings.coins', { coins }), Math.round(h * 0.022), C.mid);
      bal.anchor.set(0, 0.5); bal.x = cardX; bal.y = btnY + Math.round(h * 0.07) + Math.round(h * 0.022);
      this.container.addChild(bal);
    }
  }

  private drawLanguage(): void {
    const { w, h } = this;
    const secY = Math.round(h * 0.52);
    const label = txt(t('settings.language'), Math.round(h * 0.028), C.dark, true);
    label.anchor.set(0, 0.5); label.x = Math.round(w * 0.12); label.y = secY;
    this.container.addChild(label);

    const locales = getSupportedLocales();
    const btnH = Math.round(h * 0.062);
    const gap  = Math.round(w * 0.03);
    const btnW = Math.round(w * 0.22);
    const startX = Math.round(w * 0.12);
    const btnY = secY + Math.round(h * 0.045);
    const active = getLocale();

    locales.forEach((loc, i) => {
      const bx = startX + i * (btnW + gap);
      const on = loc === active;
      const box = new PIXI.Graphics();
      box.beginFill(on ? C.accent : C.paper);
      box.drawRect(0, 0, btnW, btnH);
      box.endFill();
      new SketchPen(box, 71 + i).rect(2, 2, btnW - 4, btnH - 4, {
        color: on ? C.gold : C.dark, width: on ? 2.8 : 2, jitter: 1.0,
      });
      box.x = bx; box.y = btnY;
      this.container.addChild(box);

      const lbl = txt(LOCALE_LABEL[loc], Math.round(btnH * 0.36), on ? 0xffffff : C.dark, on);
      lbl.anchor.set(0.5, 0.5); lbl.x = bx + btnW / 2; lbl.y = btnY + btnH / 2;
      this.container.addChild(lbl);

      if (!on) {
        this.hits.push({
          rect: { x: bx, y: btnY, w: btnW, h: btnH },
          fn: () => { setLocale(loc); this.render(); },
        });
      }
    });
  }

  private drawTitles(): void {
    const { w, h } = this;
    const secY = Math.round(h * 0.55);
    const label = txt(t('settings.titles'), Math.round(h * 0.028), C.dark, true);
    label.anchor.set(0, 0.5); label.x = Math.round(w * 0.12); label.y = secY;
    this.container.addChild(label);
    this.addButton(t('settings.openTitles'), secY + Math.round(h * 0.045), C.accent, () => this.cb.onOpenTitles!());
  }

  private drawAccount(): void {
    const { w, h } = this;
    const secY = Math.round(h * 0.74);
    const label = txt(t('settings.account'), Math.round(h * 0.028), C.dark, true);
    label.anchor.set(0, 0.5); label.x = Math.round(w * 0.12); label.y = secY;
    this.container.addChild(label);

    if (this.cb.offline) {
      const hint = txt(t('settings.offlineHint'), Math.round(h * 0.022), C.mid);
      hint.anchor.set(0, 0.5); hint.x = Math.round(w * 0.12); hint.y = secY + Math.round(h * 0.045);
      this.container.addChild(hint);
      if (this.cb.onLogin) {
        this.addButton(t('auth.loginEntry'), secY + Math.round(h * 0.09), C.gold, () => this.cb.onLogin!());
      }
    } else if (this.cb.onLogout) {
      this.addButton(t('auth.logout'), secY + Math.round(h * 0.045), C.red, () => this.cb.onLogout!());
    }
  }

  /** A dark button with a hand-drawn border. `fn = null` → disabled (greyed, inert). */
  private addButton(label: string, y: number, border: number, fn: (() => void) | null, width?: number): void {
    const { w, h } = this;
    const btnW = width ?? Math.round(w * 0.5);
    const btnH = Math.round(h * 0.07);
    const bx = Math.round(w * 0.12);
    const enabled = fn !== null;
    const box = new PIXI.Graphics();
    box.beginFill(enabled ? C.dark : 0xbbbbbb);
    box.drawRect(0, 0, btnW, btnH);
    box.endFill();
    box.alpha = enabled ? 1 : 0.6;
    new SketchPen(box, 91).rect(2, 2, btnW - 4, btnH - 4, { color: border, width: 2.6, jitter: 1.0 });
    box.x = bx; box.y = y;
    this.container.addChild(box);

    const lbl = txt(label, Math.round(btnH * 0.34), 0xffffff, true);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + btnW / 2; lbl.y = y + btnH / 2;
    lbl.alpha = enabled ? 1 : 0.6;
    this.container.addChild(lbl);

    if (enabled) this.hits.push({ rect: { x: bx, y, w: btnW, h: btnH }, fn });
  }

  private drawToast(): void {
    const { w, h } = this;
    const to = this.toast!;
    const label = txt(to.text, Math.round(h * 0.026), 0xffffff, true);
    label.anchor.set(0.5, 0.5);
    const padX = Math.round(w * 0.04), padY = Math.round(h * 0.014);
    const boxW = label.width + 2 * padX, boxH = label.height + 2 * padY;
    const bx = (w - boxW) / 2, by = Math.round(h * 0.9);
    const box = sketchPanel(boxW, boxH, { fill: to.color, fillAlpha: 0.95, border: to.color, width: 2, seed: seedFor(boxW, boxH, 4) });
    box.x = bx; box.y = by;
    this.container.addChild(box);
    label.x = w / 2; label.y = by + boxH / 2;
    this.container.addChild(label);
  }

  private drawRenameOverlay(): void {
    const { w, h } = this;
    // Modal: discard the base-scene hits so only the overlay's controls are tappable.
    this.hits = [];

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.7); dim.drawRect(0, 0, w, h); dim.endFill();
    this.container.addChild(dim);

    const pw = Math.round(w * 0.72), ph = Math.round(h * 0.34);
    const px = (w - pw) / 2, py = (h - ph) / 2;
    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, width: 2.4, seed: 33 });
    panel.x = px; panel.y = py;
    this.container.addChild(panel);

    const title = txt(t('settings.renameTitle'), Math.round(h * 0.03), C.dark, true);
    title.anchor.set(0.5, 0); title.x = w / 2; title.y = py + Math.round(h * 0.03);
    this.container.addChild(title);

    // Input box.
    const ibX = px + Math.round(pw * 0.08), ibW = pw - 2 * Math.round(pw * 0.08);
    const ibY = py + Math.round(ph * 0.34), ibH = Math.round(h * 0.06);
    const ib = new PIXI.Graphics();
    ib.beginFill(0xffffff); ib.drawRect(ibX, ibY, ibW, ibH); ib.endFill();
    new SketchPen(ib, 34).rect(ibX + 2, ibY + 2, ibW - 4, ibH - 4, { color: C.accent, width: 2, jitter: 0.8 });
    this.container.addChild(ib);
    // Tapping the field (re)focuses the hidden input on touch devices.
    this.hits.push({ rect: { x: ibX, y: ibY, w: ibW, h: ibH }, fn: () => this.hiddenInput?.focus() });

    const shown = this.renameText + (this.caretOn ? '|' : '');
    const display = this.renameText ? shown : t('settings.renamePlaceholder');
    const field = txt(display, Math.round(ibH * 0.42), this.renameText ? C.dark : C.mid);
    field.anchor.set(0, 0.5); field.x = ibX + Math.round(ibW * 0.04); field.y = ibY + ibH / 2;
    this.container.addChild(field);

    // Confirm / cancel.
    const btnW = Math.round(pw * 0.4), btnH = Math.round(h * 0.06);
    const byy = py + ph - btnH - Math.round(h * 0.03);
    const okX = px + Math.round(pw * 0.08), cancelX = px + pw - Math.round(pw * 0.08) - btnW;

    const okBox = new PIXI.Graphics();
    okBox.beginFill(C.green); okBox.drawRect(okX, byy, btnW, btnH); okBox.endFill();
    this.container.addChild(okBox);
    const okLbl = txt(t('settings.renameConfirm'), Math.round(btnH * 0.36), 0xffffff, true);
    okLbl.anchor.set(0.5, 0.5); okLbl.x = okX + btnW / 2; okLbl.y = byy + btnH / 2;
    this.container.addChild(okLbl);
    this.hits.push({ rect: { x: okX, y: byy, w: btnW, h: btnH }, fn: () => void this.submitRename() });

    const cBox = new PIXI.Graphics();
    cBox.beginFill(C.mid); cBox.drawRect(cancelX, byy, btnW, btnH); cBox.endFill();
    this.container.addChild(cBox);
    const cLbl = txt(t('settings.renameCancel'), Math.round(btnH * 0.36), 0xffffff, true);
    cLbl.anchor.set(0.5, 0.5); cLbl.x = cancelX + btnW / 2; cLbl.y = byy + btnH / 2;
    this.container.addChild(cLbl);
    this.hits.push({ rect: { x: cancelX, y: byy, w: btnW, h: btnH }, fn: () => this.closeRename() });

    // Tap anywhere outside the panel/buttons closes the overlay — registered LAST so the
    // specific button hits above take priority (handleDown is first-match-wins).
    this.hits.push({ rect: { x: 0, y: 0, w, h }, fn: () => this.closeRename() });
  }
}
