// Smoke test for the headless harness + createAppCore extraction. Proves:
//   1. createAppCore imports cleanly in a Node (no-DOM) runtime — i.e. no PIXI
//      leaked into the orchestration core's import graph.
//   2. The offline navigation wiring is intact after the refactor: intro →
//      lobby → settings → back, and lobby → campaign map.
// The networked flow (register / shop / gacha / ranked match) is covered by the
// full-link E2E against real servers (test/e2e/full-link.e2e.ts).

import { describe, it, expect } from 'vitest';
import { createAppCore } from '../src/app/createAppCore';
import { HeadlessPlatform } from './harness/HeadlessPlatform';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

/** Let queued microtasks / timers settle (resolveEntry is async). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('headless app core — offline navigation', () => {
  it('first launch shows the intro, then the GDPR consent gate, then the offline lobby', async () => {
    const platform = new HeadlessPlatform(); // no nw_api_base → offline single-player
    const views = new HeadlessAppViews();
    const core = createAppCore(platform, views);

    core.start();
    expect(views.screen).toBe('intro');

    // After intro, the consent gate (L1-1) blocks entry to the lobby until accepted.
    views.intro!.onFinish();
    expect(views.screen).toBe('consent');

    views.consent!.onAccept();
    await settle();
    expect(views.screen).toBe('lobby');
    expect(views.lobby!.offline).toBe(true);
    expect(views.lobby!.online).toBe(false);
  });

  it('a second launch (consent already given) skips the consent gate', async () => {
    const platform = new HeadlessPlatform();
    // First run: see intro, accept consent → flag persists in the shared storage.
    const first = new HeadlessAppViews();
    const coreA = createAppCore(platform, first);
    coreA.start();
    first.intro!.onFinish();
    first.consent!.onAccept();
    await settle();

    // Relaunch on the same platform/storage: no intro, no consent — straight to lobby.
    const second = new HeadlessAppViews();
    const coreB = createAppCore(platform, second);
    coreB.start();
    await settle();
    expect(second.screen).toBe('lobby');
  });

  it('lobby → profile → back → lobby, and lobby → campaign map', async () => {
    const platform = new HeadlessPlatform();
    const views = new HeadlessAppViews();
    const core = createAppCore(platform, views);

    core.start();
    views.intro!.onFinish();
    views.consent!.onAccept();
    await settle();
    expect(views.screen).toBe('lobby');

    views.lobby!.onOpenProfile();
    expect(views.screen).toBe('settings');

    views.settings!.onBack();
    expect(views.screen).toBe('lobby');

    views.lobby!.onOpenCampaign();
    expect(views.screen).toBe('campaignMap');
  });

  it('lobby pushes a social badge through the returned view handle', async () => {
    const platform = new HeadlessPlatform(); // offline → online features gated off
    const views = new HeadlessAppViews();
    const core = createAppCore(platform, views);

    core.start();
    views.intro!.onFinish();
    views.consent!.onAccept();
    await settle();
    expect(views.screen).toBe('lobby');
    // Offline: no /social/badges fetch, but the handle is still wired and the
    // cached total (0) is applied — proving showLobby → LobbyView seam works.
    expect(views.lastSocialBadge).toBe(0);
  });
});
