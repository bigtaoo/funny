import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';

startApp(new WebPlatform('game-canvas')).catch(console.error);
