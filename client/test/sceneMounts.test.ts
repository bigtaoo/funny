// Coverage for `client/src/app/sceneMounts.ts` — the rebuild policy extracted from PixiAppViews on
// 2026-09-14 (rotation must re-lay-out every screen, not just the lobby).
//
// It lands in the PLAIN unit suite rather than in test/ui, and inside `coverage.include`, because
// unlike the facade it came out of it has no PIXI dependency at all: it takes a SceneManager handle
// and scene *factories*, and never touches a display object itself. That is also what makes it worth
// testing on its own — the decisions here (which screen a settled viewport change rebuilds, what an
// overlay does to the host's rebuild, what an async mount may arm after the fact) are the ones the
// reported bug was about, and none of them need a renderer to state.
//
// `net/anomaly`'s recordConstructSample is the single value import; it is left real (it only
// accumulates a sample) so the module under test runs exactly as it ships.
import { describe, it, expect, vi } from 'vitest';
import { SceneMounts } from '../src/app/sceneMounts';
import type { SceneManager, Scene } from '../src/scenes/SceneManager';

/** A scene stand-in that records nothing but its own identity. */
function fakeScene(tag: string): Scene & { tag: string } {
  return {
    tag,
    container: { destroy: (): void => {} } as unknown as Scene['container'],
    update: (): void => {},
    destroy: (): void => {},
  };
}

function setup(): {
  mounts: SceneMounts;
  goto: ReturnType<typeof vi.fn>;
  pushOverlay: ReturnType<typeof vi.fn>;
  popOverlay: ReturnType<typeof vi.fn>;
  lobbyRebuilds: () => number;
  /** Every scene handed to goto, in order, by tag. */
  gone: () => string[];
} {
  const goto = vi.fn();
  const pushOverlay = vi.fn();
  const popOverlay = vi.fn();
  let lobbyRebuilds = 0;
  const manager = { goto, pushOverlay, popOverlay } as unknown as SceneManager;
  const mounts = new SceneMounts(manager, () => { lobbyRebuilds += 1; });
  return {
    mounts, goto, pushOverlay, popOverlay,
    lobbyRebuilds: () => lobbyRebuilds,
    gone: () => goto.mock.calls.map((c) => (c[0] as { tag: string }).tag),
  };
}

describe('SceneMounts — what a settled viewport change rebuilds', () => {
  it('rebuilds a mount() screen from the same factory', () => {
    const h = setup();
    let n = 0;
    h.mounts.mount('Shop', () => fakeScene(`shop${++n}`));
    expect(h.gone()).toEqual(['shop1']);

    h.mounts.viewportSettled();
    h.mounts.viewportSettled();
    // The factory is what gets replayed — in the real app it closes over PixiAppViews' `layout`,
    // which the viewport watcher has already swapped for the new orientation by now.
    expect(h.gone()).toEqual(['shop1', 'shop2', 'shop3']);
  });

  it('leaves a volatile() screen alone', () => {
    // A live match, a replay, the SLG map, the room: a fresh constructor cannot restore what they
    // hold, so these keep the 2026-09-10 behaviour (fitted canvas, layout of the entry orientation).
    const h = setup();
    h.mounts.volatile('Game', () => fakeScene('game'));
    h.mounts.viewportSettled();
    expect(h.gone()).toEqual(['game']);
    expect(h.lobbyRebuilds()).toBe(0);
  });

  it('routes the lobby back out through the app core instead of replaying its factory', () => {
    // nav/lobby.ts re-derives the lobby's callbacks from save/session state on every entry, so
    // replaying the factory here would rebuild it from a stale callback set.
    const h = setup();
    h.mounts.lobby('Lobby', () => fakeScene('lobby'));
    h.mounts.viewportSettled();
    expect(h.gone()).toEqual(['lobby']); // no second goto from HERE...
    expect(h.lobbyRebuilds()).toBe(1);   // ...the core did it
  });

  it('resolves the target when the change settles, not when it was noticed', () => {
    // Rotate in the lobby, then tap into another screen before the coalescing window closes. The
    // pre-2026-09-14 code cancelled the pending rebuild for exactly this case; now there is nothing
    // to cancel, because the target is read at fire time.
    const h = setup();
    h.mounts.lobby('Lobby', () => fakeScene('lobby'));
    h.mounts.mount('Settings', () => fakeScene('settings'));
    h.mounts.viewportSettled();
    expect(h.lobbyRebuilds()).toBe(0);
    expect(h.gone()).toEqual(['lobby', 'settings', 'settings']);
  });
});

