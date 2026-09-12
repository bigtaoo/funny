/**
 * paperBakeSharing.test.ts — the notebook page is cached by what it DRAWS, not by who asked for it.
 *
 * Background (measured in real Chrome, 2026-09-10; field confirmation in Loki 2026-09-11): the bake
 * key used to lead with the caller's `tag`, so walking every screen minted 33 full-page
 * RenderTextures — 262 MiB of the cache's 279 MiB — and `renderer.extract.pixels()` showed 30 of
 * them were byte-identical to one of three images. `buildPaperBackground` reads nothing but
 * `w`/`h`/`marginLine`/`railX`; the pen seed is a constant. A phone pays ~12.2 MiB per page, so the
 * multiplier was the single biggest retained allocation in the client.
 *
 * These assertions are on `paperBakeKey` rather than on a live bake cache because the cache needs a
 * real WebGL renderer (`setBakeRenderer`) that a headless run has no way to provide — the key IS the
 * sharing, and it is the part that can silently regress when someone "puts the tag back so the
 * stats name the call site".
 */
import { describe, it, expect } from 'vitest';
import { paperBakeKey, marginLineX } from '../src/render/sketchUi';

describe('paperBakeKey', () => {
  it('two screens of the same size and rule share one entry', () => {
    // What used to be 'cardbg:...' and 'statsbg:...' — byte-identical, cached twice.
    expect(paperBakeKey(1920, 1080, true, 185)).toBe(paperBakeKey(1920, 1080, true, 185));
  });

  it('a different size is still a different entry', () => {
    expect(paperBakeKey(1920, 1080, true, 185)).not.toBe(paperBakeKey(1920, 1081, true, 185));
    expect(paperBakeKey(1920, 1080, true, 185)).not.toBe(paperBakeKey(1921, 1080, true, 185));
  });

  it('a different margin rule is a different entry', () => {
    expect(paperBakeKey(1920, 1080, true, 185)).not.toBe(paperBakeKey(1920, 1080, true, 260));
  });

  it('suppressing the margin rule is a different entry (the SLG overworld)', () => {
    // The regression this guards: `marginLine` reaches a draw call but was NEVER in the key — it
    // only ever worked because `tag` happened to keep 'worldmap' apart from every menu. With the
    // tag gone, a map-sized page and a menu-sized page of the same dimensions would collide and one
    // of them would render the other's image.
    expect(paperBakeKey(1920, 1080, false)).not.toBe(paperBakeKey(1920, 1080, true));
  });

  it('an omitted railX means the default 9% rule, not a separate entry', () => {
    expect(paperBakeKey(1920, 1080, true)).toBe(paperBakeKey(1920, 1080, true, marginLineX(1920)));
  });

  it('rounds a fractional railX, which arrives as a fraction of the short edge', () => {
    expect(paperBakeKey(1920, 1080, true, 185.4)).toBe(paperBakeKey(1920, 1080, true, 185));
  });

  it('carries no caller identity — the key names the drawing', () => {
    expect(paperBakeKey(1920, 1080, true, 185)).toBe('paper:1920x1080:185');
  });
});
