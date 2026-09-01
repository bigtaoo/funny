import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { SketchPen } from '../render/sketch';
import { palette } from '../render/theme';
import { drawLoadingOverlay, tearDownChildren, ui as C } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { showToastMessage } from '../net/log';
import type { AvatarCategory } from '../render/avatar';
import { ScrollTapGesture } from '../ui/scrollTapGesture';
import { wheelScrollY } from '../ui/wheelScroll';
import type { SettingsSceneCallbacks } from './SettingsScene/types';
import { dispatchHit, hitAction, hitTest, inRect, type Hit } from '../ui/hits';
import { drawProfile, drawLanguage, drawDataSaver, drawHelp, drawAccount, type PanelHost } from './SettingsScene/panels';
import { drawAvatarPickerOverlay, type PickerHost } from './SettingsScene/avatarPicker';
import { drawRenameOverlay, drawDeleteConfirm, type OverlayHost } from './SettingsScene/overlays';
import { drawAudio, type AudioPanelHost, type AudioSlider } from './SettingsScene/audioPanel';

export type { SettingsSceneCallbacks, RenameOutcome } from './SettingsScene/types';

// ── SettingsScene — personal profile + settings ────────────────────────────────
//
// Reached from the lobby's top-left profile chip. Canvas-drawn (mirrors ShopScene):
// a render()-on-change tree with a flat hit-list, plus a hidden <input> for the
// rename overlay. Shows the player's avatar + name, a rename action (spends coins,
// online only), a language switcher, and an account action (log in / log out).
//
// 2026-08-13: the avatar-picker modal, rename/delete overlays, and profile/language/help/account
// panels were pulled out into SettingsScene/{avatarPicker,overlays,panels}.ts as form① free
// functions (claudedocs/client-modules.md "单文件 500 行收敛") — this file kept scene lifecycle,
// input routing, and the open/close/submit state transitions those modules call back into. The
// fields those modules touch went `private` → `public` (same visibility bump every mixin→
// composition/form① conversion in this codebase has needed — a `private` field can't satisfy an
// external module's structural interface).

export class SettingsScene implements Scene {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly cb: SettingsSceneCallbacks;

  /** Mutable so a successful rename updates the on-screen name without leaving. */
  playerName: string;
  /** Mutable: tracks the locally-selected avatar so the picker re-renders immediately. */
  currentAvatarId: string | undefined;

  hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() against any late (caret/async) re-render into a torn-down container. */
  private destroyed = false;

  // Rename overlay state.
  private renameOpen = false;
  renameText = '';
  /** Avatar picker overlay — opened by tapping the profile avatar. */
  private avatarPickerOpen = false;
  /** Active picker tab + its scroll offset (each tab keeps its own scroll — switching tabs resets to 0). */
  pickerTab: AvatarCategory = 'preset';
  pickerScrollY = 0;
  pickerMaxScroll = 0;
  /** Grid viewport + per-cell hit list for the current picker render — read by handleDown/Move for drag-scroll vs tap. */
  pickerViewRect: Rect | null = null;
  pickerCellHits: Hit[] = [];
  private readonly pickerGesture = new ScrollTapGesture();
  /**
   * Volume-slider drag zones (audioPanel.ts). Separate from `hits` because a slider must track the
   * pointer live instead of firing once — see CardScene's modalSliders for the same split.
   */
  audioSliders: AudioSlider[] = [];
  /** The slider currently being dragged (set on a press inside one of the rects above), or null. */
  private activeAudioSlider: AudioSlider | null = null;
  /** Set by a slider drag; update() turns it into at most ONE render per frame (a render() per
   *  pointer-move rebuilds the whole scene tree and janks — the scroll-drag-throttle pattern). */
  private audioDirty = false;
  /** Transient "why is this locked" hint shown under the grid; cleared after a couple seconds. */
  toastMsg: string | null = null;
  toastTimer = 0;
  /** Delete-account confirmation overlay (C5-b). */
  private deleteConfirmOpen = false;
  private readonly bt = new BusyTracker();
  caretOn = true;
  private caretTimer = 0;
  hiddenInput: HTMLInputElement | null = null;

  get busy(): boolean { return this.bt.busy; }

