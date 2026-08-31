import { startApp } from '../app';
import { CrazyGamesPlatform } from '../platform/crazygames/CrazyGamesPlatform';
import { setAudioBus } from '../audio/audioBus';
import { WebAudioBus } from '../platform/web/WebAudioBus';

// Same WebAudio backend as entries/web.ts — CrazyGames runs in a real browser engine
// (AUDIO_DESIGN.md §3 groups the two).
setAudioBus(new WebAudioBus());

startApp(new CrazyGamesPlatform('game-canvas')).catch(console.error);
