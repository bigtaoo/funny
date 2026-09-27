import { startApp } from '../app';
import { CrazyGamesPlatform } from '../platform/crazygames/CrazyGamesPlatform';
import { setAudioBus } from '../audio/audioBus';
import { WebAudioBus } from '../platform/web/WebAudioBus';
import { setJudgeExecutor } from '../net/judgeExecutor';
import { createWorkerJudgeExecutor } from '../platform/web/workerJudge';

// Same WebAudio backend as entries/web.ts — CrazyGames runs in a real browser engine
// (AUDIO_DESIGN.md §3 groups the two).
setAudioBus(new WebAudioBus());

// Peer-judge recomputes run in a background Web Worker (net/judgeExecutor.ts); WeChat keeps main-thread slices.
const workerJudge = createWorkerJudgeExecutor();
if (workerJudge) setJudgeExecutor(workerJudge);

startApp(new CrazyGamesPlatform('game-canvas')).catch(console.error);
