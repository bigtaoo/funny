/**
 * iosStoreKit2.test.ts — the native billing layer, checked by reading it (IOS_RELEASE.md §6).
 *
 * Swift cannot be compiled on the dev machine and is not covered by any test here, so these
 * assertions are the only mechanical statement about the iOS bridge that runs before CI. Two things
 * are worth that:
 *
 *   • **The deployment target has a deadline.** StoreKit 2 needs iOS 15, and Apple's upload warning
 *     90068 says a MinimumOSVersion below 15.0 stops being accepted for upload or submission in
 *     spring 2027. Both places that declare it (the Xcode project and the Podfile) must agree, or
 *     `pod install` fails on the runner — where it costs a full macOS build to find out.
 *   • **A transaction must not be finished before the server grants.** That rule is invisible in a
 *     screenshot and permanent when broken: StoreKit forgets the transaction, the player is charged,
 *     and nothing records that content was owed. Finishing happens in exactly one place, and JS
 *     drives it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLIENT_DIR = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.resolve(CLIENT_DIR, p), 'utf8');

const PBXPROJ = 'ios/App/App.xcodeproj/project.pbxproj';
const PODFILE = 'ios/App/Podfile';
const APP_DELEGATE = 'ios/App/App/AppDelegate.swift';

describe('iOS deployment target', () => {
  it('every build configuration targets iOS 15.0 or later', () => {
    const targets = [...read(PBXPROJ).matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)]
      .map((m) => parseFloat(m[1]!));
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t).toBeGreaterThanOrEqual(15);
  });

  it('the Podfile declares the same floor as the project', () => {
    // CocoaPods' assertDeploymentTarget (in the Podfile's post_install) fails the install when these
    // disagree, and that failure happens on the macOS runner, minutes into a build.
    const platform = /platform :ios, '([\d.]+)'/.exec(read(PODFILE));
    expect(platform).not.toBeNull();
    expect(parseFloat(platform![1]!)).toBeGreaterThanOrEqual(15);
  });
});

describe('the billing bridge is StoreKit 2', () => {
  const swift = read(APP_DELEGATE);

  it('no StoreKit 1 purchase machinery survives', () => {
    // Two APIs in one app would mean two sources of truth for what has been bought, and the
    // StoreKit 1 observer would finish transactions this code deliberately leaves open. Matched on
    // call shapes rather than bare type names: the file's header names both APIs while explaining
    // what replaced them, and a comment recording that history is not the machinery.
    expect(swift).not.toMatch(/SKPaymentQueue\.default\(/);
    expect(swift).not.toMatch(/SKProductsRequest\(/);
    expect(swift).not.toMatch(/SKPaymentTransactionObserver/);
    expect(swift).not.toMatch(/Bundle\.main\.appStoreReceiptURL/);
  });

  it('consumes both transaction streams, not just the live one', () => {
    // `updates` delivers what arrives while running; `unfinished` is the backlog a previous install
    // or a crashed session left owed. Only listening to `updates` silently drops the backlog.
    expect(swift).toMatch(/Transaction\.updates/);
    expect(swift).toMatch(/Transaction\.unfinished/);
  });

  it('attaches appAccountToken to a purchase', () => {
    // The id that lets a renewal notification name its owner even when the purchase was never
    // reported (server/commercial/src/service/appleAccount.ts).
    expect(swift).toMatch(/\.appAccountToken\(/);
  });

  it('finishes a transaction in exactly one place, and only on the JS handoff', () => {
    const finishes = [...swift.matchAll(/\.finish\(\)/g)];
    expect(finishes).toHaveLength(1);
    // That one call site is the `finish` op the JS bridge exposes — which the reporting code calls
    // only after the server confirms the grant (platform/appleUnfinishedTransactions.ts).
    const handler = /private func handleFinish\([\s\S]*?\n    \}/.exec(swift);
    expect(handler).not.toBeNull();
    expect(handler![0]).toMatch(/\.finish\(\)/);
  });

  it('exposes pending() and finish() on the injected JS bridge', () => {
    // The JS side feature-detects both (platform/iap.ts). If the names drift, the drain silently
    // does nothing — an OTA bundle running on an older binary looks exactly the same.
    expect(swift).toMatch(/pending: function\(\)/);
    expect(swift).toMatch(/finish: function\(transactionId\)/);
  });

  it('ignores transactions Apple did not verify', () => {
    // `.unverified` is not "probably fine": granting on it would let a tampered device mint
    // transactions. The unwrap returns nil and nothing downstream runs.
    expect(swift).toMatch(/case \.verified\(let tx\) = result \{ return tx \}/);
  });
});
