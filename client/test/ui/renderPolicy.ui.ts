// render/renderPolicy.ts — the frame-rate cap, the dpr cap, and demand-driven painting.
//
// Why this test carries weight: the policy's failure mode is not a wrong number, it is a screen
// that stops updating. So the assertions here are deliberately of two kinds —
//
//   1. the gate SKIPS when it should (that is the whole saving), and
//   2. the gate PAINTS for every kind of change a scene can make.
//
// (2) is the load-bearing half, and it is one case per field `stageSignature` reads. Each case was
// mutation-verified by deleting the corresponding line from the signature and confirming the case
// goes red — a detector that misses a field looks perfectly fine in a suite that never mutates that
// field, and ships as "the screen freezes until you touch it".
//
// Lives in the UI suite because it needs real PIXI display objects (the headless adapter provides
// them); no renderer is involved — the host's paint entry point is a counter.
//
// Run: npm run test:ui

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import {
  ACTIVE_AFTER_INPUT_MS, DECOR_QUIET_AFTER_MS, IDLE_FLOOR_MS, IDLE_FPS, IDLE_QUIET_MS,
  MAX_RENDER_RESOLUTION, RenderPolicy, TARGET_FPS,
  holdRenderActive, invalidateRender, rendererResolution, resetRenderHold, setRenderPolicyClock,
  setSignatureCovered, stageSignature, type PaintMode,
} from '../../src/render/renderPolicy';
import type { FrameScheduler } from '../../src/render/framePacer';
import { decorationsQuiet, setDecorationsQuiet } from '../../src/render/idleQuiet';
import { BoilingSprite } from '../../src/render/boil';

/** A stand-in for PIXI.Application: a real Ticker + stage, and a paint entry point that counts. */
function stubHost() {
  const ticker = new PIXI.Ticker();
  const stage = new PIXI.Container();
  const host = {
    ticker,
    stage,
    paints: 0,
    render(): void { host.paints += 1; },
  };
  // Exactly what Application's TickerPlugin does when it is constructed — the listener the policy
  // has to take over from. Without this line the removal assertion below would be vacuous.
  ticker.add(host.render, host, PIXI.UPDATE_PRIORITY.LOW);
  return host;
}

/** Frozen clock: `hold` and `floor` are time-based, and both must be OFF while testing detection. */
let clockMs = 10_000;

/** rAF seam that never fires by itself: the decision tests step `policy.tick()` directly. */
const manualScheduler: FrameScheduler = { request: () => 1, cancel: () => {} };

/** Installed this case; uninstalled in afterEach so `Ticker.shared` (a global) is handed back. */
const installed: RenderPolicy[] = [];

function policyFor(mode: () => PaintMode | undefined) {
  const host = stubHost();
  const policy = new RenderPolicy(host, mode, manualScheduler);
  policy.install();
  installed.push(policy);
  return { host, policy };
}

/** The cap the policy asked for. Since ADR-094 that lives on the pacer, not on `ticker.maxFPS`. */
function capOf(policy: RenderPolicy): number {
  return policy.framePacer?.capFps ?? -1;
}

beforeEach(() => {
  clockMs = 10_000;
  setRenderPolicyClock(() => clockMs);
  resetRenderHold();
});

afterEach(() => {
  setRenderPolicyClock();
  resetRenderHold();
  // `Ticker.shared` is a process-wide global whose loop the pacer takes over; hand it back.
  for (const p of installed.splice(0)) p.uninstall();
});

describe('rendererResolution — the dpr cap', () => {
  it('passes through anything at or below the cap', () => {
    expect(rendererResolution(1)).toBe(1);
    expect(rendererResolution(1.5)).toBe(1.5);
    expect(rendererResolution(2)).toBe(2);
  });

  it('caps a dpr-3 phone (the case that motivated it: 2.25x the pixels of dpr 2)', () => {
    expect(rendererResolution(3)).toBe(MAX_RENDER_RESOLUTION);
    expect(rendererResolution(4)).toBe(MAX_RENDER_RESOLUTION);
  });

  it('degrades a nonsense dpr to 1 rather than to 0 (a 0-resolution canvas draws nothing)', () => {
    expect(rendererResolution(0)).toBe(1);
    expect(rendererResolution(Number.NaN)).toBe(1);
    expect(rendererResolution(-2)).toBe(1);
  });
});

