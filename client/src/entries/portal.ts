import { startApp } from '../app';
import { PortalPlatform } from '../platform/portal/PortalPlatform';
import { setAudioBus } from '../audio/audioBus';
import { WebAudioBus } from '../platform/web/WebAudioBus';
import { setJudgeExecutor } from '../net/judgeExecutor';
import { createWorkerJudgeExecutor } from '../platform/web/workerJudge';

// Entry shared by the self-test web-portal targets `itch` and `newgrounds` (design/game/WEB_PORTALS.md);
// webpack.config.js maps both TARGETs here. Same browser runtime as entries/web.ts.
setAudioBus(new WebAudioBus());

const workerJudge = createWorkerJudgeExecutor();
if (workerJudge) setJudgeExecutor(workerJudge);

startApp(new PortalPlatform('game-canvas')).catch(console.error);
