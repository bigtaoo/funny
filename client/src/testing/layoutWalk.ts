// layoutWalk.ts — the layout sweep's walk, with no Playwright anywhere in it.
//
// The browser sweep (`test/browser/portraitLayout.spec.ts`) drives the app across a process
// boundary: every step is a `page.evaluate` and every tap is a real browser mouse click. Inside a
// WeChat mini-game package there is no such boundary and no such mouse — `miniprogram-automator`
// connects to the IDE's socket but every `evaluate` hangs forever, because a mini-*game* has no
// appservice for those commands to reach (measured 2026-08-31; see §50.6). The only shape that
// works there is a package that walks ITSELF, which is this file.
//
// So this is deliberately a SECOND walker, not a shared one: the two differ in exactly the places
// the runtimes differ (how a tap is delivered, whether a reload exists, how a report gets out), and
// everything that is genuinely the same — the stop table, the auditor, the `__nwE2E` handle — is
// imported rather than restated. `layoutStops.ts` is the contract between them.
//
// ⚠ Reading a green report is NOT the same as looking at the screen. This gate reports only
// overlaps past an area threshold; the browser sweep's last three real bugs were found by reading
// the PNGs of stops it had just called clean (§50.11). Whatever drives this walk should capture a
// picture per stop and someone should look at them.

import type { TranslationKey } from '../i18n';
import { auditLayout, auditOptionsFor, type AuditFinding, type AuditResult } from './layoutAudit';
import { STOPS, hopName, type Hop, type Stop } from './layoutStops';
import type { E2EHandle } from './instrumentViews';

/** How long a tap hop waits for its label to appear before calling the stop unreachable. */
const TAP_WAIT_MS = 6_000;
/** How long a callback hop waits for the screen to change before calling the hop unwired. */
const NAV_WAIT_MS = 10_000;
/** Down→up gap of a synthetic tap. One frame at 30 Hz plus slack: scenes record the hit on DOWN
 *  and commit it on UP, and a zero-gap pair has both land inside the same tick. */
const TAP_HOLD_MS = 60;

export interface StopReport {
  /** `Stop.as`, or the screen actually landed on. */
  screen: string;
  /**
   * What is really MOUNTED, read off the SceneManager rather than off `state.screen`.
   *
   * These two can disagree, and when they do the report is measuring something other than what its
   * name says. Two ways in, both seen on 2026-09-12: popping an overlay runs no `show*` method, so
   * the recorded name goes stale (see `forceLobby`); and a `show*` that is called but whose scene
   * never reaches the stage leaves the name pointing at a scene nobody can see — which is how both
   * `result` stops came back "clean" while their PNGs showed the BATTLE.
   *
   * `<current> +<overlay> fade:<phase>` — `fade` is non-null only while a cross-fade is in flight,
   * which is itself the answer to "why is the incoming scene not on screen yet". Class names survive
   * minification for anything ending in `Scene` (webpack.config.js keeps `/Scene$/`).
   */
  mounted: string;
  /** Visible, unoccluded labels considered — a sanity check that the walk found the scene at all. */
  labels: number;
  /** The callback names the LIVE screen exposes. They ARE the navigation graph: every deeper screen
   *  this sweep could grow into is one of these names. */
  cbKeys: string[];
  findings: AuditFinding[];
}

export interface WalkResult {
  reports: StopReport[];
  /** Stops whose `via` chain never landed — a gated/online-only feature, or a real navigation bug. */
  skipped: { stop: string; via: string; where: string }[];
  /** Screens that painted no label at all: audited, but the audit saw nothing to judge. */
  blank: string[];
  /** Anything that went wrong in the walk itself, rather than in a layout. */
  errors: string[];
  /** Stops after which the recorded screen name had gone stale — see `forceLobby`. Not a failure,
   *  but each one is a place where `__nwE2E.state.screen` stopped describing what is on screen. */
  forcedLobby: string[];
}

