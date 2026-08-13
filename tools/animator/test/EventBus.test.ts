// EventBus<T> (src/core/EventBus.ts) — the app's typed pub/sub hub. Pure logic, no DOM/PIXI.
// Previously only exercised indirectly as a real dependency of CommandManager/editorProject/
// taoExport tests; this pins its own subscribe/unsubscribe/emit contract directly.
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../src/core/EventBus';

interface TestEvents {
  'with:payload': { n: number };
  'no:payload': void;
}

describe('on/emit', () => {
  it('calls every subscriber with the emitted payload', () => {
    const bus = new EventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('with:payload', a);
    bus.on('with:payload', b);
    bus.emit('with:payload', { n: 7 });
    expect(a).toHaveBeenCalledWith({ n: 7 });
    expect(b).toHaveBeenCalledWith({ n: 7 });
  });

  it('emitting a void-payload event takes no second argument, listener receives undefined', () => {
    const bus = new EventBus<TestEvents>();
    const fn = vi.fn();
    bus.on('no:payload', fn);
    bus.emit('no:payload');
    expect(fn).toHaveBeenCalledWith(undefined);
  });

  it('emitting an event with no subscribers is a silent no-op', () => {
    const bus = new EventBus<TestEvents>();
    expect(() => bus.emit('with:payload', { n: 1 })).not.toThrow();
  });

  it('subscribing the same function twice only registers it once (Set semantics)', () => {
    const bus = new EventBus<TestEvents>();
    const fn = vi.fn();
    bus.on('with:payload', fn);
    bus.on('with:payload', fn);
    bus.emit('with:payload', { n: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a listener on one event is never called for a different event', () => {
    const bus = new EventBus<TestEvents>();
    const fn = vi.fn();
    bus.on('with:payload', fn);
    bus.emit('no:payload');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('off / unsubscribe', () => {
  it('on() returns an unsubscribe function that stops future delivery', () => {
    const bus = new EventBus<TestEvents>();
    const fn = vi.fn();
    const off = bus.on('with:payload', fn);
    off();
    bus.emit('with:payload', { n: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('off() removes only the named listener, leaving others intact', () => {
    const bus = new EventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('with:payload', a);
    bus.on('with:payload', b);
    bus.off('with:payload', a);
    bus.emit('with:payload', { n: 1 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('off() on an event with no listeners at all is a silent no-op', () => {
    const bus = new EventBus<TestEvents>();
    expect(() => bus.off('with:payload', vi.fn())).not.toThrow();
  });

  it('unsubscribing twice (double-call) is safe', () => {
    const bus = new EventBus<TestEvents>();
    const fn = vi.fn();
    const off = bus.on('with:payload', fn);
    off();
    expect(() => off()).not.toThrow();
  });

  it('a listener may unsubscribe itself mid-emit without breaking delivery to the others', () => {
    const bus = new EventBus<TestEvents>();
    const results: string[] = [];
    let offA: () => void;
    const a = () => { results.push('a'); offA(); };
    const b = () => results.push('b');
    offA = bus.on('with:payload', a);
    bus.on('with:payload', b);
    bus.emit('with:payload', { n: 1 });
    expect(results).toEqual(['a', 'b']);
    bus.emit('with:payload', { n: 2 }); // a is gone now
    expect(results).toEqual(['a', 'b', 'b']);
  });
});
