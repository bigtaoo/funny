// The wiring between the render policy and the three things that have to talk to it.
//
// Why a file of its own: renderPolicy.ui.ts proves the policy makes the right decisions when it is
// asked, and sceneGeometryBudget.ui.ts proves the lobby is cheap to draw. Neither notices if nobody
// ASKS the policy — and that is the failure this repo has already paid for once (ADR-072: "首轮测试
// 全在场景层和视图层，漏了中间那层接线，而原 bug 恰恰只长在那里"). Delete the install call from
// app.ts and every other test here stays green while the shipped client paints exactly as often as
// it did before.
//
// Three separate links, so a break can be told apart:
//   1. app.ts installs the policy at all, and caps the resolution on the way in.
//   2. InputManager holds the frame rate on every pointer path (the one link whose absence is felt
//      as "dragging is laggy" rather than as anything a screenshot would show).
//   3. SceneManager reports a paint mode that is pessimistic about overlays and fades.
//
// Run: npm run test:ui

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as PIXI from 'pixi.js-legacy';
import { InputManager } from '../../src/inputSystem/InputManager';
import { SceneManager, type Scene } from '../../src/scenes/SceneManager';
import { POWER_PREFERENCE, renderHoldActive, resetRenderHold, setRenderPolicyClock } from '../../src/render/renderPolicy';

const APP_TS = readFileSync(join(__dirname, '..', '..', 'src', 'app.ts'), 'utf8');

let clockMs = 5_000;

beforeEach(() => {
  clockMs = 5_000;
  setRenderPolicyClock(() => clockMs);
  resetRenderHold();
});

afterEach(() => {
  setRenderPolicyClock();
  resetRenderHold();
});

describe('app.ts installs the policy', () => {
  it('constructs a RenderPolicy and installs it', () => {
    // Source-level because `startApp()` needs a real WebGL Application, which this harness has no
    // way to build — the alternative is no coverage of this line at all.
    expect(APP_TS).toMatch(/new RenderPolicy\([\s\S]*?\)\s*\.install\(\)/);
  });

  it('caps the renderer resolution instead of handing PIXI the raw devicePixelRatio', () => {
    expect(APP_TS).toMatch(/resolution:\s*rendererResolution\(platform\.devicePixelRatio\)/);
    // The exact shape of the pre-fix line, which is what a careless merge would restore.
    expect(APP_TS).not.toMatch(/resolution:\s*platform\.devicePixelRatio\s*,/);
  });

  it('asks the context for the low-power GPU', () => {
    // Omitting the option is not a neutral default: PIXI's own default is 'default', which lets a
    // dual-GPU Mac put a 2D sketch game on the discrete GPU. Absence is the bug, so the assertion
    // has to be on the option being PRESENT and on where its value comes from.
    expect(APP_TS).toMatch(/powerPreference:\s*POWER_PREFERENCE\s*,/);
    expect(POWER_PREFERENCE).toBe('low-power');
  });
});

describe('InputManager holds the frame rate', () => {
  it.each([
    ['pointer down', (i: InputManager) => i._emitDown(1, 2)],
    ['pointer move', (i: InputManager) => i._emitMove(1, 2)],
    ['pointer up',   (i: InputManager) => i._emitUp(1, 2)],
    ['wheel',        (i: InputManager) => i._emitWheel(1, 2, 3)],
  ])('%s', (_name, emit) => {
    const input = new InputManager();
    expect(renderHoldActive()).toBe(false);
    emit(input);
    expect(renderHoldActive()).toBe(true);
  });

  it('holds even for an event the gates then drop (a modal or a fade consumes it, and repaints)', () => {
    const input = new InputManager();
    input.holdForModal(true);
    input._emitDown(1, 2);
    // The tap went to a stage-level dialog through PixiJS's own event system, which InputManager
    // never sees the far side of — so "dropped here" must not mean "no repaint".
    expect(renderHoldActive()).toBe(true);
  });
});

describe('SceneManager.paintMode', () => {
  function fakeApp() {
    return {
      stage: new PIXI.Container(),
      screen: { width: 800, height: 600 },
      ticker: new PIXI.Ticker(),
      renderer: { resize: () => {} },
    } as unknown as PIXI.Application;
  }

  function scene(paint?: 'live' | 'reactive'): Scene {
    return {
      container: new PIXI.Container(),
      update: () => {},
      destroy: () => {},
      ...(paint ? { paint } : {}),
    };
  }

  it('is live with nothing mounted', () => {
    expect(new SceneManager(fakeApp()).paintMode).toBe('live');
  });

  it('follows a reactive scene', () => {
    const m = new SceneManager(fakeApp());
    m.goto(scene('reactive'));
    expect(m.paintMode).toBe('reactive');
  });

  it('follows a live scene', () => {
    const m = new SceneManager(fakeApp());
    m.goto(scene('live'));
    expect(m.paintMode).toBe('live');
  });

  it('treats an undeclared scene as live', () => {
    const m = new SceneManager(fakeApp());
    m.goto(scene());
    expect(m.paintMode).toBe('live');
  });

  it('stays live while a live scene simulates under a reactive overlay', () => {
    // The SLG map keeps animating under a City panel — the overlay's own thriftiness must not
    // stop the map underneath from being painted.
    const m = new SceneManager(fakeApp());
    m.goto(scene('live'));
    m.pushOverlay(scene('reactive'));
    expect(m.paintMode).toBe('live');
  });

  it('is reactive only when both the scene and its overlay asked for it', () => {
    const m = new SceneManager(fakeApp());
    m.goto(scene('reactive'));
    m.pushOverlay(scene('reactive'));
    expect(m.paintMode).toBe('reactive');
    m.popOverlay();
    expect(m.paintMode).toBe('reactive');
  });

  it('is live for the duration of a fade (the cover is outside the scene subtree)', () => {
    const m = new SceneManager(fakeApp());
    m.goto(scene('reactive'));
    m.goto(scene('reactive'), { fade: true });
    expect(m.paintMode).toBe('live');
  });

  it('forces a paint on a scene swap', () => {
    const m = new SceneManager(fakeApp());
    resetRenderHold();
    m.goto(scene('reactive'));
    expect(renderHoldActive()).toBe(true);
  });
});
