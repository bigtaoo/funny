// CityScene — Home-city management scene. Thin assembly file.
//
// SLG_CITY_DESIGN P1 + P3 D-CITY-8/10/12. Entry: WorldMapScene taps own base tile → "Enter Desk".
// The scene is split by domain — each part lives in ./CityScene/*.ts as an independent class
// constructed with the shared `CitySceneCore` (./CityScene/core.ts, which owns all instance state +
// data loading + icon resolution + network actions + input/lifecycle — but NOT the render()
// dispatcher, which lives here since only this assembly knows about every domain class). To add a
// renderer or modal: find the matching domain class (render / modals) or add a new one — do NOT
// grow the domain logic into this file, only its one-line dispatch call. CitySceneCallbacks is
// re-exported so existing importers (`from './CityScene'`) keep resolving to this file, not the
// directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher used to live on
// CitySceneBase and reach the domain mixins' draw methods via interface declaration merging (an
// "upward" call from base into a sibling); now Core takes a `render` callback injected from this
// assembly instead, so it never has to call sideways into a domain class.
import * as PIXI from 'pixi.js-legacy';
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { marginLineX } from '../render/sketchUi';
import { drawSceneHeader, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { GuideOverlay } from '../render/GuideOverlay';
import { CitySceneCore } from './CityScene/core';
import type { CitySceneCallbacks } from './CityScene/core';
import type { Hit } from '../ui/hits';
import { RenderPanel } from './CityScene/render';
import { ModalsPanel } from './CityScene/modals';

export type { CitySceneCallbacks } from './CityScene/core';

/**
 * CityScene — the home-city management scene registered against SceneManager, thin assembly over
 * the per-domain composition (see the file-header comment above).
 */
export class CityScene implements Scene {
  readonly container: PIXI.Container;

  private readonly core: CitySceneCore;
  private readonly renderPanel: RenderPanel;
  private readonly modals: ModalsPanel;

  constructor(layout: ILayout, input: InputManager, cb: CitySceneCallbacks) {
    const guide = new GuideOverlay();
    this.core = new CitySceneCore(
      layout, input, cb, () => this.render(), () => this.paintModal(), guide,
    );
    // Wrapper container, NOT `core.container` directly: a page paint tears down and rebuilds
    // core.paint.pageLayer, which would wipe out any guide ring/bubble added straight into it.
    // `guide.root` is a second, never-torn-down sibling added after `core.container` so it renders
    // on top (ONBOARDING_DESIGN §4.2 step2/step3).
    this.container = new PIXI.Container();
    this.container.addChild(this.core.container);
    this.container.addChild(guide.root);
    this.renderPanel = new RenderPanel(this.core);
    this.modals = new ModalsPanel(this.core);

    this.render();
    this.core.load();
  }

  update(dt: number): void {
    this.core.update(dt);
  }

  destroy(): void {
    // core.destroy() frees core.container + guide.root (both children of the wrapper below), but
    // never touches the wrapper itself — without this, `this.container` (what SceneManager/tests
    // actually hold as this scene's exposed container) never flips `.destroyed`.
    this.core.destroy();
    this.container.destroy({ children: true });
  }

  /**
   * A full paint: the page, then whatever modal is on top of it. This is what every data change
   * routes through (directly, or coalesced via `core.requestRender()`).
   *
   * Modal-only changes — opening a building card, dismissing one — call `paintModal()` instead and
   * leave `pageLayer` standing, which is the point of the layer split (see CitySceneCore's layer
   * field comment).
   */
  private render(): void {
    const core = this.core;
    if (core.destroyed) return;
    this.paintPage();
    this.paintModal();
  }

  /** Rebuilds `core.paint.pageLayer` and the page's own hit table (`core.paint.pageHits`). Does NOT touch the
   *  modal layer or `core.hits` — paintModal(), called right after, owns both. */
  private paintPage(): void {
    const core = this.core;
    if (core.destroyed) return;
    core.beginPage();
    const { w, h } = core;

    // No sidebar rail on this single-page scene, so the red binding line keeps its default
    // 9%-of-width position (marginLineX) and body content starts just right of it. The paper
    // background and decor themselves live in core.paint.staticLayer, painted once (beginPage).

    const hdr = drawSceneHeader(core.paint.pageLayer, w, h, t('city.title'), {
      variant: 'paper',
      accent: HEADER_ACCENT.slg,
      icon: 'cityTabIcon',
    });
    const backHit: Hit = {
      rect: hdr.backRect,
      sound: 'sfx.ui.back',
      fn: () => {
        core.cb.setFlag?.('guide.world.step3', true);
        core.cb.onBack();
      },
    };
    core.paint.backHit = backHit;
    core.hits.push(backHit);
    // Base durability (D-CITY-8) rides in the header bar's free right side.
    this.renderPanel.renderHeaderDurability(hdr.headerH);

    core.contentX = marginLineX(w);
    const y = hdr.headerH + 8;

    // Resource bar
    let cy = this.renderPanel.renderResourceBar(y);
    cy += 8;

    // Build queue strip
    cy = this.renderPanel.renderBuildQueue(cy);
    cy += 8;

    // The 5 team slots pin to the bottom as one compact row; the building grid fills the gap above.
    const teamsTop = this.renderPanel.renderTeamsRow();

    // Building card grid (scrollable), bottom-limited so it never runs under the team row. Sets
    // core.paint.guideStep2 to tile 0's rect as a side effect, which the guide decision below reads back.
    core.paint.guideStep2 = null;
    this.renderPanel.renderBuildingGrid(cy, teamsTop - 8);

    // Snapshot before paintModal() takes `core.hits` over — this is what a modal dismissal
    // restores, and it deliberately excludes the guide's own action (paintModal appends that, so it
    // stays last in the table exactly as it did when the old single-pass render() spliced it in).
    core.paint.pageHits = core.hits.slice();

    // SLG opening guide chain (ONBOARDING_DESIGN §4.2): step2 rings the first grid card until any
    // card is opened, then step3 rings the way back out. Decided fresh every page paint — the
    // "both done" case explicitly hides so a stale ring from an earlier pass never lingers.
    //
    // Stashed as a closure rather than run inline, because paintModal() has to be able to replay
    // the decision without a page paint: opening a modal calls `guide.hide()`, and dismissing it
    // leaves the page standing exactly as it was, so nothing else would ever put the ring back.
    core.paint.guideRestore = (): void => {
      const step2 = core.cb.getFlag?.('guide.world.step2') ?? false;
      const step2Rect = core.paint.guideStep2;
      if (!step2 && step2Rect) {
        core.guide.showAt(step2Rect, t('guide.world.step2.body'), { w, h }, {
          onSkip: () => core.cb.setFlag?.('guide.world.step2', true),
        });
      } else if (!step2) {
        // step2 pending but tile 0 scrolled out of the viewport — nothing to ring.
        core.guide.hide();
      } else if (!(core.cb.getFlag?.('guide.world.step3') ?? false)) {
        core.guide.showAt(hdr.backRect, t('guide.world.step3.body'), { w, h }, {
          onSkip: () => core.cb.setFlag?.('guide.world.step3', true),
        });
      } else {
        core.guide.hide();
      }
    };
  }

  /**
   * Rebuilds `core.paint.modalLayer` and re-decides `core.hits` from whether a modal is up. Leaves
   * `pageLayer` untouched, so this is the whole cost of opening or dismissing one.
   *
   * Detail modal: popup-scale-to-80% convention, tap-outside-to-close. The page content sits
   * dimmed underneath — its hits are dropped (keeping only Back) so a tap there can't silently
   * switch buildings or trigger speedup instead of dismissing the modal. Opening a building card
   * (incl. academy/tech-tree) or the train tile routes through here.
   */
  private paintModal(): void {
    const core = this.core;
    if (core.destroyed) return;
    core.beginModal();
    const backHit = core.paint.backHit;

    if ((core.selectedBuilding || core.selectedTrain) && backHit) {
      core.hits = [backHit];
      // The page paint may have rung step2's ring on grid tile 0 — a modal opening supersedes it
      // outright (same reasoning as the hits reset above: nothing else on the page should be
      // tappable while it's up), so drop it before it can end up shadowing one of the modal's own
      // buttons via the currentAction() splice below.
      core.guide.hide();
      if (core.selectedBuilding) this.modals.renderDetailModal(core.selectedBuilding);
      else this.modals.renderTrainModal();
      return;
    }

    // No modal: the page's own hits are live again, and the ring the modal hid has to be re-decided
    // against the page still standing in pageLayer (dismissing a modal repaints nothing else).
    core.hits = core.paint.pageHits.slice();
    core.paint.guideRestore?.();
    // Splice whatever guide.showAt/showCard call left as the current action into this paint's own
    // hit list. Appended, not unshifted: the guide's bubble/skip glyph is always positioned outside
    // its target rect (positionBubble's above/below placement), so in practice it never overlaps
    // another hit — appending preserves the long-standing `hits[0] === backHit` assumption several
    // existing tests rely on (see cityScene.ui.ts's modal-hit-gating describe block).
    const guideHit = core.guide.currentAction();
    if (guideHit) core.hits.push(guideHit);
  }
}