describe('install — the frame cap, and taking over the paint', () => {
  it("caps the loop at TARGET_FPS, and keeps PIXI's own truncating throttle off (ADR-094)", () => {
    const { host, policy } = policyFor(() => 'live');
    expect(capOf(policy)).toBe(TARGET_FPS);
    expect(host.ticker.maxFPS).toBe(0);
    expect(PIXI.Ticker.shared.maxFPS).toBe(0);
  });

  it("removes Application's own render listener — the ticker must not paint behind the gate", () => {
    // The proof has to be behavioural, not a listener count: with the host's own LOW-priority
    // listener still registered, a ticker tick paints regardless of what the policy decided, and
    // every skip below would be a lie. Drive the REAL ticker here (the decision tests below call
    // policy.tick() directly).
    const { host } = policyFor(() => 'reactive');
    host.ticker.update(clockMs);          // first tick: nothing painted yet -> the policy paints once
    const afterFirst = host.paints;
    clockMs += 20;
    host.ticker.update(clockMs + 20);     // second tick: unchanged stage -> nobody may paint
    expect(host.paints).toBe(afterFirst);
  });
});

describe('paint modes', () => {
  it("'live' paints every tick — a scene that says nothing keeps its old behaviour", () => {
    const { host, policy } = policyFor(() => 'live');
    for (let i = 0; i < 5; i++) expect(policy.tick().painted).toBe(true);
    expect(host.paints).toBe(5);
  });

  it('an undeclared paint mode is treated as live', () => {
    const { policy } = policyFor(() => undefined);
    expect(policy.tick().reason).toBe('live');
    expect(policy.tick().reason).toBe('live');
  });

  it("'live' never walks the stage: nothing reads a signature while the scene stays live (ADR-096)", () => {
    // The walk was a quarter of the city screen's main-thread time, spent after every paint on a
    // number no live tick compares against. Counted through the one field every visit reads first.
    const { host, policy } = policyFor(() => 'live');
    const child = new PIXI.Container();
    let reads = 0;
    Object.defineProperty(child, 'visible', { get: () => { reads += 1; return true; }, configurable: true });
    host.stage.addChild(child);
    for (let i = 0; i < 5; i++) policy.tick();
    expect(host.paints).toBe(5);
    expect(reads).toBe(0);
  });

  it('a switch from live to reactive paints once, then settles', () => {
    let mode: PaintMode = 'live';
    const { host, policy } = policyFor(() => mode);
    for (let i = 0; i < 3; i++) policy.tick();
    mode = 'reactive';
    expect(policy.tick()).toEqual({ painted: true, reason: 'changed' });
    for (let i = 0; i < 10; i++) expect(policy.tick().painted).toBe(false);
    expect(host.paints).toBe(4);
  });

  it("'reactive' paints the first tick and then stops while nothing changes", () => {
    const { host, policy } = policyFor(() => 'reactive');
    expect(policy.tick().painted).toBe(true);
    for (let i = 0; i < 30; i++) expect(policy.tick().painted).toBe(false);
    expect(host.paints).toBe(1);
  });
});

