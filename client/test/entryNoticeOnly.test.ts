// The notice-only entry (IPlatform.entryNoticeOnly — the CrazyGames build, COMPLIANCE_GLOBAL §3.3).
//
// CrazyGames: "Games should land new users in gameplay immediately … a maximum of 1 click", and for a
// game's own terms/privacy policy "a simple notice rather than a pop-up blocking the user". So on that
// build there is no entry screen at all. What has to stay true underneath, and is pinned here:
//   * nothing blocks: the first screen is the game, not an age gate or a consent wall;
//   * outside the covered regions (the EEA) analytics are on by default, but only once the analytics
//     notice has been on screen (COMPLIANCE_GLOBAL §3.3b): until then nothing is recorded or sent;
//     the lobby strip (or the tutorial's graduation card) showing it is what persists the flag and
//     tracks `gdpr_consent { mode: 'notice' }`;
//   * inside them nothing is granted until the player answers the non-blocking prompt, and its two
//     answers go through the same recording path as the gate's (refusal: flag false + the anonymous
//     refusal tick, nothing tracked);
//   * an account already recorded as underage still gets the dead end;
//   * every other platform keeps its gate (consentGate.test.ts / ageGate.test.ts), now with
//     `mode: 'gate'` and `dwell_ms` on the accept.
import { describe, it, expect, afterEach, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<{ event: string; props: Record<string, unknown> }>);
vi.mock('../src/analytics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/analytics')>();
  return {
    ...real,
    track: (event: string, props: Record<string, unknown> = {}) => { tracked.push({ event, props }); real.track(event, props); },
  };
});

import { createAppCore } from '../src/app/createAppCore';
import { AGE_DECLARED_FLAG, GDPR_CONSENT_FLAG, TERMS_ACCEPTED_FLAG } from '../src/app/appConstants';
import { HeadlessPlatform } from './harness/HeadlessPlatform';
import { HeadlessAppViews } from './harness/HeadlessAppViews';
import { fetchTransport, setNetTransport, type NetRequest } from '../src/net/transport';

function withTimeZone(tz: string): void {
  vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
    resolvedOptions: () => ({ timeZone: tz }),
  } as unknown as Intl.DateTimeFormat);
}

/** A brand-new player on the notice-only build (no age, no consent, no terms recorded). */
function launch(flags: Record<string, boolean> = {}, storage: Record<string, string> = {}, noticeOnly = true) {
  const platform = new HeadlessPlatform({
    storage: { nw_save_v1: JSON.stringify({ flags: { tutorial_done: true, ...flags } }), ...storage },
  });
  // The CrazyGames build has both: no entry screen, and no login screen either (silent accounts).
  if (noticeOnly) {
    Object.defineProperty(platform, 'entryNoticeOnly', { value: true });
    Object.defineProperty(platform, 'silentAccountOnly', { value: true });
  }
  const views = new HeadlessAppViews();
  createAppCore(platform, views).start();
  return { views, platform };
}

function storedFlags(platform: HeadlessPlatform): Record<string, boolean> {
  return (JSON.parse(platform.storage.getItem('nw_save_v1') ?? '{}') as { flags?: Record<string, boolean> }).flags ?? {};
}

const consentEvents = () => tracked.filter((e) => e.event === 'gdpr_consent').map((e) => e.props);

