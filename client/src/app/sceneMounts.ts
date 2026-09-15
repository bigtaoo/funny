// sceneMounts.ts — "which screen is on, and how do we put it back when the viewport changes shape".
// Extracted from PixiAppViews 2026-09-14, when making rotation re-lay-out every screen (rather than
// only the lobby) pushed that file past the 500-line convention for the third time. Same form②
// seam as `app/viewportResize.ts` one step further in: the ~35-method `showX` forward list and this
// bookkeeping share nothing but the SceneManager handle — the list decides WHAT to build (it owns
// `layout`, which ~40 call sites read), this decides what happens to it afterwards.
//
// ## The problem this exists to solve
//
// 2026-09-10 made the canvas RE-FIT unconditional but left the scene REBUILD attached to the lobby's
// lifetime (`armRebuild`/`disarmRebuild` on the watcher). So rotating the phone anywhere else — the
// shop being the report that started this — left the screen drawn against the design rect it was
// constructed with: a portrait layout stretched across a landscape canvas, and vice versa.
//
// The fix is not another gate on the watcher. The watcher's job ends at "the viewport settled"; it
// has no idea what a scene is. WHICH screens accept a rebuild is a statement about scenes, so it
// lives with them:
//
//   - `mount()`    — rebuildable. Build it again from the same callbacks against the new layout.
//                    Every menu / shop / meta screen, and the stage-level dialogs.
//   - `volatile()` — never rebuilt, because a fresh constructor cannot restore what the scene is
//                    holding: an engine mid-match, a replay's playhead, the SLG map's camera and
//                    live subscriptions, a room whose contents only ever arrive as server pushes, a
//                    cinematic mid-beat. These keep the 2026-09-10 behaviour — fitted canvas,
//                    layout of the orientation they were entered in.
//   - `lobby()`    — the one screen rebuilt through the app core instead (`nav.goLobby({fromResize})`),
//                    because nav/lobby.ts re-derives its callbacks from save/session state on every
//                    entry.
//
// What a rebuild costs the player is the scene's own transient state — the open tab, the scroll
// offset, a half-typed field. That is the same trade the lobby has made since 2026-08-24, and a far
// smaller one than a screen laid out for the orientation they just rotated away from.
//
// Dropping the arm/disarm lifetime also dropped the need for a "cancel the pending rebuild" hook:
// the timer only means the viewport settled, and the target is resolved when it FIRES, so a rotation
// followed immediately by a tap into another screen rebuilds the screen the player actually reached.
import { recordConstructSample } from '../net/anomaly';
import type { SceneManager, Scene } from '../scenes/SceneManager';
import type { FadeOpts } from './AppViews';

/** Tracks the current screen and how (or whether) to rebuild it after a viewport change. */
export class SceneMounts {
  /** True only while the lobby is the current screen — see `lobby()`. */
  private lobbyActive = false;

  /**
   * How to put the CURRENT screen back after the viewport changed shape. `null` means this screen
   * must not be rebuilt (see `volatile()`), or that an overlay is sitting on top of it.
   */
  private respawn: (() => void) | null = null;

  /**
   * The host screen's `respawn`, parked while an overlay covers it: rebuilding the host from under a
   * live overlay would tear the host down and leave the overlay pointing at a dead parent.
   *
   * A one-field record rather than a bare function, because "no overlay is up" and "the host under
   * the overlay had no respawn" are different states and `popOverlay` must not confuse them: an
   * overlay can also be dismissed by a plain `goto` (SceneManager clears its own overlay slot), and
   * a `popOverlay` arriving after that used to hand the NEW screen the old host's `null`, silently
   * making the screen the player is actually on unrebuildable.
   */
  private park: { respawn: (() => void) | null } | null = null;

  /** Bumped by every full-screen swap, so a mount that finishes asynchronously (the gacha asset
   *  gate) can tell whether it is still the screen the player is on before arming its respawn. */
  private seq = 0;

  /** True only while a viewport-driven rebuild is in flight, so that swap is always instant. */
  private rebuilding = false;

  constructor(
    private readonly manager: SceneManager,
    /** Rebuild the lobby — the only screen that goes back out through the app core. */
    private readonly rebuildLobby: () => void,
  ) {}