describe('reactive: every kind of change repaints', () => {
  let host: ReturnType<typeof stubHost>;
  let policy: RenderPolicy;
  let g: PIXI.Graphics;
  let text: PIXI.Text;
  let sprite: PIXI.Sprite;

  /** Settle into "painted once, now skipping" — the state a real idle screen sits in. */
  function settle(): void {
    expect(policy.tick().painted).toBe(true);
    expect(policy.tick().painted).toBe(false);
  }

  /** The change under test must produce exactly one paint, and then settle again. */
  function expectRepaint(change: () => void): void {
    change();
    const painted = policy.tick();
    expect(painted.painted).toBe(true);
    expect(painted.reason).toBe('changed');
    expect(policy.tick().painted).toBe(false);
  }

  beforeEach(() => {
    const made = policyFor(() => 'reactive');
    host = made.host;
    policy = made.policy;
    g = new PIXI.Graphics();
    g.beginFill(0xff0000).drawRect(0, 0, 10, 10).endFill();
    text = new PIXI.Text('hello');
    sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
    const layer = new PIXI.Container();
    layer.addChild(g, text, sprite);
    host.stage.addChild(layer);
    settle();
  });

  it('a move', () => expectRepaint(() => { g.x += 3; }));
  it('a scale', () => expectRepaint(() => { g.scale.set(2, 2); }));
  it('a rotation', () => expectRepaint(() => { g.rotation = 0.2; }));
  it('an alpha fade', () => expectRepaint(() => { g.alpha = 0.4; }));
  it('a hide', () => expectRepaint(() => { g.visible = false; }));
  it('a show (after a hide)', () => {
    expectRepaint(() => { g.visible = false; });
    expectRepaint(() => { g.visible = true; });
  });
  it('a renderable flag', () => expectRepaint(() => { g.renderable = false; }));
  it('a tint', () => expectRepaint(() => { sprite.tint = 0x00ff00; }));
  it('a redraw of the same shape in a different colour', () => expectRepaint(() => {
    g.clear();
    g.beginFill(0x0000ff).drawRect(0, 0, 10, 10).endFill();
  }));
  it('a rewritten label of the same length', () => expectRepaint(() => { text.text = 'hellp'; }));
  it('a spritesheet frame swap (same baseTexture, different frame)', () => {
    // The faithful shape of the real case — an atlas frame change — and the only one that isolates
    // `texture.uid`: swapping in a texture off a DIFFERENT baseTexture would also move `dirtyId`
    // and `valid`, so it would pass even with the uid unread.
    const base = new PIXI.BaseTexture(undefined, { width: 8, height: 8 });
    sprite.texture = new PIXI.Texture(base, new PIXI.Rectangle(0, 0, 4, 4));
    settle();
    expectRepaint(() => { sprite.texture = new PIXI.Texture(base, new PIXI.Rectangle(4, 0, 4, 4)); });
  });
  it('art finishing its decode (baseTexture update, same texture object)', () => expectRepaint(() => {
    sprite.texture.baseTexture.update();
  }));

  it('a swap to a different image (both not yet decoded, so only the identity differs)', () => {
    // Isolates `baseTexture.uid`: two fresh BaseTextures both start `valid: false` with the same
    // `dirtyId`, and the frames are the same size, so nothing else in the signature moves.
    const a = new PIXI.Texture(new PIXI.BaseTexture(undefined, { width: 8, height: 8 }));
    const b = new PIXI.Texture(new PIXI.BaseTexture(undefined, { width: 8, height: 8 }));
    sprite.texture = a;
    settle();
    expectRepaint(() => { sprite.texture = b; });
  });

  it('a mask being applied to an already-present node', () => {
    const maskShape = new PIXI.Graphics();
    maskShape.beginFill(0xffffff).drawRect(0, 0, 5, 5).endFill();
    expectRepaint(() => { host.stage.addChild(maskShape); });
    // The mask object is already hashed as a child; only the RELATIONSHIP changes here.
    expectRepaint(() => { text.mask = maskShape; });
  });

  // Two fields in the signature are deliberately NOT pinned by a case of their own, because they
  // cannot be: `visible` and `children.length`. Both are already implied by the walk's SHAPE — a
  // hidden subtree is not descended into, and an added/removed child changes how many values get
  // folded in — so removing either line leaves every case above green. They stay in because the
  // shape alone makes the hash structurally ambiguous (the classic "ab"+"c" vs "a"+"bc" aliasing):
  // they are separators, not detectors. Recorded here so a later reader does not "clean them up"
  // believing the mutation sweep covered them.
  it('a child appearing', () => expectRepaint(() => { host.stage.addChild(new PIXI.Graphics()); }));
  it('a child disappearing', () => expectRepaint(() => { g.parent.removeChild(g); }));
  it('a zIndex reorder', () => expectRepaint(() => {
    host.stage.sortableChildren = true;
    text.zIndex = 5;
  }));
  it('a change deep inside a nested container', () => {
    const deep = new PIXI.Container();
    const inner = new PIXI.Graphics();
    deep.addChild(inner);
    expectRepaint(() => { host.stage.addChild(deep); });
    expectRepaint(() => { inner.x = 12; });
  });

  it('does NOT repaint for a change inside a hidden subtree (nothing there can be seen)', () => {
    const hidden = new PIXI.Container();
    const inner = new PIXI.Graphics();
    hidden.addChild(inner);
    hidden.visible = false;
    expectRepaint(() => { host.stage.addChild(hidden); });
    inner.x = 40;
    expect(policy.tick().painted).toBe(false);
  });
});

