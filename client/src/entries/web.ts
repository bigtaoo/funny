import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';

// `?sketch` boots the procedural brush-stroke sampler instead of the game,
// so the notebook look can be validated in isolation (see render/sketchDemo.ts).
if (/[?&]sketch\b/.test(window.location.search)) {
  import('../render/sketchDemo').then(({ startSketchDemo }) => {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    startSketchDemo(canvas);
  }).catch(console.error);
} else {
  startApp(new WebPlatform('game-canvas')).catch(console.error);
}
