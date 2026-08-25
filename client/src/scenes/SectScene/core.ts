// Shared foundation for the SectScene composition (see ../SectScene.ts assembly).
//
// SectSceneCore holds every instance field (all `public`, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.mode, this.core.sect, this.core.bodyLayer, …) +
// the layer scaffold (build), the static header, the permission getters, the shared close-modal /
// toast / error primitives, and the pointer-input/lifecycle plumbing. Core wires all four
// InputManager subscriptions itself AND owns handleDown/handleMove/handleUp/handleWheel directly —
// they only ever dispatch through pre-registered `hitRects`/`modalHits` closures (set by whichever
// domain rendered them), never calling a domain method by name, so there's no two-phase-construction
// concern here (unlike DefenseEditorScene's InputPanel). Core does NOT own the render() dispatcher
// (which calls into RenderPanel's mode-specific methods) or the initial loadData() call — both live
// on the outer ../SectScene.ts assembly since only it knows about every domain instance (Core takes
// a `render` callback injected at construction instead of owning render() itself).
//
// Each domain (data / modals / actions / input-overlay / render) is its own independent class in a
// sibling file, constructed with `core` (2026-08-11: converted from the former `XMixin(Base)`
// inheritance chain — the cross-mixin calls this used to reach via interface declaration merging are
// now explicit constructor params/callbacks instead, see claudedocs/client-modules.md's split-form
// priority note). Dependency shape: Render → Actions, InputOverlay; Actions → Data, Modals; Data and
// Modals depend only on Core — narrow interfaces (DataHandlers/ModalsHandlers/ActionHandlers, each
// already 1:1 with its class's own public surface) are passed down rather than the whole class, per
// the composition-priority rule's "only the specific cross-domain methods needed" guidance.

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { ui as C, buildPaperBackground, tearDownChildren } from '../../render/sketchUi';
import { showToastMessage } from '../../net/log';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { sidebarNavW, bottomNavH } from '../../ui/widgets/HubTabs';
import type {
  WorldApiClient, SectView, SectDetailView, SectMessageView, FamilyDetailView,
} from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { drawSocialTabRail, type SocialTab } from '../../ui/widgets/socialTabRail';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import { BusyTracker, TimeoutError } from '../../ui/busyTracker';
import { drawHeaderTitle } from './header';
import { SectRepaint, type ScrollCol } from './repaint';

export interface SectSceneCallbacks {
  onBack(): void;
  /** Rail click for one of the other 4 social tabs (friends/family/world/mail); 'sect' is a no-op. */
  onNavTab(tab: SocialTab): void;
  worldApi: WorldApiClient;
  worldId: string;
  /**
   * What the social hub already fetched on its way in — its status load pulled the identical
   * GET /social/family/mine and GET /world/.../sects/:id moments earlier, and re-requesting them put
   * a redundant loading screen between tapping the Sect tab and seeing the roster. One-shot: the hub
   * clears them on hand-off, so any later entry re-fetches rather than painting a stale roster.
   * `preloadedSect` is only trusted when its sectId matches the family's (see DataPanel.loadData).
   */
  preloadedFamily?: FamilyDetailView | null;
  preloadedSect?: SectDetailView | null;
  /** current player's accountId */
  myAccountId: string;
  /** display name used as senderName for channel messages */
  playerName: string;
  /** current player's coin balance — drives the create-sect afford check */
  getCoins(): number;
  /** Re-syncs the local wallet cache after a spend the commercial service applied server-side (createSect). */
  refreshWallet(): Promise<void>;
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene (e.g. the world map underneath) changes the wallet. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
}

/** Handle returned by showSect so the core can push live sect-channel messages in. */
export interface SectSceneView {
  applySectMsg(msg: SectMessageView): void;
}

export type SectTab = 'families' | 'channel';
export type ViewMode = 'loading' | 'noSect' | 'create' | 'mySect';

