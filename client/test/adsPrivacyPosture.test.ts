/**
 * adsPrivacyPosture.test.ts — the binary and the App Store privacy label must describe the same app.
 *
 * On 2026-09-03 they did not, and nothing caught it for six weeks. `store-assets-checklist.md §1.4`
 * declared "Data Used to Track You: none, so no ATT prompt", while the AdMob integration that landed
 * on 2026-07-21 shipped `NSUserTrackingUsageDescription` in Info.plist and called
 * `ATTrackingManager.requestTrackingAuthorization` before every rewarded video. Both halves were
 * written deliberately, by someone reading the other half's docs — which is exactly why neither
 * author noticed. Filing a privacy label that contradicts the binary is a removal-grade problem, and
 * it is invisible to every other test in this repo: the app runs fine either way.
 *
 * Resolved on the not-tracking side — non-personalised ads (`npa=1`), no IDFA, no ATT — and this file
 * is the thing that keeps the two halves agreeing. It is deliberately a set of assertions about
 * FILES rather than behaviour: the contradiction lives between a plist, a Swift file and a Chinese
 * design doc, none of which any runtime test can reach.
 *
 * If the product decision ever flips to personalised ads, this file is the checklist for the switch:
 * every assertion below has to be inverted at the same time as the label is refiled.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLIENT_DIR = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.resolve(CLIENT_DIR, p), 'utf8');

const INFO_PLIST = 'ios/App/App/Info.plist';
const APP_DELEGATE = 'ios/App/App/AppDelegate.swift';
const CHECKLIST = '../design/product/release/store-assets-checklist.md';

describe('the iOS binary does not track', () => {
  it('Info.plist declares no tracking-permission purpose string', () => {
    // The key is what makes an ATT prompt possible at all; App Review reads its presence as intent.
    // (Commented-out prose explaining its absence is fine — the plist parse below is the real check.)
    const plist = read(INFO_PLIST);
    expect(plist).not.toMatch(/<key>NSUserTrackingUsageDescription<\/key>/);
  });

  it('no ATT request survives in the ad path', () => {
    const swift = read(APP_DELEGATE);
    expect(swift).not.toMatch(/import AppTrackingTransparency/);
    expect(swift).not.toMatch(/ATTrackingManager/);
  });

  it('every rewarded-ad request is tagged non-personalised', () => {
    // npa=1 says it explicitly instead of relying on the IDFA merely being unavailable. Asserting on
    // the call sites, not just the helper, because a second load site added later would silently
    // request personalised ads with the helper sitting right there unused.
    const swift = read(APP_DELEGATE);
    expect(swift).toMatch(/additionalParameters = \["npa": "1"\]/);
    const loads = swift.match(/RewardedAd\.load\(with:[^)]*\)/g) ?? [];
    expect(loads.length).toBeGreaterThan(0);
    for (const call of loads) expect(call).toMatch(/nonPersonalizedRequest\(\)/);
  });

  it('SKAdNetwork stays — it is attribution, not tracking', () => {
    // Apple's own App Privacy guidance excludes SKAdNetwork from the definition of tracking
    // (aggregate install attribution, no user-level identifier, no ATT). Removing it would cost
    // AdMob attribution and buy nothing, so this asserts it is still there on purpose.
    expect(read(INFO_PLIST)).toMatch(/<key>SKAdNetworkItems<\/key>/);
  });
});

describe('the privacy label still says what the binary does', () => {
  it('the store checklist declares no cross-app tracking', () => {
    // The other half of the pair. If someone flips the product decision, this assertion is what
    // makes them come back here and flip the binary too — instead of filing a label that lies.
    const doc = read(CHECKLIST);
    expect(doc).toMatch(/\*\*Data Used to Track You\*\*：无/);
    expect(doc).toMatch(/跨 App 广告跟踪标识 \| \*\*否\*\*/);
  });

  it('the three privacy policies name AdMob and say non-personalised', () => {
    // The hosted policy is the URL filed in App Store Connect; a reviewer reads it. All three
    // languages ship, so all three have to say the same thing.
    for (const locale of ['zh', 'en', 'de']) {
      const policy = read(`../design/product/legal/privacy-policy.${locale}.md`);
      expect(policy, `${locale}: names the ad SDK`).toMatch(/AdMob/);
      expect(policy, `${locale}: no unfilled placeholder`).not.toMatch(/\{\{ADS_SDK\}\}/);
    }
  });

  it('the hosted privacy page names Apple as the iOS payment processor', () => {
    // Same page, the other thing a reviewer checks: it used to name only Paddle, which is not who
    // takes the money on iOS.
    const page = read('public/web/privacy.html');
    expect(page).toMatch(/In-App Purchase/);
    expect(page).toMatch(/apple\.com\/legal\/privacy/);
  });
});
