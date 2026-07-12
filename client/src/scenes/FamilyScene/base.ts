// Shared foundation for the FamilyScene mixin chain (see ../FamilyScene.ts assembly).
//
// FamilySceneBase holds every instance field (all `protected`, so the domain mixin bodies keep
// referencing them verbatim: this.mode, this.family, this.bodyLayer, …) + the layer scaffold (build),
// the render dispatcher, the shared confirm-modal / toast / error primitives, and the input/lifecycle
// plumbing. Each UI domain (data / render / input overlay / actions) lives in its own sibling file as
// `XMixin(Base)` and is chained into the final FamilyScene.
//
// FamilyScene — SLG family management scene (S8-4)
// State machine: noFamily → search/create branch; myFamily → channel/members
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import type { WorldApiClient, FamilyDetailView, FamilyMemberView, FamilyMessageView } from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { drawSocialTabRail, type SocialTab } from '../../render/socialTabRail';

export interface FamilySceneCallbacks {
  onBack(): void;
  /** Open the sect hub (S8-4b) — sect = a family-of-families, rooted in the family UI. */
  onOpenSect(): void;
  /** Rail click for one of the other 4 social tabs (friends/sect/world/mail); 'family' is a no-op. */
  onNavTab(tab: SocialTab): void;
  worldApi: WorldApiClient;
  worldId: string;
  /** current player's accountId */
  myAccountId: string;
  /** current player's display name, denormalized onto sent family messages */
  playerName: string;
}

export type FamilyTab = 'members' | 'channel';
export type ViewMode = 'loading' | 'noFamily' | 'create' | 'myFamily';

export const ROW_H = 48;

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type FamilySceneBaseCtor = Constructor<FamilySceneBase>;

