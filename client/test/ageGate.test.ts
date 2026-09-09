// The neutral age gate's placement and memory (COMPLIANCE_GLOBAL §3.4, `privacy-policy §9`,
// store-assets-checklist §1.5 — the App Store questionnaire's "Age Assurance" row).
//
// The screen itself is asserted in test/ui/ageGate.ui.ts; what matters here is the wiring around
// it, where the compliance claims actually live:
//   * it runs BEFORE the GDPR consent gate, so no telemetry (including consent's own event) can
//     fire while the player's age is unknown;
//   * the answer is REMEMBERED — a gate that asks again after a "too young" answer is not a gate,
//     and `SaveManager.getFlag` cannot express that state (it answers `flags[key] === true`), which
//     is exactly the mistake this file pins down;
//   * the threshold is inclusive at MIN_AGE_YEARS, since an off-by-one here silently locks out or
//     lets in a whole birth year.
import { describe, it, expect, afterEach } from 'vitest';
import { createAppCore } from '../src/app/createAppCore';
import { AGE_DECLARED_FLAG, MIN_AGE_YEARS, SEEN_INTRO_FLAG, GDPR_CONSENT_FLAG, TOKEN_KEY } from '../src/app/appConstants';
import { HeadlessPlatform } from './harness/HeadlessPlatform';
import { HeadlessAppViews } from './harness/HeadlessAppViews';
import { fetchTransport, setNetTransport, type NetRequest } from '../src/net/transport';

const THIS_YEAR = new Date().getFullYear();

/** A core whose save carries `flags`, started as a returning player (past the intro). */
function launch(flags: Record<string, boolean>, storage: Record<string, string> = {}) {
  const platform = new HeadlessPlatform({
    storage: {
      nw_save_v1: JSON.stringify({ flags: { tutorial_done: true, [SEEN_INTRO_FLAG]: true, ...flags } }),
      ...storage,
    },
  });
  const views = new HeadlessAppViews();
  createAppCore(platform, views).start();
  return { views, platform };
}

/** The age flag as it now stands in local storage (undefined = never recorded). */
function recordedFlag(platform: HeadlessPlatform): boolean | undefined {
  const raw = platform.storage.getItem('nw_save_v1');
  return (JSON.parse(raw ?? '{}') as { flags?: Record<string, boolean> }).flags?.[AGE_DECLARED_FLAG];
}

describe('age gate', () => {
  afterEach(() => { setNetTransport(fetchTransport); }); // the REST seam is process-global


  it('is the first screen on a launch that has never recorded an age', () => {
    const { views } = launch({});
    expect(views.screen).toBe('ageGate');
    expect(views.ageGate?.mode).toBe('ask');
  });

  it('hands over to the consent gate once an age at or above the threshold is declared', () => {
    const { views, platform } = launch({});
    views.ageGate!.cb.onDeclared(THIS_YEAR - MIN_AGE_YEARS); // exactly the threshold — allowed
    expect(recordedFlag(platform)).toBe(true);
    expect(views.screen).toBe('consent');
  });

  it('blocks — and never reaches the consent gate — when the declared age is one year short', () => {
    const { views, platform } = launch({});
    views.ageGate!.cb.onDeclared(THIS_YEAR - MIN_AGE_YEARS + 1);
    expect(recordedFlag(platform)).toBe(false);
    expect(views.screen).toBe('ageGate');
    expect(views.ageGate?.mode).toBe('blocked');
    expect(views.consent).toBeUndefined();
  });

  it('remembers a blocked answer across launches instead of asking again', () => {
    const { views } = launch({ [AGE_DECLARED_FLAG]: false });
    expect(views.screen).toBe('ageGate');
    expect(views.ageGate?.mode).toBe('blocked');
  });

  it('asks nothing once age and consent are both on record', () => {
    const { views } = launch({ [AGE_DECLARED_FLAG]: true, [GDPR_CONSENT_FLAG]: true });
    expect(views.screen).not.toBe('ageGate');
    expect(views.screen).not.toBe('consent');
  });

  it('REGRESSION: the answer reaches the server on a launch that only had a stored token', async () => {
    // 2026-09-09: the gates run before resolveEntry, which used to be the first place the persisted
    // token was handed to ApiClient — so `setFlag` saw `online() === false`, wrote the local mirror
    // only, and resolveEntry's own pull then overwrote `flags` with the cloud copy (reconcile's
    // "cloud always wins"). Net effect for every already-logged-in install: the gate asked again on
    // every single launch, no matter how many times it was answered. What makes the answer stick is
    // that it actually leaves the device, under this account's token.
    const seen: NetRequest[] = [];
    setNetTransport({
      request: async (req) => {
        seen.push(req);
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { save: {} } }), text: async () => '' };
      },
    });

    const { views } = launch({}, { nw_api_base: 'http://api.test', [TOKEN_KEY]: 'tok-1' });
    views.ageGate!.cb.onDeclared(THIS_YEAR - MIN_AGE_YEARS);
    await new Promise((r) => setTimeout(r, 0)); // let the background PUT run

    const put = seen.find((r) => r.url === 'http://api.test/flags');
    expect(put, 'the declared age must be pushed to the server, not just written locally').toBeDefined();
    expect(put!.method).toBe('PUT');
    expect(put!.headers['authorization']).toBe('Bearer tok-1');
    expect(JSON.parse(put!.body!)).toEqual({ key: AGE_DECLARED_FLAG, value: true });
  });

  it('still asks for an age when only consent is on record (the pre-gate accounts)', () => {
    // Every existing install is in this state: consented before the age gate existed. They must be
    // asked, and asked BEFORE anything else — not grandfathered in by the consent flag.
    const { views } = launch({ [GDPR_CONSENT_FLAG]: true });
    expect(views.screen).toBe('ageGate');
    expect(views.ageGate?.mode).toBe('ask');
  });
});
