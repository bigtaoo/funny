// SectScene — SLG sect management scene (S8-4b, C6). Thin assembly file.
//
// The scene is split by domain — each part lives in ./SectScene/*.ts and is composed here over
// SectSceneCore (./SectScene/core.ts, which owns all instance state + the layer scaffold + static
// header + permission getters + shared close-modal/toast/error primitives + pointer-input/lifecycle,
// but NOT the render() dispatcher — see core.ts's header comment). To add a handler: find the
// matching domain class (data / render / input-overlay / actions / modals) or add a new one — do NOT
// grow this file. SectSceneCallbacks / SectSceneView are re-exported so existing importers
// (`from './SectScene'`) keep resolving to this file, not the directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher lives here since
// only this assembly knows about every domain class (Core takes a `render` callback instead of
// owning render() itself); the initial loadData() call also moves here, since Data's completion
// calls `core.render()` which needs RenderPanel to exist.
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { SectSceneCore } from './SectScene/core';
import type { SectSceneCallbacks } from './SectScene/core';
import { DataPanel } from './SectScene/data';
import { ModalsPanel } from './SectScene/modals';
import { ActionsPanel } from './SectScene/actions';
import { InputPanel } from './SectScene/input';
import { RenderPanel } from './SectScene/render';
import { preloadIconArt } from '../render/icons';

export type { SectSceneCallbacks, SectSceneView } from './SectScene/core';

/**
 * SectScene — the SLG sect management scene registered against SceneManager, thin assembly over
 * the per-domain composition (see the file-header comment above).
 */
export class SectScene implements Scene {
  readonly container;

  private readonly core: SectSceneCore;
  private readonly data: DataPanel;
  private readonly modals: ModalsPanel;
  private readonly actions: ActionsPanel;
  private readonly input: InputPanel;
  private readonly renderPanel: RenderPanel;

  constructor(layout: ILayout, input: InputManager, cb: SectSceneCallbacks) {
    this.core = new SectSceneCore(layout, input, cb, () => this.render());
    this.container = this.core.container;
    this.data = new DataPanel(this.core);
    this.modals = new ModalsPanel(this.core);
    this.actions = new ActionsPanel(this.core, this.data, this.modals);
    this.input = new InputPanel(this.core, this.actions);
    this.renderPanel = new RenderPanel(this.core, this.actions, this.input);

    // The header's alliance buttons are drawn from Core itself (renderHeader runs inside Core's own
    // constructor, before any domain instance exists) — wire the lazy hooks now that ActionsPanel
    // exists, before the first real render.
    this.core.allianceHooks = {
      openManageAllies: () => this.actions.openManageAllies(),
      openAllyList: () => this.actions.openAllyList(),
      openAlliesView: () => this.actions.openAlliesView(),
    };
    this.core.emblemHooks = { openEmblemPicker: () => this.actions.openEmblemPicker() };

    // Warm the rail/title glyph PNGs and redraw once they land — the same one-liner CardScene/
    // EquipmentScene use, for the same reason: buildRasterTabIcon draws NOTHING while its texture is
    // still decoding, and this page is reachable without passing through LobbyScene (which warms them
    // for everything entered from the lobby). It used to self-heal by accident, off the per-frame
    // scroll/caret/busy renders that ./SectScene/repaint.ts has now removed.
    void preloadIconArt().then(() => this.render());

    void this.data.loadData();
  }

  update(dt: number): void {
    this.core.update(dt);
  }

  destroy(): void {
    this.core.destroy();
  }

  /** applySectMsg forwards to DataPanel — see SectSceneView (gateway push handle). */
  applySectMsg(msg: Parameters<DataPanel['applySectMsg']>[0]): void {
    this.data.applySectMsg(msg);
  }

  /** See SectSceneView.getFamily/getSect — read by nav/world.ts's onNavTab hand-off. */
  getFamily(): SectSceneCore['family'] {
    return this.core.family;
  }

  getSect(): SectSceneCore['sect'] {
    return this.core.sect;
  }

  private render(): void {
    const core = this.core;
    // The single throttle point for every redraw entry (菜单场景生命周期契约) — core's
    // onSaveChanged already guards itself, but the guard belongs here so any future deferred
    // redraw is covered without having to remember.
    if (core.destroyed) return;
    core.beginRender();
    core.drawRail();
    switch (core.mode) {
      case 'loading': this.renderPanel.renderLoading(); break;
      case 'noSect': this.renderPanel.renderNoSect(); break;
      case 'create': this.renderPanel.renderCreate(); break;
      case 'mySect': this.renderPanel.renderMySect(); break;
    }
  }
}
