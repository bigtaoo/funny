/**
 * chainBanner.test.ts — the level-chain banner over a won battle (ONBOARDING_DESIGN §17.3).
 * One decision, fired once: the countdown or a tap starts the next level, the map button leaves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Minimal PIXI stub — only what ChainBanner/pixiText/hudButton touch ──
vi.mock('pixi.js-legacy', () => {
  class Point { x = 0; y = 0; set(x: number, y?: number): void { this.x = x; this.y = y ?? x; } }
  class FakeContainer {
    children: FakeContainer[] = [];
    visible = true; alpha = 1; width = 10; height = 10;
    position = new Point(); scale = new Point(); pivot = new Point();
    get x(): number { return this.position.x; } set x(v: number) { this.position.x = v; }
    get y(): number { return this.position.y; } set y(v: number) { this.position.y = v; }
    constructor() { this.scale.set(1); }
    addChild(...c: FakeContainer[]): FakeContainer { this.children.push(...c); return c[0]!; }
    removeChild(c: FakeContainer): void { this.children = this.children.filter((x) => x !== c); }
    removeChildren(): FakeContainer[] { const r = this.children; this.children = []; return r; }
    destroy(): void { /* no-op */ }
  }
  class FakeGraphics extends FakeContainer {
    beginFill(): this { return this; }
    endFill(): this { return this; }
    lineStyle(): this { return this; }
    drawRect(): this { return this; }
    drawRoundedRect(): this { return this; }
    drawCircle(): this { return this; }
    clear(): this { return this; }
  }
  class FakeText extends FakeContainer {
    text: string;
    style: Record<string, unknown>;
    anchor = new Point();
    constructor(text = '', style: Record<string, unknown> = {}) { super(); this.text = text; this.style = { ...style }; }
  }
  return {
    Container: FakeContainer,
    Graphics: FakeGraphics,
    Text: FakeText,
    settings: { ADAPTER: {} },
    RENDERER_TYPE: { CANVAS: 2, WEBGL: 1 },
  };
});

import { ChainBanner, type ChainBannerSpec } from '../../src/render/ChainBanner';
import type { ILayout } from '../../src/layout/ILayout';

const layout = { designWidth: 720, designHeight: 1280 } as ILayout;

function make(over: Partial<ChainBannerSpec> = {}): { banner: ChainBanner; onNext: ReturnType<typeof vi.fn>; onMap: ReturnType<typeof vi.fn> } {
  const onNext = vi.fn();
  const onMap = vi.fn();
  const banner = new ChainBanner(layout, { stars: 2, nextName: 'Level 2', newCards: ['Archer'], autoSec: 1.5, onNext, onMap, ...over });
  return { banner, onNext, onMap };
}

/** The map button's rect, read back off the panel: its container is the last child. */
function mapButtonCentre(banner: ChainBanner): { x: number; y: number } {
  const btn = banner.container.children[banner.container.children.length - 1]!;
  return { x: btn.x + 10, y: btn.y + 10 };
}

describe('ChainBanner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts the next level by itself once the countdown runs out — and only once', () => {
    const { banner, onNext, onMap } = make();
    banner.update(1.0);
    expect(onNext).not.toHaveBeenCalled();
    banner.update(0.6);
    banner.update(1.0);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledWith(true); // auto: no tap (ONBOARDING_DESIGN §17.7 lvN_auto)
    expect(onMap).not.toHaveBeenCalled();
  });

  it('a tap anywhere but the map button skips the wait', () => {
    const { banner, onNext } = make();
    expect(banner.handleDown(5, 5)).toBe(true);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledWith(false);
    banner.update(5);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('the map button leaves the chain instead', () => {
    const { banner, onNext, onMap } = make();
    const p = mapButtonCentre(banner);
    banner.handleDown(p.x, p.y);
    banner.update(5);
    expect(onMap).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('keeps swallowing taps after deciding, so nothing behind it fires', () => {
    const { banner } = make({ stars: undefined, newCards: undefined });
    banner.handleDown(5, 5);
    expect(banner.handleDown(5, 5)).toBe(true);
  });
});
