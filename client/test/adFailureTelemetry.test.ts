/**
 * adFailureTelemetry.test.ts — a failed rewarded ad has to say WHY, all the way to Loki.
 *
 * On 2026-09-10 the first real device run of the AdMob bridge produced "暂无可看的广告" on every
 * press, and there was no way to find out what had actually happened. Three separate places threw
 * the reason away, each of them reasonably:
 *
 *   1. Swift settled the promise with the bare word `ad_not_ready` — the real error only reached
 *      an NSLog, and this code runs exclusively on signed device builds with no Mac attached.
 *   2. `WebPlatform.showRewardedAd`'s `.catch(() => null)` dropped whatever the bridge did say.
 *   3. DailyScene turned null into one generic sentence, which is all the player (and the only
 *      person who can reproduce it) ever saw.
 *
 * So AdMob no-fill — expected, harmless, and the overwhelmingly likely answer until the app is live
 * on the App Store — looked exactly like a wrong ad unit id or a bridge that never loaded.
 *
 * These are FILE assertions, not behavioural ones, and deliberately so: `WebPlatform` needs a DOM
 * and both vitest configs here run `environment: 'node'`, while Swift compiles only in CI. Same
 * species as adsPrivacyPosture.test.ts and iosStoreKit2.test.ts, for the same reason — the thing
 * worth protecting lives between files that no runtime test in this repo can reach.
 *
 * The one runtime half that CAN be tested lives on the server:
 * `server/metaserver/test/clientLog.test.ts` asserts a `type: 'ad'` event survives the Loki
 * allowlist as `type=ad` instead of collapsing to `type=other`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLIENT_DIR = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.resolve(CLIENT_DIR, p), 'utf8');

const REPORTER = 'src/net/anomaly/reporter.ts';
const WEB_PLATFORM = 'src/platform/web/WebPlatform.ts';
const APP_DELEGATE = 'ios/App/App/AppDelegate.swift';
const SERVER_CLIENT_LOG = '../server/metaserver/src/clientLog.ts';

describe('the client and server anomaly-type lists agree', () => {
  // These two lists are the whole reporting contract, they live in different workspaces, and they
  // fail SILENTLY when they drift: an unlisted type is not rejected, it is rewritten to `type=other`
  // (buildAnomalyLine), so the events keep arriving and every dashboard query for them keeps
  // returning nothing. Nobody would think to look.
  const clientTypes = (): string[] => {
    const m = read(REPORTER).match(/export type AnomalyType = ([^;]+);/);
    expect(m, 'AnomalyType union not found — did reporter.ts move?').toBeTruthy();
    return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  };
  const serverTypes = (): string[] => {
    const m = read(SERVER_CLIENT_LOG).match(/const ALLOWED_ANOMALY_TYPES = new Set\(\[([^\]]+)\]\)/);
    expect(m, 'ALLOWED_ANOMALY_TYPES not found — did clientLog.ts move?').toBeTruthy();
    return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  };

  it('every type the client can report is one the server keeps', () => {
    expect([...clientTypes()].sort()).toEqual([...serverTypes()].sort());
  });

  it("'ad' is one of them", () => {
    expect(clientTypes()).toContain('ad');
    expect(serverTypes()).toContain('ad');
  });

  it("'ad' has no cooldown — it is user-initiated, and repeats are the evidence", () => {
    // A cooldown here would hide the one pattern that matters: the same failure on every press.
    expect(read(REPORTER)).toMatch(/ad:\s*0\b/);
  });
});

describe('a failed rewarded ad reports its reason', () => {
  it('WebPlatform does not swallow the native rejection', () => {
    const src = read(WEB_PLATFORM);
    // The exact shape of the bug: a catch that discards its argument.
    expect(src).not.toMatch(/showRewarded\([^)]*\)\.catch\(\(\)\s*=>\s*null\)/);
    expect(src).toMatch(/reportAnomaly\('ad',/);
  });

  it('the Swift bridge sends the load error, not just "ad_not_ready"', () => {
    const swift = read(APP_DELEGATE);
    expect(swift).toMatch(/lastAdLoadError/);
    // `ad_not_ready` must be interpolated with a reason — never settled as a bare literal again.
    expect(swift).not.toMatch(/payload:\s*"ad_not_ready"/);
    expect(swift).toMatch(/ad_not_ready:\s*\\\(/);
  });

  it('the Swift bridge records the error code, which is what separates no-fill from misconfiguration', () => {
    // GADErrorCode 3 = no fill (expected pre-launch), 1 = invalid request (wrong ad unit id),
    // 2 = network, 0 = internal. Without the code every one of them reads the same.
    const swift = read(APP_DELEGATE);
    expect(swift).toMatch(/error as NSError/);
    expect(swift).toMatch(/ns\.code/);
  });
});
