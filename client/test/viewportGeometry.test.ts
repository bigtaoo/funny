// layout/viewportGeometry.ts — the on-device readout that exists because this bug class cannot be
// reproduced in any environment we can inspect (desktop Chrome: zero insets, full-height viewport).
//
// The case that matters is `inset-eaten`: a native shell whose layout viewport is SMALLER than the
// screen while `env(safe-area-inset-*)` reports nothing. That combination is the iPhone-13 portrait
// bug's fingerprint, and it is the one neither of the two readings the 2026-07/09 analyses assumed
// (insets correct / insets zero) can produce — see the file's header for the arithmetic.
import { describe, it, expect } from 'vitest';
import {
  formatViewportGeometry, viewportGeometryProps, viewportVerdict, type ViewportGeometry,
} from '../src/layout/viewportGeometry';

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };
const IPHONE13 = { top: 47, right: 0, bottom: 34, left: 0 };

/** iPhone 13 portrait: 390x844pt panel, 47/34 real insets. */
function geom(over: Partial<ViewportGeometry> = {}): ViewportGeometry {
  return {
    innerW: 390, innerH: 844,
    screenW: 390, screenH: 844,
    visualW: 390, visualH: 844, visualOffsetTop: 0,
    dpr: 3,
    insets: ZERO,
    nativeShell: true,
    ...over,
  };
}

describe('viewportVerdict', () => {
  it('reads a shrunken viewport with zero insets as inset-eaten (the reported bug)', () => {
    // What ios.contentInset:'always' produces: WKWebView insets the page itself (844 - 47 - 34 =
    // 763) and zeroes env(), so our own gameLayer offset has nothing to act on.
    expect(viewportVerdict(geom({ innerH: 763, insets: ZERO }))).toBe('inset-eaten');
  });

  it('reads a full viewport with real insets as env-reported (the fixed state)', () => {
    expect(viewportVerdict(geom({ innerH: 844, insets: IPHONE13 }))).toBe('env-reported');
  });

  it('reads a full viewport with no insets as no-inset (a phone with nothing to avoid)', () => {
    expect(viewportVerdict(geom({ innerH: 844, insets: ZERO }))).toBe('no-inset');
  });

  it('never claims inset-eaten outside the native shell, however small the viewport', () => {
    // A browser window is legitimately smaller than the screen (tabs, URL bar, the OS taskbar), so
    // the screen-vs-viewport comparison carries no information there. Claiming it does would make
    // every desktop screenshot look like the bug.
    expect(viewportVerdict(geom({ nativeShell: false, innerW: 1280, innerH: 700, screenW: 2560, screenH: 1440 })))
      .toBe('browser');
  });

  it('does not read a rotated device as inset-eaten (screen.width/height stay portrait on iOS)', () => {
    // Landscape iPhone 13: viewport 844x390, but `screen` still reports 390x844. Comparing axis to
    // like-named axis would show an 454pt "loss" on both and cry wolf on every rotation.
    expect(viewportVerdict(geom({ innerW: 844, innerH: 390, screenW: 390, screenH: 844 }))).toBe('no-inset');
  });

  it('ignores sub-2px differences (rounding, not an inset)', () => {
    expect(viewportVerdict(geom({ innerH: 843 }))).toBe('no-inset');
    expect(viewportVerdict(geom({ innerH: 842 }))).toBe('inset-eaten');
  });
});

describe('formatViewportGeometry', () => {
  it('puts every number a diagnosis needs into two photographable lines', () => {
    const [top, bottom] = formatViewportGeometry(geom({ innerH: 763 }));
    expect(top).toBe('inner 390x763 | screen 390x844 | dpr 3');
    expect(bottom).toBe('env 0/0/0/0 | vv 390x844@0 | inset-eaten');
  });

  it('says so rather than printing -1 when visualViewport is absent', () => {
    const [, bottom] = formatViewportGeometry(geom({ visualW: -1, visualH: -1, visualOffsetTop: -1 }));
    expect(bottom).toContain('vv n/a');
  });

  it('rounds fractional readings to one decimal (a photo of "46.999999" reads as noise)', () => {
    const [, bottom] = formatViewportGeometry(geom({ insets: { ...ZERO, top: 46.99999 } }));
    expect(bottom).toContain('env 47/0/0/0');
  });
});

describe('viewportGeometryProps', () => {
  it('is flat — the log ring buffer JSON.stringifies props and truncates at 500 chars', () => {
    const props = viewportGeometryProps(geom({ innerH: 763 }));
    for (const v of Object.values(props)) expect(typeof v).not.toBe('object');
    expect(props.insetTop).toBe(0);
    expect(props.verdict).toBe('inset-eaten');
    expect(props.nativeShell).toBe(true);
  });
});
