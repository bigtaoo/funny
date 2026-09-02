// CityScene's paint plumbing: the display layers, the frame-coalescing repaint flag, the per-layer
// hit tables, and the in-flight dim (2026-09-02 render-coalescing pass).
//
// Before this pass the scene was one immediate-mode tree that every render() tore down and rebuilt
// — roughly 80 `PIXI.Text` re-rastered and re-uploaded per pass (~8–10 ms of main thread, matching
// the CardScene roster measurement of 105 Texts ≈ 11 ms). A single "upgrade" or "speed up" tap fired
// three or four of those passes, and the in-flight dim was gated on `bt.busy` rather than on
// BusyTracker's own 1-second `loadingVisible` threshold, so a 30–80 ms round trip flashed a
// full-screen wash on and back off within two or three frames. The player's report was that the
// whole page blinks on every tap in the build modal (2026-09-02).
//
// Composition over `core` (form ② per claudedocs/client-modules.md's split-form priority note),
// same shape as SectScene/repaint.ts and FriendsScene/repaint.ts: the state here is only ever
// touched by these methods. Constructed by Core, reachable as `core.paint`.
import * as PIXI from 'pixi.js-legacy';
import {
  txt,
  tearDownChildren,
  buildPaperBackground,
} from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildDecorCLayer } from '../../render/decorCLayer';
import type { Hit } from '../../ui/hits';

/** What CityPaint needs from its host — CitySceneCore supplies all four. */
export interface PaintHost {
  readonly container: PIXI.Container;
  readonly w: number;
  readonly h: number;
  /** Paints the page and then the modal on top of it (../CityScene.ts's render). */
  render(): void;
}

export class CityPaint {
  /**
   * `host.container`'s four permanent children. Splitting the tree by how often each part actually
   * changes lets a repaint touch only the layer whose content moved:
   *
   *   - `staticLayer` — notebook paper + decor. Painted ONCE, lazily on the first page paint; the
   *     scene's `w`/`h` are fixed for its lifetime, so it never needs invalidating.
   *   - `pageLayer`  — header, resource bar, build queue, building grid, team row. Torn down and
   *     rebuilt by paintPage(), i.e. only when the page's own data moved.
   *   - `modalLayer` — the open detail/train modal and its dim. Torn down by paintModal() alone, so
   *     opening or dismissing a modal no longer rebuilds the page standing behind it.
   *   - `busyLayer`  — the in-flight dim. Toggled by syncBusy() straight from Core's update(), so
   *     busy state never routes through a render at all.
   *
   * Child order IS the z-order and cityModalSpeedup.ui.ts depends on it ("the modal renders after
   * (and over) the dimmed queue bar", `textNodes(...).pop()`).
   */
  readonly staticLayer = new PIXI.Container();
  readonly pageLayer = new PIXI.Container();
  readonly modalLayer = new PIXI.Container();
  private readonly busyLayer = new PIXI.Container();

  /** False until the paper/decor have been built — done lazily on the first page paint. */
  private staticPainted = false;
  /** Whether `busyLayer` currently holds the in-flight dim (see syncBusy). */
  private busyShown = false;
  /**
   * A repaint is owed on the next update() tick. Set by requestRender() and consumed once per
   * frame, which is what collapses a burst of same-tick render requests into a single paint — the
   * "speed up" path alone used to fire three (pre-flight busy overlay → refreshWallet's
   * onSaveChanged → post-stop), each a full teardown-and-rebuild of the whole scene.
   *
   * Only paths that can fire more than once per frame, or whose result the player cannot perceive a
   * frame early, go through requestRender(). Anything a test or a tap needs to see synchronously
   * (data.ts's four staggered load slices, a modal opening) still calls render()/paintModal().
   */
  private renderDirty = false;

  /** What paintPage() last registered: `[backHit, ...page hits]`, without the guide's action. */
  pageHits: Hit[] = [];
  /** The header Back button — pushed first by every paint, and the one page hit that survives a
   *  modal opening (a modal must never trap the player in the scene). */
  backHit: Hit | null = null;
  /** Re-applies the page's guide-ring decision (ONBOARDING_DESIGN §4.2) against the page currently
   *  standing in `pageLayer`. Set by paintPage; replayed by paintModal when a modal closes, since
   *  opening one calls `guide.hide()` and the page underneath was never repainted. */
  guideRestore: (() => void) | null = null;
  /** Grid tile 0's on-screen rect, recorded by renderBuildingGrid for guideRestore to ring as
   *  step2's target — null when the tile is scrolled out of the viewport. Recorded rather than rung
   *  inline, so the decision stays in one place (paintPage's guideRestore) and can be replayed after
   *  a modal closes without repainting the grid that produced the rect. */
  guideStep2: { x: number; y: number; w: number; h: number } | null = null;

  constructor(private readonly host: PaintHost) {
    host.container.addChild(this.staticLayer);
    host.container.addChild(this.pageLayer);
    host.container.addChild(this.modalLayer);
    host.container.addChild(this.busyLayer);
  }

  /**
   * Ask for a repaint on the next update() tick instead of painting inline. Several requests in one
   * tick collapse into a single paint — see the `renderDirty` field comment for which callers go
   * through here and which still paint synchronously.
   */
  requestRender(): void {
    this.renderDirty = true;
  }

  /** Paints if a repaint is owed. Called last in Core's update(), so everything earlier in the tick
   *  that asked for one gets folded into this single pass. */
  flush(): void {
    if (this.renderDirty) this.host.render();
  }

  /**
   * Opens a page paint: clears any owed repaint (this pass supersedes it), builds the paper/decor
   * layer on first use, and empties `pageLayer` for the caller to draw into. `tearDownChildren`,
   * not `destroy({children:true})` — it frees each Text's baseTexture, which a plain destroy of the
   * parent would orphan (texture defaults to false for descendants), and this scene opens and closes
   * as an overlay over the long-lived WorldMapScene (§mem-leak).
   */
  beginPage(): void {
    this.renderDirty = false;
    if (!this.staticPainted) {
      this.staticPainted = true;
      this.staticLayer.addChild(buildPaperBackground('citybg', this.host.w, this.host.h));
      const decoC = buildDecorCLayer(this.host.w, this.host.h);
      if (decoC) this.staticLayer.addChild(decoC);
    }
    tearDownChildren(this.pageLayer);
    this.pageHits = [];
  }

  /** Opens a modal paint: empties `modalLayer`, leaving `pageLayer` exactly as it stands. */
  beginModal(): void {
    tearDownChildren(this.modalLayer);
  }

  /**
   * The in-flight dim, gated on BusyTracker's own 1-second `loadingVisible` threshold rather than on
   * `busy`. Gating on `busy` meant a 30–80 ms round trip flashed a full-screen 25% wash on and back
   * off within two or three frames — the page-blink report this whole module came from. Input is
   * blocked by `if (this.bt.busy) return` in Core's handleDown either way, so the dim carries no
   * responsibility beyond telling the player that something is genuinely taking a while.
   */
  syncBusy(loadingVisible: boolean): void {
    if (loadingVisible === this.busyShown) return;
    this.busyShown = loadingVisible;
    tearDownChildren(this.busyLayer);
    if (!loadingVisible) return;
    const { w, h } = this.host;
    const ov = new PIXI.Graphics();
    ov.beginFill(0x000000, 0.25);
    ov.drawRect(0, 0, w, h);
    ov.endFill();
    this.busyLayer.addChild(ov);
    const lbl = txt('…', FS.headline, 0xffffff, true);
    lbl.x = w / 2 - 15;
    lbl.y = h / 2 - 21;
    this.busyLayer.addChild(lbl);
  }
}
