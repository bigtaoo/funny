import { EventBus }              from './core/EventBus';
import { AppState }              from './core/AppState';
import { CommandManager }        from './core/CommandManager';
import { Skeleton }              from './skeleton/Skeleton';
import { ImageController }       from './images/ImageController';
import { DEFAULT_ZORDER, BONE_SLOTS } from './images/ImageController';
import { AnimationController }   from './animation/AnimationController';
import { Renderer }              from './rendering/Renderer';
import { InteractionController } from './interaction/InteractionController';
import { TimelineView }          from './timeline/TimelineView';
import { AnimListPanel }         from './ui/AnimListPanel';
import { BoneInspectorPanel }    from './ui/BoneInspectorPanel';
import { ImagePanel }            from './ui/ImagePanel';
import { AttachmentPanel }       from './ui/AttachmentPanel';
import { ToolbarPanel }          from './ui/ToolbarPanel';
import { StatusBar }             from './ui/StatusBar';
import { ResizablePanels }       from './ui/ResizablePanels';
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

    const { w, h } = renderer.logicalSize;
    state.setRootPos(w / 2, h / 2 + 30);

    // ── 3. Controllers ──────────────────────────────────────────────────────
    const imageCtrl  = new ImageController(bus);
    const animCtrl   = new AnimationController(bus, state);
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
      bus, state, animCtrl, imageCtrl, cmdManager,
    );
    new ImagePanel(
      rootEl.querySelector<HTMLElement>('#image-panel')!,
      bus, imageCtrl, state,
    );
    new ToolbarPanel(
      rootEl.querySelector<HTMLElement>('.toolbar')!,
      bus, state, animCtrl, cmdManager,
    );
    new StatusBar(
      rootEl.querySelector<HTMLElement>('#status-text')!,
      bus,
    );
    new AttachmentPanel(
      rootEl.querySelector<HTMLElement>('#attachment-panel')!,
      bus, state,
    );
    new IOController(state, animCtrl, imageCtrl, cmdManager, bus);
    new ResizablePanels(rootEl);

    // ── 6. Auto-binding when images are loaded ───────────────────────────────
    // When an image is loaded for a bone slot, create a default binding if
    // none exists; then mark sprite order as dirty for re-sort.
    bus.on('images:change', (slotId: string) => {
      if ((BONE_SLOTS as readonly string[]).includes(slotId)) {
        if (!state.getBinding(slotId) && imageCtrl.getTexture(slotId)) {
          state.setBinding(slotId, {
            anchorX:  0.5,
            anchorY:  0.5,
            flipX:    false,
            zOrder:   DEFAULT_ZORDER[slotId] ?? 0,
            offsetX:  0,
            offsetY:  0,
            rotation: 0,
            scaleX:   1,
            scaleY:   1,
          });
        }
        renderer.markSpriteOrderDirty();

        if (state.previewMode !== 'sprite') {
          state.setPreviewMode('sprite');
          bus.emit('status', 'Image loaded — switched to Sprite mode');
        }
      }
    });

    // Re-sort whenever a binding's zOrder changes
    bus.on('binding:change', () => renderer.markSpriteOrderDirty());

    // ── 7. Resize handling ───────────────────────────────────────────────────
    const resizeObs = new ResizeObserver(entries => {
      const { width: nw, height: nh } = entries[0].contentRect;
      if (nw === 0 || nh === 0) return;
      const { w: oldW, h: oldH } = renderer.logicalSize;
      const dx = oldW > 0 ? state.rootX - oldW / 2 : 0;
      const dy = oldH > 0 ? state.rootY - (oldH / 2 + 30) : 0;
      renderer.resize(nw, nh);
      state.setRootPos(nw / 2 + dx, nh / 2 + 30 + dy);
    });
    resizeObs.observe(canvasWrap);

    // ── 8. Main render loop ──────────────────────────────────────────────────
    renderer.pixiApp.ticker.add(() => {
      // In Skin mode render the rest pose (all rotations = 0) so the artist
      // always adjusts binding parameters against the neutral T-pose.
      const frame     = state.editorMode === 'skin'
        ? new Map<string, import('./core/types').ResolvedBoneTransform>()
        : animCtrl.getCurrentFrame();
      const worldPose = Skeleton.computeFK(state.rootX, state.rootY, frame, state.boneLengthScales);

      renderer.draw({
        worldPose,
        boneTransforms:      frame,
        bindings:            state.boneBindings,
        getTexture:          (boneId: string) => imageCtrl.getTexture(boneId),
        attachmentPoints:    state.attachmentPoints,
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
              worldPose:      Skeleton.computeFK(state.rootX, state.rootY, f, state.boneLengthScales),
              boneTransforms: f,
            }))
          : [],
      });
    });

    // ── 9. Timeline loop ────────────────────────────────────────────────────
    const tlLoop = () => { timelineView.render(); requestAnimationFrame(tlLoop); };
    requestAnimationFrame(tlLoop);

    // ── 10. Load presets ─────────────────────────────────────────────────────
    for (const name of ['idle', 'walk', 'attack', 'hurt', 'death', 'spawn'] as const) {
      animCtrl.loadPreset(name);
    }
    animCtrl.selectClip('walk');

    bus.emit('status', 'Ready');
  }
}
