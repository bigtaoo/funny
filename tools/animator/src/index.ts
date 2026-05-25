/**
 * Entry point.
 * Initializes all modules in dependency order and wires cross-module concerns.
 */
import { state } from './state';
import { initRenderer, renderScene, resizeRenderer, drawGrid } from './renderer';
import { initInteraction } from './interaction';
import { initTimeline, renderTimeline } from './timeline';
import { initUI, selectAnimation, renderAnimList, renderBoneInfo, updateTimeDisplay } from './ui';
import { initIO } from './io';
import { clonePreset } from './presets';
import {
  addKeyframeAtCurrentTime, deleteKeyframeAtCurrentTime,
  togglePlayback, stopPlayback, applyAnimationAtTime,
} from './animation';
import { on, emit, TIME_CHANGE, ANIM_SELECT, BONE_SELECT, STATUS } from './events';

// ── 1. Renderer (PixiJS) ──────────────────────────────────────────────────────

const canvasWrap = document.getElementById('canvas-wrap')!;
const pixiApp   = initRenderer(canvasWrap);

// Render loop: PixiJS ticker drives renderScene every frame.
pixiApp.ticker.add(() => renderScene());

// Timeline loop: separate RAF loop so it runs independently of PIXI.
(function timelineLoop() {
  renderTimeline();
  requestAnimationFrame(timelineLoop);
})();

// ── 2. Other modules ──────────────────────────────────────────────────────────

initInteraction();   // attaches mouse events to the PixiJS canvas
initTimeline();      // attaches events to the timeline canvas
initUI();            // wires all HTML controls and subscribes to events
initIO(name => {     // wires export/import buttons; called on successful import
  renderAnimList();
  selectAnimation(name);
});

// ── 3. Cross-module event subscriptions ──────────────────────────────────────

// When bone selection changes, re-render info panel (already handled in ui.ts)
// and ensure the timeline label column updates (already handled in renderTimeline).

// When animation changes, sync timeline's duration input.
on(ANIM_SELECT, () => {
  const clip = state.animations[state.currentAnim];
  if (clip) {
    const durInput = document.getElementById('inp-duration') as HTMLInputElement;
    durInput.value = clip.duration.toFixed(2);
  }
});

// ── 4. Keyboard shortcuts ─────────────────────────────────────────────────────

document.addEventListener('animator:key', e => {
  const key = (e as CustomEvent<string>).detail;
  switch (key) {
    case 'Space':     togglePlayback();               break;
    case 'KeyS':      stopPlayback();                 break;
    case 'KeyK':      addKeyframeAtCurrentTime();     break;
    case 'Delete':    deleteKeyframeAtCurrentTime();  break;
    case 'Backspace': deleteKeyframeAtCurrentTime();  break;
    case 'ArrowLeft': {
      state.currentTime = Math.max(0, state.currentTime - 0.05);
      applyAnimationAtTime(state.currentTime);
      emit(TIME_CHANGE);
      break;
    }
    case 'ArrowRight': {
      const dur = parseFloat((document.getElementById('inp-duration') as HTMLInputElement).value) || 0.5;
      state.currentTime = Math.min(dur, state.currentTime + 0.05);
      applyAnimationAtTime(state.currentTime);
      emit(TIME_CHANGE);
      break;
    }
  }
});

// ── 5. Resize handling ────────────────────────────────────────────────────────

new ResizeObserver(() => {
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  resizeRenderer(w, h);
  drawGrid();
}).observe(canvasWrap);

// ── 6. Load default presets and select 'walk' ─────────────────────────────────

(['idle', 'walk', 'attack', 'hurt', 'death', 'spawn'] as const).forEach(name => {
  state.animations[name] = clonePreset(name)!;
});

renderAnimList();
selectAnimation('walk');
updateTimeDisplay();
emit(STATUS, 'Ready — click a bone to select, drag to rotate');