describe('the safety valves', () => {
  it('a pointer event holds the full frame rate, then lets go', () => {
    const { policy } = policyFor(() => 'reactive');
    policy.tick();                                     // settle
    holdRenderActive();
    expect(policy.tick().reason).toBe('hold');
    clockMs += ACTIVE_AFTER_INPUT_MS - 1;
    expect(policy.tick().reason).toBe('hold');
    clockMs += 2;                                      // hold expired, and nothing changed
    expect(policy.tick().painted).toBe(false);
  });

  it('invalidateRender() buys exactly one paint (for changes the signature cannot see)', () => {
    const { policy } = policyFor(() => 'reactive');
    policy.tick();
    expect(policy.tick().painted).toBe(false);
    invalidateRender();
    expect(policy.tick().reason).toBe('hold');
    clockMs += 2;
    expect(policy.tick().painted).toBe(false);
  });

  it('paints on the floor even with nothing changed — a missed change is late, never permanent', () => {
    const { host, policy } = policyFor(() => 'reactive');
    policy.tick();
    // Whatever the detector fails to notice, this is the bound on how long it stays invisible.
    clockMs += IDLE_FLOOR_MS;
    expect(policy.tick().reason).toBe('floor');
    expect(host.paints).toBe(2);
  });

  it('counts what it did, so a paint rate can be read rather than guessed', () => {
    const { policy } = policyFor(() => 'reactive');
    policy.tick();
    for (let i = 0; i < 9; i++) policy.tick();
    expect(policy.stats).toEqual({ ticks: 10, painted: 1, skipped: 9, idle: false });
  });
});

describe('stageSignature', () => {
  it('is stable for an untouched tree (otherwise nothing would ever be skipped)', () => {
    const stage = new PIXI.Container();
    stage.addChild(new PIXI.Text('x'), new PIXI.Sprite(PIXI.Texture.WHITE));
    expect(stageSignature(stage)).toBe(stageSignature(stage));
  });

  it('distinguishes two trees that differ only in child order', () => {
    const a = new PIXI.Container();
    const first = new PIXI.Graphics();
    const second = new PIXI.Sprite(PIXI.Texture.WHITE);
    a.addChild(first, second);
    const sigBefore = stageSignature(a);
    a.setChildIndex(second, 0);
    expect(stageSignature(a)).not.toBe(sigBefore);
  });
});

// ── walking less (ADR-101) ────────────────────────────────────────────────────
//
// The walk was 40% of the world map's and the city's idle main thread. Two savings, each pinned both
// ways: the walk is skipped where it was wasted, and every case where skipping would hide a change
// still paints (or at worst paints one frame late — never stops painting, never keeps painting).

/** A node that counts how often the walk reads it: the walk reads `visible` exactly once per node. */
function walkCounter(): { node: PIXI.Container; walks: () => number } {
  const node = new PIXI.Container();
  let reads = 0;
  Object.defineProperty(node, 'visible', { get: () => { reads += 1; return true; }, set: () => {} });
  return { node, walks: () => reads };
}

