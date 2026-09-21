// The consent gate's two shapes and three answers (COMPLIANCE_GLOBAL §3.3, ANALYTICS_DESIGN §3.6c).
//
// The card itself is asserted in test/ui/consentDialogWrap.ui.ts; what lives here is the part the
// compliance claim actually rests on:
//   * where analytics consent has to be freely given, refusing it still ENTERS THE GAME. A second
//     button that merely closes the dialog and then blocks would be the same wall with extra steps;
//   * the refusal STICKS — `flags.gdprConsent === false` has to survive as its own state, distinct
//     from "never asked", or the next launch asks again and the first stray tap overwrites it;
//   * refusing emits NOTHING, not even the consent event. This is the one answer that cannot be
//     reported through the mechanism it refuses — its single trace is a tick on the anonymous launch
//     counter, so the funnel can tell a refusal apart from a player who left at the gate (§3.6c);
//   * outside the covered regions the card has no second button at all, rather than one that is
//     drawn and then ignored.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAppCore } from '../src/app/createAppCore';
import { AGE_DECLARED_FLAG, SEEN_INTRO_FLAG, GDPR_CONSENT_FLAG, TOKEN_KEY } from '../src/app/appConstants';
import { needsConsentChoice } from '../src/platform/consentRegion';
import { HeadlessPlatform } from './harness/HeadlessPlatform';
import { HeadlessAppViews } from './harness/HeadlessAppViews';
import { fetchTransport, setNetTransport, type NetRequest } from '../src/net/transport';

/** A returning player (intro seen, age declared) who has never answered the consent gate. */
function launch(flags: Record<string, boolean> = {}, storage: Record<string, string> = {}) {
  const platform = new HeadlessPlatform({
    storage: {
      nw_save_v1: JSON.stringify({
        flags: { tutorial_done: true, [SEEN_INTRO_FLAG]: true, [AGE_DECLARED_FLAG]: true, ...flags },
      }),
      ...storage,
    },
  });
  const views = new HeadlessAppViews();
  createAppCore(platform, views).start();
  return { views, platform };
}

/** The consent flag as it now stands on disk (undefined = never answered). */
function storedConsent(platform: HeadlessPlatform): boolean | undefined {
  const raw = platform.storage.getItem('nw_save_v1');
  return (JSON.parse(raw ?? '{}') as { flags?: Record<string, boolean> }).flags?.[GDPR_CONSENT_FLAG];
}

/**
 * Wait for a request to show up, rather than for one tick of the event loop: every ApiClient call
 * goes through the process-wide token bucket in net/rateGate.ts (5 in a burst, then one per 200ms),
 * so a launch that has already spent the budget holds the next call back by a few hundred ms. A
 * fixed `setTimeout(0)` passes or fails depending on what the tests before it happened to send.
 */
async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

/** Pin the reported IANA zone for one test — the region test's only input on the web. */
function withTimeZone(tz: string): void {
  vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
    resolvedOptions: () => ({ timeZone: tz }),
  } as unknown as Intl.DateTimeFormat);
}

