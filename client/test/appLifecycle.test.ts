// Regression coverage for platform/appLifecycle.ts — extracted 2026-09-01 out of
// analytics/index.ts + analytics/queue.ts, which each carried their own copy of this exact
// web-vs-WeChat branching. Previously neither copy had a single test exercising it: the wx.onHide
// path existed correctly since the original A9 commit, but nothing would have caught it being
// deleted by accident. This file is what closes that gap for the shared implementation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onAppLifecycleChange, type AppLifecycleState } from '../src/platform/appLifecycle';

function makeDoc() {
  const listeners = new Map<string, Array<() => void>>();
  const doc = {
    hidden: false,
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: (type: string, cb: () => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
  };
  return { doc, fire: (type: string) => (listeners.get(type) ?? []).forEach((f) => f()) };
}

function makeWindow() {
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    addEventListener: (type: string, cb: () => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
  };
  return { win, fire: (type: string) => (listeners.get(type) ?? []).forEach((f) => f()) };
}

describe('onAppLifecycleChange — web / CrazyGames path', () => {
  let doc: ReturnType<typeof makeDoc>['doc'];
  let fireDoc: ReturnType<typeof makeDoc>['fire'];
  let win: ReturnType<typeof makeWindow>['win'];
  let fireWin: ReturnType<typeof makeWindow>['fire'];

  beforeEach(() => {
    ({ doc, fire: fireDoc } = makeDoc());
    ({ win, fire: fireWin } = makeWindow());
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('visibilitychange → hidden reports "hidden"', () => {
    const states: AppLifecycleState[] = [];
    onAppLifecycleChange((s) => states.push(s));
    doc.visibilityState = 'hidden';
    fireDoc('visibilitychange');
    expect(states).toEqual(['hidden']);
  });

  it('visibilitychange → visible reports "visible" (tab-switch round trip)', () => {
    const states: AppLifecycleState[] = [];
    onAppLifecycleChange((s) => states.push(s));
    doc.visibilityState = 'hidden';
    fireDoc('visibilitychange');
    doc.visibilityState = 'visible';
    fireDoc('visibilitychange');
    expect(states).toEqual(['hidden', 'visible']);
  });

  it('beforeunload reports "exit", distinct from a plain background hide', () => {
    const states: AppLifecycleState[] = [];
    onAppLifecycleChange((s) => states.push(s));
    fireWin('beforeunload');
    expect(states).toEqual(['exit']);
  });

  it('does not fire immediately on registration — only on a real transition', () => {
    const cb = vi.fn();
    onAppLifecycleChange(cb);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('onAppLifecycleChange — WeChat path (no DOM)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wx.onHide reports "hidden", wx.onShow reports "visible" — never "exit" (no equivalent signal exists)', () => {
    let hideCb: (() => void) | undefined;
    let showCb: (() => void) | undefined;
    vi.stubGlobal('wx', {
      onHide: (cb: () => void) => { hideCb = cb; },
      onShow: (cb: () => void) => { showCb = cb; },
    });
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('window', undefined);

    const states: AppLifecycleState[] = [];
    onAppLifecycleChange((s) => states.push(s));

    hideCb!();
    showCb!();
    expect(states).toEqual(['hidden', 'visible']);
  });

  it('wechatHost.ts stubs document/window as no-op-addEventListener objects — those never fire, wx.onHide is what actually reports the transition', () => {
    // Mirrors platform/wechat/wechatHost.ts's installWechatHost(): document/window exist (so
    // `typeof document !== 'undefined'` is true even on a real device) but addEventListener is a
    // deliberate no-op, since there is no DOM event source behind it.
    const noopDoc = { visibilityState: 'visible', addEventListener: () => { /* no-op, per wechatHost.ts */ } };
    const noopWin = { addEventListener: () => { /* no-op, per wechatHost.ts */ } };
    vi.stubGlobal('document', noopDoc);
    vi.stubGlobal('window', noopWin);
    let hideCb: (() => void) | undefined;
    vi.stubGlobal('wx', { onHide: (cb: () => void) => { hideCb = cb; } });

    const states: AppLifecycleState[] = [];
    onAppLifecycleChange((s) => states.push(s));

    hideCb!();
    expect(states).toEqual(['hidden']);
  });
});

describe('onAppLifecycleChange — no host signals available (node, e2e headless)', () => {
  it('never throws when document/window/wx are all absent', () => {
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('wx', undefined);
    expect(() => onAppLifecycleChange(() => {})).not.toThrow();
    vi.unstubAllGlobals();
  });
});
