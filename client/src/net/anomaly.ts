// Full-coverage client anomaly reporting channel (complementary to FEATURE_FLAGS_DESIGN §9 "targeted client log collection").
//
// Targeted collection only retrieves logs for publicIds on the allowlist; this channel is the opposite —
// **any** client that encounters the following anomalies reports directly to metaserver → Loki,
// enabling field anomaly detection across all users (no prior allowlisting required):
//   mem        JS heap exceeded threshold (fed in via MemoryMonitor bypass)
//   cpu        main thread sustained saturation / persistent low FPS (PerfMonitor)
//   webgl_lost WebGL context lost (critical signal for black-screen class failures)
//   anr        main loop frozen / long stall (watchdog)
//   jserror    uncaught exception / Promise rejection (log.ts errorSink bypass)
//   crash      previous session ended abnormally (crash sentinel reports on next startup)
//
// Four anti-abuse gates: ① per-type cooldown (high-frequency signals coalesced every 60s) ② per-session total cap ③ per-entry detail truncation
// ④ server-side per-IP rate limiting (service.ts). No baseUrl / Loki unreachable → silently dropped, never impacts the player.
//
// Two crash capture paths:
//   ① On page exit (pagehide / visibilitychange→hidden), use an uncredentialed keepalive fetch (survives page unload) to eagerly
//      flush the queue + recent breadcrumbs, catching "soft crash / frozen-then-closed / error-then-refresh" type crashes that
//      **have a cleanup opportunity**. (Deliberately NOT navigator.sendBeacon — see reporter.ts's flushBeacon for the CORS rationale.)
//   ② True hard crashes (OOM / renderer process killed / tab killed) have no reporting opportunity at the moment —
//      instead use a localStorage "session sentinel": write a marker on startup + update a heartbeat timestamp,
//      mark cleanExit on exit; on the next startup, if the previous sentinel has a marker but no cleanExit,
//      the previous session is judged to have crashed, and a crash event is reported with the approximate crash time + last error.
//
// Public entry point only (claudedocs/client-modules.md "单文件 500 行收敛" form①) — pure re-exports,
// zero logic of its own. Split across ./anomaly/{reporter,anrContext,crashSentinel,watchers}.ts, each
// importing only from its siblings (never back from here), so this split stays acyclic.
export type { AnomalyType } from './anomaly/reporter';
export { anomalyReporter, reportAnomaly, setAnomalyStorage, readBuildVersion } from './anomaly/reporter';
export type { DeviceClass, MomentContext, OrientationName } from './anomaly/deviceContext';
export {
  deviceClass, devicePixelRatio, deviceMemoryGb,
  orientation, momentContext, installRotationWatch, lastRotationAt,
} from './anomaly/deviceContext';
export {
  setActiveScene, getActiveScene, setAnrContextProvider,
  recordFrameSample, recordConstructSample, recordRenderSample,
} from './anomaly/anrContext';
export { initCrashSentinel } from './anomaly/crashSentinel';
export { installAnomalyWatchers, type AnomalyWatchersOpts } from './anomaly/watchers';