describe('SceneMounts — fades', () => {
  it('honours a fade requested outside a rebuild', () => {
    const h = setup();
    h.mounts.mount('World', () => fakeScene('world'), { fade: true });
    expect(h.goto.mock.calls[0]![1]).toEqual({ fade: true });
  });

  it('swaps instantly when the rebuild is the caller', () => {
    // Cross-fading a rotation would read as a transition the player did not ask for.
    const h = setup();
    h.mounts.mount('World', () => fakeScene('world'), { fade: true });
    h.mounts.viewportSettled();
    expect(h.goto.mock.calls[1]![1]).toEqual({ fade: false });
  });

  it('applies the same rule to the lobby, which asks for a fade on a real entry', () => {
    const h = setup();
    const mounts = h.mounts;
    mounts.lobby('Lobby', () => fakeScene('lobby'), { fade: true });
    expect(h.goto.mock.calls[0]![1]).toEqual({ fade: true });
  });
});

describe('SceneMounts — overlays', () => {
  it('parks the host rebuild while an overlay is up and gives it back on pop', () => {
    // ADR-044 / ADR-072: the panel sits on a still-live host. Rebuilding the host underneath would
    // destroy it and leave the overlay parented to a dead scene graph.
    const h = setup();
    let n = 0;
    h.mounts.mount('Roster', () => fakeScene(`roster${++n}`));
    h.mounts.overlay(fakeScene('equipment'));

    h.mounts.viewportSettled();
    expect(h.gone()).toEqual(['roster1']);
    expect(h.pushOverlay).toHaveBeenCalledTimes(1);

    h.mounts.popOverlay();
    h.mounts.viewportSettled();
    expect(h.gone()).toEqual(['roster1', 'roster2']);
  });

  it('does not resurrect a parked rebuild after the host was replaced', () => {
    // The overlay can also be dismissed by a plain goto (SceneManager clears its overlay slot). A
    // later popOverlay must not hand the NEW screen the OLD host's rebuild.
    const h = setup();
    h.mounts.mount('Roster', () => fakeScene('roster'));
    h.mounts.overlay(fakeScene('equipment'));
    h.mounts.mount('Settings', () => fakeScene('settings'));

    h.mounts.popOverlay();
    h.mounts.viewportSettled();
    expect(h.gone()).toEqual(['roster', 'settings', 'settings']);
  });
});

describe('SceneMounts — screens that mount themselves', () => {
  it('takeScreen leaves the screen unrebuildable until a respawn is armed', () => {
    // The gacha asset gate and the netplay game both goto on their own schedule.
    const h = setup();
    const gen = h.mounts.takeScreen();
    h.mounts.viewportSettled();
    expect(h.gone()).toEqual([]);

    h.mounts.armRespawn(gen, () => h.goto(fakeScene('gacha')));
    h.mounts.viewportSettled();
    expect(h.gone()).toEqual(['gacha']);
  });

  it('drops a late armRespawn once the player has moved on', () => {
    // Otherwise a gacha entry backed out of during its loading screen comes flying back on the
    // next rotation, over whatever the player actually navigated to.
    const h = setup();
    const gen = h.mounts.takeScreen();
    h.mounts.mount('Settings', () => fakeScene('settings'));

    h.mounts.armRespawn(gen, () => h.goto(fakeScene('gacha')));
    h.mounts.viewportSettled();
    expect(h.gone()).toEqual(['settings', 'settings']);
  });

  it('counts the lobby as a move away, too', () => {
    const h = setup();
    const gen = h.mounts.takeScreen();
    h.mounts.lobby('Lobby', () => fakeScene('lobby'));
    h.mounts.armRespawn(gen, () => h.goto(fakeScene('gacha')));
    h.mounts.viewportSettled();
    expect(h.lobbyRebuilds()).toBe(1);
    expect(h.gone()).toEqual(['lobby']);
  });
});
