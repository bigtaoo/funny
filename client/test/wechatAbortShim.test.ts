// Coverage for `client/src/platform/wechat/abortShim.ts` — the `AbortController`/`AbortSignal`
// stand-in the mini-game runtime does not ship.
//
// 0% until now, on a file whose absence cost the WeChat build **every REST call it ever made**:
// `net/ApiClient/core.ts` does an unconditional `new AbortController()` before the transport layer
// is reached, so login, bootstrap, save sync and the whole world service failed at the first line
// with `AbortController is not defined` — reported to the player as a network error (see this
// module's header for how it was found: the in-package layout sweep, not a test).
//
// So the shim is load-bearing for one whole platform, and it is also the kind of file where a
// wrong detail is invisible on every other platform. The cases below pin the four that a consumer
// actually depends on:
//   · listeners fire ONCE and a second `abort()` is a no-op — `wechatTransport` cancels a
//     `RequestTask` in there, and a double cancel on a reused task is not free;
//   · one throwing listener neither stops the others nor escapes back into the caller, which is a
//     timeout callback at every call site;
//   · the default reason is an Error NAMED `AbortError`, because `e.name === 'AbortError'` is the
//     branch every caller writes to tell "we cancelled this" from "the network died";
//   · the install defers to a real implementation (`??=`), so a future base library that ships
//     these two classes is used instead of being shadowed by this one forever.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installAbortShim } from '../src/platform/wechat/abortShim';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

let savedController: unknown;
let savedSignal: unknown;

beforeEach(() => {
  savedController = g.AbortController;
  savedSignal = g.AbortSignal;
  // Node HAS both, so the shim would never install itself — clear them to reach the code at all.
  delete g.AbortController;
  delete g.AbortSignal;
});

afterEach(() => {
  g.AbortController = savedController;
  g.AbortSignal = savedSignal;
});

/** Install, then build one shimmed controller — typed loosely, since the classes are not exported. */
function shimmed(): { ctrl: { abort(reason?: unknown): void }; signal: {
  aborted: boolean; reason: unknown; onabort: ((ev: { type: 'abort' }) => void) | null;
  addEventListener(t: string, fn: (ev: { type: 'abort' }) => void): void;
  removeEventListener(t: string, fn: (ev: { type: 'abort' }) => void): void;
  throwIfAborted(): void;
} } {
  installAbortShim();
  const Ctor = g.AbortController as new () => { abort(reason?: unknown): void; signal: never };
  const ctrl = new Ctor();
  return { ctrl, signal: ctrl.signal };
}

describe('the WeChat AbortController shim — installation', () => {
  it('defines both globals when the runtime has neither', () => {
    expect(g.AbortController).toBeUndefined();
    installAbortShim();
    expect(typeof g.AbortController).toBe('function');
    expect(typeof g.AbortSignal).toBe('function');
  });

  it('defers to a real implementation instead of shadowing it', () => {
    // The `??=` is the whole point: the day the base library ships these, the platform's own
    // classes are the ones that talk to the platform's own request tasks.
    class Real {}
    g.AbortController = Real;
    g.AbortSignal = Real;
    installAbortShim();
    expect(g.AbortController).toBe(Real);
    expect(g.AbortSignal).toBe(Real);
  });

  it('is idempotent — importing it from more than one entry installs one class', () => {
    installAbortShim();
    const first = g.AbortController;
    installAbortShim();
    expect(g.AbortController).toBe(first);
  });
});

describe('the WeChat AbortController shim — signalling', () => {
  it('starts unaborted and with no reason', () => {
    const { signal } = shimmed();
    expect(signal.aborted).toBe(false);
    expect(signal.reason).toBeUndefined();
  });

  it('fires onabort and every listener, in that order, with an abort event', () => {
    const { ctrl, signal } = shimmed();
    const seen: string[] = [];
    signal.onabort = (ev) => { seen.push(`onabort:${ev.type}`); };
    signal.addEventListener('abort', (ev) => { seen.push(`l1:${ev.type}`); });
    signal.addEventListener('abort', () => { seen.push('l2'); });
    ctrl.abort();
    expect(seen).toEqual(['onabort:abort', 'l1:abort', 'l2']);
    expect(signal.aborted).toBe(true);
  });

  it('ignores listeners registered for any other event type', () => {
    const { ctrl, signal } = shimmed();
    let other = 0;
    signal.addEventListener('error', () => { other += 1; });
    ctrl.abort();
    expect(other).toBe(0);
  });

  it('defaults the reason to an Error named AbortError', () => {
    // `e.name === 'AbortError'` is how every caller separates "we cancelled" from "the network
    // died", and there is no DOMException in this runtime to produce the real one.
    const { ctrl, signal } = shimmed();
    ctrl.abort();
    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).name).toBe('AbortError');
    expect((signal.reason as Error).message).toContain('without reason');
  });

  it('passes an explicit reason through untouched, including a falsy one', () => {
    const { ctrl, signal } = shimmed();
    ctrl.abort(null);
    // `null` is a reason, not an absent one — `?? default` here would swallow it.
    expect(signal.reason).toBeNull();
    expect(signal.aborted).toBe(true);
  });

  it('fires each listener at most once, and a second abort does nothing at all', () => {
    // The consumer cancels a live `RequestTask` in here; re-firing is a second cancel on a task
    // that may already have been reused.
    //
    // What does the work is the `aborted` guard, NOT the list being emptied — verified by mutation:
    // deleting `this.listeners = []` keeps every case in this file green. That line is a reference
    // release (an aborted signal must not keep its listeners, and through them whatever they close
    // over, alive for the rest of the session), and no assertion here can see it. Recorded rather
    // than covered with something that looks like a behaviour test.
    const { ctrl, signal } = shimmed();
    let calls = 0;
    signal.addEventListener('abort', () => { calls += 1; });
    ctrl.abort('first');
    ctrl.abort('second');
    expect(calls).toBe(1);
    expect(signal.reason).toBe('first');
  });

  it('removes a listener, and ignores a removal for another event type', () => {
    const { ctrl, signal } = shimmed();
    let calls = 0;
    const fn = (): void => { calls += 1; };
    signal.addEventListener('abort', fn);
    signal.removeEventListener('error', fn);   // wrong type: must not remove it
    signal.removeEventListener('abort', fn);
    ctrl.abort();
    expect(calls).toBe(0);
  });

  it('contains a throwing listener: the rest still run and nothing reaches the caller', () => {
    // Every call site aborts from inside a timeout callback, where an escaping throw is an
    // unhandled rejection with no stack pointing anywhere useful.
    const { ctrl, signal } = shimmed();
    const seen: string[] = [];
    signal.onabort = () => { throw new Error('onabort blew up'); };
    signal.addEventListener('abort', () => { throw new Error('listener blew up'); });
    signal.addEventListener('abort', () => { seen.push('survivor'); });
    expect(() => ctrl.abort()).not.toThrow();
    expect(seen).toEqual(['survivor']);
  });

  it('throwIfAborted is a no-op before and throws the reason after', () => {
    const { ctrl, signal } = shimmed();
    expect(() => signal.throwIfAborted()).not.toThrow();
    ctrl.abort(new Error('cancelled'));
    expect(() => signal.throwIfAborted()).toThrow('cancelled');
  });
});
