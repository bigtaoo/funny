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
  ACTIVE_AFTER_INPUT_MS, IDLE_FLOOR_MS, MAX_RENDER_RESOLUTION, RenderPolicy, TARGET_FPS,
  holdRenderActive, invalidateRender, rendererResolution, resetRenderHold, setRenderPolicyClock,
  stageSignature, type PaintMode,
} from '../../src/render/renderPolicy';

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

function policyFor(mode: () => PaintMode | undefined) {
  const host = stubHost();
  const policy = new RenderPolicy(host, mode);
  policy.install();
  return { host, policy };
}

beforeEach(() => {
  clockMs = 10_000;
  setRenderPolicyClock(() => clockMs);
  resetRenderHold();
});

afterEach(() => {
  setRenderPolicyClock();
  resetRenderHold();
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
  it('caps the ticker at TARGET_FPS', () => {
    const { host } = policyFor(() => 'live');
    expect(host.ticker.maxFPS).toBe(TARGET_FPS);
  });

  it("removes Application's own render listener — the ticker must not paint behind the gate", () => {
    // The proof has to be behavioural, not a listener count: with the host's own LOW-priority
    // listener still registered, a ticker tick paints regardless of what the policy decided, and
    // every skip below would be a lie. Drive the REAL ticker here (the decision tests below call
    // policy.tick() directly).
    const { host } = policyFor(() => 'reactive');
    host.ticker.start();
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
    expect(policy.stats).toEqual({ ticks: 10, painted: 1, skipped: 9 });
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