describe('covered subtrees (a scene under a full-screen overlay)', () => {
  it('a change inside a covered subtree does not repaint; uncovering it does', () => {
    const { host, policy } = policyFor(() => 'reactive');
    const under = new PIXI.Container();
    const g = new PIXI.Graphics();
    under.addChild(g);
    host.stage.addChild(under);
    policy.tick();
    setSignatureCovered(under, true);
    expect(policy.tick().reason).toBe('changed');      // covering is itself a change of picture
    expect(policy.tick().painted).toBe(false);
    g.x += 5;
    expect(policy.tick().painted).toBe(false);          // painted over: nothing to show
    setSignatureCovered(under, false);
    // Uncovering alone moves the signature, even with no invalidateRender() around it.
    expect(policy.tick().reason).toBe('changed');
    expect(policy.tick().painted).toBe(false);
    g.x += 5;
    expect(policy.tick().reason).toBe('changed');
  });

  it('is not descended into at all — that is the saving', () => {
    const under = new PIXI.Container();
    const probe = walkCounter();
    under.addChild(probe.node);
    const stage = new PIXI.Container();
    stage.addChild(under);
    stageSignature(stage);
    expect(probe.walks()).toBe(1);
    setSignatureCovered(under, true);
    stageSignature(stage);
    expect(probe.walks()).toBe(1);
    setSignatureCovered(under, false);
    stageSignature(stage);
    expect(probe.walks()).toBe(2);
  });
});

describe('the baseline after a paint', () => {
  function setup(render?: (stage: PIXI.Container) => void) {
    const made = policyFor(() => 'reactive');
    if (render) {
      const count = made.host.render.bind(made.host);
      made.host.render = (): void => { count(); render(made.host.stage); };
    }
    const probe = walkCounter();
    made.host.stage.addChild(probe.node);
    made.policy.tick();
    expect(made.policy.tick().painted).toBe(false);
    return { ...made, probe };
  }

  it('a drag does not walk at all — every tick of it paints without looking', () => {
    const { policy, probe } = setup();
    const before = probe.walks();
    for (let i = 0; i < 30; i++) {
      holdRenderActive();                      // a pointer move every frame
      expect(policy.tick().reason).toBe('hold');
      clockMs += 16;
    }
    expect(probe.walks()).toBe(before);
  });

  it('the last paint of a gesture walks, so the screen settles the moment the hold ends', () => {
    const { policy, probe } = setup();
    holdRenderActive();
    policy.tick();
    const before = probe.walks();
    clockMs += ACTIVE_AFTER_INPUT_MS - 10;     // under one tick left
    expect(policy.tick().reason).toBe('hold');
    expect(probe.walks()).toBe(before + 1);
    clockMs += 20;
    expect(policy.tick().painted).toBe(false); // no extra paint for the hold having ended
  });

  it('a change walks once, not twice — the pre-paint walk stands in for the post-paint one', () => {
    const { host, policy, probe } = setup();
    const g = new PIXI.Graphics();
    host.stage.addChild(g);
    policy.tick();
    policy.tick();
    // An animation stepping every other tick, like the world map's 30 fps shield at 60 Hz.
    const before = probe.walks();
    for (let i = 0; i < 10; i++) {
      g.x += 1;
      expect(policy.tick().reason).toBe('changed');
      expect(policy.tick().painted).toBe(false);
    }
    expect(probe.walks() - before).toBe(20);
  });

  it('a Text that render re-rasterises gets a real post-paint walk (no extra paint)', () => {
    const text = new PIXI.Text('a');
    const { host, policy } = setup(() => text.updateText(true));
    host.stage.addChild(text);
    policy.tick();
    expect(policy.tick().painted).toBe(false);
    text.text = 'something longer';
    expect(policy.tick().reason).toBe('changed');
    expect(policy.tick().painted).toBe(false);
  });

  it('a container that render sorts gets a real post-paint walk (no extra paint)', () => {
    const layer = new PIXI.Container();
    layer.sortableChildren = true;
    const a = new PIXI.Graphics();
    const b = new PIXI.Graphics();
    layer.addChild(a, b);
    // What `Container.updateTransform` does on the way into a real render.
    const { host, policy } = setup(() => { if (layer.sortDirty) layer.sortChildren(); });
    host.stage.addChild(layer);
    policy.tick();
    expect(policy.tick().painted).toBe(false);
    a.zIndex = 5;
    expect(policy.tick().reason).toBe('changed');
    expect(policy.tick().painted).toBe(false);
  });

  it('a render-side change nothing knows about costs one extra paint, then settles', () => {
    // The guard: the paint straight after a reused baseline walks for real.
    const g = new PIXI.Graphics();
    const { host, policy } = setup(() => { g.y += 1; });   // moves on every render
    host.stage.addChild(g);
    policy.tick();
    policy.tick();
    g.x += 1;
    expect(policy.tick().reason).toBe('changed');
    expect(policy.tick().reason).toBe('changed');          // the one extra
    let paints = 0;
    for (let i = 0; i < 10; i++) if (policy.tick().painted) paints++;
    expect(paints).toBe(0);
  });
});

