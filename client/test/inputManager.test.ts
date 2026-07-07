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
