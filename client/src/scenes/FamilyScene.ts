// FamilyScene — SLG family management scene (S8-4). Thin assembly file.
//
// The scene is split by domain — each part lives in ./FamilyScene/*.ts and is composed here over
// FamilySceneCore (./FamilyScene/core.ts, which owns all instance state + the layer scaffold +
// static header + shared confirm-modal/toast/error primitives + member-profile popup +
// pointer-input/lifecycle, but NOT the render() dispatcher — see core.ts's header comment). To add
// a handler: find the matching domain class (data / actions / input / render) or add a new one —
// do NOT grow this file. FamilySceneCallbacks / FamilySceneView are re-exported so existing
// importers (`from './FamilyScene'`) keep resolving to this file, not the directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher lives here since
// only this assembly knows about every domain instance (Core takes a `render` callback instead of
// owning render() itself); the initial loadData() call also moves here, since Data's completion
// calls `core.render()` which needs RenderPanel to exist. See ./FamilyScene/core.ts's file-header
// comment for how the one genuine bidirectional dependency found during the conversion (the old
// actions.ts↔input.ts pair around sending a channel message) was resolved.
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { FamilySceneCore } from './FamilyScene/core';
import type { FamilySceneCallbacks } from './FamilyScene/core';
import { DataPanel } from './FamilyScene/data';
import { ActionsPanel } from './FamilyScene/actions';
import { InputPanel } from './FamilyScene/input';
import { RenderPanel } from './FamilyScene/render';
import { preloadIconArt } from '../render/icons';

export type { FamilySceneCallbacks, FamilySceneView } from './FamilyScene/core';

/**
 * FamilyScene — the SLG family management scene registered against SceneManager, thin assembly
 * over the per-domain composition (see the file-header comment above).
 */
export class FamilyScene implements Scene {
  readonly container;

  private readonly core: FamilySceneCore;
  private readonly data: DataPanel;
  private readonly actions: ActionsPanel;
  private readonly input: InputPanel;
  private readonly renderPanel: RenderPanel;

  constructor(layout: ILayout, input: InputManager, cb: FamilySceneCallbacks) {
    this.core = new FamilySceneCore(layout, input, cb, () => this.render(), () => this.actions.openEmblemPicker());
    this.container = this.core.container;
    this.data = new DataPanel(this.core);
    this.actions = new ActionsPanel(this.core, this.data);
    this.input = new InputPanel(this.core, this.data);
    this.renderPanel = new RenderPanel(this.core, this.actions, this.input);

    // Paint the rail + loading state on the same frame the scene mounts, so switching to the
    // family tab shows the chrome instantly instead of a blank body while loadData()'s network
    // round-trips are in flight (the "tab switch takes several seconds" complaint).
    this.render();
    // Warm the rail/tab/title glyph PNGs and redraw once they land — the same one-liner
    // CardScene/EquipmentScene/SectScene use, for the same reason: buildRasterTabIcon draws NOTHING
    // while its texture is still decoding, and this page is reachable without passing through
    // LobbyScene (which warms them for everything entered from the lobby). It used to self-heal by
    // accident, off the per-frame scroll/caret/busy renders that ./FamilyScene/repaint.ts removed.
    void preloadIconArt().then(() => this.render());

    void this.data.loadData();
  }

  update(dt: number): void {
    this.core.update(dt);
  }

  destroy(): void {
    this.core.destroy();
  }

  /** applyFamilyMsg forwards to DataPanel — see FamilySceneView (gateway push handle). */
  applyFamilyMsg(msg: Parameters<DataPanel['applyFamilyMsg']>[0]): void {
    this.data.applyFamilyMsg(msg);
  }

  private render(): void {
    const core = this.core;
    if (core.destroyed) return;
    core.beginRender();
    core.drawRail();
    switch (core.mode) {
      case 'loading': this.renderPanel.renderLoading(); break;
      case 'noFamily': this.renderPanel.renderNoFamily(); break;
      case 'create': this.renderPanel.renderCreate(); break;
      case 'myFamily': this.renderPanel.renderMyFamily(); break;
    }
  }
}
