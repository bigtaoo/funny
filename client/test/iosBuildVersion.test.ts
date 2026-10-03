/**
 * iosBuildVersion.test.ts — the iOS shell and OTA pipelines agree on one version line (IOS_RELEASE.md §11.3).
 *
 * ota.ts compares the OTA manifest against the version baked into the running bundle and treats
 * '0.0.0' as a dev build that never checks for updates. release-ios.yml shipped builds 11-14 without
 * NW_BUILD_VERSION, so every shell ran '0.0.0' and OTA was dead on all of them (§11.7) — invisible in
 * any local run, since only the macOS runner executes that workflow. These assertions read the
 * workflow files so the next edit that drops the version fails here instead of on a phone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isNewer } from '../src/platform/ota';

const REPO = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.resolve(REPO, p), 'utf8');

const RELEASE_IOS = '.github/workflows/release-ios.yml';
const OTA_PUBLISH = '.github/workflows/ota-publish.yml';
const PBXPROJ = 'client/ios/App/App.xcodeproj/project.pbxproj';

/** The `env:` block of the step whose `run:` is `npm run build:mobile`, as raw text. */
function buildMobileStep(yml: string): string {
  const steps = yml.split(/\n(?=\s*- name: )/);
  const hits = steps.filter((s) => /run:\s*npm run build:mobile/.test(s));
  expect(hits, 'exactly one build:mobile step').toHaveLength(1);
  return hits[0];
}

describe('release-ios.yml bakes a real builtin version', () => {
  const step = buildMobileStep(read(RELEASE_IOS));

  it('sets NW_BUILD_VERSION on the build:mobile step, from the resolve step', () => {
    expect(step).toMatch(/NW_BUILD_VERSION:\s*\$\{\{\s*steps\.ver\.outputs\.version\s*\}\}/);
  });

  it('derives it from MARKETING_VERSION and the run number agvtool stamps as CFBundleVersion', () => {
    const yml = read(RELEASE_IOS);
    expect(yml).toMatch(/V="\$MV\.\$\{\{ github\.run_number \}\}"/);
    expect(yml).toMatch(/agvtool new-version -all \$\{\{ github\.run_number \}\}/);
  });

  it('MARKETING_VERSION is one X.Y value, so <X.Y>.<build> is a three-part version', () => {
    const values = new Set([...read(PBXPROJ).matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]));
    expect(values.size).toBe(1);
    expect([...values][0]).toMatch(/^\d+\.\d+$/);
  });
});

describe('ota-publish.yml stays on the same version line', () => {
  it('bakes the published version into the bundle it zips', () => {
    expect(buildMobileStep(read(OTA_PUBLISH))).toMatch(/NW_BUILD_VERSION:\s*\$\{\{\s*steps\.ver\.outputs\.version\s*\}\}/);
  });

  it('requires <shell version>.<n> and a version above the live manifest', () => {
    const yml = read(OTA_PUBLISH);
    expect(yml).toContain(String.raw`grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'`);
    expect(yml).toContain('"${V%.*}" != "$MV.$BUILD"');
    expect(yml).toContain('must be strictly above the live manifest version');
  });
});

describe('the version scheme orders the way the pipelines assume', () => {
  it('an OTA outranks the shell it was built for, and older shells', () => {
    expect(isNewer('1.0.15.1', '1.0.15')).toBe(true);
    expect(isNewer('1.0.15.1', '1.0.14')).toBe(true);
    expect(isNewer('1.0.15.2', '1.0.15.1')).toBe(true);
  });

  it('a newer shell outranks every OTA built for an older one', () => {
    expect(isNewer('1.0.15.9', '1.0.16')).toBe(false);
    expect(isNewer('1.1.0', '1.0.99.9')).toBe(true);
  });

  it('the pre-scheme 1.0.2 manifest is below the first versioned shell (build 15)', () => {
    expect(isNewer('1.0.2', '1.0.15')).toBe(false);
  });

  it('the native gate: minNativeVersion 1.0.0 admits CFBundleShortVersionString 1.0', () => {
    expect(isNewer('1.0.0', '1.0')).toBe(false);
  });
});