/** Entry resolution behind the gate is async; wait for the lobby rather than for one tick. */
async function untilLobby(views: HeadlessAppViews): Promise<void> {
  const deadline = Date.now() + 3000;
  while (views.screen !== 'lobby' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

describe('notice-only entry (CrazyGames)', () => {
  afterEach(() => { setNetTransport(fetchTransport); vi.restoreAllMocks(); tracked.length = 0; });

  it('lands a new player in the game with no entry screen, in any region', async () => {
    for (const tz of ['Asia/Tokyo', 'Europe/Berlin', 'America/New_York']) {
      withTimeZone(tz);
      const { views } = launch();
      expect(views.ageGate, `${tz}: no age question`).toBeUndefined();
      expect(views.consent, `${tz}: no consent wall`).toBeUndefined();
      await untilLobby(views);
      expect(views.screen).toBe('lobby');
      vi.restoreAllMocks();
    }
  });

  for (const tz of ['Asia/Tokyo', 'America/New_York', 'Europe/London']) {
    it(`outside the covered regions (${tz}): analytics on once the notice is shown, recorded as mode "notice"`, async () => {
      withTimeZone(tz);
      const { views, platform } = launch();
      // Before any notice: nothing recorded, nothing tracked (events wait in the pre-consent buffer).
      expect(storedFlags(platform)[GDPR_CONSENT_FLAG]).toBeUndefined();
      expect(consentEvents()).toEqual([]);
      // No age is fabricated: the portal is 13+, we just do not ask.
      expect(storedFlags(platform)[AGE_DECLARED_FLAG]).toBeUndefined();

      await untilLobby(views);
      // The lobby carries the terms + analytics notice — no question, a single OK — and showing it
      // is the acknowledgement.
      expect(views.lastEntryNotice).toMatchObject({ terms: true, stats: true, consent: false });
      expect(storedFlags(platform)[GDPR_CONSENT_FLAG]).toBe(true);
      expect(consentEvents()).toEqual([{ granted: true, mode: 'notice' }]);
      expect(storedFlags(platform)[TERMS_ACCEPTED_FLAG], 'being shown the notice is what accepts the terms here').toBe(true);
      vi.restoreAllMocks();
      tracked.length = 0;
    });
  }

  it('a brand-new player is told on the tutorial graduation card, and that is the acknowledgement', async () => {
    withTimeZone('America/New_York');
    const platform = new HeadlessPlatform({ storage: { nw_save_v1: JSON.stringify({ flags: {} }) } });
    Object.defineProperty(platform, 'entryNoticeOnly', { value: true });
    Object.defineProperty(platform, 'silentAccountOnly', { value: true });
    const views = new HeadlessAppViews();
    const seen: Array<{ footnote?: string; flagBefore: unknown; flagAfter: unknown }> = [];
    views.onTutorial = (cfg) => {
      const flagBefore = storedFlags(platform)[GDPR_CONSENT_FLAG];
      cfg.onFootnoteShown?.();
      seen.push({ ...(cfg.footnote ? { footnote: cfg.footnote } : {}), flagBefore, flagAfter: storedFlags(platform)[GDPR_CONSENT_FLAG] });
    };
    createAppCore(platform, views).start();
    await untilLobby(views);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.footnote).toBeTruthy();
    expect(seen[0]!.flagBefore).toBeUndefined();
    expect(seen[0]!.flagAfter).toBe(true);
    expect(consentEvents()).toEqual([{ granted: true, mode: 'notice' }]);
    // Already told: the lobby strip carries the terms only.
    expect(views.lastEntryNotice).toMatchObject({ terms: true, stats: false });
  });

  it('in the EEA the graduation card has no footnote — the lobby prompt asks instead', async () => {
    withTimeZone('Europe/Berlin');
    const platform = new HeadlessPlatform({ storage: { nw_save_v1: JSON.stringify({ flags: {} }) } });
    Object.defineProperty(platform, 'entryNoticeOnly', { value: true });
    Object.defineProperty(platform, 'silentAccountOnly', { value: true });
    const views = new HeadlessAppViews();
    let footnote: string | undefined = 'unset';
    views.onTutorial = (cfg) => { footnote = cfg.footnote; };
    createAppCore(platform, views).start();
    await untilLobby(views);
    expect(footnote).toBeUndefined();
    expect(storedFlags(platform)[GDPR_CONSENT_FLAG]).toBeUndefined();
  });

  it('a returning player who already has analytics on is not told again', async () => {
    withTimeZone('Asia/Tokyo');
    const { views, platform } = launch({ [GDPR_CONSENT_FLAG]: true });
    await untilLobby(views);
    expect(views.lastEntryNotice).toMatchObject({ terms: true, stats: false, consent: false });
    expect(storedFlags(platform)[TERMS_ACCEPTED_FLAG], 'being shown the notice is what accepts the terms here').toBe(true);
  });

  it('inside them nothing is granted until the prompt is answered; Allow records it as mode "prompt" with dwell_ms', async () => {
    withTimeZone('Europe/Berlin');
    const { views, platform } = launch();
    await untilLobby(views);
    expect(storedFlags(platform)[GDPR_CONSENT_FLAG]).toBeUndefined();
    expect(consentEvents()).toEqual([]);
    expect(views.lastEntryNotice).toMatchObject({ terms: true, consent: true });

    views.lastEntryNotice!.onAnswer!(true);
    expect(storedFlags(platform)[GDPR_CONSENT_FLAG]).toBe(true);
    const [ev] = consentEvents();
    expect(ev).toMatchObject({ granted: true, mode: 'prompt' });
    expect(typeof ev!.dwell_ms).toBe('number');
  });

  it('No thanks is a refusal like the gate\'s: flag false, the anonymous refusal tick, nothing tracked', async () => {
    withTimeZone('Europe/Berlin');
    const seen: NetRequest[] = [];
    setNetTransport({
      request: async (req) => {
        seen.push(req);
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { save: {} } }), text: async () => '' };
      },
    });
    const { views, platform } = launch({}, { nw_api_base: 'http://api.test' });
    await untilLobby(views);
    views.lastEntryNotice!.onAnswer!(false);
    expect(storedFlags(platform)[GDPR_CONSENT_FLAG]).toBe(false);
    expect(consentEvents()).toEqual([]);
    const deadline = Date.now() + 2000;
    while (!seen.some((r) => r.url.includes('d=1')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(seen.filter((r) => r.url.includes('/analytics/config') && r.url.includes('d=1'))).toHaveLength(1);
  });

  it('a strip left open comes back with the lobby; once answered it is gone for the launch', async () => {
    withTimeZone('Europe/Berlin');
    const { views } = launch();
    await untilLobby(views);
    const first = views.lastEntryNotice;
    views.lastEntryNotice = undefined;
    views.lobby!.onOpenProfile();   // away …
    views.settings!.onBack();       // … and back
    expect(views.lastEntryNotice, 'not answered yet: put back').toMatchObject({ terms: true, consent: true });
    expect(views.lastEntryNotice).not.toBe(first);

    views.lastEntryNotice!.onAnswer!(true);
    views.lastEntryNotice = undefined;
    views.lobby!.onOpenProfile();
    views.settings!.onBack();
    expect(views.lastEntryNotice).toBeUndefined();
  });

  it('a returning player with everything answered sees no strip at all', async () => {
    withTimeZone('Europe/Berlin');
    const { views } = launch({ [GDPR_CONSENT_FLAG]: false, [TERMS_ACCEPTED_FLAG]: true });
    await untilLobby(views);
    expect(views.lastEntryNotice).toBeUndefined();
  });

  it('an account already recorded as underage still stops at the dead end', () => {
    withTimeZone('Asia/Tokyo');
    const { views } = launch({ [AGE_DECLARED_FLAG]: false });
    expect(views.screen).toBe('ageGate');
    expect(views.ageGate?.mode).toBe('blocked');
  });
});

describe('the gate everywhere else', () => {
  afterEach(() => { vi.restoreAllMocks(); tracked.length = 0; });

  it('is still there, and its accept carries mode "gate" and dwell_ms', async () => {
    withTimeZone('Asia/Tokyo');
    const { views } = launch({ [AGE_DECLARED_FLAG]: true }, {}, false);
    expect(views.screen).toBe('consent');
    views.consent!.onAccept();
    const [ev] = consentEvents();
    expect(ev).toMatchObject({ granted: true, mode: 'gate' });
    expect(typeof ev!.dwell_ms).toBe('number');
  });

  it('never offers the notice strip', async () => {
    withTimeZone('Europe/Berlin');
    const { views } = launch({ [AGE_DECLARED_FLAG]: true }, {}, false);
    views.consent!.onAccept();
    await untilLobby(views);
    expect(views.lastEntryNotice).toBeUndefined();
  });
});
