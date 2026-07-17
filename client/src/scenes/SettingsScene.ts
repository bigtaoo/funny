import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, getLocale, setLocale, getSupportedLocales, Locale, TranslationKey } from '../i18n';
import { SketchPen } from '../render/sketch';
import { palette } from '../render/theme';
import { sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren, ui as C } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { caretDisplay } from '../render/inputDisplay';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { buildAvatar, AVATAR_COUNT } from '../render/avatar';
import { FS, snapFont } from '../render/fontScale';

// ── SettingsScene — personal profile + settings ────────────────────────────────
//
// Reached from the lobby's top-left profile chip. Canvas-drawn (mirrors ShopScene):
// a render()-on-change tree with a flat hit-list, plus a hidden <input> for the
// rename overlay. Shows the player's avatar + name, a rename action (spends coins,
// online only), a language switcher, and an account action (log in / log out).

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
   * 9-digit public id — DISPLAY ONLY (player-facing identifier for chat / reports).
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
  /**
   * Delete account (C5-b, Apple 5.1.1(v)). Only available when logged in online; called after a second confirmation.
   * On success, core clears local state and jumps to the login page, so no navigation return value is needed —
   * on failure returns ok:false to trigger a toast.
   */
  onDeleteAccount?(): Promise<{ ok: boolean }>;
  /** Replay the onboarding tutorial (ONBOARDING_DESIGN §3.4); absent = not shown. */
  onReplayTutorial?(): void;
  /** Currently selected avatar token ('0'-'7'); absent = letter-initial fallback. */
  avatarId?: string;
  /** Called when the player picks a new avatar; absent = picker is read-only. */
  onSetAvatar?(id: string): void;
  // ── rename (online only; absent → no rename UI) ──
  /** Coin cost of a rename; presence enables the rename button. */
  renameCost?: number;
  /**
   * True when the player still holds their one-time free rename (their current name is a system-assigned
   * default they never chose). While true the rename button is free and always enabled regardless of balance.
   */
  freeRename?: boolean;
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
  /** Mutable: tracks the locally-selected avatar so the picker re-renders immediately. */
  private currentAvatarId: string | undefined;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() against any late (caret/async) re-render into a torn-down container. */
  private destroyed = false;

  // Rename overlay state.
  private renameOpen = false;
  private renameText = '';
  /** Avatar picker overlay — opened by tapping the profile avatar. */
  private avatarPickerOpen = false;
  /** Delete-account confirmation overlay (C5-b). */
  private deleteConfirmOpen = false;
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
    this.currentAvatarId = cb.avatarId;
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
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    this.container.destroy({ children: true });
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
    if (this.destroyed) return;
    tearDownChildren(this.container); // caret blink (~2×/s) + per-keystroke rename field → free Text textures
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    this.drawProfile(tbH);
    this.drawLanguage();
    if (this.cb.onReplayTutorial) this.drawHelp();
    this.drawAccount();
    if (this.toast) this.drawToast();
    if (this.avatarPickerOpen) this.drawAvatarPickerOverlay();
    if (this.renameOpen) this.drawRenameOverlay();
    if (this.deleteConfirmOpen) this.drawDeleteConfirm();
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
    const hdr = drawSceneHeader(this.container, w, h, t('settings.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    return tbH;
  }

  private drawProfile(tbH: number): void {
    const { w, h } = this;
    const cardX = Math.round(w * 0.12);
    const cardY = tbH + Math.round(h * 0.05);
    const av = Math.round(h * 0.12);

    const avatar = buildAvatar(av, this.playerName, 21, this.currentAvatarId);
    avatar.x = cardX; avatar.y = cardY;
    this.container.addChild(avatar);

    // Tapping the avatar opens the picker. A small pencil badge hints it's editable;
    // only shown when picking is enabled (onSetAvatar present).
    if (this.cb.onSetAvatar) {
      const badgeR = Math.round(av * 0.16);
      const bcx = cardX + av - badgeR, bcy = cardY + av - badgeR;
      const badge = new PIXI.Graphics();
      badge.beginFill(C.accent); badge.drawCircle(bcx, bcy, badgeR); badge.endFill();
      this.container.addChild(badge);
      const pencil = txt('✎', snapFont(Math.round(badgeR * 1.4)), 0xffffff, true);
      pencil.anchor.set(0.5, 0.5); pencil.x = bcx; pencil.y = bcy;
      this.container.addChild(pencil);
      this.hits.push({ rect: { x: cardX, y: cardY, w: av, h: av }, fn: () => this.openAvatarPicker() });
    }

    const nameX = cardX + av + Math.round(w * 0.04);
    const hasId = !!this.cb.publicId;
    const hasRank = !this.cb.offline && !!this.cb.pvp;
    // Stack name / #id / rank vertically next to the avatar; top line rises when
    // there are more lines so the block stays vertically centred on the avatar.
    const nameY = cardY + av * (hasId || hasRank ? 0.28 : 0.34);
    const name = txt(this.playerName, FS.headline, C.dark, true);
    name.anchor.set(0, 0.5); name.x = nameX; name.y = nameY;
    this.container.addChild(name);

    if (hasId) {
      // Display-only public id (#123456789); the uuid stays server-internal.
      const idLine = txt(t('settings.playerId', { id: this.cb.publicId! }), FS.heading, C.mid);
      idLine.anchor.set(0, 0.5); idLine.x = nameX; idLine.y = cardY + av * 0.56;
      this.container.addChild(idLine);
    }

    if (hasRank) {
      const pvp = this.cb.pvp!;
      const rankName = t(('rank.' + pvp.rank) as TranslationKey);
      const sub = pvp.rank === 'unranked' ? rankName : `${rankName} · ${pvp.elo}`;
      const rank = txt(sub, FS.heading, C.gold, true);
      rank.anchor.set(0, 0.5); rank.x = nameX; rank.y = cardY + av * (hasId ? 0.82 : 0.68);
      this.container.addChild(rank);
    }

    // Rename button (online only). Free first rename for players who never chose a name; otherwise
    // shows the coin cost and is disabled if the balance is short.
    if (this.cb.onRename && this.cb.renameCost != null) {
      const cost = this.cb.renameCost;
      const free = this.cb.freeRename === true;
      const coins = this.cb.getCoins?.() ?? 0;
      const enabled = (free || coins >= cost) && !this.bt.busy;
      const btnY = cardY + av + Math.round(h * 0.02);
      const label = free ? t('settings.renameFree') : t('settings.rename', { cost });
      this.addButton(label, btnY, enabled ? C.accent : C.light, enabled ? () => this.openRename() : null, Math.round(w * 0.46));

      // Free rename: show a hint instead of the balance line.
      const sub = free ? t('settings.renameFreeHint') : t('settings.coins', { coins });
      const bal = txt(sub, FS.label, C.mid);
      bal.anchor.set(0, 0.5); bal.x = cardX; bal.y = btnY + Math.round(h * 0.07) + Math.round(h * 0.022);
      this.container.addChild(bal);
    }
  }

  private openAvatarPicker(): void {
    this.avatarPickerOpen = true;
    this.toast = null;
    this.render();
  }

  private closeAvatarPicker(): void {
    this.avatarPickerOpen = false;
    this.render();
  }

  /** Modal avatar picker — a 2×4 grid of tokens (0-7) inside a sketch panel. */
  private drawAvatarPickerOverlay(): void {
    const { w, h } = this;
    // Modal: discard base-scene hits so only the overlay's controls are tappable.
    this.hits = [];

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.7); dim.drawRect(0, 0, w, h); dim.endFill();
    this.container.addChild(dim);

    const pw = Math.round(w * 0.8), ph = Math.round(h * 0.52);
    const px = (w - pw) / 2, py = (h - ph) / 2;
    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, width: 2.4, seed: 42 });
    panel.x = px; panel.y = py;
    this.container.addChild(panel);

    const title = txt(t('settings.avatar'), FS.title, C.dark, true);
    title.anchor.set(0.5, 0); title.x = w / 2; title.y = py + Math.round(h * 0.03);
    this.container.addChild(title);

    // 2 rows of 4 avatars, centred in the panel.
    const cols = 4;
    const avS = Math.round(h * 0.09);
    const gridW = Math.round(pw * 0.82);
    const gap = Math.round((gridW - cols * avS) / (cols - 1));
    const rowGap = Math.round(h * 0.03);
    const gridX = px + Math.round((pw - gridW) / 2);
    const gridY = py + Math.round(ph * 0.24);

    for (let i = 0; i < AVATAR_COUNT; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const ax = gridX + col * (avS + gap);
      const ay = gridY + row * (avS + rowGap);
      const id = String(i);
      const selected = this.currentAvatarId === id;

      // Selection ring drawn behind the avatar.
      if (selected) {
        const ring = new PIXI.Graphics();
        ring.lineStyle(Math.max(2, Math.round(avS * 0.07)), C.gold, 1);
        ring.drawCircle(ax + avS / 2, ay + avS / 2, avS / 2 + Math.round(avS * 0.06));
        this.container.addChild(ring);
      }

      const av = buildAvatar(avS, '', 10 + i, id);
      av.x = ax; av.y = ay;
      av.alpha = (!this.cb.onSetAvatar) ? 0.75 : (selected ? 1.0 : 0.82);
      this.container.addChild(av);

      if (this.cb.onSetAvatar && !selected) {
        this.hits.push({
          rect: { x: ax, y: ay, w: avS, h: avS },
          fn: () => {
            this.currentAvatarId = id;
            this.cb.onSetAvatar!(id);
            this.closeAvatarPicker(); // pick + dismiss
          },
        });
      }
    }

    // Close button.
    const btnW = Math.round(pw * 0.5), btnH = Math.round(h * 0.06);
    const bxx = px + (pw - btnW) / 2, byy = py + ph - btnH - Math.round(h * 0.03);
    const cBox = new PIXI.Graphics();
    cBox.beginFill(C.dark); cBox.drawRect(bxx, byy, btnW, btnH); cBox.endFill();
    this.container.addChild(cBox);
    const cLbl = txt(t('common.close'), snapFont(Math.round(btnH * 0.36)), 0xffffff, true);
    cLbl.anchor.set(0.5, 0.5); cLbl.x = bxx + btnW / 2; cLbl.y = byy + btnH / 2;
    this.container.addChild(cLbl);
    this.hits.push({ rect: { x: bxx, y: byy, w: btnW, h: btnH }, fn: () => this.closeAvatarPicker() });

    // Tap outside panel = close (registered last so specific hits win — first-match-wins).
    this.hits.push({ rect: { x: 0, y: 0, w, h }, fn: () => this.closeAvatarPicker() });
  }

  private drawLanguage(): void {
    const { w, h } = this;
    const secY = Math.round(h * 0.48);
    const label = txt(t('settings.language'), FS.title, C.dark, true);
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

      const lbl = txt(LOCALE_LABEL[loc], snapFont(Math.round(btnH * 0.36)), on ? 0xffffff : C.dark, on);
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

  // Help (left) and Account (right) sit side by side on the same row so the
  // help block no longer pushes account down when the tutorial replay is shown.
  private drawHelp(): void {
    const { w, h } = this;
    const secY = Math.round(h * 0.73);
    const x = Math.round(w * 0.56);
    const label = txt(t('settings.help'), FS.title, C.dark, true);
    label.anchor.set(0, 0.5); label.x = x; label.y = secY;
    this.container.addChild(label);
    this.addButton(t('settings.replayTutorial'), secY + Math.round(h * 0.045), C.accent, () => this.cb.onReplayTutorial!(), Math.round(w * 0.4), x);
  }

  private drawAccount(): void {
    const { w, h } = this;
    const secY = Math.round(h * 0.73);
    const x = Math.round(w * 0.12);
    const btnW = Math.round(w * 0.4);
    const label = txt(t('settings.account'), FS.title, C.dark, true);
    label.anchor.set(0, 0.5); label.x = x; label.y = secY;
    this.container.addChild(label);

    if (this.cb.offline) {
      const hint = txt(t('settings.offlineHint'), FS.label, C.mid);
      hint.anchor.set(0, 0.5); hint.x = x; hint.y = secY + Math.round(h * 0.045);
      this.container.addChild(hint);
      if (this.cb.onLogin) {
        this.addButton(t('auth.loginEntry'), secY + Math.round(h * 0.09), C.gold, () => this.cb.onLogin!(), btnW, x);
      }
    } else if (this.cb.onLogout) {
      this.addButton(t('auth.logout'), secY + Math.round(h * 0.045), C.dark, () => this.cb.onLogout!(), btnW, x);
      // Account deletion (C5-b, Apple 5.1.1(v)) — danger entry below logout, online only.
      if (this.cb.onDeleteAccount) {
        this.addButton(t('settings.deleteAccount'), secY + Math.round(h * 0.125), C.red, () => this.openDelete(), btnW, x);
      }
    }
  }

  private openDelete(): void {
    this.deleteConfirmOpen = true;
    this.toast = null;
    this.render();
  }

  private closeDelete(): void {
    this.deleteConfirmOpen = false;
    this.render();
  }

  private async submitDelete(): Promise<void> {
    if (this.bt.busy || !this.cb.onDeleteAccount) return;
    this.deleteConfirmOpen = false;
    this.bt.start();
    this.render();
    try {
      const res = await withTimeout(this.cb.onDeleteAccount());
      // On success the core navigates to the login screen (this scene is torn down);
      // only a failure path returns here visibly.
      if (!res.ok) this.toast = { text: t('settings.deleteAccount.failed'), color: C.red };
    } catch (e) {
      this.toast = { text: e instanceof TimeoutError ? t('common.networkTimeout') : t('settings.deleteAccount.failed'), color: C.red };
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  private drawDeleteConfirm(): void {
    const { w, h } = this;
    // Modal: discard base-scene hits so only the overlay's controls are tappable.
    this.hits = [];

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.7); dim.drawRect(0, 0, w, h); dim.endFill();
    this.container.addChild(dim);

    const pw = Math.round(w * 0.78), ph = Math.round(h * 0.36);
    const px = (w - pw) / 2, py = (h - ph) / 2;
    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.red, width: 2.6, seed: 37 });
    panel.x = px; panel.y = py;
    this.container.addChild(panel);

    const title = txt(t('settings.deleteAccount.confirmTitle'), FS.title, C.red, true);
    title.anchor.set(0.5, 0); title.x = w / 2; title.y = py + Math.round(h * 0.03);
    this.container.addChild(title);

    const body = new PIXI.Text(t('settings.deleteAccount.confirmBody'), {
      fontSize: FS.heading, fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: pw * 0.86, align: 'center', lineHeight: Math.round(h * 0.036),
    });
    body.anchor.set(0.5, 0); body.x = w / 2; body.y = py + Math.round(ph * 0.26);
    this.container.addChild(body);

    // Confirm (danger) / cancel.
    const btnW = Math.round(pw * 0.4), btnH = Math.round(h * 0.06);
    const byy = py + ph - btnH - Math.round(h * 0.03);
    const delX = px + Math.round(pw * 0.08), cancelX = px + pw - Math.round(pw * 0.08) - btnW;

    const delBox = new PIXI.Graphics();
    delBox.beginFill(C.red); delBox.drawRect(delX, byy, btnW, btnH); delBox.endFill();
    this.container.addChild(delBox);
    const delLbl = txt(t('settings.deleteAccount.confirm'), snapFont(Math.round(btnH * 0.32)), 0xffffff, true);
    delLbl.anchor.set(0.5, 0.5); delLbl.x = delX + btnW / 2; delLbl.y = byy + btnH / 2;
    this.container.addChild(delLbl);
    this.hits.push({ rect: { x: delX, y: byy, w: btnW, h: btnH }, fn: () => void this.submitDelete() });

    const cBox = new PIXI.Graphics();
    cBox.beginFill(C.mid); cBox.drawRect(cancelX, byy, btnW, btnH); cBox.endFill();
    this.container.addChild(cBox);
    const cLbl = txt(t('settings.deleteAccount.cancel'), snapFont(Math.round(btnH * 0.36)), 0xffffff, true);
    cLbl.anchor.set(0.5, 0.5); cLbl.x = cancelX + btnW / 2; cLbl.y = byy + btnH / 2;
    this.container.addChild(cLbl);
    this.hits.push({ rect: { x: cancelX, y: byy, w: btnW, h: btnH }, fn: () => this.closeDelete() });

    // Tap outside panel = cancel (registered last so the buttons win — first-match-wins).
    this.hits.push({ rect: { x: 0, y: 0, w, h }, fn: () => this.closeDelete() });
  }

  /** A dark button with a hand-drawn border. `fn = null` → disabled (greyed, inert). */
  private addButton(label: string, y: number, border: number, fn: (() => void) | null, width?: number, x?: number): void {
    const { w, h } = this;
    const btnW = width ?? Math.round(w * 0.5);
    const btnH = Math.round(h * 0.07);
    const bx = x ?? Math.round(w * 0.12);
    const enabled = fn !== null;
    const box = new PIXI.Graphics();
    box.beginFill(enabled ? C.dark : 0xbbbbbb);
    box.drawRect(0, 0, btnW, btnH);
    box.endFill();
    box.alpha = enabled ? 1 : 0.6;
    new SketchPen(box, 91).rect(2, 2, btnW - 4, btnH - 4, { color: border, width: 2.6, jitter: 1.0 });
    box.x = bx; box.y = y;
    this.container.addChild(box);

    const lbl = txt(label, snapFont(Math.round(btnH * 0.34)), 0xffffff, true);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + btnW / 2; lbl.y = y + btnH / 2;
    lbl.alpha = enabled ? 1 : 0.6;
    this.container.addChild(lbl);

    if (enabled) this.hits.push({ rect: { x: bx, y, w: btnW, h: btnH }, fn });
  }

  private drawToast(): void {
    const { w, h } = this;
    const to = this.toast!;
    const label = txt(to.text, FS.heading, 0xffffff, true);
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

    const title = txt(t('settings.renameTitle'), FS.title, C.dark, true);
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

    const display = caretDisplay(this.renameText, this.caretOn, t('settings.renamePlaceholder'));
    const field = txt(display, snapFont(Math.round(ibH * 0.42)), (this.renameText || this.caretOn) ? C.dark : C.mid);
    field.anchor.set(0, 0.5); field.x = ibX + Math.round(ibW * 0.04); field.y = ibY + ibH / 2;
    this.container.addChild(field);

    // Confirm / cancel.
    const btnW = Math.round(pw * 0.4), btnH = Math.round(h * 0.06);
    const byy = py + ph - btnH - Math.round(h * 0.03);
    const okX = px + Math.round(pw * 0.08), cancelX = px + pw - Math.round(pw * 0.08) - btnW;

    const okBox = new PIXI.Graphics();
    okBox.beginFill(C.green); okBox.drawRect(okX, byy, btnW, btnH); okBox.endFill();
    this.container.addChild(okBox);
    const okLbl = txt(t('settings.renameConfirm'), snapFont(Math.round(btnH * 0.36)), 0xffffff, true);
    okLbl.anchor.set(0.5, 0.5); okLbl.x = okX + btnW / 2; okLbl.y = byy + btnH / 2;
    this.container.addChild(okLbl);
    this.hits.push({ rect: { x: okX, y: byy, w: btnW, h: btnH }, fn: () => void this.submitRename() });

    const cBox = new PIXI.Graphics();
    cBox.beginFill(C.mid); cBox.drawRect(cancelX, byy, btnW, btnH); cBox.endFill();
    this.container.addChild(cBox);
    const cLbl = txt(t('settings.renameCancel'), snapFont(Math.round(btnH * 0.36)), 0xffffff, true);
    cLbl.anchor.set(0.5, 0.5); cLbl.x = cancelX + btnW / 2; cLbl.y = byy + btnH / 2;
    this.container.addChild(cLbl);
    this.hits.push({ rect: { x: cancelX, y: byy, w: btnW, h: btnH }, fn: () => this.closeRename() });

    // Tap anywhere outside the panel/buttons closes the overlay — registered LAST so the
    // specific button hits above take priority (handleDown is first-match-wins).
    this.hits.push({ rect: { x: 0, y: 0, w, h }, fn: () => this.closeRename() });
  }
}