// ── the idle throttles (2026-09-09) ──────────────────────────────────────────
//
// Demand-driven painting stopped the idle GPU work; these two knobs go after what is left, which is
// the frame itself — 60 scene `update()` calls and 60 signature walks a second on a picture that is
// standing still. Both failure modes are worse than the saving, so both directions are pinned:
// engaging when it should (the saving) and disengaging the instant anything happens (the risk).
describe('idle tick-rate throttle', () => {
  /** Tick `n` times, advancing the clock by `stepMs` before each one. */
  function run(policy: RenderPolicy, n: number, stepMs: number): void {
    for (let i = 0; i < n; i++) { clockMs += stepMs; policy.tick(); }
  }

  it('drives the SECOND loop too, on the same beat — Application does not use Ticker.shared', () => {
    // `sharedTicker` defaults to false, so `render/boil.ts` and the battle fx animate on a ticker
    // the application's own cap never touched: uncapped, i.e. 120 Hz on a ProMotion device, for as
    // long as one lobby boiling line existed. ADR-094: one pacer runs both, shared first.
    const order: string[] = [];
    const fx = (): void => { order.push('shared'); };
    PIXI.Ticker.shared.add(fx);
    const { host, policy } = policyFor(() => 'live');
    host.ticker.add(() => { order.push('app'); });
    expect(PIXI.Ticker.shared.started).toBe(false); // its own rAF loop is off
    // A real-clock timestamp: `Ticker.shared` was started long ago, and PIXI ignores any time at or
    // before its `lastTime`.
    policy.framePacer!.onFrame(performance.now() + 1_000);
    expect(order).toEqual(['shared', 'app']);
    PIXI.Ticker.shared.remove(fx);
  });

  it('hands the shared ticker back as it found it on uninstall', () => {
    const shared = PIXI.Ticker.shared;
    const before = { autoStart: shared.autoStart, maxFPS: shared.maxFPS };
    const { policy } = policyFor(() => 'reactive');
    expect(shared.autoStart).toBe(false);
    policy.uninstall();
    installed.splice(installed.indexOf(policy), 1);
    expect({ autoStart: shared.autoStart, maxFPS: shared.maxFPS }).toEqual(before);
  });

  it('drops to IDLE_FPS once a reactive screen has been still for IDLE_QUIET_MS', () => {
    const { host, policy } = policyFor(() => 'reactive');
    policy.tick();                       // first tick always paints (no baseline yet)
    expect(capOf(policy)).toBe(TARGET_FPS);

    run(policy, 1, IDLE_QUIET_MS - 1);   // not quiet long enough yet
    expect(capOf(policy)).toBe(TARGET_FPS);
    expect(policy.stats.idle).toBe(false);

    run(policy, 1, 2);
    expect(capOf(policy)).toBe(IDLE_FPS);
    // Published with the cap: PerfMonitor keeps these stretches out of the fps (ADR-095).
    expect(policy.stats.idle).toBe(true);
      });

  it('the IDLE_FLOOR_MS paint does not count as activity — otherwise this never engages at all', () => {
    // The floor fires every 500ms, so if a floor paint re-armed full frame rate the 2s quiet window
    // could never elapse. Step in floor-sized hops so every tick below paints for reason 'floor'.
    const { host, policy } = policyFor(() => 'reactive');
    policy.tick();
    const paintsBefore = host.paints;
    run(policy, 6, IDLE_FLOOR_MS + 1);   // 6 floor paints, ~3s of clock
    expect(host.paints).toBe(paintsBefore + 6); // they really did paint, i.e. really were floors
    expect(capOf(policy)).toBe(IDLE_FPS);
  });

  it('a real change puts the rate straight back', () => {
    const { host, policy } = policyFor(() => 'reactive');
    policy.tick();
    run(policy, 1, IDLE_QUIET_MS + 1);
    expect(capOf(policy)).toBe(IDLE_FPS);

    host.stage.addChild(new PIXI.Container()); // the picture changed
    clockMs += 16;
    expect(policy.tick().reason).toBe('changed');
    expect(capOf(policy)).toBe(TARGET_FPS);
    expect(policy.stats.idle).toBe(false);
  });

  it('a pointer event restores the rate synchronously, without waiting for a tick', () => {
    // This is why the activity seam calls back into the policy: while throttled, the next tick can
    // be 50ms away, and the first frame after a tap must not be the one that pays for it.
    const { host, policy } = policyFor(() => 'reactive');
    policy.tick();
    run(policy, 1, IDLE_QUIET_MS + 1);
    expect(capOf(policy)).toBe(IDLE_FPS);

    expect(policy.stats.idle).toBe(true);
    holdRenderActive();
    expect(capOf(policy)).toBe(TARGET_FPS); // no tick happened in between
    // ...and so does the idle flag, or the first full-rate interval after a tap would be dropped
    // from the fps as idle while the pacer is already running it at 60.
    expect(policy.stats.idle).toBe(false);
    policy.uninstall();
  });

  it('never throttles a live scene, however long it sits there', () => {
    const { host, policy } = policyFor(() => 'live');
    run(policy, 60, IDLE_QUIET_MS);
    expect(capOf(policy)).toBe(TARGET_FPS);
    expect(policy.stats.idle).toBe(false);
  });
});

