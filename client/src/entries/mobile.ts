import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';
import { checkOtaUpdate } from '../platform/ota';
import { setAudioBus } from '../audio/audioBus';
import { WebAudioBus } from '../platform/web/WebAudioBus';
import { setJudgeExecutor } from '../net/judgeExecutor';
import { createWorkerJudgeExecutor } from '../platform/web/workerJudge';

// Native (Capacitor iOS/Android) entry. The same WebPlatform runs inside the WKWebView:
// it detects the native StoreKit bridge injected on `window.NWBilling` by the shell
// (AppDelegate.swift) and routes coin recharges to Apple IAP (iapKind → 'apple').
//
// Unlike the web entry, there is no /version.json foreground-reload poll (WKWebView can't reload
// the whole page from a remote origin). JS/asset updates instead arrive via OTA hot-update
// (Capgo, IOS_RELEASE.md §11): checkOtaUpdate() confirms this bundle booted, then downloads any
// newer bundle in the background and arms it for the next cold start — decoupled from App Store
// binary updates, which remain the only channel for native changes.
// Same WebAudio backend as the web entry: the WKWebView is a real browser engine. iOS is the
// strictest of the autoplay gates (AUDIO_DESIGN.md §5) — WebAudioBus resumes on the first
// window-level gesture, which covers it.
setAudioBus(new WebAudioBus());

// Peer-judge recomputes run in a background Web Worker (net/judgeExecutor.ts); WeChat keeps main-thread slices.
const workerJudge = createWorkerJudgeExecutor();
if (workerJudge) setJudgeExecutor(workerJudge);

startApp(new WebPlatform('game-canvas')).catch(console.error);

// Fire-and-forget: never blocks or interrupts the running game (see ota.ts).
void checkOtaUpdate();
