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
import { txt, tearDownChildren, buildPaperBackground, marginLineX } from '../render/sketchUi';
import { drawSceneHeader, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { FS } from '../render/fontScale';
import { buildDecorCLayer } from '../render/decorCLayer';
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
    this.core = new CitySceneCore(layout, input, cb, () => this.render(), guide);
    // Wrapper container, NOT `core.container` directly: render() below does a full
    // `tearDownChildren(core.container)` + rebuild on every state change, which would wipe out any
    // guide ring/bubble added straight into it. `guide.root` is a second, never-torn-down sibling
    // added after `core.container` so it renders on top (ONBOARDING_DESIGN §4.2 step2/step3).
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

  private render(): void {
    const core = this.core;
    if (core.destroyed) return;
    tearDownChildren(core.container);
    core.hits = [];
    core.resTotalLbls = [];
    const { w, h } = core;

    // No sidebar rail on this single-page scene, so the red binding line keeps its default
    // 9%-of-width position (marginLineX) and body content starts just right of it.
    core.container.addChild(buildPaperBackground('citybg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) core.container.addChild(decoC);

    const hdr = drawSceneHeader(core.container, w, h, t('city.title'), {
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
    core.hits.push(backHit);
    // Base durability (D-CITY-8) rides in the header bar's free right side.
    this.renderPanel.renderHeaderDurability(hdr.headerH);

    // SLG opening guide chain step3 (ONBOARDING_DESIGN §4.2): once step2 (renderBuildingGrid, below)
    // is done, highlight the way back out. Decided fresh every render() pass — the `!step2` case is
    // a deliberate no-op here (renderBuildingGrid owns showing its own ring then); the "both done"
    // case explicitly hides so a stale ring from an earlier pass never lingers.
    if (!(core.cb.getFlag?.('guide.world.step2') ?? false)) {
      // renderBuildingGrid (below) will call guide.showAt for its own target.
    } else if (!(core.cb.getFlag?.('guide.world.step3') ?? false)) {
      core.guide.showAt(hdr.backRect, t('guide.world.step3.body'), { w, h }, {
        onSkip: () => core.cb.setFlag?.('guide.world.step3', true),
      });
    } else {
      core.guide.hide();
    }

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

    // Building card grid (scrollable), bottom-limited so it never runs under the team row.
    this.renderPanel.renderBuildingGrid(cy, teamsTop - 8);

    // Detail modal (popup-scale-to-80% convention, tap-outside-to-close). The page content
    // sits dimmed underneath — drop its hits (keeping only Back) so a tap there can't
    // silently switch buildings or trigger speedup instead of dismissing the modal. Opening
    // a building card (incl. academy/tech-tree) or the train tile routes through here.
    if (core.selectedBuilding) {
      core.hits = [backHit];
      // renderBuildingGrid (above) may have just called guide.showAt for step2's ring on tile 0 —
      // a modal opening supersedes it outright (same reasoning as the hits reset above: nothing
      // else on the page should be tappable while it's up), so drop it before it can end up
      // shadowing one of the modal's own buttons via the currentAction() splice at the end of render().
      core.guide.hide();
      this.modals.renderDetailModal(core.selectedBuilding);
    } else if (core.selectedTrain) {
      core.hits = [backHit];
      core.guide.hide();
      this.modals.renderTrainModal();
    }

    // Busy overlay
    if (core.bt.busy) {
      const ov = new PIXI.Graphics();
      ov.beginFill(0x000000, 0.25);
      ov.drawRect(0, 0, w, h);
      ov.endFill();
      core.container.addChild(ov);
      const lbl = txt('…', FS.headline, 0xffffff, true);
      lbl.x = w / 2 - 15;
      lbl.y = h / 2 - 21;
      core.container.addChild(lbl);
    }

    // SLG opening guide chain (ONBOARDING_DESIGN §4.2): splice whatever guide.showAt/showCard call
    // above (here or in renderBuildingGrid) left as the current action into this render pass's own
    // hit list. Appended, not unshifted: the guide's bubble/skip glyph is always positioned outside
    // its target rect (positionBubble's above/below placement), so in practice it never overlaps
    // another hit — appending preserves the long-standing `hits[0] === backHit` assumption several
    // existing tests rely on (see cityScene.ui.ts's modal-hit-gating describe block).
    const guideHit = core.guide.currentAction();
    if (guideHit) core.hits.push(guideHit);
  }
}
