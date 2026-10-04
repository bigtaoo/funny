import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';
import { setAudioBus } from '../audio/audioBus';
import { WebAudioBus } from '../platform/web/WebAudioBus';
import { setJudgeExecutor } from '../net/judgeExecutor';
import { createWorkerJudgeExecutor } from '../platform/web/workerJudge';

// Audio device (AUDIO_DESIGN.md §3). Installed the same way as setAssetIO in entries/wechat.ts:
// a module-level seam rather than an IPlatform member — see audio/audioBus.ts for why.
setAudioBus(new WebAudioBus());

// Peer-judge recomputes run in a background Web Worker (net/judgeExecutor.ts); WeChat keeps main-thread slices.
const workerJudge = createWorkerJudgeExecutor();
if (workerJudge) setJudgeExecutor(workerJudge);

// Version check: when the player returns to the foreground, compare against /version.json and
// reload immediately if a newer version is detected.
// Only active in production builds (NW_BUILD_VERSION != '0.0.0'); skipped in development.
const CURRENT_VERSION = (globalThis as { __NW_BUILD_VERSION__?: string }).__NW_BUILD_VERSION__ ?? '0.0.0';
if (CURRENT_VERSION !== '0.0.0') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    fetch('/version.json?_=' + Date.now(), { cache: 'no-store' })
      .then(r => r.json())
      .then(({ v }: { v: string }) => { if (v !== CURRENT_VERSION) window.location.reload(); })
      .catch(() => { /* offline / network error, ignore */ });
  });
}

// `?sketch` boots the procedural brush-stroke sampler instead of the game,
// so the notebook look can be validated in isolation (see render/sketchDemo.ts).
if (/[?&]sketch\b/.test(window.location.search)) {
  import('../render/sketchDemo').then(({ startSketchDemo }) => {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    startSketchDemo(canvas);
  }).catch(console.error);
} else if (/[?&]unitlab\b/.test(window.location.search)) {
  // `?unitlab` plays each frame-sheet unit next to its bone rig (see render/unitLab.ts).
  import('../render/unitLab').then(({ startUnitLab }) => {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    return startUnitLab(canvas);
  }).catch(console.error);
} else {
  startApp(new WebPlatform('game-canvas')).catch(console.error);
}