export class FamilySceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly landscape: boolean;
  protected readonly cb: FamilySceneCallbacks;

  protected mode: ViewMode = 'loading';
  protected activeTab: FamilyTab = 'members';

  protected family: FamilyDetailView | null = null;
  protected members: FamilyMemberView[] = [];
  protected messages: FamilyMessageView[] = [];

  protected bodyLayer!: PIXI.Container;
  protected toastLayer!: PIXI.Container;
  protected modalLayer!: PIXI.Container;

  // Input overlay for create form
  protected hiddenInput: HTMLInputElement | null = null;
  protected createName = '';
  protected createTag = '';
  protected createField: 'name' | 'tag' | null = null;
  protected caretOn = true;
  protected caretTimer = 0;

  // Scroll
  protected scrollY = 0;
  /** Title-bar height, set from the shared header — drives all body layout below it. */
  protected headerH = 0;
  protected dragStart: { x: number; y: number; scroll: number } | null = null;
  protected dragMoved = false;

  // Hit rects
  protected hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalOpen = false;

  // Toast
  protected toastTimer = 0;
  protected destroyed = false;
  protected readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: FamilySceneCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.container = new PIXI.Container();
    this.build();
    void this.loadData();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
  }

  /** Width of the social hub rail left of the notebook binding line (matches every other left-edge tab rail). */
  protected get railW(): number {
    return sidebarNavW(this.w, this.h, this.landscape);
  }

  private build(): void {
    const { w, h, landscape } = this;
    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = landscape ? sidebarNavW(w, h, true) : undefined;
    const bg = buildPaperBackground('family', w, h, { railX });
    this.container.addChild(bg);
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);

    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);

    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);

    this.renderHeader();
  }

  protected renderHeader(): void {
    const { w } = this;
    const hdr = drawSceneHeader(this.container, w, this.h, t('family.title'), {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.headerH = hdr.headerH;
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer); // create-form input re-renders per keystroke → free Text textures
    this.hitRects = [];
    this.renderHeader();

    // Draw the social hub rail in every mode (not just 'myFamily') — otherwise the other 4 tabs
    // vanish while this scene is still loading or has no family yet, since it replaces FriendsScene
    // wholesale on navigation.
    const railHits = drawSocialTabRail(this.bodyLayer, this.w, this.h, this.headerH, this.landscape, 'family', {}, (tab) => this.cb.onNavTab(tab));
    this.hitRects.push(...railHits.map((hit) => ({ rect: hit.rect, action: hit.fn })));

    switch (this.mode) {
      case 'loading': this.renderLoading(); break;
      case 'noFamily': this.renderNoFamily(); break;
      case 'create': this.renderCreate(); break;
      case 'myFamily': this.renderMyFamily(); break;
    }
  }

  // ── Confirm modal ─────────────────────────────────────────────────────────

  protected showConfirm(msg: string, onOk: () => void): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const mw = Math.min(280, w - 40);
    const mh = 110;
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    const lbl = txt(msg, 13, C.dark);
    lbl.anchor.set(0.5, 0); lbl.x = mx + mw / 2; lbl.y = my + 14;
    ml.addChild(lbl);

    const okBtn = sketchPanel(80, 28, { fill: C.dark, border: C.accent, seed: seedFor(0, 1, 80) });
    okBtn.x = mx + mw / 2 - 88; okBtn.y = my + mh - 36;
    ml.addChild(okBtn);
    const ol = txt('OK', 13, C.light);
    ol.anchor.set(0.5, 0.5); ol.x = mx + mw / 2 - 48; ol.y = my + mh - 22;
    ml.addChild(ol);
    this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: 80, h: 28 }, action: onOk });

    const cancelBtn = sketchPanel(80, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 2, 80) });
    cancelBtn.x = mx + mw / 2 + 8; cancelBtn.y = my + mh - 36;
    ml.addChild(cancelBtn);
    const cl = buildIcon('close', 15, C.dark);
    cl.x = mx + mw / 2 + 48 - 7.5; cl.y = my + mh - 22 - 7.5;
    ml.addChild(cl);
    this.modalHits.push({ rect: { x: cancelBtn.x, y: cancelBtn.y, w: 80, h: 28 }, action: () => this.closeModal() });
  }

  protected closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  protected showToast(msg: string, color: number = C.dark): void {
    const tl = this.toastLayer;
    tl.removeChildren();
    const lbl = txt(msg, 13, color);
    lbl.anchor.set(0.5, 0);
    lbl.x = this.w / 2; lbl.y = this.h - 80;
    tl.addChild(lbl);
    this.toastTimer = 2500;
  }

  protected errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      const map: Record<string, string> = {
        ALREADY_IN_FAMILY: t('family.err.alreadyIn'),
        FAMILY_FULL:       t('family.err.cap'),
        NOT_IN_FAMILY:     t('family.err.notIn'),
        NO_PERMISSION:     t('family.err.noPermission'),
        INVALID_TAG:       t('family.err.badTag'),
        NOT_FOUND:         t('family.err.notFound'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  handleDown(x: number, y: number): void {
    if (this.modalOpen) {
      for (const { rect, action } of this.modalHits) {
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          action(); return;
        }
      }
      return;
    }
    for (const { rect, action } of this.hitRects) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
        action(); return;
      }
    }
    this.dragStart = { x, y, scroll: this.scrollY };
    this.dragMoved = false;
  }

  handleMove(x: number, y: number): void {
    if (!this.dragStart) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.dragMoved = true;
      this.scrollY = Math.max(0, this.dragStart.scroll - dy);
      this.render();
    }
  }

  handleUp(_x: number, _y: number): void {
    this.dragStart = null;
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt * 1000;
      if (this.toastTimer <= 0) this.toastLayer.removeChildren();
    }
    if (this.createField) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.render(); }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    this.container.destroy({ children: true });
  }
}

// ── Domain entrypoints dispatched to from base-level code (render dispatcher, constructor) and across
// sibling mixins (render → input/actions; actions → data; input → data). Declared via interface/class
// declaration merging so base-level `this.renderLoading()` / `this.loadData()` type-check as METHODS
// (not properties, which would clash with the mixin override — TS2425). Emits NOTHING at runtime, so
// the real prototype methods provided by the mixins run and all method bodies stay verbatim.
export interface FamilySceneBase {
  // data
  loadData(): Promise<void>;
  loadMyFamily(familyId: string): Promise<void>;
  loadChannel(): Promise<void>;
  // render
  renderLoading(): void;
  renderNoFamily(): void;
  renderCreate(): void;
  renderMyFamily(): void;
  // input overlay
  openInputFor(field: 'name' | 'tag'): void;
  openSendInput(): void;
  // actions
  doCreate(): Promise<void>;
  openJoinList(): Promise<void>;
  doSendMsg(): Promise<void>;
  doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void>;
  confirmKick(targetId: string, name: string): void;
  confirmDissolve(): void;
  confirmLeave(): void;
}
