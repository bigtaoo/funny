// InputManager fault-isolation regression tests.
//
// Background: pointer dispatch used `list.forEach(f => f(x, y))`. If ANY handler
// threw — e.g. a stale subscription from a scene that was torn down mid-transition
// touching a destroyed display object — the exception propagated out of forEach and
// every LATER handler (including the live scene's) was skipped. To the player this
// read as "taps do nothing" until a page reload. dispatch() now iterates a snapshot
// and isolates each handler in try/catch. These tests pin that behavior.

import { describe, it, expect, vi } from 'vitest';
import { InputManager } from '../src/inputSystem/InputManager';

describe('InputManager fault isolation', () => {
  it('a throwing handler does not prevent later handlers from running', () => {
    const input = new InputManager();
    const order: string[] = [];

    input.onDown(() => { order.push('a'); });
    input.onDown(() => { throw new Error('boom'); });
    input.onDown(() => { order.push('c'); });

    expect(() => input._emitDown(10, 20)).not.toThrow();
    // The throwing middle handler must NOT swallow the ones registered after it.
    expect(order).toEqual(['a', 'c']);
  });

  it('isolates throws on move and up channels too', () => {
    const input = new InputManager();
    const moved = vi.fn();
    const upped = vi.fn();

    input.onMove(() => { throw new Error('move-boom'); });
    input.onMove(moved);
    input.onUp(() => { throw new Error('up-boom'); });
    input.onUp(upped);

    expect(() => input._emitMove(1, 2)).not.toThrow();
    expect(() => input._emitUp(3, 4)).not.toThrow();
    expect(moved).toHaveBeenCalledWith(1, 2);
    expect(upped).toHaveBeenCalledWith(3, 4);
  });

  it('passes the event coordinates through to every handler', () => {
    const input = new InputManager();
    const h = vi.fn();
    input.onDown(h);
    input._emitDown(42, 99);
    expect(h).toHaveBeenCalledWith(42, 99);
  });

  it('a handler that unsubscribes mid-dispatch does not skip the next handler', () => {
    // Dispatch iterates a snapshot, so mutating the subscriber list from within a
    // handler must not drop a sibling from the current event.
    const input = new InputManager();
    const seen: string[] = [];
    let unsubB: () => void = () => {};

    input.onDown(() => { seen.push('a'); unsubB(); });
    unsubB = input.onDown(() => { seen.push('b'); });
    input.onDown(() => { seen.push('c'); });

    input._emitDown(0, 0);
    expect(seen).toEqual(['a', 'b', 'c']);

    // On the NEXT event, b is gone (it unsubscribed).
    seen.length = 0;
    input._emitDown(0, 0);
    expect(seen).toEqual(['a', 'c']);
  });

  it('unsubscribe removes a handler from future dispatches', () => {
    const input = new InputManager();
    const h = vi.fn();
    const unsub = input.onDown(h);
    input._emitDown(0, 0);
    unsub();
    input._emitDown(0, 0);
    expect(h).toHaveBeenCalledTimes(1);
  });
});

// Suppression + fade-abort gate.
//
// Background: pointer input bypasses PixiJS — WebAdapter feeds InputManager straight from DOM
// pointer listeners. So the SceneManager's fade overlay ("nothing clickable mid-fade") can't block
// taps; the manager must gate the input source directly. Without it, a tap during the ~280ms fade
// reaches the outgoing scene's still-live hit-rects (the "Store → Career" mis-navigation). The gate
// also lets the first tap ABORT the fade (via onSuppressedInput) so fast tapping isn't lost, with
// swallowNextUp eating that tap's release so it can't land on the freshly-mounted scene.
describe('InputManager suppression gate', () => {
  it('drops every channel while suppressed, and restores on release', () => {
    const input = new InputManager();
    const down = vi.fn(), move = vi.fn(), up = vi.fn();
    input.onDown(down); input.onMove(move); input.onUp(up);

    input.suppress(true);
    input._emitDown(1, 1); input._emitMove(1, 1); input._emitUp(1, 1);
    expect(down).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(up).not.toHaveBeenCalled();

    input.suppress(false);
    input._emitDown(2, 2); input._emitMove(2, 2); input._emitUp(2, 2);
    expect(down).toHaveBeenCalledWith(2, 2);
    expect(move).toHaveBeenCalledWith(2, 2);
    expect(up).toHaveBeenCalledWith(2, 2);
  });

  it('a suppressed pointer-down fires the abort hook and is NOT dispatched', () => {
    const input = new InputManager();
    const hook = vi.fn(), down = vi.fn();
    input.onSuppressedInput(hook);
    input.onDown(down);

    input.suppress(true);
    input._emitDown(5, 5);
    expect(hook).toHaveBeenCalledTimes(1); // fade-abort trigger
    expect(down).not.toHaveBeenCalled();   // the aborting down is consumed, never delivered to a scene
  });

  it('the abort hook is down-only — suppressed move/up never fire it', () => {
    const input = new InputManager();
    const hook = vi.fn();
    input.onSuppressedInput(hook);
    input.suppress(true);
    input._emitMove(5, 5);
    input._emitUp(5, 5);
    expect(hook).not.toHaveBeenCalled();
  });

  it('swallowNextUp drops exactly one up, then dispatch resumes', () => {
    const input = new InputManager();
    const up = vi.fn();
    input.onUp(up);

    input.swallowNextUp();
    input._emitUp(1, 1);
    expect(up).not.toHaveBeenCalled(); // the swallowed release
    input._emitUp(2, 2);
    expect(up).toHaveBeenCalledTimes(1); // one-shot only
  });

  it('a swallow armed during suppression survives the release (the real abort sequence)', () => {
    // Real flow: a tap during the fade aborts it — the hook arms swallowNextUp and lifts suppression,
    // then the SAME gesture's pointer-up arrives. It must be eaten so it can't tap the new scene.
    const input = new InputManager();
    const up = vi.fn();
    input.onUp(up);

    input.suppress(true);
    input.swallowNextUp();     // armed while still suppressed (as skipTransition does)
    input.suppress(false);     // fade aborted → input live again
    input._emitUp(9, 9);
    expect(up).not.toHaveBeenCalled(); // the aborting tap's release, swallowed
    input._emitUp(9, 9);
    expect(up).toHaveBeenCalledTimes(1);
  });
});
