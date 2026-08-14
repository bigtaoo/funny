// Playback.ts — the preview clock (normalized progress t over the effect duration). Fully
// pure/DOM-free already (no PIXI, no canvas), unlike everything else in rendering/*.
import { describe, it, expect, vi } from 'vitest';
import { Playback } from '../src/rendering/Playback';

describe('Playback.advance', () => {
  it('advances t proportionally to elapsed time / duration', () => {
    const p = new Playback(() => {});
    p.duration = 2; // seconds
    p.advance(500); // 0.5s / 2s = 0.25
    expect(p.t).toBeCloseTo(0.25);
  });

  it('wraps back into [0,1) once t reaches 1 (loops the preview)', () => {
    const p = new Playback(() => {});
    p.duration = 1;
    p.t = 0.9;
    p.advance(200); // +0.2 → 1.1 → wraps to 0.1
    expect(p.t).toBeCloseTo(0.1);
  });

  it('does nothing while paused', () => {
    const p = new Playback(() => {});
    p.playing = false;
    p.t = 0.3;
    p.advance(1000);
    expect(p.t).toBe(0.3);
  });

  it('does nothing when duration is zero or negative (guards div-by-zero)', () => {
    const p = new Playback(() => {});
    p.duration = 0;
    p.t = 0.3;
    p.advance(1000);
    expect(p.t).toBe(0.3);
  });

  it('calls onChange after a real advance, not when guarded out', () => {
    const onChange = vi.fn();
    const p = new Playback(onChange);
    p.duration = 1;
    p.advance(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    onChange.mockClear();
    p.playing = false;
    p.advance(100);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Playback.setPlaying / toggle', () => {
  it('sets the playing flag and notifies', () => {
    const onChange = vi.fn();
    const p = new Playback(onChange);
    p.setPlaying(false);
    expect(p.playing).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('toggle flips the current state', () => {
    const p = new Playback(() => {});
    expect(p.playing).toBe(true);
    p.toggle();
    expect(p.playing).toBe(false);
    p.toggle();
    expect(p.playing).toBe(true);
  });
});

describe('Playback.scrubTo', () => {
  it('sets t and pauses', () => {
    const p = new Playback(() => {});
    p.scrubTo(0.6);
    expect(p.t).toBe(0.6);
    expect(p.playing).toBe(false);
  });

  it('clamps below 0 up to 0', () => {
    const p = new Playback(() => {});
    p.scrubTo(-0.5);
    expect(p.t).toBe(0);
  });

  it('clamps above 1 down to 1', () => {
    const p = new Playback(() => {});
    p.scrubTo(1.5);
    expect(p.t).toBe(1);
  });
});
