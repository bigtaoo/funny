import { EventBus }              from './core/EventBus';
import { AppState }              from './core/AppState';
import { CommandManager }        from './core/CommandManager';
import { Skeleton }              from './skeleton/Skeleton';
import { AtlasController }       from './atlas/AtlasController';
import { AnimationController }   from './animation/AnimationController';
import { Renderer }              from './rendering/Renderer';
import { InteractionController } from './interaction/InteractionController';
import { TimelineView }          from './timeline/TimelineView';
import { AnimListPanel }         from './ui/AnimListPanel';
import { BoneInspectorPanel }    from './ui/BoneInspectorPanel';
import { AtlasPanel }            from './ui/AtlasPanel';
import { ToolbarPanel }          from './ui/ToolbarPanel';
import { StatusBar }             from './ui/StatusBar';
import { IOController }          from './io/IOController';
import type { AppEvents }        from './core/EventBus';

export class App {
  constructor(rootEl: HTMLElement) {
    // ── 1. Core infrastructure ──────────────────────────────────────────────
    const bus        = new EventBus<AppEvents>();
    const state      = new AppState(bus);
    const cmdManager = new CommandManager(bus);

    // ── 2. Renderer ─────────────────────────────────────────────────────────
    const canvasWrap = rootEl.querySelector<HTMLElement>('#canvas-wrap')!;
    const renderer   = new Renderer(canvasWrap);

    // Set initial root position
    const { w, h } = renderer.logicalSize;
    state.setRootPos(w / 2, h / 2 + 30);

    // ── 3. Controllers ──────────────────────────────────────────────────────
    const atlasCtrl   = new AtlasController(bus, cmdManager);
    const animCtrl    = new AnimationController(bus, state);
    new InteractionController(renderer, bus, state, animCtrl, cmdManager);

    // ── 4. Timeline ─────────────────────────────────────────────────────────
    const tlCanvas    = rootEl.querySelector<HTMLCanvasElement>('#timeline-canvas')!;
    const tlLabels    = rootEl.querySelector<HTMLElement>('#tl-labels')!;
    const timelineView = new TimelineView(tlCanvas, tlLabels, bus, state, animCtrl, cmdManager);

    // ── 5. UI panels ────────────────────────────────────────────────────────
    new AnimListPanel(
      rootEl.querySelector<HTMLElement>('#anim-list')!,
      bus, animCtrl, cmdManager,
    );
    new BoneInspectorPanel(
      rootEl.querySelector<HTMLElement>('.right-panel')!,
      bus, state, animCtrl, atlasCtrl, cmdManager,
    );
    new AtlasPanel(
      rootEl.querySelector<HTMLElement>('#atlas-panel')!,
      bus, atlasCtrl,
    );
    new ToolbarPanel(
      rootEl.querySelector<HTMLElement>('.toolbar')!,
      bus, state, animCtrl, cmdManager,
    );
    new StatusBar(
      rootEl.querySelector<HTMLElement>('#status-text')!,
      bus,
    );
    new IOController(state, animCtrl, atlasCtrl, cmdManager, bus);

    // ── 6. Resize handling ───────────────────────────────────────────────────
    const resizeObs = new ResizeObserver(() => {
      const { w: nw, h: nh } = renderer.logicalSize;
      renderer.resize(nw, nh);
      state.setRootPos(nw / 2 + state.panOffsetX, nh / 2 + 30 + state.panOffsetY);
    });
    resizeObs.observe(canvasWrap);

    // ── 7. Main render loop (PixiJS ticker) ──────────────────────────────────
    renderer.pixiApp.ticker.add(() => {
      const frame     = animCtrl.getCurrentFrame();
      const worldPose = Skeleton.computeFK(state.rootX, state.rootY, frame);

      renderer.draw({
        worldPose,
        boneTransforms:      frame,
        bindings:            state.boneBindings,
        getTexture:          id => atlasCtrl.getTexture(id),
        previewMode:         state.previewMode,
        selectedBone:        state.selectedBone,
        showJoints:          state.showJoints,
        showSkeletonOverlay: state.showSkeletonOverlay,
        showGuide:           state.showGuide,
        showPivots:          state.showPivots,
        backgroundColor:     state.backgroundColor,
        rootX:               state.rootX,
        rootY:               state.rootY,
        onionData:           state.showOnion
          ? animCtrl.getOnionFrames().map(f => ({
              worldPose:      Skeleton.computeFK(state.rootX, state.rootY, f),
              boneTransforms: f,
            }))
          : [],
      });
    });

    // ── 8. Timeline loop ────────────────────────────────────────────────────
    const tlLoop = () => { timelineView.render(); requestAnimationFrame(tlLoop); };
    requestAnimationFrame(tlLoop);

    // ── 9. Load presets ──────────────────────────────────────────────────────
    for (const name of ['idle', 'walk', 'attack', 'hurt', 'death', 'spawn'] as const) {
      animCtrl.loadPreset(name);
    }
    animCtrl.selectClip('walk');

    bus.emit('status', 'Ready');
  }
}
