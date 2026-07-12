// Shared foundation for the SectScene mixin chain (see ../SectScene.ts assembly).
//
// SectSceneBase holds every instance field (all `protected`, so the domain mixin bodies keep
// referencing them verbatim: this.mode, this.sect, this.bodyLayer, this.modalLayer, …) + the layer
// scaffold (build), the static header, the permission getters, the render dispatcher, the shared
// close-modal / toast / error primitives, and the input/lifecycle plumbing. Each domain (data /
// render / input overlay / actions / modals) lives in its own sibling file as `XMixin(Base)` and is
// chained into the final SectScene.
//
// SectScene — SLG sect management scene (S8-4b, C6).
// A sect = a faction organization composed of families within a region; member unit is a family, linked by family.sectId.
// Most write operations require the requester to be the family leader (representing the whole family); disband/ally/unally are sect-master only.
// Channel is readable/writable by any sect member. Real-time push at scale goes through Redis (this slice uses REST polling, see SLG_DESIGN §9.3).
//
// Entry point: FamilyScene's "Sect" button (sects are the family of families, naturally belongs in the family UI).
// Aligned with FamilyScene pattern: modalLayer + hitRects/modalHits (dim click to close), hand-drawn sketchPanel/txt,
// subscribe input.onDown/Move/Up in constructor + unsubscribe in destroy (SLG scene input subscription was a latent bug, fixed in C3).

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, tearDownChildren } from '../../render/sketchUi';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import type {
  WorldApiClient, SectView, SectDetailView, SectMessageView,
} from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { drawSocialTabRail, type SocialTab } from '../../render/socialTabRail';

export interface SectSceneCallbacks {
  onBack(): void;
  /** Rail click for one of the other 4 social tabs (friends/family/world/mail); 'sect' is a no-op. */
  onNavTab(tab: SocialTab): void;
  worldApi: WorldApiClient;
  worldId: string;
  /** current player's accountId */
  myAccountId: string;
  /** display name used as senderName for channel messages */
  playerName: string;
}

/** Handle returned by showSect so the core can push live sect-channel messages in. */
export interface SectSceneView {
  applySectMsg(msg: SectMessageView): void;
}

export type SectTab = 'families' | 'channel';
export type ViewMode = 'loading' | 'noSect' | 'create' | 'mySect';

export const ROW_H = 48;

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type SectSceneBaseCtor = Constructor<SectSceneBase>;

export class SectSceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly landscape: boolean;
  protected readonly cb: SectSceneCallbacks;

  protected mode: ViewMode = 'loading';
  protected activeTab: SectTab = 'families';

  // My family context (drives permission gating).
  protected myFamilyId: string | null = null;
  protected myFamilyRole: 'leader' | 'elder' | 'member' | null = null;
  protected inFamily = false;

  protected sect: SectDetailView | null = null;
  protected messages: SectMessageView[] = [];
  /** cache of all sects in the world — used for browse/ally name resolution. */
  protected sectsCache: SectView[] = [];

  protected bodyLayer!: PIXI.Container;
  protected toastLayer!: PIXI.Container;
  protected modalLayer!: PIXI.Container;

  // Create form
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

  protected toastTimer = 0;
  protected destroyed = false;
  protected readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: SectSceneCallbacks) {
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
    const bg = buildPaperBackground('sect', w, h, { railX });
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
    const hdr = drawSceneHeader(this.container, w, this.h, t('sect.title'), {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.headerH = hdr.headerH;
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
  }

  // ── Permission helpers ──────────────────────────────────────────────────────

  protected get isFamilyLeader(): boolean { return this.myFamilyRole === 'leader'; }
  protected get isSectLeader(): boolean { return !!this.sect && this.sect.leaderId === this.cb.myAccountId; }

  // ── Render ──────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer); // create-form input re-renders per keystroke → free Text textures
    this.hitRects = [];
    this.renderHeader();

    // Draw the social hub rail in every mode (not just 'mySect') — otherwise the other 4 tabs
    // vanish while this scene is still loading or has no sect yet, since it replaces FriendsScene
    // wholesale on navigation.
    const railHits = drawSocialTabRail(this.bodyLayer, this.w, this.h, this.headerH, this.landscape, 'sect', {}, (tab) => this.cb.onNavTab(tab));
    this.hitRects.push(...railHits.map((hit) => ({ rect: hit.rect, action: hit.fn })));

    switch (this.mode) {
      case 'loading': this.renderLoading(); break;
      case 'noSect': this.renderNoSect(); break;
      case 'create': this.renderCreate(); break;
      case 'mySect': this.renderMySect(); break;
    }
  }

  // ── Modals ──────────────────────────────────────────────────────────────────

  protected closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ───────────────────────────────────────────────────────────────────

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
        ALREADY_IN_SECT:    t('sect.err.alreadyIn'),
        SECT_FULL:          t('sect.err.full'),
        NOT_IN_SECT:        t('sect.err.notIn'),
        NO_PERMISSION:      t('sect.err.noPermission'),
        NOT_FOUND:          t('sect.err.notFound'),
        ALLY_CAP_REACHED:   t('sect.err.allyCap'),
        INSUFFICIENT_FUNDS: t('sect.err.funds'),
        BAD_REQUEST:        t('sect.err.badReq'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Scene interface ─────────────────────────────────────────────────────────

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

// ── Domain entrypoints dispatched to from base-level code (render / constructor) and across sibling
// mixins (render → input/actions; actions → modals/data; input → data). Declared via interface/class
// declaration merging so base-level `this.renderNoSect()` / cross-mixin `this.showSectPickModal()`
// type-check as METHODS (not properties, which would clash with the mixin override — TS2425). Emits
// NOTHING at runtime, so the real prototype methods provided by the mixins run and all bodies stay
// verbatim.
export interface SectSceneBase {
  // data
  loadData(): Promise<void>;
  loadMySect(sectId: string): Promise<void>;
  loadChannel(): Promise<void>;
  // render
  renderLoading(): void;
  renderNoSect(): void;
  renderCreate(): void;
  renderMySect(): void;
  // input overlay
  openInputFor(field: 'name' | 'tag'): void;
  openSendInput(): void;
  // actions
  doCreate(): Promise<void>;
  openBrowseList(): Promise<void>;
  confirmLeave(): void;
  confirmDissolve(): void;
  confirmVote(nomineeFamilyId: string, nomineeLabel: string): void;
  openAllyList(): Promise<void>;
  openManageAllies(): Promise<void>;
  // modals
  showSectPickModal(sects: SectView[], onPick: (sectId: string) => void, emptyKey: 'sect.noSects' | 'sect.noAllies'): void;
  showConfirm(msg: string, onOk: () => void): void;
}
