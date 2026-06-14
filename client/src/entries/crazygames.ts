import { startApp } from '../app';
import { CrazyGamesPlatform } from '../platform/crazygames/CrazyGamesPlatform';

startApp(new CrazyGamesPlatform('game-canvas')).catch(console.error);