export interface WalkDeps {
  handle: E2EHandle;
  /**
   * The literal, parameter-free prefix of a UI string in the locale this walk booted in — what a
   * tap can match on. Injected because the two walkers have different dictionaries in hand: the
   * Playwright one holds all three and picks per viewport, the WeChat package ships `zh` alone.
   */
  label(key: TranslationKey): string;
  /** Best-effort picture of the current screen, named for the stop. Never fatal. */
  capture(name: string): Promise<void>;
  /** Progress line — the only thing a human sees while a 36-stop walk is running. */
  log(line: string): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Walks every stop in `STOPS` from the lobby and audits what it lands on.
 *
 * The caller is responsible for getting the app AS FAR AS THE LOBBY first (boot gates, login,
 * whatever that platform's entry path is) — this starts and ends on the lobby and does nothing
 * else.
 */
export async function walkLayout(deps: WalkDeps): Promise<WalkResult> {
  const { handle, label, capture, log } = deps;
  const state = handle.state;
  const app = handle.app;
  const input = handle.input;
  const scaling = handle.scaling;
  const out: WalkResult = { reports: [], skipped: [], blank: [], errors: [], forcedLobby: [] };
  if (!app || !input || !scaling) {
    out.errors.push('__nwE2E is missing app/input/scaling — not an instrumented build');
    return out;
  }

  const screenNow = (): string => (typeof state.screen === 'string' ? state.screen : '?');

  /** `state.<bag>.<fn>(...args)`, awaited. False when the callback does not exist on this screen. */
  const callCb = async (bag: string, fn: string, args: unknown[] = []): Promise<boolean> => {
    const target = state[bag] as Record<string, (...a: unknown[]) => unknown> | undefined;
    if (!target || typeof target[fn] !== 'function') return false;
    // Awaited: several callbacks are the LOADER for the screen behind them rather than the
    // navigation itself (`loadSLGStatus` resolves the caller's shard, and `openFamilyHub` returns
    // false until it has). A throw does not change the return value — the callback existed and ran,
    // which is all it claims — but it IS recorded, and that is not bookkeeping.
    //
    // `instrumentViews` stamps `state.screen` BEFORE calling through, so a scene CONSTRUCTOR that
    // throws leaves the recorded screen pointing at a scene that was never mounted: the walk then
    // audits (and screenshots) whatever is still on the stage, under the new screen's name, and
    // reports it clean. Measured 2026-09-12: both `result` stops came back with 17 labels, 0
    // findings — and their PNGs were the BATTLE. Swallowing the throw is what made that look green.
    try {
      await target[fn]!(...args);
    } catch (e) {
      out.errors.push(`${bag}.${fn} threw: ${String(e)}`);
    }
    return true;
  };

  /** Dismiss the first-time feature guide (ONBOARDING_DESIGN §4.1) if one is up. */
  const dismissFeatureGuide = (): boolean => {
    const cb = state.showFeatureGuideCb;
    if (typeof cb !== 'function') return false;
    state.showFeatureGuideCb = undefined;
    (cb as () => void)();
    return true;
  };

  /**
   * Centre of the topmost visible label containing `needle`, in renderer screen space — the same
   * walk `layoutAudit` does, minus the judging. Baked labels are plain sprites and carry their
   * string on `name` as `txt:<text>` (render/fastText.ts stamps it for exactly this).
   */
  const findLabel = (needle: string): { x: number; y: number } | null => {
    interface N {
      visible: boolean; alpha: number; name: string | null; text?: unknown; children?: N[];
      getBounds(skipUpdate?: boolean): { x: number; y: number; width: number; height: number };
    }
    let best: { x: number; y: number } | null = null;
    const walk = (n: N): void => {
      if (!n.visible || n.alpha <= 0.02) return;
      const own = typeof n.text === 'string' ? n.text
        : typeof n.name === 'string' && n.name.indexOf('txt:') === 0 ? n.name.slice(4)
          : null;
      if (own !== null && own.indexOf(needle) >= 0) {
        const b = n.getBounds(false);
        // Last match wins: pre-order DFS is PIXI's paint order, so the last one found is the one
        // drawn on top — which is the one a player's finger would reach once a modal is up.
        if (b.width > 0 && b.height > 0) best = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      const kids = n.children;
      if (kids) for (const k of kids) walk(k);
    };
    walk(app.stage as unknown as N);
    return best;
  };

  /**
   * A tap, the only way this runtime has one. The browser walker clicks a real screen pixel and
   * lets the platform adapter convert it; here there is no adapter event to fire, so the two halves
   * are done by hand: `ScalingManager.toDesignSpace` is the exact transform every adapter applies,
   * and `InputManager._emit*` is the exact funnel they all feed.
   *
   * What this does NOT reach is PixiJS's own event system — a stage-level dialog built on
   * `eventMode`/`pointertap` (AppealDialog / FeedbackDialog) consumes taps there, not here. Every
   * tap hop in `STOPS` targets a hit rect inside a scene instead, which is exactly what
   * `InputManager` drives, and two of the five (`cardRoster+detail`, `city+buildDetail`) are
   * confirmed to land on WeChat. The other three did not visibly change the screen on the
   * 2026-09-12 run — one of them (`equipment+craft`) needs nothing but a tab switch, so at least
   * that one is not "the account is empty". Unexplained; see UI_DESIGN_LOG §51.3 ③.
   */
  const tapAt = async (sx: number, sy: number): Promise<void> => {
    const p = scaling.toDesignSpace(sx, sy);
    input._emitDown(p.x, p.y);
    await sleep(TAP_HOLD_MS);
    input._emitUp(p.x, p.y);
  };

  const tapLabel = async (needle: string): Promise<boolean> => {
    const pt = findLabel(needle);
    if (pt === null) return false;
    await tapAt(pt.x, pt.y);
    return true;
  };

  /**
   * What the SceneManager actually has mounted — see `StopReport.mounted` for why this is a separate
   * question from `state.screen`. Reaches through TS privacy exactly like `views.app` does, and for
   * the same reason: a production seam existing solely for a probe would be the worse trade.
   */
  const mountedNow = (): string => {
    const mgr = (handle.views as unknown as {
      manager?: {
        current?: object | null; overlayScene?: object | null;
        transition?: { phase?: string } | null;
      };
    }).manager;
    if (!mgr) return '?';
    const nameOf = (o: object | null | undefined): string => o?.constructor?.name ?? '-';
    const fade = mgr.transition?.phase ?? 'none';
    return `${nameOf(mgr.current)} +${nameOf(mgr.overlayScene)} fade:${fade}`;
  };

  /** What the app thinks it is showing — the readable half of a navigation failure. */
  const whereAmI = (): string => {
    const cbs = Object.keys(state).filter((k) => k.endsWith('Cb')).join(',');
    return `screen=${screenNow()} cbs=[${cbs}]`;
  };

  /** Walks one stop's `via` chain from the lobby. Returns the screen reached, or null. */
  const open = async (stop: Stop): Promise<string | null> => {
    let from = screenNow();
    for (const hop of stop.via as readonly Hop[]) {
      if (typeof hop === 'object' && ('tap' in hop || 'tapText' in hop)) {
        // A tap opens a modal (or a tab) on the SAME screen, so there is no screen change to wait
        // for — settle, re-read whatever `state.screen` says, and let the audit judge what is now
        // on top of it. A tab CAN navigate, though, so the re-read matters either way.
        //
        // Polled rather than tapped once: a tap hop that follows a navigation hop fires the instant
        // `state.screen` changes, which for a list the server fills in is before any row exists.
        const text = 'tap' in hop ? label(hop.tap) : hop.tapText;
        const deadline = Date.now() + TAP_WAIT_MS;
        let tapped = await tapLabel(text);
        while (!tapped && Date.now() < deadline) {
          await sleep(250);
          tapped = await tapLabel(text);
        }
        if (!tapped) return null;
        await sleep(800);
        from = screenNow();
        continue;
      }
      const fn = typeof hop === 'string' ? hop : hop.fn;
      const args = typeof hop === 'string' ? [] : hop.args ?? [];
      const bag = `${from}Cb`;
      if (!await callCb(bag, fn, args)) return null;
      if (typeof hop === 'object' && hop.stay) {
        // Deliberately no screen change: an overlay mounted on `app.stage`, or a loader the next
        // hop depends on. `callCb` has already awaited whatever it returned.
        from = screenNow();
        continue;
      }
      const deadline = Date.now() + NAV_WAIT_MS;
      let landed: string | null = null;
      while (Date.now() < deadline) {
        const now = screenNow();
        if (now !== from) { landed = now; break; }
        if (dismissFeatureGuide()) await callCb(bag, fn, args);
        await sleep(200);
      }
      if (landed === null) return null;
      from = landed;
    }
    return from;
  };

  /**
   * Last resort — the in-package stand-in for the browser walker's `page.reload()`.
   *
   * **Why one is needed at all**: `state.screen` is written by `instrumentViews` when a `show*`
   * method runs, and popping a SceneManager OVERLAY runs none. CityScene is opened as an overlay
   * over a live WorldMapScene (`app/nav/world.ts`: `onBack: returnFromCityToMap`), so after backing
   * out of it the map is on screen and `state.screen` still says `'city'` — for ever. The unwind
   * above then calls exits on a bag whose scene is gone, gets nowhere, and every stop after it is
   * lost. Measured 2026-09-12: 16 of 36 stops, all downstream of `city`.
   *
   * This is a property of the HANDLE, not of this runtime, so the browser walker has it too — it
   * just never had to notice, because reloading the page lands straight back in the lobby. A
   * mini-game cannot reload (`wx.reLaunch` is a mini-*program* API), hence this.
   *
   * What it does: almost every scene's `onBack` is `nav.goLobby()`, so calling one on ANY recorded
   * bag gets there — newest first, because the newest live scene is the one whose exit is real.
   * Counted in the report (`forcedLobby`) rather than done quietly: each entry is a place where the
   * recorded screen name went stale, which is worth knowing even though the walk survives it.
   */
  const forceLobby = async (): Promise<boolean> => {
    const bags = Object.keys(state).filter((k) => k.endsWith('Cb')).reverse();
    for (const bag of bags) {
      for (const fn of ['onExitToLobby', 'onBack']) {
        if (!await callCb(bag, fn)) continue;
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          if (screenNow() === 'lobby') return true;
          await sleep(150);
        }
      }
    }
    return screenNow() === 'lobby';
  };

  /** Back to the lobby by whichever exit each scene offers, unwinding however deep the stop went. */
  const backToLobby = async (from: string): Promise<boolean> => {
    for (let depth = 0; depth < 4; depth++) {
      const screen = screenNow();
      if (screen === 'lobby') return true;
      let moved = false;
      for (const fn of ['onBack', 'onExit', 'onClose', 'onExitToLobby']) {
        if (!await callCb(`${screen}Cb`, fn)) continue;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (screenNow() !== screen) { moved = true; break; }
          await sleep(150);
        }
        if (moved) break;
      }
      if (!moved) break;
    }
    if (screenNow() === 'lobby') return true;
    out.forcedLobby.push(`${from} (stale screen=${screenNow()})`);
    return forceLobby();
  };

  const audit = async (name: string): Promise<void> => {
    // Read the design box and the design→screen factor off the LIVE objects rather than
    // re-deriving them from the window size the way the Playwright walker has to.
    const layout = (handle.views as unknown as { layout?: { designWidth: number; designHeight: number } }).layout;
    const opts = auditOptionsFor(
      layout?.designWidth ?? app.renderer.screen.width,
      layout?.designHeight ?? app.renderer.screen.height,
      scaling.gameLayer.scale.x,
    );
    let res: AuditResult = auditLayout(opts);
    if (res.labels === 0) {
      // Still painting its loading state (the world map streams tiles before anything else).
      await sleep(2_000);
      res = auditLayout(opts);
    }
    if (res.labels === 0) out.blank.push(name);
    // Off the LIVE screen name, not the report's: a modal stop reports under its own name
    // (`Stop.as`) while the callback bag still belongs to the scene underneath.
    const bag = state[`${screenNow()}Cb`];
    const cbKeys = bag && typeof bag === 'object' ? Object.keys(bag) : [];
    out.reports.push({
      screen: name, mounted: mountedNow(), labels: res.labels, cbKeys, findings: res.findings,
    });
    log(`  ${name}: ${res.labels} labels, ${res.findings.length} finding(s) [${mountedNow()}]`);
    await capture(name);
  };

  await sleep(600);
  await audit('lobby');

  // `reloadAfter` stops last. The browser walker reloads the page to unwind them (the feedback
  // dialog is mounted straight on `app.stage`, so `backToLobby` — which unwinds by LEAVING screens
  // — has nothing to leave and the overlay would stay up over every stop after it). A mini-game has
  // no reload: `wx.reLaunch` is a mini-*program* API and there is no equivalent here. Running them
  // at the end is the same guarantee by a different route — nothing comes after them to spoil.
  const ordered = [...STOPS].sort((a, b) => Number(!!a.reloadAfter) - Number(!!b.reloadAfter));

  for (const stop of ordered) {
    const name = stop.as ?? stop.screen;
    let landed: string | null = null;
    try {
      landed = await open(stop);
    } catch (e) {
      out.errors.push(`${name}: open threw — ${String(e)}`);
    }
    if (landed === null) {
      out.skipped.push({
        stop: name,
        via: stop.via.map(hopName).join(' > '),
        where: whereAmI(),
      });
      log(`  ${name}: SKIPPED (gated=${!!stop.gated}) — ${whereAmI()}`);
      if (!await backToLobby(name)) out.errors.push(`${name}: stranded at ${whereAmI()}`);
      continue;
    }
    await sleep(stop.settleMs ?? 400);
    try {
      await audit(name);
    } catch (e) {
      out.errors.push(`${name}: audit threw — ${String(e)}`);
    }
    if (!await backToLobby(name)) out.errors.push(`${name}: stranded at ${whereAmI()}`);
  }
  return out;
}