// Bumped from 48 so the enlarged (family-matched) row fonts — a heading-size name over a body-size
// stat line — fit without clipping. See RenderPanel.renderFamiliesList / renderChannel.
export const ROW_H = 68;

export class SectSceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly landscape: boolean;
  readonly cb: SectSceneCallbacks;

  mode: ViewMode = 'loading';
  activeTab: SectTab = 'families';

  // My family context (drives permission gating).
  myFamilyId: string | null = null;
  myFamilyRole: 'leader' | 'elder' | 'member' | null = null;
  inFamily = false;

  sect: SectDetailView | null = null;
  messages: SectMessageView[] = [];
  /** cache of all sects in the world — used for browse/ally name resolution. */
  sectsCache: SectView[] = [];

  bodyLayer!: PIXI.Container;
  modalLayer!: PIXI.Container;

  // Create form
  hiddenInput: HTMLInputElement | null = null;
  createName = '';
  createTag = '';
  createField: 'name' | 'tag' | null = null;
  caretOn = true;
  caretTimer = 0;

  // Channel message draft — persists the hidden-input value so the visible Send button can send
  // it directly (previously the field and button both just reopened the hidden input, and the
  // only actual send path was a literal Enter keydown, which is unreliable on mobile keyboards).
  channelInput = '';
  channelActive = false;
  channelSending = false;

  // Scroll — `scrollY` is the families/single-column scroll; `scrollYChannel` only comes into play
  // in the landscape split view (see RenderPanel.renderSplitView), where the channel column scrolls
  // independently alongside the families column instead of sharing one tab's scroll state.
  scrollY = 0;
  scrollYChannel = 0;
  /** Pin the channel to the latest message; cleared once the user scrolls up to read history, re-armed
   *  when they drag back to the bottom or send a message (see renderChannel / handleMove). */
  channelStick = true;
  /** Channel scroll extent from the last renderChannel — lets handleMove classify a channel drag as
   *  "back at the bottom" (re-stick) vs "scrolled up" (unstick) without recomputing the content height. */
  channelMax = 0;
  /** X boundary between the families and channel columns in the landscape split view; used by
   *  handleDown to route a drag to the right column's scroll state. Unused (0) in portrait. */
  chatColX = 0;
  /** Families-list viewport vertical bounds + scroll extent, set each renderFamiliesList call — mirrors
   *  channelMax/channelRegion* but for the families column. Touch-drag scroll doesn't need an upfront
   *  region/max (it just clamps on the next render), but wheel scroll (onWheel) needs both known before
   *  the event is handled, so they're captured here purely for that. */
  familiesRegionTop = 0;
  familiesRegionBottom = 0;
  familiesMax = 0;
  /** Channel viewport vertical bounds, set each renderChannel call — same reasoning as familiesRegion*. */
  channelRegionTop = 0;
  channelRegionBottom = 0;
  /** Title-bar height, set from the shared header — drives all body layout below it. */
  headerH = 0;
  /** Live header text/button nodes (title +, in landscape, the sect identity + alliance controls
   *  lifted out of the body — see drawHeaderTitle), drawn on top of the cached header chrome.
   *  Destroyed and rebuilt each renderHeader() so repeated renders don't stack duplicate nodes. */
  headerExtras: PIXI.DisplayObject[] = [];
  /**
   * Tap-vs-drag gesture tracker: defers a hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a member/list cell scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Which column the in-progress drag scrolls — captured at pointer-down, applied in handleMove. */
  private dragCol: ScrollCol = 'families';
  /** The column a drag/wheel just moved, set by handleMove/handleWheel instead of acting inline (raw
   *  pointermove events outrun the display refresh rate). Drained once per frame in update() through
   *  repaint.applyScroll, which translates the pre-built layer instead of rebuilding it. */
  private scrollDirtyCol: ScrollCol | null = null;
  /** Handles for the incremental repaint paths (per-column scroll translate / caret blink /
   *  keystroke) — everything that used to be an unconditional full render(). See ./repaint.ts. */
  readonly repaint = new SectRepaint(this);

  // Hit rects. `scroll` marks a rect recorded in a scroll layer's build space (see ./repaint.ts):
  // handleDown maps the tap into that space and drops it when the tap landed outside the column's
  // viewport, where the overscan band's pre-built rows live.
  hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void; scroll?: ScrollCol }[] = [];
  modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  modalOpen = false;

  destroyed = false;
  readonly unsubs: (() => void)[] = [];

  /** Guards every mutating action below (create/join/leave/dissolve/vote/ally/unally): blocks a
   *  repeat click while one is in flight and drives the busy-button greying in render.ts. */
  readonly bt = new BusyTracker();

  /** @param render Injected by the outer SectScene assembly (which owns the actual render
   *  dispatcher, since it's the only thing that knows about all domain classes) — Core and the
   *  domain classes call `this.render()`/`this.core.render()` wherever the old flattened class
   *  called its own `render()` method verbatim. Does NOT auto-fire the initial loadData() — the
   *  outer assembly does that after all domain instances exist. */
  constructor(layout: ILayout, input: InputManager, cb: SectSceneCallbacks, readonly render: () => void) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.container = new PIXI.Container();
    this.build();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.unsubs.push(input.onWheel((x, y, deltaY) => this.handleWheel(x, y, deltaY)));
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.destroyed) this.render(); }));
  }

  /** Width of the social hub rail left of the notebook binding line (matches every other left-edge tab
   *  rail); 0 in portrait, where the rail is drawn as a bottom nav bar instead (§18) and reserves no
   *  horizontal space. */
  get railW(): number {
    return this.landscape ? sidebarNavW(this.w, this.h, true) : 0;
  }

  /** Bottom edge for portrait's tabbed body content — stops `bottomNavH` short of the screen so the
   *  bottom nav bar (always shown; drawSocialTabRail has no orientation gate) never overlaps the
   *  families/channel viewport. Landscape's split view has no such bar to avoid. */
  get bodyBottom(): number {
    return this.landscape ? this.h : this.h - bottomNavH(this.h);
  }

  /**
   * Which column a pointer at screen `x` scrolls. The landscape split view shows both columns side
   * by side (routed by the divider); portrait shows one at a time, so the active tab decides. Modes
   * other than 'mySect' have neither column, and scroll there falls back to a full render anyway.
   */
  scrollColAt(x: number): ScrollCol {
    if (this.mode !== 'mySect') return 'families';
    if (this.landscape) return x >= this.chatColX ? 'channel' : 'families';
    return this.activeTab === 'channel' ? 'channel' : 'families';
  }

  /** Which of the two scroll fields a column's position lives in — mirrors the `scrollKey` each
   *  render path passes to renderFamiliesList/renderChannel: the landscape columns scroll
   *  independently, while portrait's single visible column always uses `scrollY`. */
  scrollKeyFor(col: ScrollCol): 'scrollY' | 'scrollYChannel' {
    return col === 'channel' && this.landscape ? 'scrollYChannel' : 'scrollY';
  }

  /** Is screen `y` inside a column's viewport? See handleDown for why a hit needs this. */
  private inViewport(col: ScrollCol, y: number): boolean {
    return col === 'channel'
      ? y >= this.channelRegionTop && y <= this.channelRegionBottom
      : y >= this.familiesRegionTop && y <= this.familiesRegionBottom;
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

    this.renderHeader();
  }

  renderHeader(): void {
    const { w } = this;
    // Draw only the bar chrome + back button from the shared header; the title (and, in landscape,
    // the sect identity + alliance controls lifted out of the body) are drawn live below so we
    // control layout — mirrors FamilySceneBase.renderHeader/drawHeaderTitle.
    const hdr = drawSceneHeader(this.container, w, this.h, null, {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.headerH = hdr.headerH;
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
    drawHeaderTitle(this, hdr.headerH);
  }

  /**
   * Set once by the outer assembly right after ActionsPanel is constructed (Core is constructed
   * before it, so a direct `actions.openXxx` reference isn't available yet — same lazy-binding
   * trick as `render`). renderHeader() (and the drawHeaderAllianceButtons call inside it) also runs
   * from Core's OWN constructor via build(), but `this.sect` is always null then, so
   * drawHeaderAllianceButtons returns before ever touching this — the default no-op body is never
   * actually reachable, just here so the field has a well-typed value from the start.
   */
  allianceHooks: {
    openManageAllies(): Promise<void>;
    openAllyList(): Promise<void>;
    openAlliesView(): Promise<void>;
  } = {
    openManageAllies: async () => {},
    openAllyList: async () => {},
    openAlliesView: async () => {},
  };

  /** Same lazy-binding trick as allianceHooks above — the emblem badge's leader-only tap target
   *  (family-emblem-art-prompts.md, 2026-08-14) also lives in drawHeaderTitle. */
  emblemHooks: { openEmblemPicker(): void } = { openEmblemPicker: () => {} };

  // ── Permission helpers ──────────────────────────────────────────────────────

  get isFamilyLeader(): boolean { return this.myFamilyRole === 'leader'; }
  get isSectLeader(): boolean { return !!this.sect && this.sect.leaderId === this.cb.myAccountId; }

  // ── Rail + mode dispatch shell (called from the outer render() dispatcher before it hands off to
  // RenderPanel's mode-specific method) ──────────────────────────────────────────

  /** Tears down + redraws the header/rail chrome shared by every mode; returns nothing — the outer
   *  render() dispatcher calls this, then draws the rail itself, then switches on `mode`. */
  beginRender(): void {
    tearDownChildren(this.bodyLayer); // free the Text baseTextures this frame's tree is about to drop
    this.hitRects = [];
    // Everything the incremental-repaint paths hold onto lived in bodyLayer and was just destroyed —
    // drop the refs so each path falls back to a full render instead of touching a dead node.
    this.repaint.reset();
    this.renderHeader();
  }

  /** Draw the social hub rail in every mode (not just 'mySect') — otherwise the other 4 tabs vanish
   *  while this scene is still loading or has no sect yet, since it replaces FriendsScene wholesale
   *  on navigation. Hides the sect tab itself once we know the player is neither a family leader nor
   *  already in a sect — same rule FriendsScene's rail applies, kept in sync so navigating between
   *  scenes doesn't flicker the tab in and out. */
  drawRail(): void {
    const hidden: SocialTab[] = !this.isFamilyLeader && !this.sect ? ['sect'] : [];
    const railHits = drawSocialTabRail(this.bodyLayer, this.w, this.h, this.headerH, this.landscape, 'sect', {}, (tab) => this.cb.onNavTab(tab), hidden);
    this.hitRects.push(...railHits.map((hit) => ({ rect: hit.rect, action: hit.fn })));
  }

  // ── Modals ──────────────────────────────────────────────────────────────────

  closeModal(): void {
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ───────────────────────────────────────────────────────────────────

  showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  errorMsg(e: unknown): string {
    if (e instanceof TimeoutError) return t('common.networkTimeout');
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
      // Reverse order: the full-screen dim-to-close rect is always pushed first, so checking
      // in push order made it win over every button drawn on top of it — see FamilySceneBase's
      // handleDown for the same fix and the bug it addresses.
      for (let i = this.modalHits.length - 1; i >= 0; i--) {
        const { rect, action } = this.modalHits[i]!;
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          action(); return;
        }
      }
      return;
    }
    // Defer the hit action to pointer-up — if the pointer drags past the threshold it becomes a
    // scroll and the tap is dropped, so a drag starting on a cell scrolls instead of firing it.
    //
    // A rect tagged `scroll` was recorded in its column's build space, and that layer may since have
    // been translated by a cheap scroll — so map the tap into the same space, deliberately by the
    // APPLIED delta rather than the pending one (see SectRepaint.appliedDelta).
    let hit: (() => void) | null = null;
    for (const { rect, action, scroll } of this.hitRects) {
      const py = scroll ? y + this.repaint.appliedDelta(scroll) : y;
      if (x < rect.x || x > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue;
      // Rows are built one viewport beyond the region in each direction, so a hit rect alone no
      // longer implies "on screen" — a tap outside the column's viewport must miss.
      if (scroll && !this.inViewport(scroll, y)) continue;
      hit = action; break;
    }
    this.dragCol = this.scrollColAt(x);
    this.gesture.down(this[this.scrollKeyFor(this.dragCol)], y, hit);
  }

  handleMove(_x: number, y: number): void {
    const raw = this.gesture.move(y);
    if (raw === null) return;
    const col = this.dragCol;
    // Clamp to the column's extent HERE, not just at the next rebuild. The gesture reports raw
    // finger travel, and the cheap-scroll path translates whatever the scroll field says — so before
    // repaint.ts an over-drag past the end was silently re-clamped by the full render this no longer
    // does, and the list would keep translating into blank space (2026-08-25, caught while writing
    // socialRepaintCoverage tests). Matches FriendsScene's onPointerMove, which always clamped.
    const scroll = Math.min(raw, col === 'channel' ? this.channelMax : this.familiesMax);
    this[this.scrollKeyFor(col)] = scroll;
    // Dragging to the bottom re-pins the channel to the latest; scrolling up releases the pin so
    // incoming messages don't yank the reader back down.
    if (col === 'channel') this.channelStick = scroll >= this.channelMax - 1;
    this.scrollDirtyCol = col;
  }

  handleUp(_x: number, _y: number): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  /** PC-only mouse-wheel scroll (see wheelScroll.ts). Mirrors handleMove's routing: in the landscape
   *  split view the families/channel columns scroll independently (routed by chatColX, same as
   *  handleDown); portrait's single-column tab view scrolls whichever tab is active, both sharing
   *  scrollY (see renderTabbedView). */
  handleWheel(x: number, y: number, deltaY: number): void {
    if (this.modalOpen || this.mode !== 'mySect') return;
    const col = this.scrollColAt(x);
    const key = this.scrollKeyFor(col);
    const channel = col === 'channel';
    const top = channel ? this.channelRegionTop : this.familiesRegionTop;
    const bottom = channel ? this.channelRegionBottom : this.familiesRegionBottom;
    const max = channel ? this.channelMax : this.familiesMax;
    const next = wheelScrollY(top, bottom, y, deltaY, this[key], max);
    if (next === null) return;
    this[key] = next;
    if (channel) this.channelStick = next >= this.channelMax - 1;
    this.scrollDirtyCol = col;
  }

  update(dt: number): void {
    // Deliberately no redraw off the busy tracker: nothing on this scene draws its dots/loading
    // overlay (bt only greys buttons while a mutating action is in flight), and every bt.start()/
    // stop() already pairs with its own render() in actions.ts — so ticking it used to cost 2.5 full
    // rebuilds a second for zero visual change. Add a dots overlay and it has to route through
    // `repaint`, not render().
    this.bt.tick(dt);
    // Both tickers below move exactly one thing where render() rebuilds the whole body, so they go
    // through `repaint` instead (see ./repaint.ts).
    if (this.scrollDirtyCol) {
      const col = this.scrollDirtyCol;
      this.scrollDirtyCol = null;
      this.repaint.applyScroll(col);
    }
    if (this.createField || this.channelActive) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.repaint.blinkCaret(); }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    // Free descendant Text baseTextures before dropping the container (overlay over the live
    // WorldMapScene → leaks a screenful of Text per close otherwise). See sketchUi.tearDownChildren.
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }
}
