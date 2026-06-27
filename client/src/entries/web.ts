import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';

// 版本检查：玩家切回前台时对比 /version.json，发现新版本立即重载页面。
// 仅在生产包（NW_BUILD_VERSION != '0.0.0'）生效，开发环境跳过。
const CURRENT_VERSION = (globalThis as { __NW_BUILD_VERSION__?: string }).__NW_BUILD_VERSION__ ?? '0.0.0';
if (CURRENT_VERSION !== '0.0.0') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    fetch('/version.json?_=' + Date.now(), { cache: 'no-store' })
      .then(r => r.json())
      .then(({ v }: { v: string }) => { if (v !== CURRENT_VERSION) window.location.reload(); })
      .catch(() => { /* 离线 / 网络错误，忽略 */ });
  });
}

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
