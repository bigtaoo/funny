// Incremental repaints for FriendsScene — everything that used to be a full render().
//
// FriendsScene renders immediate-mode: render() tears down the whole display tree and rebuilds every
// Text/Graphics/Sprite (see chrome.ts's beginRender + render/sketchUi.ts's tearDownChildren). That's
// the repo-wide convention for these hand-drawn pages and it's fine for an actual state change — but
// three things were driving it far more often than the content actually changed
// (social-tab-switch-cost, 2026-08-20):
//
//   - a drag/wheel scroll, once per frame for the whole gesture;
//   - the focused input's caret, twice a second;
//   - the duel-invite banner's countdown, once a second.
//
// Each of those moves one thing. So this class holds the handles needed to move just that thing, and
// core.update() routes the three tickers through here instead of through render(). Every path falls
// back to a full render() if the object it wants is missing or dead, so a missed registration
// degrades to the old behaviour rather than to a stale screen.
//
// Composition over `core` (form ② per claudedocs/client-modules.md's split-form priority note): the
// state below is only ever touched by these methods, so it lives with them instead of adding six
// more fields to FriendsSceneCore. Constructed by Core itself, reachable as `core.repaint`.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { caretDisplay } from '../../ui/inputDisplay';
import { serverNow } from '../../net/serverClock';
import type { Rect } from '../../layout/ILayout';
import type { FriendsSceneCore } from './core';

/** The focused input's value Text plus what it takes to rebuild that one string. */
export interface CaretField {
  obj: PIXI.Text;
  value: string;
  placeholder: string;
  /** Re-applies any width-dependent layout after the string changed (world chat's right-anchored
   *  overflow behaviour) — omitted for plain left-anchored fields. */
  reflow?: (obj: PIXI.Text) => void;
}

export class RepaintState {
  constructor(private readonly core: FriendsSceneCore) {}

  // ── Cheap scroll (CardCodexScene precedent) ─────────────────────────────────
  // Rows are laid out once, at `builtScrollY`, into a masked `layer`, with `overscan` px of extra
  // rows above and below the visible region. A drag then just translates that layer and only falls
  // back to a full render once the position leaves the overscan band.
  /** The masked scroll layer this render built, or null on tabs that don't scroll. */
  layer: PIXI.Container | null = null;
  /** The scroll-position indicator — outside `layer`, so a translate has to redraw it separately. */
  scrollbar: PIXI.Graphics | null = null;
  /** scrollY the current tree was laid out at — `layer` is translated by `scrollY - builtScrollY`. */
  builtScrollY = 0;
  /**
   * Extra content height built beyond the region in each direction. Set by scrollRegion(); stays 0
   * on tabs that draw rows straight into `container` with no mask (the family/sect browse lists),
   * where widening rowVisible() would spill rows past the region with nothing to clip them.
   */
  overscan = 0;
  /** Set by whichever panel drew the focused field this render (see chrome.ts's caretText). */
  caretField: CaretField | null = null;
  /** The duel-invite banner's countdown Text (set by friendsList's drawDuelInviteBanner). */
  duelBannerLabel: PIXI.Text | null = null;

  /** Everything above was just destroyed by tearDownChildren — drop the refs so each path falls back
   *  to a full render instead of touching a dead display object. Called from beginRender(). */
  reset(): void {
    this.layer = null;
    this.scrollbar = null;
    this.overscan = 0;
    this.caretField = null;
    this.duelBannerLabel = null;
  }

  /** Adopt a freshly built scroll layer, baselined at the current scrollY. */
  register(layer: PIXI.Container, regionH: number): void {
    this.layer = layer;
    this.overscan = regionH;
    this.markScrollBuilt();
  }

  /** Re-baseline the translate origin onto the current scrollY. For a render-time scrollY change
   *  made *after* scrollRegion() but *before* rows are placed (world chat's stick-to-latest). */
  markScrollBuilt(): void {
    this.builtScrollY = this.core.scrollY;
    if (this.layer && !this.layer.destroyed) this.layer.y = 0;
  }

  /** How far the built tree is from where it should be — also the offset scroll-layer hit rects
   *  need at hit-test time, since they were recorded in build space (see core.onPointerUp). */
  get scrollDelta(): number {
    return this.core.scrollY - this.builtScrollY;
  }

  /** The viewport rect the indicator is drawn against (also the content mask's rect). */
  get viewRect(): Rect {
    const core = this.core;
    return { x: 0, y: core.regionTop, w: core.w, h: core.regionBottom - core.regionTop };
  }

  /**
   * Drain a scroll change: translate the already-built layer when the new position is still covered
   * by the overscan band, else rebuild the window. reset() clears `layer`, so the first scroll after
   * a render on a non-scrolling tab correctly falls through to render().
   */
  applyScroll(): void {
    const delta = this.scrollDelta;
    if (!this.layer || this.layer.destroyed || Math.abs(delta) > this.overscan) {
      this.core.render();
      return;
    }
    this.layer.y = -delta;
    this.drawScrollbar();
  }

  /** (Re)draw just the scroll thumb. Also the initial draw, from endRender(). */
  drawScrollbar(): void {
    const core = this.core;
    if (this.scrollbar) { this.scrollbar.destroy(); this.scrollbar = null; }
    this.scrollbar = drawScrollIndicator(core.container, this.viewRect, core.scrollY, core.maxScroll);
    // Added on top of the popup/modal singletons — put them back in front. (Scrolling is gated on
    // neither being open, so this only matters if one opened between the drag frame that set
    // scrollDirty and this drain.)
    if (this.scrollbar) {
      core.container.addChild(core.popup.container);
      core.container.addChild(core.modalLayer);
    }
  }

  /** Swap the caret in or out of the focused field's existing Text. */
  blinkCaret(): void {
    const f = this.caretField;
    if (!f || f.obj.destroyed) { this.core.render(); return; }
    f.obj.text = caretDisplay(f.value, this.core.caretOn, f.placeholder);
    f.reflow?.(f.obj);
  }

  /** Rewrite the duel banner's remaining-seconds string in place. */
  tickDuelBanner(): void {
    const inv = this.core.incomingDuelInvite;
    const lbl = this.duelBannerLabel;
    if (!inv || !lbl || lbl.destroyed) { this.core.render(); return; }
    const secs = Math.max(0, Math.ceil((inv.expiresAt - serverNow()) / 1000));
    lbl.text = t('friends.duelInviteBanner', { name: inv.fromName || inv.fromPublicId, secs });
  }
}