describe('decoration quiescence', () => {
  it('stays off while the player is around, and turns on after DECOR_QUIET_AFTER_MS', () => {
    const { policy } = policyFor(() => 'reactive');
    policy.tick();
    expect(decorationsQuiet()).toBe(false);

    clockMs += DECOR_QUIET_AFTER_MS - 1;
    policy.tick();
    expect(decorationsQuiet()).toBe(false);

    clockMs += 2;
    policy.tick();
    expect(decorationsQuiet()).toBe(true);
    policy.uninstall();
  });

  it('a pointer event revives decorations on the next tick', () => {
    const { policy } = policyFor(() => 'reactive');
    clockMs += DECOR_QUIET_AFTER_MS + 1;
    policy.tick();
    expect(decorationsQuiet()).toBe(true);

    holdRenderActive();
    policy.tick();
    expect(decorationsQuiet()).toBe(false);
    policy.uninstall();
  });

  it('uninstall clears the flag — a torn-down policy must not freeze whatever runs next', () => {
    const { policy } = policyFor(() => 'reactive');
    clockMs += DECOR_QUIET_AFTER_MS + 1;
    policy.tick();
    expect(decorationsQuiet()).toBe(true);
    policy.uninstall();
    expect(decorationsQuiet()).toBe(false);
  });
});

// The boiling line is the other menu decoration, and unlike the stickman it lives on
// `PIXI.Ticker.shared` — so it needs real PIXI display objects, which is why it is pinned here and
// not in test/render/idleDecorations.test.ts with the stickman.
describe('boiling line', () => {
  /** Which variant is currently the visible one. */
  function shown(b: BoilingSprite): number {
    return b.children.findIndex((c) => (c as PIXI.DisplayObject).visible);
  }

  afterEach(() => { setDecorationsQuiet(false); });

  it('cycles variants while the screen is in use', () => {
    const boil = new BoilingSprite(40, 20, (pen, g) => { pen.rect(0, 0, 40, 20); void g; }, { fps: 8 });
    const first = shown(boil);
    boil.step(0.2); // 8fps => one step every 0.125s
    expect(shown(boil)).not.toBe(first);
    boil.destroy();
  });

  it('holds its variant once decorations are quiet', () => {
    const boil = new BoilingSprite(40, 20, (pen, g) => { pen.rect(0, 0, 40, 20); void g; }, { fps: 8 });
    const first = shown(boil);
    setDecorationsQuiet(true);
    for (let i = 0; i < 60; i++) boil.step(1 / 60); // a full second
    expect(shown(boil)).toBe(first);

    // ...and it is held, not broken: reviving resumes the cycle.
    setDecorationsQuiet(false);
    boil.step(0.2);
    expect(shown(boil)).not.toBe(first);
    boil.destroy();
  });
});