  constructor(layout: ILayout, input: InputManager, cb: SettingsSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.playerName = cb.playerName;
    this.currentAvatarId = cb.avatarId;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => { this.handleAudioMove(x); this.handlePickerMove(y); }));
    this.unsubs.push(input.onUp(() => {
      // Release the slider BEFORE clearing it: the panel hangs its audition cue off onRelease so
      // that "does letting go make a sound" stays a decision in audioPanel.ts (see there).
      this.activeAudioSlider?.onRelease?.();
      this.activeAudioSlider = null;
      this.handlePickerUp();
    }));
    // Avatar picker grid mouse-wheel scroll (browser/PC only — see wheelScroll.ts); only live while
    // the picker overlay is open, same viewport rect handleDown's inRect gate uses.
    this.unsubs.push(input.onWheel((x, y, deltaY) => {
      if (!this.avatarPickerOpen || !this.pickerViewRect) return;
      const r = this.pickerViewRect;
      if (x < r.x || x > r.x + r.w) return;
      const next = wheelScrollY(r.y, r.y + r.h, y, deltaY, this.pickerScrollY, this.pickerMaxScroll);
      if (next !== null) { this.pickerScrollY = next; this.render(); }
    }));
    this.setupHiddenInput();
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => this.render()));
    this.render();
  }

  update(dt: number): void {
    if (this.renameOpen) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.render(); }
    }
    if (this.toastMsg) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) { this.toastMsg = null; this.render(); }
    }
    if (this.audioDirty) { this.audioDirty = false; this.render(); }
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
    // Volume sliders track the pointer live, so they are checked before (and instead of) the hit
    // table and jump to the press point immediately — see audioPanel.ts.
    const slider = hitTest(this.audioSliders, x, y);
    if (slider) { this.activeAudioSlider = slider; slider.onDrag(x); return; }
    // The picker grid is drag-scrollable: a down inside its viewport starts a tap-vs-drag gesture
    // (ScrollTapGesture) instead of firing immediately, so a drag that starts on a cell scrolls the
    // grid rather than instantly selecting/toasting that cell.
    if (this.avatarPickerOpen && this.pickerViewRect && inRect(x, y, this.pickerViewRect)) {
      this.pickerGesture.down(this.pickerScrollY, y, hitAction(this.pickerCellHits, x, y));
      return;
    }
    dispatchHit(this.hits, x, y);
  }

  private handlePickerMove(y: number): void {
    if (!this.avatarPickerOpen) return;
    const scroll = this.pickerGesture.move(y);
    if (scroll !== null) {
      this.pickerScrollY = Math.max(0, Math.min(scroll, this.pickerMaxScroll));
      this.render();
    }
  }

  private handleAudioMove(x: number): void {
    this.activeAudioSlider?.onDrag(x);
  }

  private handlePickerUp(): void {
    if (!this.avatarPickerOpen) return;
    const tap = this.pickerGesture.up();
    if (tap) tap();
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

  openRename(): void {
    this.renameOpen = true;
    this.renameText = '';
    this.caretOn = true; this.caretTimer = 0;
    const el = this.hiddenInput;
    if (el) { el.value = ''; el.focus(); }
    this.render();
  }

  closeRename(): void {
    this.renameOpen = false;
    this.hiddenInput?.blur();
    this.render();
  }

  async submitRename(): Promise<void> {
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
        showToastMessage(t('settings.renameOk'), 'success');
      } else {
        showToastMessage(t(res.key), 'error');
      }
    } catch (e) {
      showToastMessage(e instanceof TimeoutError ? t('common.networkTimeout') : t('settings.renameFail'), 'error');
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container); // caret blink (~2×/s) + per-keystroke rename field → free Text textures
    this.hits = [];
    this.audioSliders = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    drawProfile(this.asPanelHost(), tbH);
    drawLanguage(this.asPanelHost());
    drawDataSaver(this.asPanelHost());
    drawAudio(this.asAudioHost());
    if (this.cb.onReplayTutorial) drawHelp(this.asPanelHost());
    drawAccount(this.asPanelHost());
    if (this.avatarPickerOpen) drawAvatarPickerOverlay(this.asPickerHost());
    if (this.renameOpen) drawRenameOverlay(this.asOverlayHost());
    if (this.deleteConfirmOpen) drawDeleteConfirm(this.asOverlayHost());
    // The overlays paint over the volume block and reset `hits` to their own buttons; the sliders
    // would otherwise stay live underneath and a drag across the dim would move a volume.
    if (this.avatarPickerOpen || this.renameOpen || this.deleteConfirmOpen) this.audioSliders = [];
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  // asXxxHost() are cheap object literals (not stored) — each render() call gets a fresh one so
  // `hits`/other mutable fields always reflect the current instance state; the panels/overlays
  // mutate through these references exactly as they used to mutate `this` directly.
  private asPanelHost(): PanelHost {
    return {
      container: this.container, w: this.w, h: this.h, cb: this.cb,
      playerName: this.playerName, currentAvatarId: this.currentAvatarId, busy: this.bt.busy,
      hits: this.hits,
      render: () => this.render(),
      openAvatarPicker: () => this.openAvatarPicker(),
      openRename: () => this.openRename(),
      openDelete: () => this.openDelete(),
    };
  }

  private asAudioHost(): AudioPanelHost {
    const scene = this;
    return {
      container: this.container, w: this.w, h: this.h,
      hits: this.hits,
      get audioSliders() { return scene.audioSliders; },
      set audioSliders(v) { scene.audioSliders = v; },
      markAudioDirty: () => { this.audioDirty = true; },
      render: () => this.render(),
    };
  }

  private asPickerHost(): PickerHost {
    const scene = this;
    return {
      container: this.container, w: this.w, h: this.h, cb: this.cb,
      get currentAvatarId() { return scene.currentAvatarId; },
      set currentAvatarId(v) { scene.currentAvatarId = v; },
      get hits() { return scene.hits; },
      set hits(v) { scene.hits = v; },
      get pickerTab() { return scene.pickerTab; },
      set pickerTab(v) { scene.pickerTab = v; },
      get pickerScrollY() { return scene.pickerScrollY; },
      set pickerScrollY(v) { scene.pickerScrollY = v; },
      get pickerMaxScroll() { return scene.pickerMaxScroll; },
      set pickerMaxScroll(v) { scene.pickerMaxScroll = v; },
      get pickerViewRect() { return scene.pickerViewRect; },
      set pickerViewRect(v) { scene.pickerViewRect = v; },
      get pickerCellHits() { return scene.pickerCellHits; },
      set pickerCellHits(v) { scene.pickerCellHits = v; },
      get toastMsg() { return scene.toastMsg; },
      set toastMsg(v) { scene.toastMsg = v; },
      get toastTimer() { return scene.toastTimer; },
      set toastTimer(v) { scene.toastTimer = v; },
      render: () => this.render(),
      closeAvatarPicker: () => this.closeAvatarPicker(),
    };
  }

  private asOverlayHost(): OverlayHost {
    const scene = this;
    return {
      container: this.container, w: this.w, h: this.h,
      renameText: this.renameText, caretOn: this.caretOn, hiddenInput: this.hiddenInput,
      // Getter/setter, not a plain property: drawRenameOverlay/drawDeleteConfirm reassign
      // `host.hits = []` wholesale (not just `.push()`) to discard base-scene hits for the modal —
      // a plain copied property would only rebind this throwaway object literal, never reaching
      // back to `scene.hits`, and handleDown() (which reads `scene.hits` directly) would then never
      // see the modal's own button hits. Same reasoning as PickerHost.hits below.
      get hits() { return scene.hits; },
      set hits(v) { scene.hits = v; },
      submitRename: () => void this.submitRename(),
      closeRename: () => this.closeRename(),
      submitDelete: () => void this.submitDelete(),
      closeDelete: () => this.closeDelete(),
    };
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
    const hdr = drawSceneHeader(this.container, w, h, t('settings.title'), { icon: 'settingsTabIcon' });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, sound: 'sfx.ui.back', fn: () => this.cb.onBack() });

    return tbH;
  }

  openAvatarPicker(): void {
    this.avatarPickerOpen = true;
    this.pickerTab = 'preset';
    this.pickerScrollY = 0;
    this.toastMsg = null;
    this.render();
  }

  closeAvatarPicker(): void {
    this.avatarPickerOpen = false;
    this.pickerViewRect = null;
    this.pickerCellHits = [];
    this.render();
  }

  openDelete(): void {
    this.deleteConfirmOpen = true;
    this.render();
  }

  closeDelete(): void {
    this.deleteConfirmOpen = false;
    this.render();
  }

  async submitDelete(): Promise<void> {
    if (this.bt.busy || !this.cb.onDeleteAccount) return;
    this.deleteConfirmOpen = false;
    this.bt.start();
    this.render();
    try {
      const res = await withTimeout(this.cb.onDeleteAccount());
      // On success the core navigates to the login screen (this scene is torn down);
      // only a failure path returns here visibly.
      if (!res.ok) showToastMessage(t('settings.deleteAccount.failed'), 'error');
    } catch (e) {
      showToastMessage(e instanceof TimeoutError ? t('common.networkTimeout') : t('settings.deleteAccount.failed'), 'error');
    } finally {
      this.bt.stop();
      this.render();
    }
  }
}