describe('consent gate', () => {
  afterEach(() => { setNetTransport(fetchTransport); vi.restoreAllMocks(); });

  it('shows the two-answer card in a covered region and the accept-only card elsewhere', () => {
    withTimeZone('Europe/Berlin');
    expect(launch().views.consentMode).toBe('choice');
    vi.restoreAllMocks();

    withTimeZone('Asia/Tokyo');
    expect(launch().views.consentMode).toBe('accept-only');
  });

  it('lets a player who refused analytics into the game anyway', async () => {
    withTimeZone('Europe/Berlin');
    const { views, platform } = launch();
    expect(views.screen).toBe('consent');

    views.consent!.onDecline();
    // Entry resolution behind the gate is async (it may pull GET /save first), so the screen the
    // player lands on only appears a tick later. What matters is that one arrives at all.
    await new Promise((r) => setTimeout(r, 0));

    expect(views.screen, 'refusing analytics must not leave the player on the gate').not.toBe('consent');
    expect(storedConsent(platform)).toBe(false);
  });

  it('remembers a refusal instead of asking again on the next launch', () => {
    // `false` and `undefined` are different answers. `SaveManager.getFlag` cannot tell them apart
    // (it returns `flags[key] === true`), which is why the gate reads `save.flags` directly.
    withTimeZone('Europe/Berlin');
    const { views } = launch({ [GDPR_CONSENT_FLAG]: false });
    expect(views.screen).not.toBe('consent');
  });

  it('reports nothing at all after a refusal — not even the consent event', async () => {
    withTimeZone('Europe/Berlin');
    const seen: NetRequest[] = [];
    setNetTransport({
      request: async (req) => {
        seen.push(req);
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { save: {} } }), text: async () => '' };
      },
    });

    const { views } = launch({}, { nw_api_base: 'http://api.test', nw_analytics_base: 'http://an.test' });
    views.consent!.onDecline();
    await new Promise((r) => setTimeout(r, 0));

    const posted = seen.filter((r) => r.url.includes('/analytics/events'));
    expect(posted, 'a refusal may not be reported through the thing it refuses').toEqual([]);
  });

  it('counts the refused launch on the launch counter — the one thing that path does send', async () => {
    // Not a contradiction of the test above: this is the unauthenticated date/platform/count row
    // (ANALYTICS_DESIGN §3.6b), not an event. Without it a refusing player is indistinguishable from
    // one who closed the tab at the gate — both reach the counter, neither ever reaches session_start.
    withTimeZone('Europe/Berlin');
    const seen: NetRequest[] = [];
    setNetTransport({
      request: async (req) => {
        seen.push(req);
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { save: {} } }), text: async () => '' };
      },
    });

    const { views } = launch({}, { nw_api_base: 'http://api.test' });
    views.consent!.onDecline();
    await until(() => seen.some((r) => r.url.includes('d=1')));

    const ticks = seen.filter((r) => r.url.includes('/analytics/config') && r.url.includes('d=1'));
    expect(ticks).toHaveLength(1);
    expect(ticks[0].url).toContain('p=web');
    expect(ticks[0].body, 'the tick carries nothing — the whole point is a number that needs no consent').toBeUndefined();
  });

  it('counts every later launch of a player who already refused, not just the one they refused on', async () => {
    // The gate answers itself from the stored flag on those launches, so this is the branch that has
    // to tick: they keep launching and keep reporting nothing, and each of those launches lands in
    // the funnel's denominator.
    withTimeZone('Europe/Berlin');
    const seen: NetRequest[] = [];
    setNetTransport({
      request: async (req) => {
        seen.push(req);
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { save: {} } }), text: async () => '' };
      },
    });

    const { views } = launch({ [GDPR_CONSENT_FLAG]: false }, { nw_api_base: 'http://api.test' });
    await until(() => seen.some((r) => r.url.includes('d=1')));

    expect(views.screen).not.toBe('consent');
    expect(seen.filter((r) => r.url.includes('/analytics/config') && r.url.includes('d=1'))).toHaveLength(1);
  });

  it('does not tick the refusal counter when the player accepts', async () => {
    withTimeZone('Europe/Berlin');
    const seen: NetRequest[] = [];
    setNetTransport({
      request: async (req) => {
        seen.push(req);
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { save: {} } }), text: async () => '' };
      },
    });

    const { views } = launch({}, { nw_api_base: 'http://api.test' });
    views.consent!.onAccept();
    await new Promise((r) => setTimeout(r, 0));

    expect(seen.filter((r) => r.url.includes('d=1'))).toEqual([]);
  });

  it('mirrors the refusal to the account, which is record-keeping and not telemetry', async () => {
    withTimeZone('Europe/Berlin');
    const seen: NetRequest[] = [];
    setNetTransport({
      request: async (req) => {
        seen.push(req);
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { save: {} } }), text: async () => '' };
      },
    });

    const { views } = launch({}, { nw_api_base: 'http://api.test', [TOKEN_KEY]: 'tok-1' });
    views.consent!.onDecline();
    await until(() => seen.some((r) => r.url.includes('gdpr')));

    const post = seen.find((r) => r.url.includes('gdpr'));
    expect(post, 'the answer has to leave the device or it is lost on the next install').toBeDefined();
    expect(JSON.parse(post!.body!)).toEqual({ consent: false });
  });

  it('still lets an acceptance through unchanged', async () => {
    withTimeZone('Europe/Berlin');
    const { views, platform } = launch();
    views.consent!.onAccept();
    await new Promise((r) => setTimeout(r, 0));
    expect(views.screen).not.toBe('consent');
    expect(storedConsent(platform)).toBe(true);
  });
});

describe('needsConsentChoice', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // Spot checks, not a table of every zone: what is worth pinning is the SHAPE of each rule, since
  // each one is a judgement about which way to be wrong (see consentRegion.ts's header).
  const covered = [
    'Europe/Berlin', 'Europe/London', 'Europe/Dublin',
    'Europe/Moscow',        // deliberately over-inclusive: the prefix rule does not carve out non-EEA Europe
    'Atlantic/Reykjavik', 'Atlantic/Canary', 'Asia/Nicosia',
    'America/New_York', 'America/Los_Angeles', 'America/Indiana/Knox', 'Pacific/Honolulu', 'US/Eastern',
  ];
  const notCovered = [
    'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney',
    'America/Toronto', 'America/Sao_Paulo', 'America/Mexico_City', // `America/` is NOT a prefix rule
    'Africa/Cairo',
  ];

  for (const tz of covered) {
    it(`offers the choice in ${tz}`, () => { withTimeZone(tz); expect(needsConsentChoice()).toBe(true); });
  }
  for (const tz of notCovered) {
    it(`does not offer it in ${tz}`, () => { withTimeZone(tz); expect(needsConsentChoice()).toBe(false); });
  }

  it('assumes covered when the runtime reports no timezone at all', () => {
    withTimeZone('');
    expect(needsConsentChoice()).toBe(true);
  });

  it('assumes covered when Intl throws outright', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new Error('no Intl'); });
    expect(needsConsentChoice()).toBe(true);
  });
});