  /** The viewport has settled: rebuild the current screen, if it is one that can be rebuilt. */
  viewportSettled(): void {
    // `rebuilding` has to be true across the rebuild itself (showLobby() reads it through
    // `instantSwap` to force an instant swap), hence the try/finally rather than a plain flag.
    this.rebuilding = true;
    try {
      if (this.lobbyActive) this.rebuildLobby();
      else this.respawn?.();
    } finally {
      this.rebuilding = false;
    }
  }

  /**
   * Times a scene constructor and reports it to net/anomaly if it ran long enough to plausibly
   * BE a prod ANR (see recordConstructSample) — this is the only vantage point that can see scene
   * construction, since it happens before the scene is ever mounted/ticked by SceneManager.
   */
  timedBuild<T extends Scene>(name: string, build: () => T): T {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const scene = build();
    const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    recordConstructSample(name, dt);
    return scene;
  }

  /**
   * Swap to a freshly built scene and remember how to build it again, so a rotation — or a late
   * safe-area inset — re-lays the screen out for the new shape. `build` closes over the caller's
   * current layout, which the viewport watcher has already replaced by the time a rebuild fires.
   *
   * Returns a getter for the live instance rather than the instance itself: a rebuild destroys the
   * scene the caller was handed, so any view the caller keeps across pushes has to read through
   * this or it would forward into a dead scene graph.
   */
  mount<T extends Scene>(name: string, build: () => T, opts?: FadeOpts): () => T {
    this.enterScreen();
    let live!: T;
    const swap = (fade: boolean): void => {
      live = this.timedBuild(name, build);
      this.manager.goto(live, { fade });
    };
    swap(this.instantSwap(opts));
    this.respawn = () => swap(false);
    return () => live;
  }

  /** Same swap, for a screen that must not be rebuilt (see the file header's `volatile()` list). */
  volatile(name: string, build: () => Scene, opts?: FadeOpts): void {
    this.takeScreen();
    this.manager.goto(this.timedBuild(name, build), { fade: this.instantSwap(opts) });
  }

  /**
   * Mount the lobby: rebuilt through `rebuildLobby` rather than through a respawn of its own.
   * Returns the instance — nothing can swap it without going back through this method.
   */
  lobby<T extends Scene>(name: string, build: () => T, opts?: FadeOpts): T {
    const scene = this.timedBuild(name, build);
    this.manager.goto(scene, { fade: this.instantSwap(opts) });
    this.enterScreen(); // a full-screen swap like any other — bumps the generation, clears the park
    this.lobbyActive = true;
    this.respawn = null;
    return scene;
  }

  /**
   * Claim the screen for a mount that does its own `goto` — one behind an asset gate, or the
   * netplay game with its flipped joiner layout — and mark it not-rebuildable for now. Returns the
   * generation to hand back to {@link armRespawn} if the mount turns out to be rebuildable once it
   * finishes.
   */
  takeScreen(): number {
    this.respawn = null;
    return this.enterScreen();
  }

  /**
   * Arm a respawn for a screen that finished mounting asynchronously. A no-op if the player has
   * navigated on since `gen` was issued — otherwise a gacha entry the player backed out of would
   * come flying back on the next rotation.
   */
  armRespawn(gen: number, respawn: () => void): void {
    if (this.seq === gen) this.respawn = respawn;
  }

  /** Mount `scene` on top of the current one, parking the host's respawn for {@link popOverlay}. */
  overlay(scene: Scene): void {
    this.park = { respawn: this.respawn };
    this.respawn = null;
    this.manager.pushOverlay(scene);
  }

  /** Close the overlay; the host is the current screen again, so give it its respawn back. */
  popOverlay(): void {
    this.manager.popOverlay();
    if (this.park) { this.respawn = this.park.respawn; this.park = null; }
  }

  /** Bookkeeping shared by every full-screen swap: the lobby is no longer on screen, and any park
   *  under an overlay dies with the scene that owned it (the swap drops the overlay too). */
  private enterScreen(): number {
    this.lobbyActive = false;
    this.park = null;
    return ++this.seq;
  }

  /** A viewport-driven rebuild always swaps instantly, regardless of the caller's fade request. */
  private instantSwap(opts?: FadeOpts): boolean {
    return !this.rebuilding && !!opts?.fade;
  }
}
